/**
 * Rev.com → Slack Poller
 *
 * Polls the Rev V1 API every 15 minutes for order status changes
 * and posts rich Slack notifications when something changes.
 *
 * Environment variables (set in Railway → Variables):
 *   REV_API_KEY        — Your Rev V1 API user key
 *   SLACK_WEBHOOK_URL  — Slack Incoming Webhook URL
 *   SLACK_CHANNEL      — e.g. #transcriptions
 *   POLL_INTERVAL_MS   — optional, defaults to 900000 (15 min)
 *   PORT               — optional, defaults to 3000
 */

const https = require("https");
const http  = require("http");

// ─── Config ───────────────────────────────────────────────────────────────────

const REV_API_KEY   = process.env.REV_API_KEY;
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL    || "#transcriptions";
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS) || 15 * 60 * 1000;
const PORT          = process.env.PORT || 3000;

if (!REV_API_KEY)   { console.error("❌  REV_API_KEY is required");       process.exit(1); }
if (!SLACK_WEBHOOK) { console.error("❌  SLACK_WEBHOOK_URL is required"); process.exit(1); }

// ─── State ────────────────────────────────────────────────────────────────────
// Tracks last known status per order to avoid duplicate notifications.
// Resets on server restart — acceptable for a lightweight notifier.

const knownOrders = new Map(); // orderId → last known status

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

// ─── Rev API ──────────────────────────────────────────────────────────────────

async function fetchRevOrders() {
  const res = await request({
    hostname: "www.rev.com",
    path:     "/api/v1/orders?page_size=50",
    method:   "GET",
    headers: {
      "Authorization": `Rev ${REV_API_KEY}`,
      "Content-Type":  "application/json",
    },
  });

  if (res.status !== 200) {
    throw new Error(`Rev API returned ${res.status}: ${JSON.stringify(res.body)}`);
  }

  return res.body.orders || [];
}

// ─── Slack ────────────────────────────────────────────────────────────────────

const STATUS_EMOJI = {
  in_progress: "⚙️",
  complete:    "✅",
  cancelled:   "🚫",
  failed:      "❌",
};

const STATUS_COLOR = {
  in_progress: "#F5A623",
  complete:    "#2ECC71",
  cancelled:   "#E74C3C",
  failed:      "#E74C3C",
};

const STATUS_LABEL = {
  in_progress: "Transcription in progress",
  complete:    "Transcription complete",
  cancelled:   "Order cancelled",
  failed:      "Order failed",
};

function buildSlackPayload(order) {
  const status    = order.status;
  const emoji     = STATUS_EMOJI[status] || "🔔";
  const color     = STATUS_COLOR[status] || "#888888";
  const label     = STATUS_LABEL[status] || status;
  const name      = order.name           || "Untitled order";
  const orderId   = order.order_number   || order.id;
  const revUrl    = `https://www.rev.com/app/order/${order.id}`;
  const wordCount = order.word_count;
  const duration  = order.duration_seconds
    ? `${Math.floor(order.duration_seconds / 60)}m ${order.duration_seconds % 60}s`
    : null;

  const fields = [];
  if (orderId)   fields.push({ type: "mrkdwn", text: `*Order ID*\n${orderId}` });
  if (duration)  fields.push({ type: "mrkdwn", text: `*Duration*\n${duration}` });
  if (wordCount) fields.push({ type: "mrkdwn", text: `*Word count*\n${wordCount.toLocaleString()}` });

  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: `${emoji} *${label}*\n${name}` } },
  ];

  if (fields.length > 0) blocks.push({ type: "section", fields });

  blocks.push({
    type: "actions",
    elements: [{
      type: "button",
      text: { type: "plain_text", text: "Open in Rev", emoji: true },
      url:  revUrl,
      action_id: "open_rev",
    }],
  });

  blocks.push({ type: "divider" });

  return {
    channel:     SLACK_CHANNEL,
    attachments: [{ color, blocks, fallback: `${emoji} ${label}: ${name}` }],
  };
}

async function postToSlack(payload) {
  const body = JSON.stringify(payload);
  const url  = new URL(SLACK_WEBHOOK);
  const res  = await request({
    hostname: url.hostname,
    path:     url.pathname + url.search,
    method:   "POST",
    headers: {
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);

  if (res.status !== 200) {
    throw new Error(`Slack returned ${res.status}: ${res.body}`);
  }
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

const NOTIFY_STATUSES = new Set(["in_progress", "complete", "cancelled", "failed"]);

async function poll() {
  console.log(`🔍  Polling Rev API... [${new Date().toISOString()}]`);

  let orders;
  try {
    orders = await fetchRevOrders();
  } catch (err) {
    console.error("❌  Failed to fetch Rev orders:", err.message);
    return;
  }

  console.log(`   Found ${orders.length} orders`);

  for (const order of orders) {
    const id            = order.id;
    const currentStatus = order.status;
    const lastStatus    = knownOrders.get(id);

    // First time seeing this order — record it, notify only if already complete
    if (lastStatus === undefined) {
      knownOrders.set(id, currentStatus);
      if (currentStatus === "complete") {
        console.log(`   New order detected (already complete): ${id} — notifying`);
        try { await postToSlack(buildSlackPayload(order)); }
        catch (err) { console.error(`   ❌  Slack post failed for ${id}:`, err.message); }
      }
      continue;
    }

    // Status changed — notify if it's a status we care about
    if (currentStatus !== lastStatus && NOTIFY_STATUSES.has(currentStatus)) {
      console.log(`   Status change: ${id} ${lastStatus} → ${currentStatus}`);
      knownOrders.set(id, currentStatus);
      try {
        await postToSlack(buildSlackPayload(order));
        console.log(`   ✅  Slack notified for order ${id}`);
      } catch (err) {
        console.error(`   ❌  Slack post failed for ${id}:`, err.message);
      }
    } else {
      knownOrders.set(id, currentStatus);
    }
  }
}

// ─── Health check server ──────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok:               true,
      orders_tracked:   knownOrders.size,
      poll_interval_ms: POLL_INTERVAL,
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`🚀  Rev→Slack poller running on port ${PORT}`);
  console.log(`   Polling every ${POLL_INTERVAL / 1000 / 60} minutes`);
  console.log(`   GET /health — health check`);
});

// ─── Start ────────────────────────────────────────────────────────────────────

poll();
setInterval(poll, POLL_INTERVAL);

/**
 * Rev.com → Slack Webhook Server
 * 
 * Listens for Rev.com order events and posts rich notifications to Slack.
 * Handles: order submitted, in_progress, transcription_completed, cancelled
 * 
 * Setup:
 *   1. npm install express
 *   2. Set env vars (see .env.example)
 *   3. node server.js
 *   4. Expose publicly via ngrok or deploy to a host
 *   5. Register the /webhook URL in Rev.com dashboard
 */

const express = require("express");
const crypto  = require("crypto");
const https   = require("https");

const app = express();

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT             = process.env.PORT             || 3000;
const SLACK_WEBHOOK    = process.env.SLACK_WEBHOOK_URL;   // Slack Incoming Webhook URL
const REV_SECRET       = process.env.REV_WEBHOOK_SECRET;  // Optional: Rev signing secret
const SLACK_CHANNEL    = process.env.SLACK_CHANNEL    || "#transcriptions";

if (!SLACK_WEBHOOK) {
  console.error("❌  SLACK_WEBHOOK_URL env var is required");
  process.exit(1);
}

// ─── Middleware ───────────────────────────────────────────────────────────────

// Raw body needed for signature verification
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// ─── Signature Verification ───────────────────────────────────────────────────

function verifyRevSignature(req) {
  if (!REV_SECRET) return true; // Skip if no secret configured

  const signature = req.headers["x-rev-signature"];
  if (!signature) return false;

  const expected = crypto
    .createHmac("sha256", REV_SECRET)
    .update(req.rawBody)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(expected, "hex")
  );
}

// ─── Rev Status → Slack Block Builder ────────────────────────────────────────

const STATUS_EMOJI = {
  order_submitted:          "📤",
  in_progress:              "⚙️",
  transcription_completed:  "✅",
  cancelled:                "🚫",
  attachment_added:         "📎",
};

const STATUS_COLOR = {
  order_submitted:          "#4A90D9",
  in_progress:              "#F5A623",
  transcription_completed:  "#2ECC71",
  cancelled:                "#E74C3C",
  attachment_added:         "#9B59B6",
};

const STATUS_LABEL = {
  order_submitted:          "Order submitted",
  in_progress:              "Transcription in progress",
  transcription_completed:  "Transcription complete",
  cancelled:                "Order cancelled",
  attachment_added:         "Attachment added",
};

function formatDuration(seconds) {
  if (!seconds) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildSlackPayload(event) {
  const { event: eventType, payload } = event;
  const order = payload?.order || payload || {};

  const emoji  = STATUS_EMOJI[eventType]  || "🔔";
  const color  = STATUS_COLOR[eventType]  || "#888888";
  const label  = STATUS_LABEL[eventType]  || eventType;

  const orderId   = order.id    || order.order_number || "—";
  const orderName = order.name  || order.title || "Untitled";
  const created   = order.created_on ? new Date(order.created_on).toLocaleString() : null;
  const duration  = formatDuration(order.duration_seconds);
  const wordCount = order.word_count;
  const revUrl    = order.id
    ? `https://www.rev.com/app/order/${order.id}`
    : null;

  // Context fields
  const fields = [];
  if (orderId)   fields.push({ type: "mrkdwn", text: `*Order ID*\n${orderId}` });
  if (created)   fields.push({ type: "mrkdwn", text: `*Submitted*\n${created}` });
  if (duration)  fields.push({ type: "mrkdwn", text: `*Duration*\n${duration}` });
  if (wordCount) fields.push({ type: "mrkdwn", text: `*Word count*\n${wordCount.toLocaleString()}` });

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} *${label}*\n${orderName}`,
      },
    },
  ];

  if (fields.length > 0) {
    blocks.push({ type: "section", fields });
  }

  if (revUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open in Rev", emoji: true },
          url: revUrl,
          action_id: "open_rev",
        },
      ],
    });
  }

  blocks.push({ type: "divider" });

  return {
    channel:     SLACK_CHANNEL,
    attachments: [
      {
        color,
        blocks,
        fallback: `${emoji} ${label}: ${orderName}`,
      },
    ],
  };
}

// ─── Post to Slack ────────────────────────────────────────────────────────────

function postToSlack(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url  = new URL(SLACK_WEBHOOK);

    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`Slack returned ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Webhook Endpoint ─────────────────────────────────────────────────────────

app.post("/webhook", async (req, res) => {
  // Verify signature
  if (!verifyRevSignature(req)) {
    console.warn("⚠️  Invalid Rev signature — rejecting request");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = req.body;
  const eventType = event?.event;

  console.log(`📨  Received Rev event: ${eventType}`);

  // Only handle known events
  const HANDLED_EVENTS = [
    "order_submitted",
    "in_progress",
    "transcription_completed",
    "cancelled",
    "attachment_added",
  ];

  if (!HANDLED_EVENTS.includes(eventType)) {
    console.log(`   Skipping unhandled event type: ${eventType}`);
    return res.status(200).json({ ok: true, skipped: true });
  }

  try {
    const slackPayload = buildSlackPayload(event);
    await postToSlack(slackPayload);
    console.log(`✅  Slack notified for event: ${eventType}`);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`❌  Failed to post to Slack:`, err.message);
    res.status(500).json({ error: "Failed to notify Slack" });
  }
});

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀  Rev→Slack webhook server running on port ${PORT}`);
  console.log(`   POST /webhook  — Rev.com webhook endpoint`);
  console.log(`   GET  /health   — Health check`);
});

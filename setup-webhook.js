#!/usr/bin/env node
// Usage: BOT_TOKEN=xxx node setup-webhook.js https://your-project.vercel.app

const https = require("https");

const TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.argv[2];

if (!TOKEN || !WEBHOOK_URL) {
  console.error("Usage: BOT_TOKEN=xxx node setup-webhook.js https://your-project.vercel.app");
  process.exit(1);
}

const url = `${WEBHOOK_URL}/api/webhook`;

const body = JSON.stringify({ url });
const options = {
  hostname: "api.telegram.org",
  path: `/bot${TOKEN}/setWebhook`,
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  },
};

const req = https.request(options, (res) => {
  let data = "";
  res.on("data", (c) => (data += c));
  res.on("end", () => {
    const r = JSON.parse(data);
    if (r.ok) {
      console.log(`✅ Webhook set successfully!`);
      console.log(`   URL: ${url}`);
    } else {
      console.error("❌ Error:", r.description);
    }
  });
});

req.on("error", console.error);
req.write(body);
req.end();

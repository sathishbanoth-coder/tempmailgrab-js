#!/usr/bin/env node
/**
 * Receive signed webhook deliveries and print the OTP from each one.
 *
 *   export TMG_WEBHOOK_SECRET=whsec_...   # returned once by tmg.webhooks.create(url)
 *   node examples/webhook-receiver.mjs
 *
 * Uses node:http so the example has no dependencies. The important part is the
 * body handling, which is the same in every framework: verify the RAW bytes
 * before parsing them.
 *
 * To try it end to end, expose this port with a tunnel (cloudflared, ngrok) and
 * register the public URL:
 *
 *   const { secret } = await tmg.webhooks.create('https://your-tunnel/hooks/mail');
 */
import { createServer } from 'node:http';
import { constructWebhookEvent, WebhookVerificationError } from '../dist/index.js';

const secret = process.env.TMG_WEBHOOK_SECRET;
if (!secret) {
  console.error('Set TMG_WEBHOOK_SECRET first (returned once by tmg.webhooks.create()).');
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 8787);

/** Message ids already handled, so a replayed delivery is a no-op. */
const processed = new Set();

const server = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end('method not allowed');
    return;
  }

  // Collect the raw bytes. Do NOT JSON.parse and re-stringify — the signature
  // is over these exact bytes, and re-serialising will not reproduce them.
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);

  let event;
  try {
    event = await constructWebhookEvent({
      payload: raw,
      signature: req.headers['x-tmg-signature'],
      secret,
      // Narrows the replay window. Not sufficient alone — see the id check below.
      toleranceSeconds: 300,
    });
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      // Log the reason for yourself; tell the caller nothing useful.
      console.warn(`rejected delivery: ${err.code}`);
      res.writeHead(400).end('bad signature');
      return;
    }
    throw err;
  }

  // This is what actually makes delivery idempotent. Webhooks can arrive twice
  // for ordinary reasons — a retry, a proxy — not only from an attacker.
  if (processed.has(event.data.id)) {
    console.log(`duplicate ${event.data.id}, ignored`);
    res.writeHead(200).end('ok');
    return;
  }
  processed.add(event.data.id);

  console.log(`\n  ${event.data.inbox_address}  ←  ${event.data.sender}`);
  console.log(`  Subject: ${event.data.subject ?? '(none)'}`);
  console.log(`  OTP:     ${event.data.extracted_otp ?? '(none found)'}`);
  for (const link of event.data.extracted_links) console.log(`  Link:    ${link}`);

  // Acknowledge quickly. Deliveries are best-effort and time out after 5s, so
  // do real work asynchronously rather than before responding.
  res.writeHead(200).end('ok');
});

server.listen(PORT, () => {
  console.log(`Listening for webhooks on http://localhost:${PORT}/`);
});

#!/usr/bin/env node
/**
 * Create a disposable inbox, wait for a message, print the OTP.
 *
 *   export TMG_API_KEY=tmg_live_...      # https://tempmailgrab.com/dashboard
 *   node examples/wait-for-otp.mjs
 *
 * The script prints an address and then blocks. Send mail to that address —
 * by hand from any mail client, or by pasting it into a real sign-up form —
 * and the code appears. Nothing is mocked; this talks to the live API.
 *
 * Run it against a local build with:
 *   npm run build && node examples/wait-for-otp.mjs
 */
import { TempMailGrab, TimeoutError, ApiError } from '../dist/index.js';

const apiKey = process.env.TMG_API_KEY;
if (!apiKey) {
  console.error('Set TMG_API_KEY first. Create a key at https://tempmailgrab.com/dashboard');
  process.exit(1);
}

// How long to wait for mail. Generous, because this example expects a human to
// go and send the message after reading the address off the terminal.
const TIMEOUT_MS = Number(process.env.TMG_TIMEOUT_MS ?? 180_000);

const tmg = new TempMailGrab({ apiKey });

// The prefix is only for legibility in logs — the client appends random entropy
// so two concurrent runs never collide on the same address.
const inbox = await tmg.createInbox({ prefix: 'example' });

console.log(`\n  Address:  ${inbox.address}`);
console.log(`  Inbox id: ${inbox.id}`);
console.log(`\n  Send an email to that address. Waiting up to ${TIMEOUT_MS / 1000}s…\n`);

// Ctrl-C should stop the poll loop promptly rather than waiting out the timeout.
const abort = new AbortController();
process.on('SIGINT', () => {
  console.log('\n  Interrupted.');
  abort.abort();
});

try {
  const otp = await inbox.waitForOtp({ timeout: TIMEOUT_MS, signal: abort.signal });
  console.log(`  OTP: ${otp}\n`);

  // waitForOtp resolves as soon as a code is found; re-reading the inbox shows
  // what else came with it — the sender, subject and any confirmation links.
  const [message] = await inbox.messages();
  if (message) {
    const full = await inbox.message(message.id);
    console.log(`  From:    ${full.sender}`);
    console.log(`  Subject: ${full.subject ?? '(none)'}`);
    if (full.extracted_links.length > 0) {
      console.log('  Links:');
      for (const link of full.extracted_links) console.log(`    ${link}`);
    }
    console.log();
  }
} catch (err) {
  if (err instanceof TimeoutError) {
    // messagesSeen separates "nothing was sent" from "mail arrived but had no
    // code in it", which are different bugs with different fixes.
    console.error(
      err.messagesSeen === 0
        ? `  Nothing arrived in ${err.waitedMs}ms. Was the mail actually sent?`
        : `  Saw ${err.messagesSeen} message(s) in ${err.waitedMs}ms, but none contained a code.`,
    );
    process.exitCode = 1;
  } else if (err instanceof ApiError && err.isAuthError) {
    console.error('  TMG_API_KEY was rejected. Check the key at https://tempmailgrab.com/dashboard');
    process.exitCode = 1;
  } else if (abort.signal.aborted) {
    process.exitCode = 130;
  } else {
    throw err;
  }
} finally {
  // Optional — every inbox expires on its own TTL. Done here so a run leaves
  // nothing behind, and because it demonstrates the call.
  await inbox.delete().catch(() => {});
}

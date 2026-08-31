# tempmailgrab

**Disposable email inboxes for automated tests.** Create a real inbox, wait for the email, read the one-time code — in three lines, with no IMAP server, no shared QA mailbox, and no regex over an HTML template.

[![CI](https://github.com/sathishbanoth-coder/tempmailgrab-js/actions/workflows/ci.yml/badge.svg)](https://github.com/sathishbanoth-coder/tempmailgrab-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/tempmailgrab.svg)](https://www.npmjs.com/package/tempmailgrab)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![zero dependencies](https://img.shields.io/badge/runtime_dependencies-0-brightgreen.svg)](./package.json)

```bash
npm i tempmailgrab
```

```ts
import { TempMailGrab } from 'tempmailgrab';

const tmg = new TempMailGrab({ apiKey: process.env.TMG_API_KEY! });

const inbox = await tmg.createInbox();
// → inbox.address = "a1b2c3d4e5f6@tempmailgrab.com", a real, working address

await signUpMyApp(inbox.address);

const code = await inbox.waitForOtp();   // → "448213"
```

Zero runtime dependencies. TypeScript types included. Node 20+.

---

## Why this exists

Every product has a flow that only works if an email actually arrives: sign-up confirmation, password reset, magic link, 2FA. They're the flows most likely to break in production and the least likely to be tested — because testing them is awkward.

The usual workarounds each fail in their own way:

| Approach | What goes wrong |
| --- | --- |
| **Shared QA mailbox** | Parallel tests compete for messages. Test A's code gets claimed by test B. Failures are non-deterministic and unreproducible. |
| **Mock the mail transport** | Tests your code, but not your templates, your ESP config, or deliverability — the parts that actually break. |
| **Read a real inbox over IMAP** | Credentials in CI, connection limits, and a mailbox that fills up and needs pruning. |

An inbox-per-test removes the shared resource entirely. Nothing to reset between runs, nothing to contend over.

## The part that saves the most code

The one-time code is extracted **server-side, at ingestion**, and arrives as a field:

```ts
const code = await inbox.waitForOtp();
```

Not this:

```ts
const html = await getLatestEmailSomehow();
const code = html.match(/verification code is (\d{6})/)?.[1];   // breaks when marketing edits the template
```

Same for verification links — `inbox.waitForLink()` returns the confirm URL without you parsing anchors out of a marketing layout.

---

## Playwright

A fixture that hands every test its own address:

```ts
// fixtures.ts
import { test as base } from '@playwright/test';
import { inboxFixture } from 'tempmailgrab/playwright';

export const test = base.extend(inboxFixture({ apiKey: process.env.TMG_API_KEY! }));
export { expect } from '@playwright/test';
```

```ts
// signup.spec.ts
import { test, expect } from './fixtures';

test('a new user can verify their email', async ({ page, inbox }) => {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(inbox.address);
  await page.getByRole('button', { name: 'Create account' }).click();

  await page.getByLabel('Verification code').fill(await inbox.waitForOtp());
  await page.getByRole('button', { name: 'Verify' }).click();

  await expect(page.getByText('Welcome')).toBeVisible();
});
```

Because the fixture is per-test, parallel workers hold different addresses and never see each other's mail. There's no `afterEach` — inboxes expire on their own.

## Cypress

```js
// cypress/support/commands.js
import { TempMailGrab } from 'tempmailgrab';

const tmg = new TempMailGrab({ apiKey: Cypress.env('TMG_API_KEY') });

Cypress.Commands.add('createInbox', () => cy.wrap(tmg.createInbox(), { log: false }));
Cypress.Commands.add('waitForOtp', (inbox) => cy.wrap(inbox.waitForOtp(), { timeout: 40000 }));
```

```js
// cypress/e2e/signup.cy.js
it('verifies a new account', () => {
  cy.createInbox().then((inbox) => {
    cy.visit('/signup');
    cy.get('[name=email]').type(inbox.address);
    cy.contains('Create account').click();

    cy.waitForOtp(inbox).then((code) => {
      cy.get('[name=code]').type(code);
      cy.contains('Verify').click();
      cy.contains('Welcome').should('be.visible');
    });
  });
});
```

## Vitest / Jest / anything else

It's a plain async API — no runner-specific magic:

```ts
test('password reset sends a working link', async () => {
  const inbox = await tmg.createInbox();
  await requestPasswordReset(inbox.address);

  const link = await inbox.waitForLink();
  expect(link).toContain('/reset?token=');
});
```

---

## API

### `new TempMailGrab(options)`

| Option | Type | Default | |
| --- | --- | --- | --- |
| `apiKey` | `string` | — | **Required.** Create one at [tempmailgrab.com/dashboard](https://tempmailgrab.com/dashboard) |
| `baseUrl` | `string` | `https://tempmailgrab.com` | Point at a self-hosted instance |
| `fetch` | `typeof fetch` | global | Inject a fetch (proxies, tests) |
| `requestTimeout` | `number` | `15000` | Per-request timeout, ms |
| `retries` | `number` | `2` | Retries on 5xx, 429, and network failures (see below). `0` disables |
| `retryBaseDelay` | `number` | `300` | Backoff base, ms. Grows exponentially with jitter |


### Retries

Transient failures are retried automatically — twice by default, with
exponential backoff and jitter. A `Retry-After` header on a 429 overrides the
backoff.

What gets retried depends on whether repeating the call is safe:

| Failure | Retried? |
| --- | --- |
| `5xx` response | Yes, any method — the server said it did not act |
| `429` response | Yes, any method — honours `Retry-After` |
| `4xx` response | No — repeating will not change the answer |
| Network error / timeout | Only `GET` and `DELETE` |

That last row is the important one. A transport failure leaves the outcome
unknown: the request may have reached the API and succeeded, with only the
response lost. Repeating a `POST` there could mint a second inbox, or register
a duplicate webhook that then fires twice for every message. So `createInbox()`
and webhook creation get exactly one attempt when the network itself fails.

```ts
const tmg = new TempMailGrab({ apiKey, retries: 4 });   // flaky CI network
const tmg = new TempMailGrab({ apiKey, retries: 0 });   // handle it yourself
```

### `tmg.createInbox(options?) → Promise<Inbox>`

| Option | Type | Notes |
| --- | --- | --- |
| `prefix` | `string` | Local part. Sanitised to `[a-z0-9]`, max 12 chars, plus a random suffix so parallel runs never collide |
| `domain` | `string` | Defaults to the primary domain |
| `ttlSeconds` | `number` | 600–259200 (10 min – 72 h). Default 24 h |

### `tmg.inbox(id) → Inbox`

Re-attach to an existing inbox with no network round-trip — useful when the id crosses a process boundary.

### `Inbox`

| Member | Returns | |
| --- | --- | --- |
| `.address` | `string` | The real email address. Put this in your form |
| `.id` / `.expiresAt` | `string` / `number` | |
| `.messages()` | `Message[]` | Newest first |
| `.message(id)` | `FullMessage` | Bodies, links, attachments |
| `.waitForOtp(opts?)` | `string` | The extracted one-time code |
| `.waitForLink(opts?)` | `string` | First verification/confirm URL |
| `.waitForMessage(predicate?, opts?)` | `Message` | First match |
| `.clear()` | `void` | Delete mail, keep the address |
| `.delete()` | `void` | Destroy it now (optional — it expires anyway) |

**Wait options:** `timeout` (default `30000` ms), `interval` (default `1000` ms), `signal` (`AbortSignal`).

### `tmg.webhooks`

`list()`, `create(url)` → `{ id, url, secret }`, `delete(id)`.

The secret is returned **once**, at creation. Store it.

---

## Webhooks

Instead of polling, have mail POSTed to you. Every delivery is signed with
HMAC-SHA256 over the raw body, in `X-TMG-Signature`.

```ts
import express from 'express';
import { constructWebhookEvent } from 'tempmailgrab';

const app = express();

// express.raw, NOT express.json — see the warning below.
app.post('/hooks/mail', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = await constructWebhookEvent({
      payload: req.body,                          // Buffer of the raw bytes
      signature: req.header('x-tmg-signature'),
      secret: process.env.TMG_WEBHOOK_SECRET!,
    });
  } catch {
    return res.status(400).send('bad signature'); // fail closed, don't say why
  }

  console.log(event.data.extracted_otp);          // "448213"
  console.log(event.data.extracted_links);        // ["https://…/confirm?t=…"]
  res.sendStatus(200);
});
```

> ⚠️ **Pass the raw body.** `JSON.stringify(req.body)` after your framework has
> parsed it does not reproduce the original bytes — key order, whitespace and
> unicode escaping all differ — so every legitimate delivery will fail to verify.
> Express: `express.raw({ type: 'application/json' })`. Next.js: read the request
> stream. Workers/Hono: `await c.req.text()` before `JSON.parse`.

| Export | Returns | Use when |
|---|---|---|
| `constructWebhookEvent(opts)` | `Promise<WebhookEvent>` | In a route. Verifies, parses, throws `WebhookVerificationError` on any failure. |
| `verifyWebhookSignature(opts)` | `Promise<boolean>` | You want to branch rather than catch. |
| `signWebhookPayload(secret, body)` | `Promise<string>` | Generating valid deliveries in your own tests. |

`WebhookVerificationError` carries a `code`: `missing_signature`,
`malformed_signature`, `signature_mismatch`, `invalid_json`, or
`timestamp_out_of_tolerance`. Log the code; return a bare 400 to the caller.

### Replay

The signature covers the body only — it does not bind the timestamp the way
Stripe's `t=`/`v1=` scheme does. `sent_at` sits inside the signed body so it
cannot be *altered*, but a captured delivery replayed byte-for-byte still carries
a valid signature, forever.

`toleranceSeconds` narrows that window by rejecting deliveries whose `sent_at` is
too far from now:

```ts
await constructWebhookEvent({ payload, signature, secret, toleranceSeconds: 300 });
```

It is off by default, because a strict clock check turns benign server clock skew
into dropped mail. It is also defence in depth rather than a guarantee — if
replay matters, record `event.data.id` and skip ids you have already processed.
That is the part that actually makes delivery idempotent.

---

## Errors

Typed, so you can branch on them:

```ts
import { ApiError, TimeoutError } from 'tempmailgrab';

try {
  const code = await inbox.waitForOtp({ timeout: 20_000 });
} catch (err) {
  if (err instanceof TimeoutError) {
    // messagesSeen tells you WHICH failure this is, without a second run:
    //   0  → nothing arrived; your app probably never sent it
    //  >0  → mail is being delivered, but none of it matched
    console.error(`gave up after ${err.waitedMs}ms, saw ${err.messagesSeen} message(s)`);
  }
  if (err instanceof ApiError && err.isRateLimited) await backOff();
  if (err instanceof ApiError && err.isAuthError) throw new Error('Check TMG_API_KEY');
}
```

## Notes

- **Rate limits are per key, not per IP** — a CI runner behind shared NAT gets its own budget.
- **Inboxes are isolated** — another key cannot read your mail.
- **No teardown required** — every inbox has a TTL and is purged with its messages.
- **Don't use temporary inboxes for anything you need to keep.** They're built to disappear.

## Examples

Runnable, no test framework required. Both talk to the real API.

```bash
npm run build

TMG_API_KEY=tmg_live_... node examples/wait-for-otp.mjs        # inbox → wait → print OTP
TMG_WEBHOOK_SECRET=whsec_... node examples/webhook-receiver.mjs # verify signed deliveries
```

## Links

- [Email Testing API guide](https://tempmailgrab.com/email-testing-api) — the longer write-up
- [API reference](https://tempmailgrab.com/api-docs) · [OpenAPI spec](https://tempmailgrab.com/api/openapi.json)
- [Playwright tutorial](https://tempmailgrab.com/blog/playwright-email-testing-tutorial) · [Cypress tutorial](https://tempmailgrab.com/blog/cypress-email-testing)

## License

MIT

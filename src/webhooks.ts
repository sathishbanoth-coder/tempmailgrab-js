import { TempMailGrabError } from './errors.js';
import type { WebhookEvent, VerifyWebhookOptions } from './types.js';

/** Thrown when a delivery fails verification. Never contains the secret. */
export class WebhookVerificationError extends TempMailGrabError {
  constructor(
    message: string,
    /** Machine-readable cause, for logging and tests. */
    readonly code:
      | 'missing_signature'
      | 'malformed_signature'
      | 'signature_mismatch'
      | 'invalid_json'
      | 'timestamp_out_of_tolerance',
  ) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

const HEX_64 = /^[0-9a-f]{64}$/i;

/**
 * Normalise the payload to bytes backed by a plain ArrayBuffer.
 *
 * The copy in the Uint8Array branch is deliberate: a view backed by a
 * SharedArrayBuffer is not a valid `BufferSource` for `crypto.subtle`, and
 * since TypeScript 5.7 `Uint8Array` is generic over its buffer type, so an
 * un-copied argument does not type-check either. The return type is left to
 * inference so this still compiles on TypeScript 5.6.
 */
function toBytes(payload: string | Uint8Array) {
  return typeof payload === 'string' ? new TextEncoder().encode(payload) : Uint8Array.from(payload);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time comparison of two equal-length hex strings.
 *
 * `a === b` on a signature leaks, through timing, how many leading characters an
 * attacker guessed correctly — which turns forging a signature into 64 cheap
 * sequential searches instead of one infeasible one. The length check before the
 * loop is safe to short-circuit: the length of a signature is not a secret.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Compute the signature TempMailGrab would send for `payload`.
 *
 * Exported mainly so you can generate valid deliveries in your own tests without
 * reimplementing the scheme. Verification should go through
 * {@link verifyWebhookSignature}, which compares in constant time.
 */
export async function signWebhookPayload(
  secret: string,
  payload: string | Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, toBytes(payload)));
}

/**
 * Verify an `X-TMG-Signature` header against the raw request body.
 *
 * The signature is a hex HMAC-SHA256 of the body bytes exactly as delivered.
 *
 * ⚠️ Pass the RAW body, not a re-serialised object. `JSON.stringify(req.body)`
 * after your framework has parsed it will not reproduce the original bytes —
 * key order, whitespace and unicode escaping all differ — and verification will
 * fail for every legitimate delivery. In Express use
 * `express.raw({ type: 'application/json' })`; in Next.js read the raw body from
 * the request stream; in a Worker use `await request.text()` before `JSON.parse`.
 *
 * Returns a boolean rather than throwing, so you can branch on it. Use
 * {@link constructWebhookEvent} when you want the parsed, typed event instead.
 */
export async function verifyWebhookSignature(options: {
  /** Raw request body, exactly as received. */
  payload: string | Uint8Array;
  /** The `X-TMG-Signature` header value. */
  signature: string | null | undefined;
  /** The signing secret returned once by `tmg.webhooks.create()`. */
  secret: string;
}): Promise<boolean> {
  const { payload, signature, secret } = options;
  if (!signature || !HEX_64.test(signature)) return false;
  const expected = await signWebhookPayload(secret, payload);
  return timingSafeEqualHex(expected, signature.toLowerCase());
}

/**
 * Verify a delivery and return the parsed event, or throw.
 *
 * This is the function to reach for in a webhook route: it fails closed, and
 * everything it returns has already been authenticated.
 *
 * ```ts
 * app.post('/hooks/mail', express.raw({ type: 'application/json' }), async (req, res) => {
 *   let event;
 *   try {
 *     event = await constructWebhookEvent({
 *       payload: req.body,                                 // a Buffer — raw bytes
 *       signature: req.header('x-tmg-signature'),
 *       secret: process.env.TMG_WEBHOOK_SECRET!,
 *     });
 *   } catch {
 *     return res.status(400).send('bad signature');        // do not leak why
 *   }
 *   console.log(event.data.extracted_otp);
 *   res.sendStatus(200);
 * });
 * ```
 *
 * ### On `toleranceSeconds`
 *
 * The signature covers the body only — it does not bind the timestamp the way
 * Stripe's `t=`/`v1=` scheme does. So `sent_at` is inside the signed body and
 * cannot be altered, but a captured delivery stays valid forever: replaying it
 * byte-for-byte reproduces a valid signature.
 *
 * Setting `toleranceSeconds` rejects deliveries whose `sent_at` is too old,
 * which narrows that window. It is defence in depth, not a cryptographic
 * guarantee, and it is off by default because a strict clock check turns benign
 * clock skew on your server into dropped mail. If replay matters to you, also
 * record `event.data.id` and ignore ids you have already processed — that is the
 * part that actually makes delivery idempotent.
 */
export async function constructWebhookEvent(
  options: VerifyWebhookOptions,
): Promise<WebhookEvent> {
  const { payload, signature, secret, toleranceSeconds } = options;

  if (!signature) {
    throw new WebhookVerificationError('Missing X-TMG-Signature header.', 'missing_signature');
  }
  if (!HEX_64.test(signature)) {
    throw new WebhookVerificationError(
      'X-TMG-Signature is not a 64-character hex digest.',
      'malformed_signature',
    );
  }

  const expected = await signWebhookPayload(secret, payload);
  if (!timingSafeEqualHex(expected, signature.toLowerCase())) {
    throw new WebhookVerificationError(
      'Signature does not match the request body. If legitimate deliveries fail ' +
        'here, you are almost certainly passing a re-serialised body instead of ' +
        'the raw bytes.',
      'signature_mismatch',
    );
  }

  const text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
  let event: WebhookEvent;
  try {
    event = JSON.parse(text) as WebhookEvent;
  } catch {
    throw new WebhookVerificationError('Body is not valid JSON.', 'invalid_json');
  }

  if (typeof toleranceSeconds === 'number') {
    const age = Math.floor(Date.now() / 1000) - event.sent_at;
    if (!Number.isFinite(event.sent_at) || Math.abs(age) > toleranceSeconds) {
      throw new WebhookVerificationError(
        `Delivery timestamp is ${age}s away from now, outside the ${toleranceSeconds}s tolerance.`,
        'timestamp_out_of_tolerance',
      );
    }
  }

  return event;
}

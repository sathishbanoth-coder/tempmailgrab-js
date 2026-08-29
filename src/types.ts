/** A message as it appears in an inbox listing. */
export interface Message {
  id: string;
  sender: string;
  subject: string | null;
  /** First ~140 characters of the plaintext body. */
  snippet: string;
  /**
   * The one-time code, extracted server-side at ingestion.
   *
   * This is the field that removes most email-test code: you are not writing a
   * regex over an HTML body that breaks the next time marketing edits the
   * template. `null` when the message contains no code-shaped value in a
   * verification context.
   */
  extracted_otp: string | null;
  /** Unix epoch seconds. */
  created_at: number;
}

/** A single message with its full body, attachments and extracted links. */
export interface FullMessage {
  id: string;
  sender: string;
  subject: string | null;
  text_body: string | null;
  /** Sanitized on the server: scripts, tracking pixels and remote images removed. */
  html_body: string | null;
  extracted_otp: string | null;
  /** Verification/confirmation URLs found in the body, deduped. */
  extracted_links: string[];
  raw_headers: string | null;
  /** Unix epoch seconds. */
  timestamp: number;
  attachments: Attachment[];
}

export interface Attachment {
  id: string;
  filename: string | null;
  content_type: string | null;
  size: number;
  /** Signed, time-limited download URL. */
  url: string;
}

export interface CreateInboxOptions {
  /**
   * Local part of the address. Sanitised to `[a-z0-9]`, max 12 characters, and a
   * short random suffix is appended so parallel runs never collide.
   */
  prefix?: string;
  /** Defaults to the service's primary domain. */
  domain?: string;
  /** 600–259200 (10 minutes to 72 hours). Defaults to 24 hours. */
  ttlSeconds?: number;
}

export interface WaitOptions {
  /** Give up after this many milliseconds. Default 30000. */
  timeout?: number;
  /** Delay between polls in milliseconds. Default 1000. */
  interval?: number;
  /** Abort the wait early (e.g. a test runner's signal). */
  signal?: AbortSignal;
}

export interface ClientOptions {
  /** API key. Create one at https://tempmailgrab.com/dashboard */
  apiKey: string;
  /** Override the API origin. Defaults to https://tempmailgrab.com */
  baseUrl?: string;
  /** Inject a fetch implementation (useful for tests and proxies). */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in milliseconds. Default 15000. */
  requestTimeout?: number;
  /**
   * How many times to retry a failed request. Default 2 (so three attempts).
   *
   * Retries cover 5xx responses, 429s, and — for idempotent methods only —
   * network failures. Set to 0 to disable. See TempMailGrab.request for why the
   * idempotency distinction matters.
   */
  retries?: number;
  /**
   * Base delay for retry backoff, in milliseconds. Default 300.
   *
   * Grows exponentially with jitter: roughly 300ms, then 600ms. A `Retry-After`
   * header on a 429 overrides it.
   */
  retryBaseDelay?: number;
}

export interface Webhook {
  id: string;
  url: string;
  created_at: number;
}

/**
 * The email payload inside a webhook delivery.
 *
 * Mirrors `FullMessage` but is delivered rather than polled, and omits
 * attachments — fetch those with `inbox.getMessage(id)` if you need them.
 */
export interface WebhookEmailPayload {
  id: string;
  inbox_address: string;
  sender: string;
  subject: string | null;
  text_body: string | null;
  /** Sanitized server-side: scripts, tracking pixels and remote images removed. */
  html_body: string | null;
  /** The one-time code, extracted at ingestion. `null` when none was found. */
  extracted_otp: string | null;
  /** Verification/confirmation URLs found in the body, deduped. */
  extracted_links: string[];
  /** Unix epoch seconds. */
  timestamp: number;
}

/** The full JSON envelope POSTed to a webhook URL. */
export interface WebhookEvent {
  event: 'email.received';
  /** Unix epoch seconds at which the delivery was sent. */
  sent_at: number;
  data: WebhookEmailPayload;
}

export interface VerifyWebhookOptions {
  /**
   * Raw request body, exactly as received — a string or the raw bytes.
   * A re-serialised object will not verify. See `constructWebhookEvent`.
   */
  payload: string | Uint8Array;
  /** The `X-TMG-Signature` header value. */
  signature: string | null | undefined;
  /** The signing secret returned once by `tmg.webhooks.create()`. */
  secret: string;
  /**
   * Reject deliveries whose `sent_at` is more than this many seconds from now.
   * Off by default; see `constructWebhookEvent` for why.
   */
  toleranceSeconds?: number;
}

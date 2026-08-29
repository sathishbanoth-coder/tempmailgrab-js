import { ApiError, TempMailGrabError } from './errors.js';
import { Inbox, type Transport } from './inbox.js';
import type { ClientOptions, CreateInboxOptions, Webhook } from './types.js';

const DEFAULT_BASE_URL = 'https://tempmailgrab.com';
const DEFAULT_REQUEST_TIMEOUT = 15_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY = 300;

const PREFIX_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Make a caller-supplied prefix collision-proof.
 *
 * Addresses are globally unique, and the API returns 409 if one is taken. So a
 * bare `createInbox({ prefix: 'signup' })` works exactly once: the moment two
 * Playwright workers — or two CI jobs, or one re-run — ask for the same prefix,
 * the second fails. That is precisely the non-deterministic flakiness this
 * library exists to remove, so the prefix is always suffixed with random
 * entropy and kept readable for debugging: "signup" -> "signup-k3f9qa".
 *
 * Sanitised to the character set the API accepts, and kept well inside its
 * 32-character limit.
 */
export function uniquePrefix(prefix: string): string {
  const base = prefix.trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (b) => PREFIX_CHARS[b % PREFIX_CHARS.length]).join('');
  return base ? `${base}-${suffix}` : suffix;
}

/**
 * TempMailGrab API client.
 *
 * ```ts
 * const tmg = new TempMailGrab({ apiKey: process.env.TMG_API_KEY! });
 * const inbox = await tmg.createInbox();
 * // …use inbox.address in your app…
 * const code = await inbox.waitForOtp();
 * ```
 */
export class TempMailGrab implements Transport {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeout: number;
  private readonly retries: number;
  private readonly retryBaseDelay: number;

  constructor(options: ClientOptions) {
    if (!options?.apiKey) {
      throw new TempMailGrabError(
        'An apiKey is required. Create one at https://tempmailgrab.com/dashboard',
      );
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
    this.retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
    this.retryBaseDelay = Math.max(0, options.retryBaseDelay ?? DEFAULT_RETRY_BASE_DELAY);

    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') {
      throw new TempMailGrabError(
        'No fetch implementation found. Use Node 18+, or pass one via the `fetch` option.',
      );
    }
    // Bound so undici's fetch keeps its `this` when called as a property.
    this.fetchImpl = f.bind(globalThis);
  }

  /**
   * Create a fresh disposable inbox.
   *
   * Give every test its own — that is the whole advantage over a shared QA
   * mailbox, where two concurrent tests can claim each other's verification mail
   * and fail non-deterministically.
   */
  async createInbox(options: CreateInboxOptions = {}): Promise<Inbox> {
    const body: Record<string, unknown> = {};
    if (options.prefix) body.prefix = uniquePrefix(options.prefix);
    if (options.domain) body.domain = options.domain;
    if (options.ttlSeconds != null) body.ttl_seconds = options.ttlSeconds;

    const created = await this.request<{ id: string; address: string; expires_at: number }>(
      'POST',
      '/api/v1/inbox',
      body,
    );
    return new Inbox(this, created.id, created.address, created.expires_at);
  }

  /**
   * Re-attach to an inbox you already created, without a network round-trip.
   * Useful when the id was created in one process and used in another.
   */
  inbox(id: string, address = '', expiresAt = 0): Inbox {
    return new Inbox(this, id, address, expiresAt);
  }

  /** Account-level webhooks — fire for every inbox this key owns. */
  readonly webhooks = {
    list: async (): Promise<Webhook[]> => {
      const res = await this.request<{ webhooks: Webhook[] }>('GET', '/api/v1/webhooks');
      return res.webhooks ?? [];
    },
    /** Returns the signing secret ONCE — store it to verify X-TMG-Signature. */
    create: async (url: string): Promise<{ id: string; url: string; secret: string }> =>
      this.request('POST', '/api/v1/webhooks', { url }),
    delete: async (id: string): Promise<void> => {
      await this.request('DELETE', `/api/v1/webhooks/${encodeURIComponent(id)}`);
    },
  };

  /**
   * Pause before the next attempt.
   *
   * Exponential with jitter. The jitter matters more than it looks: a CI matrix
   * that starts twenty jobs at once will have all twenty hit a blip together,
   * and without jitter all twenty would then retry in lockstep and hammer the
   * API at exactly the same instants.
   *
   * A `Retry-After` on a 429 is the server stating what it wants, so it wins —
   * capped, so a pathological value cannot hang a test run.
   */
  private async backoff(attempt: number, retryAfter?: string | null): Promise<void> {
    const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
    const ms =
      Number.isFinite(seconds) && seconds >= 0
        ? Math.min(seconds * 1000, 30_000)
        : this.retryBaseDelay * 2 ** attempt + Math.random() * this.retryBaseDelay;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** @internal — the Transport contract Inbox depends on. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    // Whether repeating this call is safe when we do not know if it landed.
    //
    // A 5xx or 429 is the server telling us it did NOT act, so repeating is
    // safe for any method. A network failure or timeout is different: the
    // request may well have reached the API and succeeded, with only the
    // response lost. Repeating a POST there could mint a second inbox, or a
    // duplicate webhook that then fires twice for every message. So transport
    // failures are only retried for methods that can be repeated harmlessly.
    const repeatable = method === 'GET' || method === 'DELETE' || method === 'HEAD';

    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < this.retries;
      let res: Response;

      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          // Rebuilt per attempt — a timeout signal is already spent once it fires.
          signal: AbortSignal.timeout(this.requestTimeout),
        });
      } catch (err) {
        if (canRetry && repeatable) {
          await this.backoff(attempt);
          continue;
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new TempMailGrabError(`${method} ${path} could not reach the API: ${reason}`);
      }

      if (canRetry && (res.status >= 500 || res.status === 429)) {
        await this.backoff(attempt, res.headers.get('retry-after'));
        continue;
      }

      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = text;
      }

      if (!res.ok) {
        const detail =
          parsed && typeof parsed === 'object' && 'error' in parsed
            ? String((parsed as { error: unknown }).error)
            : text.slice(0, 300);
        throw new ApiError(res.status, detail, `${method} ${path}`);
      }
      return parsed as T;
    }
  }
}

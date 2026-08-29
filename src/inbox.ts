import { TimeoutError } from './errors.js';
import type { FullMessage, Message, WaitOptions } from './types.js';

/** Internal transport contract, so Inbox does not depend on the client class. */
export interface Transport {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_INTERVAL = 1_000;

/**
 * A live disposable inbox.
 *
 * The `waitFor*` methods are the point of this library: they turn "poll an API
 * until an email shows up, then dig a code out of it" — the awkward part of
 * every email test — into a single awaited call.
 */
export class Inbox {
  constructor(
    private readonly transport: Transport,
    /** Opaque inbox id, used for every API call. */
    readonly id: string,
    /** The real, working email address. Put this in your sign-up form. */
    readonly address: string,
    /** Unix epoch seconds at which this inbox and its mail are deleted. */
    readonly expiresAt: number,
  ) {}

  /** Every message currently in the inbox, newest first. */
  async messages(): Promise<Message[]> {
    const res = await this.transport.request<{ messages: Message[] }>(
      'GET',
      `/api/v1/inbox/${encodeURIComponent(this.id)}/messages`,
    );
    return res.messages ?? [];
  }

  /** One message with its full body, attachments and extracted links. */
  async message(messageId: string): Promise<FullMessage> {
    return this.transport.request<FullMessage>(
      'GET',
      `/api/v1/inbox/${encodeURIComponent(this.id)}/messages/${encodeURIComponent(messageId)}`,
    );
  }

  /**
   * Wait for a message, optionally matching a predicate.
   *
   * ```ts
   * const welcome = await inbox.waitForMessage((m) => m.subject?.includes('Welcome'));
   * ```
   */
  async waitForMessage(
    predicate: (message: Message) => boolean = () => true,
    options: WaitOptions = {},
  ): Promise<Message> {
    const found = await this.poll(
      (messages) => messages.find(predicate),
      options,
      'No matching message arrived',
    );
    return found;
  }

  /**
   * Wait for a one-time code and return it.
   *
   * The code is extracted server-side when the mail is received, so this does not
   * parse the body client-side and does not break when the template changes.
   */
  async waitForOtp(options: WaitOptions = {}): Promise<string> {
    const message = await this.poll(
      (messages) => messages.find((m) => m.extracted_otp),
      options,
      'No message containing a one-time code arrived',
    );
    // Narrowed by the predicate above.
    return message.extracted_otp as string;
  }

  /**
   * Wait for a verification/confirmation link and return the first one.
   *
   * Requires a second request per candidate message, because links live on the
   * full message rather than the listing.
   */
  async waitForLink(options: WaitOptions = {}): Promise<string> {
    const deadline = Date.now() + (options.timeout ?? DEFAULT_TIMEOUT);
    const interval = options.interval ?? DEFAULT_INTERVAL;
    const seen = new Set<string>();
    let count = 0;

    while (Date.now() < deadline) {
      throwIfAborted(options.signal);
      const messages = await this.messages();
      count = messages.length;
      for (const summary of messages) {
        if (seen.has(summary.id)) continue;
        seen.add(summary.id);
        const full = await this.message(summary.id);
        if (full.extracted_links.length > 0) return full.extracted_links[0];
      }
      await sleep(interval, options.signal);
    }

    throw new TimeoutError(
      `No message containing a verification link arrived at ${this.address} within ${
        options.timeout ?? DEFAULT_TIMEOUT
      }ms`,
      count,
      options.timeout ?? DEFAULT_TIMEOUT,
    );
  }

  /** Delete every message but keep the address alive. */
  async clear(): Promise<void> {
    await this.transport.request('DELETE', `/api/v1/inbox/${encodeURIComponent(this.id)}/messages`);
  }

  /**
   * Destroy the inbox and its mail immediately.
   *
   * Optional — every inbox expires on its own, so tests do not need teardown.
   * Use it to keep a long-lived key's inbox list tidy.
   */
  async delete(): Promise<void> {
    await this.transport.request('DELETE', `/api/v1/inbox/${encodeURIComponent(this.id)}`);
  }

  /** Shared polling loop for the waitFor* helpers. */
  private async poll(
    pick: (messages: Message[]) => Message | undefined,
    options: WaitOptions,
    what: string,
  ): Promise<Message> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const interval = options.interval ?? DEFAULT_INTERVAL;
    const startedAt = Date.now();
    const deadline = startedAt + timeout;
    let count = 0;

    while (Date.now() < deadline) {
      throwIfAborted(options.signal);
      const messages = await this.messages();
      count = messages.length;
      const hit = pick(messages);
      if (hit) return hit;
      await sleep(interval, options.signal);
    }

    throw new TimeoutError(
      `${what} at ${this.address} within ${timeout}ms` +
        (count > 0
          ? ` — ${count} other message(s) did arrive, so delivery works but none matched.`
          : ' — nothing arrived at all, so check that your app actually sent it.'),
      count,
      Date.now() - startedAt,
    );
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TimeoutError('Wait aborted', 0, 0);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new TimeoutError('Wait aborted', 0, 0));
      },
      { once: true },
    );
  });
}

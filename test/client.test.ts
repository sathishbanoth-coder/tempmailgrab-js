import { describe, it, expect } from 'vitest';
import { TempMailGrab, ApiError, TimeoutError, TempMailGrabError } from '../src/index.js';
import type { Message } from '../src/index.js';

/** Build a fake fetch that replays queued responses and records the requests. */
function fakeFetch(handlers: Array<(url: string, init: RequestInit) => unknown>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  let i = 0;
  const impl = async (url: string | URL, init: RequestInit = {}) => {
    const handler = handlers[Math.min(i, handlers.length - 1)];
    i += 1;
    calls.push({
      method: init.method ?? 'GET',
      url: String(url),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const result = handler(String(url), init);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

const message = (over: Partial<Message> = {}): Message => ({
  id: 'msg-1',
  sender: 'no-reply@app.test',
  subject: 'Confirm your account',
  snippet: 'Your code is 123456',
  extracted_otp: null,
  created_at: 1_700_000_000,
  ...over,
});

const INBOX = { id: 'inb_1', address: 'ci-1@tempmailgrab.com', expires_at: 1_700_003_600 };

describe('constructor', () => {
  it('requires an api key, and says where to get one', () => {
    expect(() => new TempMailGrab({ apiKey: '' })).toThrow(TempMailGrabError);
    expect(() => new TempMailGrab({ apiKey: '' })).toThrow(/dashboard/);
  });

  it('accepts an injected fetch, so it is testable without a network', () => {
    const { impl } = fakeFetch([() => INBOX]);
    expect(() => new TempMailGrab({ apiKey: 'k', fetch: impl })).not.toThrow();
  });
});

describe('createInbox', () => {
  it('authenticates with a bearer token and returns a live inbox', async () => {
    const { impl, calls } = fakeFetch([() => INBOX]);
    const tmg = new TempMailGrab({ apiKey: 'secret-key', fetch: impl });
    const inbox = await tmg.createInbox();

    expect(inbox.address).toBe('ci-1@tempmailgrab.com');
    expect(inbox.id).toBe('inb_1');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://tempmailgrab.com/api/v1/inbox');
  });

  it('maps ttlSeconds to the API field name', async () => {
    const { impl, calls } = fakeFetch([() => INBOX]);
    const tmg = new TempMailGrab({ apiKey: 'k', fetch: impl });
    await tmg.createInbox({ prefix: 'ci', ttlSeconds: 600 });
    const body = calls[0].body as { prefix: string; ttl_seconds: number };
    expect(body.ttl_seconds).toBe(600);
    // The prefix is suffixed for collision safety — see the dedicated block below.
    expect(body.prefix).toMatch(/^ci-[a-z0-9]{6}$/);
  });

  it('honours a custom baseUrl', async () => {
    const { impl, calls } = fakeFetch([() => INBOX]);
    const tmg = new TempMailGrab({ apiKey: 'k', fetch: impl, baseUrl: 'http://localhost:8787/' });
    await tmg.createInbox();
    expect(calls[0].url).toBe('http://localhost:8787/api/v1/inbox');
  });
});

describe('errors', () => {
  it('raises a typed ApiError that identifies auth problems', async () => {
    const { impl } = fakeFetch([
      () => new Response(JSON.stringify({ error: 'Invalid API key' }), { status: 401 }),
    ]);
    const tmg = new TempMailGrab({ apiKey: 'bad', fetch: impl });

    await expect(tmg.createInbox()).rejects.toBeInstanceOf(ApiError);
    const err = (await tmg.createInbox().catch((e) => e)) as ApiError;
    expect(err.status).toBe(401);
    expect(err.isAuthError).toBe(true);
    expect(err.isRateLimited).toBe(false);
    expect(err.detail).toBe('Invalid API key');
  });

  it('flags rate limiting distinctly, so callers can back off', async () => {
    const { impl } = fakeFetch([
      () => new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429 }),
    ]);
    const tmg = new TempMailGrab({ apiKey: 'k', fetch: impl });
    const err = (await tmg.createInbox().catch((e) => e)) as ApiError;
    expect(err.isRateLimited).toBe(true);
    expect(err.isAuthError).toBe(false);
  });

  it('wraps network failures rather than leaking fetch internals', async () => {
    const impl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const tmg = new TempMailGrab({ apiKey: 'k', fetch: impl });
    await expect(tmg.createInbox()).rejects.toThrow(/could not reach the API/);
  });
});

describe('waitForOtp', () => {
  it('returns the server-extracted code', async () => {
    const { impl } = fakeFetch([
      () => INBOX,
      () => ({ messages: [] }),
      () => ({ messages: [message({ extracted_otp: '123456' })] }),
    ]);
    const tmg = new TempMailGrab({ apiKey: 'k', fetch: impl });
    const inbox = await tmg.createInbox();
    const otp = await inbox.waitForOtp({ interval: 1, timeout: 2000 });
    expect(otp).toBe('123456');
  });

  it('ignores messages that carry no code', async () => {
    const { impl } = fakeFetch([
      () => INBOX,
      () => ({ messages: [message({ id: 'a', extracted_otp: null })] }),
      () => ({
        messages: [message({ id: 'a' }), message({ id: 'b', extracted_otp: '999111' })],
      }),
    ]);
    const tmg = new TempMailGrab({ apiKey: 'k', fetch: impl });
    const inbox = await tmg.createInbox();
    expect(await inbox.waitForOtp({ interval: 1, timeout: 2000 })).toBe('999111');
  });

  it('times out with a message that distinguishes "nothing sent" from "wrong message"', async () => {
    // Nothing arrived at all.
    const empty = fakeFetch([() => INBOX, () => ({ messages: [] })]);
    const a = new TempMailGrab({ apiKey: 'k', fetch: empty.impl });
    const inboxA = await a.createInbox();
    const errA = (await inboxA.waitForOtp({ interval: 1, timeout: 30 }).catch((e) => e)) as TimeoutError;
    expect(errA).toBeInstanceOf(TimeoutError);
    expect(errA.message).toMatch(/nothing arrived at all/);
    expect(errA.messagesSeen).toBe(0);

    // Mail arrived, just no code — a genuinely different bug.
    const other = fakeFetch([() => INBOX, () => ({ messages: [message()] })]);
    const b = new TempMailGrab({ apiKey: 'k', fetch: other.impl });
    const inboxB = await b.createInbox();
    const errB = (await inboxB.waitForOtp({ interval: 1, timeout: 30 }).catch((e) => e)) as TimeoutError;
    expect(errB.message).toMatch(/delivery works but none matched/);
    expect(errB.messagesSeen).toBe(1);
  });

  it('can be aborted', async () => {
    const { impl } = fakeFetch([() => INBOX, () => ({ messages: [] })]);
    const tmg = new TempMailGrab({ apiKey: 'k', fetch: impl });
    const inbox = await tmg.createInbox();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    await expect(
      inbox.waitForOtp({ interval: 50, timeout: 5000, signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
  });
});

describe('waitForMessage', () => {
  it('matches on a predicate', async () => {
    const { impl } = fakeFetch([
      () => INBOX,
      () => ({
        messages: [message({ id: 'x', subject: 'Newsletter' }), message({ id: 'y', subject: 'Welcome aboard' })],
      }),
    ]);
    const tmg = new TempMailGrab({ apiKey: 'k', fetch: impl });
    const inbox = await tmg.createInbox();
    const hit = await inbox.waitForMessage((m) => (m.subject ?? '').includes('Welcome'), {
      interval: 1,
      timeout: 500,
    });
    expect(hit.id).toBe('y');
  });
});

describe('waitForLink', () => {
  it('fetches the full message and returns the first verification link', async () => {
    const { impl } = fakeFetch([
      () => INBOX,
      () => ({ messages: [message({ id: 'm9' })] }),
      () => ({
        id: 'm9',
        sender: 'a@b.test',
        subject: 's',
        text_body: null,
        html_body: null,
        extracted_otp: null,
        extracted_links: ['https://app.test/verify?t=abc'],
        raw_headers: null,
        timestamp: 1,
        attachments: [],
      }),
    ]);
    const tmg = new TempMailGrab({ apiKey: 'k', fetch: impl });
    const inbox = await tmg.createInbox();
    expect(await inbox.waitForLink({ interval: 1, timeout: 2000 })).toBe(
      'https://app.test/verify?t=abc',
    );
  });
});

describe('lifecycle', () => {
  it('deletes an inbox', async () => {
    const { impl, calls } = fakeFetch([() => INBOX, () => ({ deleted: true })]);
    const tmg = new TempMailGrab({ apiKey: 'k', fetch: impl });
    const inbox = await tmg.createInbox();
    await inbox.delete();
    expect(calls[1].method).toBe('DELETE');
    expect(calls[1].url).toBe('https://tempmailgrab.com/api/v1/inbox/inb_1');
  });

  it('re-attaches to an existing inbox without a request', async () => {
    const { impl, calls } = fakeFetch([() => ({ messages: [] })]);
    const tmg = new TempMailGrab({ apiKey: 'k', fetch: impl });
    const inbox = tmg.inbox('inb_existing');
    expect(calls).toHaveLength(0);
    await inbox.messages();
    expect(calls[0].url).toContain('inb_existing');
  });
});

describe('webhooks', () => {
  it('creates one and surfaces the signing secret', async () => {
    const { impl } = fakeFetch([() => ({ id: 'wh_1', url: 'https://x.test/h', secret: 'whsec_1' })]);
    const tmg = new TempMailGrab({ apiKey: 'k', fetch: impl });
    const wh = await tmg.webhooks.create('https://x.test/h');
    expect(wh.secret).toBe('whsec_1');
  });

  it('lists them', async () => {
    const { impl } = fakeFetch([() => ({ webhooks: [{ id: 'wh_1', url: 'u', created_at: 1 }] })]);
    const tmg = new TempMailGrab({ apiKey: 'k', fetch: impl });
    expect(await tmg.webhooks.list()).toHaveLength(1);
  });
});

describe('prefix collision safety', () => {
  // Addresses are globally unique and the API 409s on a taken one, so a bare
  // prefix works exactly once. Two parallel workers asking for the same prefix
  // is the flakiness this library exists to remove — the suffix is not cosmetic.
  it('appends entropy to a caller-supplied prefix', async () => {
    const { impl, calls } = fakeFetch([() => INBOX]);
    const tmg = new TempMailGrab({ apiKey: 'k', fetch: impl });
    await tmg.createInbox({ prefix: 'signup' });
    const sent = (calls[0].body as { prefix: string }).prefix;
    expect(sent).toMatch(/^signup-[a-z0-9]{6}$/);
  });

  it('produces a different address for concurrent callers using one prefix', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { impl, calls } = fakeFetch([() => INBOX]);
      const tmg = new TempMailGrab({ apiKey: 'k', fetch: impl });
      await tmg.createInbox({ prefix: 'signup' });
      seen.add((calls[0].body as { prefix: string }).prefix);
    }
    expect(seen.size).toBe(50);
  });

  it('sanitises characters the API would reject', async () => {
    const { impl, calls } = fakeFetch([() => INBOX]);
    const tmg = new TempMailGrab({ apiKey: 'k', fetch: impl });
    await tmg.createInbox({ prefix: 'My Test!! <User>' });
    const sent = (calls[0].body as { prefix: string }).prefix;
    expect(sent).toMatch(/^mytestuser-[a-z0-9]{6}$/);
  });

  it('stays inside the API 32-character limit even for long prefixes', async () => {
    const { impl, calls } = fakeFetch([() => INBOX]);
    const tmg = new TempMailGrab({ apiKey: 'k', fetch: impl });
    await tmg.createInbox({ prefix: 'a'.repeat(80) });
    const sent = (calls[0].body as { prefix: string }).prefix;
    expect(sent.length).toBeLessThanOrEqual(32);
  });

  it('omits the prefix entirely when none is given, letting the server pick', async () => {
    const { impl, calls } = fakeFetch([() => INBOX]);
    const tmg = new TempMailGrab({ apiKey: 'k', fetch: impl });
    await tmg.createInbox();
    expect(calls[0].body).toEqual({});
  });
});

describe('retries', () => {
  /** Fast backoff so the suite does not actually sleep. */
  const fast = { apiKey: 'k', retryBaseDelay: 0 };

  it('retries a 5xx and succeeds on a later attempt', async () => {
    const { impl, calls } = fakeFetch([
      () => new Response(JSON.stringify({ error: 'upstream' }), { status: 503 }),
      () => INBOX,
    ]);
    const tmg = new TempMailGrab({ ...fast, fetch: impl });
    const inbox = await tmg.createInbox();
    expect(inbox.address).toBe(INBOX.address);
    expect(calls).toHaveLength(2);
  });

  it('retries a 429 and succeeds', async () => {
    const { impl, calls } = fakeFetch([
      () => new Response(JSON.stringify({ error: 'slow down' }), { status: 429 }),
      () => INBOX,
    ]);
    const tmg = new TempMailGrab({ ...fast, fetch: impl });
    await tmg.createInbox();
    expect(calls).toHaveLength(2);
  });

  it('does not retry a 4xx, because repeating will not change the answer', async () => {
    const { impl, calls } = fakeFetch([
      () => new Response(JSON.stringify({ error: 'Invalid API key' }), { status: 401 }),
    ]);
    const tmg = new TempMailGrab({ ...fast, fetch: impl });
    await expect(tmg.createInbox()).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });

  it('gives up after the configured number of retries', async () => {
    const { impl, calls } = fakeFetch([
      () => new Response(JSON.stringify({ error: 'still broken' }), { status: 500 }),
    ]);
    const tmg = new TempMailGrab({ ...fast, retries: 3, fetch: impl });
    const err = (await tmg.createInbox().catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(calls).toHaveLength(4); // the original attempt plus three retries
  });

  it('can be turned off entirely', async () => {
    const { impl, calls } = fakeFetch([
      () => new Response(JSON.stringify({ error: 'upstream' }), { status: 503 }),
      () => INBOX,
    ]);
    const tmg = new TempMailGrab({ ...fast, retries: 0, fetch: impl });
    await expect(tmg.createInbox()).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });

  it('retries a network failure for an idempotent request', async () => {
    let n = 0;
    const impl = (async () => {
      n += 1;
      if (n === 1) throw new Error('ECONNRESET');
      return new Response(JSON.stringify({ webhooks: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;
    const tmg = new TempMailGrab({ ...fast, fetch: impl });
    await expect(tmg.webhooks.list()).resolves.toEqual([]);
    expect(n).toBe(2);
  });

  it('does NOT retry a network failure on a POST', async () => {
    // The decisive case. A transport failure leaves the outcome unknown: the
    // request may have reached the API and succeeded with only the reply lost.
    // Repeating it would mint a second inbox, or a duplicate webhook that then
    // fires twice for every message. One attempt only.
    let n = 0;
    const impl = (async () => {
      n += 1;
      throw new Error('ECONNRESET');
    }) as unknown as typeof globalThis.fetch;
    const tmg = new TempMailGrab({ ...fast, fetch: impl });
    await expect(tmg.createInbox()).rejects.toThrow(/could not reach the API/);
    expect(n).toBe(1);
  });

  it('honours Retry-After over its own backoff', async () => {
    const started = Date.now();
    const { impl } = fakeFetch([
      () =>
        new Response(JSON.stringify({ error: 'slow down' }), {
          status: 429,
          headers: { 'retry-after': '0' },
        }),
      () => INBOX,
    ]);
    // A large base delay would dominate if Retry-After were ignored.
    const tmg = new TempMailGrab({ apiKey: 'k', retryBaseDelay: 10_000, fetch: impl });
    await tmg.createInbox();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

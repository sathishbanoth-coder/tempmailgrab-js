import { describe, it, expect } from 'vitest';
import {
  verifyWebhookSignature,
  constructWebhookEvent,
  signWebhookPayload,
  WebhookVerificationError,
} from '../src/webhooks.js';
import type { WebhookEvent } from '../src/types.js';

const SECRET = 'whsec_5f3a9c1e8b2d47a6';

/** Build the exact envelope the Worker sends (src/api/webhooks.ts). */
function envelope(overrides: Partial<WebhookEvent['data']> = {}, sentAt?: number): string {
  return JSON.stringify({
    event: 'email.received',
    sent_at: sentAt ?? Math.floor(Date.now() / 1000),
    data: {
      id: 'msg_01HTEST',
      inbox_address: 'signup-k3f9qa@tempmailgrab.com',
      sender: 'no-reply@example.com',
      subject: 'Your verification code',
      text_body: 'Your code is 448213. It expires in 10 minutes.',
      html_body: null,
      extracted_otp: '448213',
      extracted_links: ['https://example.com/confirm?t=abc'],
      timestamp: 1756400000,
      ...overrides,
    },
  });
}

/**
 * Independent reimplementation of the server's scheme, so these tests would
 * catch the SDK and the Worker drifting apart rather than agreeing on a shared
 * mistake. Mirrors worker/src/api/webhooks.ts hmacHex().
 */
async function serverSign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('signWebhookPayload', () => {
  it('matches the Worker signing scheme byte for byte', async () => {
    const body = envelope();
    expect(await signWebhookPayload(SECRET, body)).toBe(await serverSign(SECRET, body));
  });

  it('produces a 64-character lowercase hex digest', async () => {
    expect(await signWebhookPayload(SECRET, 'x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifyWebhookSignature', () => {
  it('accepts a genuine delivery', async () => {
    const body = envelope();
    const signature = await serverSign(SECRET, body);
    expect(await verifyWebhookSignature({ payload: body, signature, secret: SECRET })).toBe(true);
  });

  it('accepts raw bytes as well as a string', async () => {
    const body = envelope();
    const signature = await serverSign(SECRET, body);
    const bytes = new TextEncoder().encode(body);
    expect(await verifyWebhookSignature({ payload: bytes, signature, secret: SECRET })).toBe(true);
  });

  it('is case-insensitive about the hex digest', async () => {
    const body = envelope();
    const signature = (await serverSign(SECRET, body)).toUpperCase();
    expect(await verifyWebhookSignature({ payload: body, signature, secret: SECRET })).toBe(true);
  });

  it('rejects a body tampered with after signing', async () => {
    const signature = await serverSign(SECRET, envelope());
    const tampered = envelope({ extracted_otp: '000000' });
    expect(await verifyWebhookSignature({ payload: tampered, signature, secret: SECRET })).toBe(
      false,
    );
  });

  it('rejects a signature made with a different secret', async () => {
    const body = envelope();
    const signature = await serverSign('whsec_attacker', body);
    expect(await verifyWebhookSignature({ payload: body, signature, secret: SECRET })).toBe(false);
  });

  it('rejects a missing or malformed signature instead of throwing', async () => {
    const body = envelope();
    for (const signature of [null, undefined, '', 'not-hex', 'ab12']) {
      expect(await verifyWebhookSignature({ payload: body, signature, secret: SECRET })).toBe(false);
    }
  });
});

describe('constructWebhookEvent', () => {
  it('returns the typed event on a valid delivery', async () => {
    const body = envelope();
    const signature = await serverSign(SECRET, body);
    const event = await constructWebhookEvent({ payload: body, signature, secret: SECRET });
    expect(event.event).toBe('email.received');
    expect(event.data.extracted_otp).toBe('448213');
    expect(event.data.extracted_links).toEqual(['https://example.com/confirm?t=abc']);
  });

  it('fails closed with a machine-readable code for each rejection', async () => {
    const body = envelope();
    const good = await serverSign(SECRET, body);

    const cases: Array<[Parameters<typeof constructWebhookEvent>[0], string]> = [
      [{ payload: body, signature: null, secret: SECRET }, 'missing_signature'],
      [{ payload: body, signature: 'nope', secret: SECRET }, 'malformed_signature'],
      [{ payload: envelope({ sender: 'evil@x.com' }), signature: good, secret: SECRET }, 'signature_mismatch'],
    ];

    for (const [options, code] of cases) {
      await expect(constructWebhookEvent(options)).rejects.toMatchObject({
        name: 'WebhookVerificationError',
        code,
      });
    }
  });

  it('reports invalid JSON only after the signature has been verified', async () => {
    const body = '{not json';
    const signature = await serverSign(SECRET, body);
    await expect(
      constructWebhookEvent({ payload: body, signature, secret: SECRET }),
    ).rejects.toMatchObject({ code: 'invalid_json' });
  });

  it('accepts a fresh delivery within tolerance', async () => {
    const body = envelope({}, Math.floor(Date.now() / 1000) - 5);
    const signature = await serverSign(SECRET, body);
    await expect(
      constructWebhookEvent({ payload: body, signature, secret: SECRET, toleranceSeconds: 300 }),
    ).resolves.toMatchObject({ event: 'email.received' });
  });

  it('rejects a replayed delivery once it falls outside tolerance', async () => {
    const body = envelope({}, Math.floor(Date.now() / 1000) - 3600);
    const signature = await serverSign(SECRET, body);
    // The signature is still cryptographically valid — this is exactly why
    // toleranceSeconds exists, and exactly why it is not sufficient on its own.
    expect(await verifyWebhookSignature({ payload: body, signature, secret: SECRET })).toBe(true);
    await expect(
      constructWebhookEvent({ payload: body, signature, secret: SECRET, toleranceSeconds: 300 }),
    ).rejects.toMatchObject({ code: 'timestamp_out_of_tolerance' });
  });

  it('ignores age entirely when no tolerance is configured', async () => {
    const body = envelope({}, 1);
    const signature = await serverSign(SECRET, body);
    await expect(
      constructWebhookEvent({ payload: body, signature, secret: SECRET }),
    ).resolves.toMatchObject({ event: 'email.received' });
  });

  it('never puts the secret in an error message', async () => {
    const body = envelope();
    try {
      await constructWebhookEvent({ payload: body, signature: 'a'.repeat(64), secret: SECRET });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookVerificationError);
      expect((err as Error).message).not.toContain(SECRET);
    }
  });
});

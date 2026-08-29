import { TempMailGrab } from './client.js';
import type { Inbox } from './inbox.js';
import type { ClientOptions } from './types.js';

/**
 * Playwright fixture factory.
 *
 * Gives every test its own inbox, so parallel workers cannot claim each other's
 * verification mail — the failure mode that makes a shared QA mailbox flaky.
 *
 * ```ts
 * // fixtures.ts
 * import { test as base } from '@playwright/test';
 * import { inboxFixture } from 'tempmailgrab/playwright';
 *
 * export const test = base.extend(inboxFixture({ apiKey: process.env.TMG_API_KEY! }));
 * export { expect } from '@playwright/test';
 *
 * // signup.spec.ts
 * test('a new user can verify their email', async ({ page, inbox }) => {
 *   await page.goto('/signup');
 *   await page.getByLabel('Email').fill(inbox.address);
 *   await page.getByRole('button', { name: 'Create account' }).click();
 *
 *   await page.getByLabel('Verification code').fill(await inbox.waitForOtp());
 *   await page.getByRole('button', { name: 'Verify' }).click();
 *   await expect(page.getByText('Welcome')).toBeVisible();
 * });
 * ```
 *
 * No `afterEach`: inboxes expire on their own, so there is nothing to tear down.
 * Pass `deleteAfterEach: true` to remove them eagerly anyway.
 */
export function inboxFixture(
  options: ClientOptions & {
    /** Delete the inbox when the test finishes instead of letting it expire. */
    deleteAfterEach?: boolean;
    /** Inbox TTL. Defaults to 1 hour, comfortably longer than a test. */
    ttlSeconds?: number;
  },
): {
  inbox: [
    (args: unknown, use: (inbox: Inbox) => Promise<void>) => Promise<void>,
    { scope: 'test' },
  ];
} {
  const { deleteAfterEach = false, ttlSeconds = 3600, ...clientOptions } = options;
  const client = new TempMailGrab(clientOptions);

  return {
    inbox: [
      async (_args, use) => {
        const inbox = await client.createInbox({ ttlSeconds });
        try {
          await use(inbox);
        } finally {
          if (deleteAfterEach) {
            // Never let cleanup fail a passing test.
            await inbox.delete().catch(() => undefined);
          }
        }
      },
      { scope: 'test' },
    ],
  };
}

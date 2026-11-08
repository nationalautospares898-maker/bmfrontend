/**
 * Real backend, real browser: the forced password-change gate.
 *
 * Reproduces the reported production defect end to end. Before this fix,
 * `must_change_password` was enforced correctly by the server on every permission-
 * gated endpoint, but nothing in the client could ever clear it — so Billing rendered
 * anyway, and the first real action (Stock → Add Items) failed with a generic
 * "You do not have permission to do this. Ask a supervisor." that had nothing to do
 * with permissions.
 *
 * This asserts the gate actually blocks the app while the flag is set (no silent
 * bypass), that completing the change ends at sign-in-again rather than a silently
 * recovered session (`change_own_password` revokes the calling device's refresh
 * tokens in the same transaction, so there is nothing left to recover), and that
 * signing in again with the new password makes every owner action that used to fail
 * work.
 *
 * Needs a real backend (`BM_DEV_API_PROXY` or `BM_E2E_API_URL`), exactly like
 * `full-stack.spec.ts`, and a disposable user seeded with `must_change_password=true`
 * in the SAME local/e2e database that suite uses — never Neon.
 */

import { expect, test } from '@playwright/test';

const API_URL = process.env.BM_E2E_API_URL;
const PROXIED = Boolean(process.env.BM_DEV_API_PROXY);

test.skip(
  !API_URL && !PROXIED,
  'Needs a real backend: set BM_DEV_API_PROXY or BM_E2E_API_URL, and seed a user with ' +
    'must_change_password=true first.',
);

const USERNAME = process.env.BM_E2E_FORCE_CHANGE_USERNAME ?? 'mcp-force-change-test';
const CURRENT_PASSWORD =
  process.env.BM_E2E_FORCE_CHANGE_PASSWORD ?? 'mcp-test-temp-pw-01';
const NEW_PASSWORD = 'a-brand-new-secure-password-01';

test('a forced password change gates the app, then every owner action works', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(CURRENT_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // The gate: Billing must not render while the flag is set. This is the regression
  // guard for "the billing interface remained visible" — it must not, any more.
  await expect(page.getByRole('heading', { name: 'Set a new password' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('button', { name: /Print Bill/ })).toHaveCount(0);

  // The gate must survive a reload, not just the initial render — `toSessionState`
  // reads `must_change_password` off the *refreshed* session on every cold start
  // (`bootstrap.ts`), so a stale client-only flag could not fake this.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Set a new password' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('button', { name: /Print Bill/ })).toHaveCount(0);

  await page.getByLabel('Current password').fill(CURRENT_PASSWORD);
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Set password' }).click();

  // `change_own_password` revokes the calling device's own refresh tokens in the same
  // transaction as the change, so there is no session left to silently continue —
  // sign-in-again is correct, not a failure.
  await expect(
    page.getByText('Password changed. Sign in with your new password.'),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('heading', { name: 'Set a new password' })).toHaveCount(0);

  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // The real regression this spec exists to catch: with the password changed, Stock →
  // Add Items (and everything else permission-gated) must now work, not say
  // "ask a supervisor".
  await expect(page.getByRole('button', { name: /Print Bill/ })).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole('button', { name: 'Stock' }).click();
  await page.getByRole('button', { name: 'Add Items' }).click();
  await expect(page.getByText(/ask a supervisor/i)).toHaveCount(0);
  // The sheet opened — the exact action the production report said failed.
  await expect(page.getByRole('button', { name: 'Save these items' })).toBeVisible();
});

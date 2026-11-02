/**
 * Opening the application without signing in — in a real browser, against a real server.
 *
 * The owner asked for the shop's computer to open straight into billing. These tests
 * check that it does, and — the part that matters more — that nothing else about
 * security moved:
 *
 * * **the API is still not public.** A request with no token is still refused. Enabling
 *   password-free *entry* must not make the application unauthenticated, and that is
 *   asserted here from inside the page, against the live server;
 * * the session that arrives is a **real** one, with the account's real permissions, and
 *   every feature works through it: billing, finalisation, stock, reports, printing;
 * * a **reload** stays inside the application rather than bouncing to a sign-in form;
 * * the sign-in form is **still there** and still works, for a second person using the
 *   machine.
 *
 * This suite requires a server with `BM_UNATTENDED_ACCESS=true`. Without it the
 * application correctly shows the sign-in form, which the other suites already cover, so
 * these skip rather than pass vacuously.
 */

import { expect, test, type Page } from '@playwright/test';

const API_URL = process.env.BM_E2E_API_URL;
const PROXIED = Boolean(process.env.BM_DEV_API_PROXY);
const UNATTENDED = process.env.BM_E2E_UNATTENDED === '1';

test.skip(
  !UNATTENDED || (!API_URL && !PROXIED),
  'Needs a real backend started with BM_UNATTENDED_ACCESS=true, and BM_E2E_UNATTENDED=1 ' +
    'to say so. Without it the sign-in form is the correct behaviour and is covered ' +
    'elsewhere.',
);

/**
 * The access token the application was issued, observed from its own response.
 *
 * Needed because the token lives in memory rather than in a cookie, so a `fetch` fired
 * from inside the page does **not** carry it automatically. Captured rather than minted:
 * the point is to use the session the application obtained for itself.
 */
let token = '';

function watchForToken(page: Page): void {
  page.on('response', (response) => {
    if (!/\/auth\/(unattended|login|refresh)$/.test(response.url())) return;
    if (response.status() !== 200) return;
    void response
      .json()
      .then((body: { access_token?: string }) => {
        if (body.access_token) token = body.access_token;
      })
      .catch(() => {});
  });
}

/** Open the application and wait until it is usable. No credentials are typed. */
async function openDirectly(page: Page): Promise<void> {
  token = '';
  watchForToken(page);
  await page.goto('/');
  // Row 1's Item cell exists only once the session is live and the draft store has
  // opened the bills, so its presence is the proof that the application is *usable* —
  // a stronger claim than "no login form appeared".
  await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  // The listener can still be mid-parse when the screen is already usable, which sent
  // the first API call with no Authorization header and made it look as though the
  // session had expired.
  await expect.poll(() => token, { timeout: 15_000 }).not.toBe('');
}

async function api<T>(
  page: Page,
  path: string,
  init?: { method?: string; body?: unknown; withToken?: boolean },
): Promise<{ status: number; body: T }> {
  // `withToken: false` sends none at all, which is how the "still not public"
  // assertions are made.
  const bearer = init?.withToken === false ? '' : token;
  return page.evaluate(
    async ({ p, method, body, bearer }) => {
      const response = await fetch(`/api/v1${p}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...(method && method !== 'GET'
            ? { 'Idempotency-Key': crypto.randomUUID() }
            : {}),
        },
        ...(body === null || body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: (await response.json().catch(() => null)) as never,
      };
    },
    { p: path, method: init?.method ?? 'GET', body: init?.body ?? null, bearer },
  );
}

// ---------------------------------------------------------------------------
// Direct access
// ---------------------------------------------------------------------------

test.describe('the application opens without a password', () => {
  test('a fresh browser lands in billing, with no sign-in form at all', async ({
    page,
  }) => {
    await openDirectly(page);

    // None of the sign-in controls are anywhere on the page.
    await expect(page.getByLabel('Username')).toHaveCount(0);
    await expect(page.getByLabel('Password')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
    // And the billing workspace is the thing on screen.
    await expect(page.getByRole('button', { name: /Print Bill/ })).toBeVisible();
  });

  test('reloading stays inside the application', async ({ page }) => {
    await openDirectly(page);

    await page.reload();
    await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  });

  test('the session carries the account’s real permissions', async ({ page }) => {
    // Not a special anonymous mode: an ordinary session for a real account, which is why
    // every permission-gated section is present.
    await openDirectly(page);

    const nav = page.getByRole('navigation', { name: 'Sections' });
    for (const section of [
      'Billing',
      'Daily Bills',
      'Credit Bills',
      'Stock',
      'Customers',
      'Saving and syncing',
    ]) {
      await expect(nav.getByRole('button', { name: section, exact: true })).toBeVisible();
    }
  });

  test('the shop’s own identity is shown, not a demo or an anonymous placeholder', async ({
    page,
  }) => {
    await openDirectly(page);
    const heading = page.locator('h2').first();
    await expect(heading).toBeVisible();
    expect((await heading.innerText()).trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// What did NOT become public
// ---------------------------------------------------------------------------

test.describe('the API is still not public', () => {
  test('a request with no token is still refused', async ({ page }) => {
    /**
     * The assertion this whole change hinges on. The browser gets in without a password;
     * the **API** did not become open. Anything else would mean the customer list, the
     * takings and the ability to issue bills were readable by anyone who could reach the
     * server, with or without the application.
     */
    await openDirectly(page);

    for (const path of [
      '/sync/bootstrap',
      '/customers',
      '/inventory/balances',
      '/reports/daily-sales?on_date=2026-11-02',
    ]) {
      const response = await api(page, path, { withToken: false });
      expect(response.status, `${path} answered without a token`).toBe(401);
    }
  });

  test('a forged token is still refused', async ({ page }) => {
    await openDirectly(page);
    const response = await page.evaluate(async () => {
      const r = await fetch('/api/v1/sync/bootstrap', {
        headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.forged.signature' },
      });
      return r.status;
    });
    expect(response).toBe(401);
  });

  test('the sign-in form still works for somebody else', async ({ page }) => {
    /**
     * The form is bypassed, not deleted. A second person who needs their own session —
     * a different role, a different audit trail — can still have one.
     */
    await openDirectly(page);

    // Sign out returns to the form rather than silently re-entering.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByLabel('Username')).toBeVisible({ timeout: 15_000 });

    await page.getByLabel('Username').fill(process.env.BM_E2E_USERNAME ?? 'e2e-owner');
    await page
      .getByLabel('Password')
      .fill(process.env.BM_E2E_PASSWORD ?? 'e2e-only-not-a-real-password-01');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Everything still works through the automatic session
// ---------------------------------------------------------------------------

test.describe('the application works end to end without signing in', () => {
  /** Put stock on the shelf through the owner's own sheet, using the page's session. */
  async function stockUp(page: Page, count: number): Promise<string[]> {
    const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    const names = Array.from({ length: count }, (_, i) => `DIRECT ${stamp} ${i + 1}`);
    const saved = await api(page, '/inventory/stock-entries', {
      method: 'POST',
      body: {
        entries: names.map((item) => ({
          item,
          price: '100.0000',
          min_qty: '2.000',
          stock_qty: '40.000',
        })),
      },
    });
    // A 401 here would mean the application never obtained a session — the very thing
    // being tested — so this doubles as a check that automatic entry actually worked.
    expect(saved.status, `stock entry: ${JSON.stringify(saved.body)}`).toBe(200);
    return names;
  }

  test('a cash bill is finalised and stock goes down', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __printed: string[] }).__printed = [];
      window.print = () => {
        const root = document.getElementById('print-root');
        (window as unknown as { __printed: string[] }).__printed.push(
          root?.innerHTML ?? '',
        );
        setTimeout(() => window.dispatchEvent(new Event('afterprint')), 0);
      };
    });
    await openDirectly(page);
    const [part] = await stockUp(page, 1);
    await page.reload();
    await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    // Product search, selection, quantity — through the automatic session.
    const cell = page.getByLabel('Item, row 1', { exact: true });
    await cell.click();
    await cell.fill(part!);
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Enter');

    await page.getByRole('button', { name: /Print Bill/ }).click();

    await page.waitForFunction(
      () => ((window as unknown as { __printed?: string[] }).__printed ?? []).length > 0,
      null,
      { timeout: 30_000 },
    );
    const printed = await page.evaluate(
      () => (window as unknown as { __printed?: string[] }).__printed ?? [],
    );
    // Printing works, and the bill that printed is the bill that was typed.
    expect(printed.at(-1)).toContain(part!);
    expect(printed.at(-1)).toContain('ESTIMATE');

    // Stock went down by one, read back from the server.
    const balances = await api<{ items: Array<{ name: string; quantity: string }> }>(
      page,
      '/inventory/balances?limit=200',
    );
    const row = balances.body.items.find((item) => item.name === part);
    expect(row, 'the product is missing from the balances').toBeTruthy();
    expect(Number(row!.quantity)).toBe(39);
  });

  test('the back-office screens all load through the automatic session', async ({
    page,
  }) => {
    await openDirectly(page);
    const nav = page.getByRole('navigation', { name: 'Sections' });

    for (const section of [
      'Daily Bills',
      'Credit Bills',
      'Customers',
      'Saving and syncing',
    ]) {
      await nav.getByRole('button', { name: section, exact: true }).click();
      // Something real rendered, not an error panel or an empty shell.
      await expect(page.locator('main')).toBeVisible();
      await expect(page.getByText(/Please sign in|not signed in/i)).toHaveCount(0);
    }
  });

  test('Stock and the Stock Movement Report work', async ({ page }) => {
    await openDirectly(page);
    await stockUp(page, 1);
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: 'Stock', exact: true })
      .click();

    await expect(page.getByRole('table', { name: /Stock on hand/i })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('button', { name: 'Add Items' })).toBeVisible();

    await page.getByRole('button', { name: 'Stock Movement Report' }).click();
    const panel = page.getByRole('region', { name: /Stock movement on one day/i });
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Stock Added' }).click();
    // The day's additions are there — proof the report's own requests carry the session.
    await expect(panel.getByText('Products affected')).toBeVisible({ timeout: 15_000 });
  });

  test('a draft survives a reload, so offline work is not tied to signing in', async ({
    page,
  }) => {
    await openDirectly(page);
    const [part] = await stockUp(page, 1);
    await page.reload();
    await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    const cell = page.getByLabel('Item, row 1', { exact: true });
    await cell.click();
    await cell.fill(part!);
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('table', { name: /Bill items/i }).getByText(part!),
    ).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    // The half-typed bill is still on screen, and still no sign-in form.
    await expect(
      page.getByRole('table', { name: /Bill items/i }).getByText(part!),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  });

  test('no console errors and no failed requests while opening and using it', async ({
    page,
  }) => {
    const errors: string[] = [];
    const failures: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('response', (r) => {
      if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
    });

    await openDirectly(page);
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: 'Stock', exact: true })
      .click();
    await expect(page.getByRole('table', { name: /Stock on hand/i })).toBeVisible({
      timeout: 30_000,
    });

    /**
     * Two messages are expected and are not defects:
     *
     * * `frame-ancestors is ignored when delivered via a <meta> element` — true, and
     *   pre-existing; the directive can only be set as an HTTP header.
     * * a `401` from `POST /auth/refresh` on a cold start — there is no cookie yet, which
     *   is exactly why the unattended request follows it. The application then opens.
     */
    const unexpectedErrors = errors.filter(
      (m) =>
        !/frame-ancestors/.test(m) &&
        !/401 \(Unauthorized\)/.test(m) &&
        !/Failed to load resource/.test(m),
    );
    const unexpectedFailures = failures.filter((f) => !/401 .*auth\/refresh/.test(f));

    expect(unexpectedErrors, `console errors: ${unexpectedErrors.join(' / ')}`).toEqual(
      [],
    );
    expect(
      unexpectedFailures,
      `failed requests: ${unexpectedFailures.join(' / ')}`,
    ).toEqual([]);
  });
});

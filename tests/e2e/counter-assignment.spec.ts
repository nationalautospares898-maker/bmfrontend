/**
 * Full stack: a computer bills with **nobody assigning it a counter** (C-2, superseded).
 *
 * What this file used to be, and why it changed
 * ---------------------------------------------
 *
 * It drove the `Counters` screen through the browser: assign a till, reassign it, share a
 * counter between two machines, take one off, and finally the acceptance path — an
 * unassigned computer that cannot bill, is assigned, and then can.
 *
 * The owner has since withdrawn that workflow. They run the shop from one computer, and
 * asked for the counter step to stop being part of using the application. So the eleven
 * tests that clicked through a screen no longer reachable from the navigation have been
 * replaced by tests of the behaviour that **took their place**. The coverage that
 * mattered is kept and inverted:
 *
 * | Was | Is now |
 * |---|---|
 * | an unassigned computer cannot bill, until an owner fixes it | a brand-new computer bills immediately, with nobody fixing anything |
 * | the assignment survives a full reload | the automatic binding survives a full reload |
 * | the screen lists the real counters and computers | the endpoints behind that screen still work and are still permission-guarded |
 *
 * That last row is the important one, and it is why this suite was rewritten rather than
 * deleted. "Withdrawn from the workflow" must not quietly become "deleted, along with its
 * authorization": `GET /admin/counters` and `PUT /admin/devices/{id}/counter` are still
 * mounted, still require `admin.settings.manage`, and still refuse an anonymous caller.
 * A suite that was simply removed would have left nobody checking that.
 *
 * Nothing here is mocked. The bundle is built against a live FastAPI process on a
 * disposable PostgreSQL seeded by `bmbackend/scripts/seed_e2e_tenant.py`, which provides
 * two counters, a provisioned device, and — still useful — a device registered with no
 * counter at all, which is now a **recovery** case rather than a dead end.
 *
 * Skipped, loudly, when `BM_E2E_API_URL` is absent: a full-stack suite that passes without
 * a backend is worse than one that does not run.
 */

import { expect, test, type Page } from '@playwright/test';

const API_URL = process.env.BM_E2E_API_URL;
/**
 * Set when the preview server proxies `/api` to the backend — the **only** CSP-clean
 * way to reach an isolated database.
 *
 * The app's CSP is `connect-src 'self' http://localhost:8000`, so an absolute API base
 * is permitted for exactly one port, and on a developer machine that port is the live
 * shop instance. Through the proxy the origin is empty and the URL is relative, so it
 * satisfies `'self'` whatever port the API is on. The CSP is not widened.
 */
const PROXIED = Boolean(process.env.BM_DEV_API_PROXY);
/** Prefix for in-page fetches: empty (same origin) when proxied. */
const ORIGIN = PROXIED ? '' : (API_URL ?? '');

const USERNAME = process.env.BM_E2E_USERNAME ?? 'e2e-owner';
const PASSWORD = process.env.BM_E2E_PASSWORD ?? 'e2e-only-not-a-real-password-01';

/** The already-provisioned owner browser, assigned to counter C1 by the seed. */
const OWNER_DEVICE_ID =
  process.env.BM_E2E_DEVICE_ID ?? '0192f100-0000-7000-8000-0000000000d1';

/**
 * A device the seed registers with `counter_id = NULL` — exactly what `register_device`
 * writes for a brand-new browser profile.
 *
 * Before this change that was a dead end. It is now the repair case: signing in binds it.
 * `bm`'s own `Probe` device is in precisely this state, which is why it is worth a test.
 */
const UNASSIGNED_DEVICE_ID =
  process.env.BM_E2E_UNASSIGNED_DEVICE_ID ?? '0192f100-0000-7000-8000-0000000000d2';

test.skip(
  !API_URL && !PROXIED,
  'Needs a real backend: set BM_DEV_API_PROXY (preferred — works with an isolated ' +
    'database) or BM_E2E_API_URL, and seed scripts/seed_e2e_tenant.py first.',
);

/**
 * The access token the application itself was issued, observed from the real response.
 *
 * Captured rather than fetched: a refresh token is single-use and rotated, so a helper
 * that minted its own would race the application for it. Reading a response body is
 * observation, not interception — no `page.route` is involved.
 */
let accessToken = '';

function watchForToken(page: Page): void {
  page.on('response', (response) => {
    if (!response.url().includes('/auth/login') || response.status() !== 200) return;
    void response
      .json()
      .then((body: { access_token?: string }) => {
        if (body.access_token) accessToken = body.access_token;
      })
      .catch(() => {
        /* a failed login has no token to capture */
      });
  });
}

/**
 * Present a given device id to the server.
 *
 * Dexie owns the `nas-counter` schema, so the app creates it on a first visit and the
 * `meta` row is written afterwards, opening **without** a version so the request cannot
 * trigger an upgrade. (Opening with an explicit version creates a database Dexie then
 * finds with stores missing, and the app hangs on "Starting".)
 */
async function presentDevice(page: Page, deviceId: string): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    async () =>
      ((await indexedDB.databases?.()) ?? []).some((d) => d.name === 'nas-counter'),
    null,
    { timeout: 30_000 },
  );
  await page.evaluate(
    (id) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('nas-counter');
        open.onerror = () =>
          reject(new Error(`indexedDB.open failed: ${String(open.error)}`));
        open.onsuccess = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains('meta')) {
            reject(new Error('no meta store'));
            return;
          }
          const tx = database.transaction('meta', 'readwrite');
          tx.objectStore('meta').put({ key: 'device_id', value: id });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(new Error(`meta write failed: ${String(tx.error)}`));
        };
      }),
    deviceId,
  );
  await page.reload();
}

async function fillLogin(page: Page): Promise<void> {
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/**
 * Signed in **and able to bill** — which is the whole point of this file.
 *
 * Row 1's Item cell is the assertion rather than any banner: it only exists once the
 * draft store has opened the bills, and the store is only initialised once the server has
 * said where bills are booked. So its presence is proof the counter resolved, reached
 * through the thing a cashier actually uses.
 */
async function expectReadyToBill(page: Page): Promise<void> {
  // 45s, not 30s: the CI runner is a shared 2-core box, slower than a developer
  // machine (the performance job's own comment makes the same point), and this wait
  // covers a full boot — auth bootstrap, counter resolution, and the draft store
  // opening — which has grown with each feature added since this number was chosen.
  await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible({
    timeout: 45_000,
  });
  // And the dead end is genuinely absent, not merely scrolled past.
  await expect(page.getByText(/Billing is not ready on this computer/)).toHaveCount(0);
}

/** Call the API with the application's own token, from inside the page. */
async function api(
  page: Page,
  path: string,
  options: { token?: string | null } = {},
): Promise<number> {
  const token = options.token === undefined ? accessToken : options.token;
  return page.evaluate(
    async ([base, target, bearer]) => {
      const response = await fetch(`${base}${target}`, {
        headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
      });
      return response.status;
    },
    [ORIGIN, path, token ?? ''] as const,
  );
}

test.describe('the counter step is gone from the workflow', () => {
  test('a brand-new computer signs in and bills straight away', async ({ page }) => {
    /**
     * The headline, and the exact inverse of what this file used to assert.
     *
     * A device id the server has never seen — the real state of a freshly installed PC,
     * which is what the owner will have. `register_device` enrols it against a branch and
     * deliberately not against a counter, so before this change `/sync/bootstrap`
     * answered `counter: null` and the billing screen had nothing to open drafts for.
     */
    accessToken = '';
    watchForToken(page);
    await presentDevice(page, crypto.randomUUID());
    await fillLogin(page);

    await expectReadyToBill(page);
    expect(accessToken, 'no access token was observed on the login response').not.toBe(
      '',
    );
  });

  test('the navigation is the everyday sections, with no counter setup among them', async ({
    page,
  }) => {
    accessToken = '';
    watchForToken(page);
    await presentDevice(page, crypto.randomUUID());
    await fillLogin(page);
    await expectReadyToBill(page);

    const nav = page.getByRole('navigation', { name: 'Sections' });
    const labels = (await nav.getByRole('button').allInnerTexts()).map((text) =>
      text.trim(),
    );
    expect(labels).toEqual([
      'Billing',
      'Daily Bills',
      'Credit Bills',
      'Canceled Bills',
      'Stock',
      'Customers',
      'Orders',
      'Saving and syncing',
    ]);
  });

  test('the binding persists, so a reload does not ask for setup again', async ({
    page,
  }) => {
    // It is written to `devices.counter_id`, not merely resolved for one request — so a
    // reload, a new session, and the offline cache all agree.
    accessToken = '';
    watchForToken(page);
    const deviceId = crypto.randomUUID();
    await presentDevice(page, deviceId);
    await fillLogin(page);
    await expectReadyToBill(page);

    await page.reload();
    await expectReadyToBill(page);
  });

  test('a computer enrolled with no counter recovers by signing in', async ({ page }) => {
    // The seeded `counter_id IS NULL` device. This is the state every machine registered
    // before the change is in, including the `Probe` device in the owner's own database,
    // so without this the existing install would still need the screen that was removed.
    accessToken = '';
    watchForToken(page);
    await presentDevice(page, UNASSIGNED_DEVICE_ID);
    await fillLogin(page);

    await expectReadyToBill(page);
  });

  test('the already-provisioned computer is unaffected', async ({ page }) => {
    // A deliberate assignment is never overwritten — the `UPDATE` carries a
    // `counter_id IS NULL` guard — so the seeded owner browser keeps billing as C1.
    accessToken = '';
    watchForToken(page);
    await presentDevice(page, OWNER_DEVICE_ID);
    await fillLogin(page);

    await expectReadyToBill(page);
  });
});

test.describe('withdrawn from the workflow, not deleted from the system', () => {
  /**
   * The security half of this file.
   *
   * Taking a section out of the navigation must not be mistaken for removing the feature,
   * and must not weaken what guards it. These call the endpoints the withdrawn screen used
   * to call, directly.
   */
  test.beforeEach(async ({ page }) => {
    accessToken = '';
    watchForToken(page);
    await presentDevice(page, crypto.randomUUID());
    await fillLogin(page);
    await expectReadyToBill(page);
  });

  test('the counter endpoints are still mounted and still answer the owner', async ({
    page,
  }) => {
    // 200, not 404: the capability is intact for an operator who needs it.
    expect(await api(page, '/api/v1/admin/counters')).toBe(200);
  });

  test('and they still refuse a caller with no token', async ({ page }) => {
    // The permission was `admin.settings.manage` before and is unchanged. Nothing about
    // simplifying the interface relaxed it.
    expect(await api(page, '/api/v1/admin/counters', { token: null })).toBe(401);
  });
});

/**
 * Measured request frequency, in a real browser, against a real backend.
 *
 * ## Why this is separate from `notifications-redesign.spec.ts`
 *
 * That suite proves the notification system *works*. This one answers the question the
 * production readiness audit actually asks — **how many requests does it cost** — in the
 * five situations the owner named, and it answers with counts taken off the wire rather
 * than from a fake timer.
 *
 * A unit test with `vi.advanceTimersByTime` can show the module arms no interval. It
 * cannot show that a real Chromium tab, with a real service worker, real HTTP, real
 * `visibilitychange` from the real page lifecycle and a real server deciding the hint,
 * makes no requests. Only this can, and the CDN bill is paid on the real number.
 *
 * Each scenario prints its measurement, so the audit document quotes observations rather
 * than predictions.
 *
 * ## Running it
 *
 *   BM_DEV_API_PROXY=http://127.0.0.1:8011 BM_E2E_PORT=4273 \
 *     npx playwright test tests/e2e/notification-request-frequency.spec.ts
 */

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const PROXIED = Boolean(process.env.BM_DEV_API_PROXY);
const API_URL = process.env.BM_E2E_API_URL;

const USERNAME = process.env.BM_E2E_USERNAME ?? 'e2e-owner';
const PASSWORD = process.env.BM_E2E_PASSWORD ?? 'e2e-only-not-a-real-password-01';
const PROVISIONED_DEVICE_ID =
  process.env.BM_E2E_DEVICE_ID ?? '0192f100-0000-7000-8000-0000000000d1';

test.skip(!API_URL && !PROXIED, 'Needs a real backend — see the file header.');

/** Counts `GET /api/v1/notifications` on one page. */
function counter(page: Page): { count: () => number } {
  let n = 0;
  page.on('request', (request) => {
    if (
      request.url().includes('/api/v1/notifications') &&
      request.method() === 'GET' &&
      // The lifecycle actions are POSTs to `/notifications/{id}:…`; only the list costs
      // a recurring request.
      !/:(read|dismiss|acknowledge|snooze)/.test(request.url())
    ) {
      n += 1;
    }
  });
  return { count: () => n };
}

async function provisionDevice(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    async () =>
      ((await indexedDB.databases?.()) ?? []).some((d) => d.name === 'nas-counter'),
    null,
    { timeout: 30_000 },
  );
  await page.evaluate(
    (deviceId) =>
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
          tx.objectStore('meta').put({ key: 'device_id', value: deviceId });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(new Error(`meta write failed: ${String(tx.error)}`));
        };
      }),
    PROVISIONED_DEVICE_ID,
  );
  await page.reload();
}

async function signIn(page: Page): Promise<void> {
  await provisionDevice(page);
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: /Print Bill/ })).toBeVisible({
    timeout: 30_000,
  });
}

const bell = (page: Page) => page.getByRole('button', { name: /^Notifications/ });

/** Reported per scenario so the audit quotes measurements, not estimates. */
function report(scenario: string, requests: number, seconds: number): void {
  const perHour = ((requests / seconds) * 3600).toFixed(1);
  console.log(
    `[frequency] ${scenario}: ${requests} requests in ${seconds}s → ${perHour}/hour`,
  );
}

test.describe('notification request frequency, measured', () => {
  test('scenario 1: one idle active tab — two minutes', async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);

    const seen = counter(page);
    await page.waitForTimeout(3_000); // let the sign-in fetch settle
    const before = seen.count();

    await page.waitForTimeout(120_000);
    const requests = seen.count() - before;

    report('1 idle active tab', requests, 120);
    // The old 30-second poll spent 4 here. The server's hint for a shop with nothing
    // imminent is 15 minutes, so the correct answer is none at all.
    expect(requests).toBe(0);
  });

  test('scenario 2: two simultaneously open tabs — two minutes', async ({ browser }) => {
    test.setTimeout(300_000);
    // Two tabs in one context share cookies and IndexedDB, exactly as two tabs on the
    // counter PC would. Both are "visible" to the page lifecycle in separate pages,
    // which is the worst case — the visibility gate only silences a *backgrounded* tab.
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1366, height: 768 },
    });
    const first = await context.newPage();
    const second = await context.newPage();

    await signIn(first);
    await signIn(second);

    const a = counter(first);
    const b = counter(second);
    await first.waitForTimeout(3_000);
    const before = a.count() + b.count();

    await first.waitForTimeout(120_000);
    const requests = a.count() + b.count() - before;

    report('2 open tabs', requests, 120);
    // Each tab is its own module instance — there is deliberately no cross-tab leader
    // election (a hidden tab holding the lock would starve the visible one). So the
    // ceiling is twice one tab's, and one tab's is zero.
    expect(requests).toBeLessThanOrEqual(2);

    await context.close();
  });

  test('scenario 3: repeated bell opening and closing — 30 cycles', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);

    const seen = counter(page);
    await page.waitForTimeout(3_000);
    const before = seen.count();

    const start = Date.now();
    for (let i = 0; i < 30; i += 1) {
      await bell(page).click();
      await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
      await bell(page).click();
      await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeHidden();
    }
    const seconds = Math.max(1, Math.round((Date.now() - start) / 1000));
    const requests = seen.count() - before;

    report(`30 bell open/close cycles`, requests, seconds);
    // Each open asks for a refresh; the 5-second floor is what turns 30 asks into a
    // trickle. One per 5 seconds of elapsed time, plus one deferred.
    expect(requests).toBeLessThanOrEqual(Math.ceil(seconds / 5) + 2);
  });

  test('scenario 4: repeated offline/online transitions — 20 cycles', async ({
    page,
    context,
  }) => {
    test.setTimeout(180_000);
    await signIn(page);

    const seen = counter(page);
    await page.waitForTimeout(3_000);
    const before = seen.count();

    const start = Date.now();
    for (let i = 0; i < 20; i += 1) {
      await context.setOffline(true);
      await page.waitForTimeout(250);
      await context.setOffline(false);
      await page.waitForTimeout(250);
    }
    // Let the last reconnect's refresh land.
    await page.waitForTimeout(6_000);
    const seconds = Math.max(1, Math.round((Date.now() - start) / 1000));
    const requests = seen.count() - before;

    report('20 offline/online cycles', requests, seconds);
    // A flapping adapter must not become a request storm. Each reconnect asks; the floor
    // bounds it. Failed requests while offline are counted too, which is why this allows
    // a little more headroom than the pure ceiling.
    expect(requests).toBeLessThanOrEqual(Math.ceil(seconds / 5) + 4);

    await context.setOffline(false);
  });

  test('scenario 5: long-running active session — five minutes with interaction', async ({
    page,
  }) => {
    test.setTimeout(420_000);
    await signIn(page);

    const seen = counter(page);
    await page.waitForTimeout(3_000);
    const before = seen.count();

    // Five minutes of a cashier working: moving between screens, not sitting idle.
    // Navigation must not cost notification requests — the bell lives in the header and
    // never unmounts.
    const start = Date.now();
    for (let round = 0; round < 5; round += 1) {
      for (const section of ['Stock', 'Orders', 'Billing']) {
        await page.getByRole('button', { name: section, exact: true }).click();
        await page.waitForTimeout(20_000);
      }
    }
    const seconds = Math.max(1, Math.round((Date.now() - start) / 1000));
    const requests = seen.count() - before;

    report('5 min active session (15 screen changes)', requests, seconds);
    // Screen changes are free; only the server's own hint schedules anything, and at
    // 15 minutes that is at most one inside this window.
    expect(requests).toBeLessThanOrEqual(2);
  });
});

test.describe('notification response caching', () => {
  test('the notification response is not cacheable by any intermediary', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // Armed BEFORE signing in, because the only notification fetch in this window is
    // the one sign-in itself triggers — waiting afterwards times out, which is the
    // system working as intended and was how this test first failed.
    const settled = page.waitForResponse(
      (r) =>
        r.url().includes('/api/v1/notifications') &&
        r.request().method() === 'GET' &&
        r.status() === 200,
      { timeout: 60_000 },
    );
    await signIn(page);
    const response = await settled;
    const headers = response.headers();

    console.log(`[cache] cache-control: ${headers['cache-control'] ?? '(absent)'}`);
    // `no-store` is set by `SecurityHeadersMiddleware` on every response. It matters
    // here specifically: a cached notification list would show the owner a stale bell,
    // and a CDN caching a *per-business* response is a tenancy problem, not just a
    // staleness one.
    expect(headers['cache-control']).toContain('no-store');
    // And nothing that would let a shared cache keep it anyway.
    expect(headers['etag']).toBeUndefined();
    expect(headers['last-modified']).toBeUndefined();
  });
});

/**
 * Routing: no notification or reminder request may use the page's own origin.
 *
 * The acceptance topology is what makes this assertable at runtime rather than by
 * reading source: the built app is served from the preview port while the API lives at
 * `BM_E2E_API_URL`, so "went to the API origin" and "went to the page origin" are
 * distinguishable on the wire — exactly as `bmfrontend-seven.vercel.app` and
 * `bmbackend-production.up.railway.app` are in production.
 *
 * It exists because a relative notification URL is invisible in every other check: the
 * app works perfectly, the tests pass, and the only symptom is a CDN bill. That is the
 * shape the November incident had.
 */
test.describe('notification routing', () => {
  test('every notification and reminder request leaves the page origin', async ({
    page,
  }) => {
    test.setTimeout(180_000);

    const pageOrigin = new URL(`http://localhost:${process.env.BM_E2E_PORT ?? 4273}`)
      .origin;
    const offenders: string[] = [];
    const seen: string[] = [];

    page.on('request', (request) => {
      const url = new URL(request.url());
      if (!/\/api\/v1\/(notifications|reminders)/.test(url.pathname)) return;
      seen.push(`${request.method()} ${url.origin}${url.pathname}`);
      if (url.origin === pageOrigin) {
        offenders.push(`${request.method()} ${url.href}`);
      }
    });

    await signIn(page);
    // Drive every notification trigger the feed has: mount, an explicit open, and a
    // lifecycle action if anything is listed.
    await bell(page).click();
    await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
    await page.waitForTimeout(6_000);
    await bell(page).click();
    await page.waitForTimeout(2_000);

    console.log(`[routing] notification/reminder requests observed: ${seen.length}`);
    for (const entry of seen) console.log(`[routing]   ${entry}`);

    expect(
      offenders,
      `these used the page origin instead of the API origin — in production that is the ` +
        `Vercel CDN being billed for notification traffic:\n${offenders.join('\n')}`,
    ).toEqual([]);
    // And prove the listener was actually wired to something, so a silent zero cannot
    // pass for compliance.
    expect(seen.length).toBeGreaterThan(0);
  });
});

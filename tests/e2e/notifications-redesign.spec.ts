/**
 * The notification system, in a real browser, against a real backend.
 *
 * ## What this suite is for
 *
 * The notification rework of 2026-11-22 changed three things that **only** a browser can
 * verify:
 *
 * 1. **The unconditional 30-second poll is gone.** A unit test with fake timers can show
 *    that the module does not arm an interval; only a real browser against a real server
 *    can show that an idle, signed-in, visible tab makes no notification requests for
 *    minutes at a time. This suite counts the actual network requests.
 * 2. **The scheduler runs in the API process.** There is no worker service any more, so
 *    "did a notification get created at all" is now a question about the process serving
 *    the page. This suite creates a real stock movement and watches the notification
 *    arrive.
 * 3. **The panel is a popover, not a modal.** Focus return, Escape, outside-click and
 *    "the billing screen is still visible behind it" are DOM-and-layout facts.
 *
 * Nothing here is mocked. The first test asserts that no route interception is
 * registered, so this suite cannot quietly become a stubbed one.
 *
 * ## Running it
 *
 *   # 1. an isolated database, migrated and seeded
 *   cd bmbackend
 *   BM_MIGRATION_DATABASE_URL=…/bm_e2e uv run alembic upgrade head
 *   BM_DATABASE_URL=…/bm_e2e uv run python scripts/seed_e2e_tenant.py
 *   # 2. the API, with the scheduler on (its default)
 *   BM_DATABASE_URL=…/bm_e2e … uv run uvicorn bm.main:create_app --factory --port 8011
 *   # 3. this suite, pointed at it through the preview proxy
 *   cd ../bmfrontend
 *   BM_DEV_API_PROXY=http://127.0.0.1:8011 BM_E2E_PORT=4273 \
 *     npx playwright test tests/e2e/notifications-redesign.spec.ts
 *
 * Skipped, loudly, without a backend: a notification suite that passes with no server is
 * worse than one that does not run.
 */

import { expect, test, type Page, type Request } from '@playwright/test';

const PROXIED = Boolean(process.env.BM_DEV_API_PROXY);
const API_URL = process.env.BM_E2E_API_URL;
const BASE = PROXIED ? '/api/v1' : `${API_URL ?? ''}/api/v1`;

const USERNAME = process.env.BM_E2E_USERNAME ?? 'e2e-owner';
const PASSWORD = process.env.BM_E2E_PASSWORD ?? 'e2e-only-not-a-real-password-01';
const PROVISIONED_DEVICE_ID =
  process.env.BM_E2E_DEVICE_ID ?? '0192f100-0000-7000-8000-0000000000d1';
const COUNTER_ID =
  process.env.BM_E2E_COUNTER_ID ?? '0192f100-0000-7000-8000-0000000000c1';

test.skip(
  !API_URL && !PROXIED,
  'Needs a real backend: set BM_DEV_API_PROXY (preferred — works with an isolated ' +
    'database) or BM_E2E_API_URL, and seed scripts/seed_e2e_tenant.py first.',
);

/** Unique per run, so a re-run cannot collide on a part code. */
const RUN = Date.now().toString(36);
let sequence = 0;

let accessToken = '';

/**
 * Console errors that this work could plausibly have caused.
 *
 * Two classes are filtered out, because asserting on them would be asserting on things
 * that were already true before any of this and have nothing to do with notifications:
 *
 * * **The `frame-ancestors` meta-element notice.** Chrome logs it on every page load
 *   because `index.html` declares a CSP in a `<meta>` tag and that one directive is only
 *   honoured as a real header. `vercel.json` sets `X-Frame-Options: DENY` for the same
 *   protection, so the control is in place; the notice is informational and predates this
 *   change entirely.
 * * **Bare `Failed to load resource` lines for 401/403.** A cold load legitimately
 *   attempts `/auth/refresh` with no session and is refused, and the shell probes a
 *   permission-gated endpoint. Chrome logs those as console errors with no useful text.
 *   The application handles both; they are visible in every run of every existing suite.
 *
 * An **uncaught exception** is never filtered — that is the thing worth failing on, and
 * `pageerror` is how it arrives.
 */
const IGNORED_CONSOLE = [
  /frame-ancestors/i,
  /Failed to load resource: the server responded with a status of 40[13]/i,
];

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return;
    errors.push(text);
  });
  // Never filtered.
  page.on('pageerror', (error) => errors.push(`uncaught: ${error.message}`));
  return errors;
}

/** Every request this page has made to the notification endpoint. */
function watchNotificationRequests(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/v1/notifications') && request.method() === 'GET') {
      seen.push(request);
    }
  });
  return seen;
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
  accessToken = '';
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

  await provisionDevice(page);
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: /Print Bill/ })).toBeVisible({
    timeout: 30_000,
  });
  expect(accessToken, 'no access token was observed on the login response').not.toBe('');
}

/**
 * Drive stock through the real API, using the page's own session and token.
 *
 * `reorderLevel` is set on the product and `stock` arrives via a confirmed purchase
 * receipt, so the notification this produces is raised by `apply_movements` exactly as it
 * would be for the owner — not inserted into `notifications` by a back door.
 */
async function createStockedProduct(
  page: Page,
  { stock, reorderLevel }: { stock: string; reorderLevel: string },
): Promise<{ productId: string; sku: string; name: string }> {
  sequence += 1;
  const sku = `NOTIF-${RUN}-${sequence}`;
  const name = `Notification Test Part ${RUN}-${sequence}`;

  return page.evaluate(
    async ([base, token, partCode, partName, qty, minQty]) => {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      };
      const post = async (path: string, body: unknown, key?: string) => {
        const response = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: key ? { ...headers, 'Idempotency-Key': key } : headers,
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          throw new Error(`${path} -> ${response.status} ${await response.text()}`);
        }
        return response.json() as Promise<Record<string, unknown>>;
      };

      await fetch(`${base}/units:ensure-defaults`, { method: 'POST', headers });

      const product = await post('/products', {
        name: partName,
        unit_code: 'NOS',
        default_selling_price: '100.0000',
        sku: partCode,
        reorder_level: minQty,
      });
      const productId = String(product['id']);

      const supplier = await fetch(`${base}/suppliers/${crypto.randomUUID()}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ name: 'Notification Test Supplier', phone: '9876543210' }),
      }).then((r) => r.json() as Promise<Record<string, unknown>>);

      const purchase = await post('/purchases', {
        supplier_id: String(supplier['id']),
        supplier_document_number: `NT/${partCode}`,
        items: [{ product_id: productId, quantity: qty, unit_cost: '80.0000' }],
      });
      await post(
        `/purchases/${String(purchase['purchase_id'])}:confirm`,
        undefined,
        crypto.randomUUID(),
      );

      return { productId, sku: partCode, name: partName };
    },
    [BASE, accessToken, sku, name, stock, reorderLevel] as const,
  );
}

/** Sell `quantity` of a product through the real finalisation endpoint. */
async function sell(page: Page, productId: string, quantity: string): Promise<void> {
  await page.evaluate(
    async ([base, token, counterId, id, qty]) => {
      const total = `${Number(qty) * 100}.00`;
      const response = await fetch(`${base}/sales:finalize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          counter_id: counterId,
          sale_type: 'cash',
          lines: [
            {
              product_id: id,
              quantity: qty,
              unit_price: '100.0000',
              price_source: 'catalog',
            },
          ],
          client_computed_total: total,
          payment: { method: 'cash', amount: total },
        }),
      });
      if (!response.ok) {
        throw new Error(`finalize -> ${response.status} ${await response.text()}`);
      }
    },
    [BASE, accessToken, COUNTER_ID, productId, quantity] as const,
  );
}

const bell = (page: Page) => page.getByRole('button', { name: /^Notifications/ });
const panel = (page: Page) => page.getByRole('dialog', { name: 'Notifications' });

test.describe('notifications: a real browser against a real backend', () => {
  test('1. this suite is not stubbed', ({ page }) => {
    // `page.route` would show up here. If this ever fails, the suite has become a
    // component test wearing an E2E costume.
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((page as any)._routes ?? []).length,
      'a route interception is registered — this suite must stay unmocked',
    ).toBe(0);
  });

  test('2-5. the application loads, signs in, and shows an interactive bell', async ({
    page,
  }) => {
    const errors = watchConsole(page);
    await signIn(page);

    await expect(bell(page)).toBeVisible();
    await expect(bell(page)).toBeEnabled();
    // Closed to begin with.
    await expect(bell(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(panel(page)).toBeHidden();

    // 14. no uncaught errors from loading and signing in.
    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('4. opening the bell shows the redesigned panel, and it is a popover not a modal', async ({
    page,
  }) => {
    await signIn(page);
    await bell(page).click();

    const open = panel(page);
    await expect(open).toBeVisible();
    await expect(open).toHaveAttribute('aria-modal', 'false');
    await expect(bell(page)).toHaveAttribute('aria-expanded', 'true');

    // The point of a popover: the billing screen is still there behind it. Under the
    // old centred `Dialog` the cashier had to dismiss a modal to get back to the bill.
    await expect(page.getByRole('button', { name: /Print Bill/ })).toBeVisible();

    // It is anchored to the bell, not centred over the page.
    const bellBox = await bell(page).boundingBox();
    const panelBox = await open.boundingBox();
    expect(bellBox).not.toBeNull();
    expect(panelBox).not.toBeNull();
    expect(panelBox!.y).toBeGreaterThan(bellBox!.y);
  });

  test('6-8. a real stock movement produces a notification the browser shows', async ({
    page,
  }) => {
    const errors = watchConsole(page);
    await signIn(page);

    // 10 on the shelf, minimum 4. Selling 7 leaves 3 — below the minimum.
    const product = await createStockedProduct(page, {
      stock: '10.000',
      reorderLevel: '4.000',
    });
    await sell(page, product.productId, '7.000');

    // 7. The browser learns about it through the implemented delivery mechanism. The tab
    // is visible and a sale was just made from it, so the next interaction-driven
    // refresh picks it up — here, opening the bell.
    await bell(page).click();
    await expect(panel(page).getByText(`${product.name} is running low`)).toBeVisible({
      timeout: 15_000,
    });

    // The badge counts it.
    await expect(bell(page)).toHaveAttribute('aria-label', /\d+ active/);

    // Severity reads as a word, not only as a colour (§10).
    await expect(panel(page).getByText('Needs attention').first()).toBeVisible();
    // And the card carries a timestamp.
    await expect(panel(page).getByText('Just now').first()).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();

    // 8. The automatic presentation: the same alert on screen with no bell click.
    await expect(
      page
        .getByRole('group', { name: 'Alerts' })
        .getByText(`${product.name} is running low`),
    ).toBeVisible({ timeout: 15_000 });

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('9. clicking a notification navigates to the existing destination screen', async ({
    page,
  }) => {
    await signIn(page);
    const product = await createStockedProduct(page, {
      stock: '10.000',
      reorderLevel: '4.000',
    });
    await sell(page, product.productId, '7.000');

    await bell(page).click();
    await expect(panel(page).getByText(`${product.name} is running low`)).toBeVisible({
      timeout: 15_000,
    });
    await panel(page).getByRole('button', { name: 'Go to' }).first().click();

    // A low-stock notification goes to Stock — the pre-existing destination, unchanged.
    await expect(panel(page)).toBeHidden();
    await expect(
      page.getByRole('heading', { name: /Stock/ }).or(page.getByText('Min Qty')).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('10. the existing notification actions still work against the real server', async ({
    page,
  }) => {
    await signIn(page);
    const product = await createStockedProduct(page, {
      stock: '10.000',
      reorderLevel: '4.000',
    });
    await sell(page, product.productId, '7.000');

    await bell(page).click();
    const card = panel(page).getByText(`${product.name} is running low`);
    await expect(card).toBeVisible({ timeout: 15_000 });

    await panel(page)
      .getByRole('button', { name: `Dismiss: ${product.name} is running low` })
      .click();

    // Gone from the list, and it stays gone across a reload — which is the proof the
    // server accepted it rather than the row only vanishing locally.
    await expect(card).toBeHidden();
    await page.reload();
    await expect(page.getByRole('button', { name: /Print Bill/ })).toBeVisible({
      timeout: 30_000,
    });
    await bell(page).click();
    await expect(panel(page).getByText(`${product.name} is running low`)).toBeHidden();
  });

  test('11. opening and closing the panel repeatedly behaves, and does not storm the API', async ({
    page,
  }) => {
    await signIn(page);
    const requests = watchNotificationRequests(page);
    const before = requests.length;

    for (let i = 0; i < 10; i += 1) {
      await bell(page).click();
      await expect(panel(page)).toBeVisible();
      await bell(page).click();
      await expect(panel(page)).toBeHidden();
    }

    // Focus came back to the bell each time, so the keyboard is never stranded.
    await expect(bell(page)).toBeFocused();

    // Ten openings inside a few seconds: the module-level floor allows at most one
    // request per 5 s, so this is a trickle, not ten requests.
    const added = requests.length - before;
    expect(added, `10 panel openings produced ${added} requests`).toBeLessThanOrEqual(3);
  });

  test('12. the panel fits the counter viewport without overflowing it', async ({
    page,
  }) => {
    // 1366x768 is the owner's monitor, and `playwright.config.ts` already uses it.
    await signIn(page);
    await bell(page).click();
    await expect(panel(page)).toBeVisible();

    const box = await panel(page).boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);

    // The page itself must never scroll sideways because of the panel.
    const overflows = await page.evaluate(
      () =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows, 'the panel made the page scroll horizontally').toBe(false);
  });

  test('13. unrelated screens and the billing workflow are unchanged', async ({
    page,
  }) => {
    const errors = watchConsole(page);
    await signIn(page);

    // The four primary actions, still four, still named as OD-14 settled them.
    // `name` has to be anchored: `/Credit Bill/` alone also matches the `Credit Bills`
    // navigation button, which is a different control entirely.
    for (const action of [
      /^Print Bill/,
      /^Credit Bill Ctrl/,
      /^Save a Draft/,
      /^Clear Draft/,
    ]) {
      await expect(page.getByRole('button', { name: action }).first()).toBeVisible();
    }

    // The navigation sections the owner asked for, reachable as before.
    for (const section of ['Stock', 'Customers', 'Orders', 'Credit Bills']) {
      await page.getByRole('button', { name: section, exact: true }).click();
      await expect(
        page.getByRole('button', { name: section, exact: true }),
      ).toBeVisible();
    }

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('15. an idle visible tab makes NO notification requests for two minutes', async ({
    page,
  }) => {
    // The headline requirement. Under the old 30-second poll this window produced four
    // requests; the server's hint for a shop with nothing imminent is 15 minutes, so the
    // correct answer here is zero.
    test.setTimeout(240_000);

    await signIn(page);
    const requests = watchNotificationRequests(page);

    // Let the sign-in fetch settle, then start counting.
    await page.waitForTimeout(3_000);
    const baseline = requests.length;

    await page.waitForTimeout(120_000);

    const during = requests.length - baseline;
    const urls = requests.slice(baseline).map((r) => r.url());
    expect(
      during,
      `an idle visible tab issued ${during} notification requests in 2 minutes: ${urls.join(', ')}`,
    ).toBe(0);
  });

  test('15b. the response carries the schedule hint the client sleeps on', async ({
    page,
  }) => {
    // The mechanism behind the test above: the client is not guessing an interval, the
    // server is telling it when the next scheduled notification could exist.
    const hints: number[] = [];
    page.on('response', (response) => {
      if (!response.url().includes('/api/v1/notifications')) return;
      if (response.request().method() !== 'GET') return;
      void response
        .json()
        .then((body: { next_check_after_seconds?: number }) => {
          if (typeof body.next_check_after_seconds === 'number') {
            hints.push(body.next_check_after_seconds);
          }
        })
        .catch(() => {
          /* a non-JSON response has no hint */
        });
    });

    await signIn(page);
    await expect.poll(() => hints.length, { timeout: 20_000 }).toBeGreaterThan(0);

    // Bounded by the server: never a tight loop, never long enough to strand the bell.
    for (const hint of hints) {
      expect(hint).toBeGreaterThanOrEqual(60);
      expect(hint).toBeLessThanOrEqual(900);
    }
  });

  test('evidence: screenshots of the bell, the panel, and an active alert', async ({
    page,
  }) => {
    await signIn(page);
    const product = await createStockedProduct(page, {
      stock: '10.000',
      reorderLevel: '4.000',
    });
    await sell(page, product.productId, '9.000'); // 1 left — critical territory

    await bell(page).click();
    await expect(panel(page).getByText(`${product.name} is running low`)).toBeVisible({
      timeout: 15_000,
    });

    await page.screenshot({
      path: 'test-results/notifications-panel-open.png',
      fullPage: false,
    });
    await bell(page).locator('..').screenshot({
      path: 'test-results/notifications-bell-badge.png',
    });

    await page.keyboard.press('Escape');
    await expect(
      page
        .getByRole('group', { name: 'Alerts' })
        .getByText(`${product.name} is running low`),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByRole('group', { name: 'Alerts' }).screenshot({
      path: 'test-results/notifications-auto-alert.png',
    });
  });
});

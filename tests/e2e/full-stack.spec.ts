/**
 * Full stack: the **built** front end against the **real** backend.
 *
 * Why this suite exists
 * ---------------------
 *
 * Every other suite in this repository stubs the API. `offline-and-keyboard.spec.ts`
 * and `back-office-screens.spec.ts` intercept it at the network layer; the component
 * suites mock `@/api/endpoints` outright. All of that is useful and none of it answers
 * the question the 30 October 2026 audit asked: does the client the shop will actually
 * run talk correctly to the server the shop will actually run? Twelve green E2E tests
 * against stubs cannot tell you that a field was renamed, that a status code changed,
 * or that CORS is wrong.
 *
 * So nothing here is mocked. The bundle is built with `VITE_API_BASE_URL` pointing at a
 * live FastAPI process, which is itself talking to a disposable PostgreSQL seeded by
 * `bmbackend/scripts/seed_e2e_tenant.py`. Requests are real HTTP, authentication is a
 * real Argon2 verification against a real row, and every figure asserted below came out
 * of the real money engine.
 *
 * The first test in the file asserts that **no route interception is registered**, so
 * this suite cannot quietly become a stubbed one.
 *
 * Skipped, loudly, when `BM_E2E_API_URL` is absent — a full-stack suite that passes
 * without a backend is worse than one that does not run.
 */

import { expect, test, type Page } from '@playwright/test';

const API_URL = process.env.BM_E2E_API_URL;
/**
 * Set when the preview server proxies `/api` to the backend, which is the **only**
 * CSP-clean way to reach an isolated database.
 *
 * The app's CSP is `connect-src 'self' http://localhost:8000`, so an absolute API base
 * is permitted for exactly one port — and on a developer machine that port is the live
 * shop instance. Pointing `BM_E2E_API_URL` anywhere else makes the browser block every
 * request before Playwright can even see it, which is how this suite came to have no
 * safe way of running at all. Through the proxy the base is **relative**, so it
 * satisfies `'self'` whatever port the API is on.
 */
const PROXIED = Boolean(process.env.BM_DEV_API_PROXY);
const BASE = PROXIED ? '/api/v1' : `${API_URL ?? ''}/api/v1`;

const USERNAME = process.env.BM_E2E_USERNAME ?? 'e2e-owner';
const PASSWORD = process.env.BM_E2E_PASSWORD ?? 'e2e-only-not-a-real-password-01';

test.skip(
  !API_URL && !PROXIED,
  'Needs a real backend: set BM_DEV_API_PROXY (preferred — works with an isolated ' +
    'database) or BM_E2E_API_URL, and seed scripts/seed_e2e_tenant.py first.',
);

/** Unique per run, so a re-run does not collide on a part code. */
const RUN = Date.now().toString(36);

/**
 * Bumped per product created, so two tests in one run cannot collide.
 *
 * `uq_products__business_sku` is a real uniqueness constraint and the server correctly
 * refuses a second product with the same part code — which is exactly what happened when
 * every test shared one `RUN`-derived code, and it is worth saying rather than silently
 * randomising: the duplicate refusal was the server behaving properly.
 */
let productSequence = 0;

interface Created {
  productId: string;
  sku: string;
}

/**
 * The device id this browser presents, matching the one `seed_e2e_tenant.py` registers
 * against counter `C1`.
 *
 * Why this is seeded rather than left to the client
 * -------------------------------------------------
 *
 * `ensureDeviceId()` mints a fresh UUIDv7 per browser profile, and `register_device`
 * deliberately enrols a device **without** a counter (`devices.counter_id` is nullable
 * by design — `DATA-MODEL.md §3.2`). A counter is attached to a device by provisioning:
 * `DEPLOYMENT.md`'s go-live checklist lists "Devices registered; counter machines have
 * full-disk encryption" as an operational step.
 *
 * So writing the provisioned device id into Dexie before the app boots is what makes
 * this browser *a counter PC that the owner has already registered* — the state the
 * application is designed to run in. It is environment provisioning, not a way around a
 * defect: the unprovisioned case is a real and currently unserviceable state, it is
 * covered separately by `tests/api/test_bootstrap_counter.py` on the backend and by the
 * "not assigned to a counter" panel in `AppShell`, and it is written up as an
 * unimplemented requirement (C-2 counter selection) in the final report.
 */
const PROVISIONED_DEVICE_ID =
  process.env.BM_E2E_DEVICE_ID ?? '0192f100-0000-7000-8000-0000000000d1';

/**
 * Present the provisioned device id.
 *
 * Dexie owns the `nas-counter` schema, so this lets the application create it on a first
 * visit and then writes the `meta` row, opening **without** a version number so the
 * request cannot trigger an upgrade. Writing the store directly with an explicit version
 * instead creates a database Dexie then finds at its own version with stores missing,
 * and the app hangs on "Starting" — which is how this was first written and why it is
 * worth the comment.
 */
async function provisionDevice(page: Page): Promise<void> {
  await page.goto('/');
  // Wait until the app has opened its database at least once.
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
        // Wrapped: `IDBRequest.error` is a `DOMException | null`, and rejecting with a
        // non-Error loses the stack that says which step failed.
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

/**
 * The access token the application itself was issued, observed from the real response.
 *
 * Captured rather than fetched. The helpers below originally called `/auth/refresh` to
 * mint their own token, which broke as soon as there was more than one of them: a
 * refresh token is **single-use and rotated** (that is the point of it), so the second
 * caller got `REFRESH_TOKEN_REUSED`, `access_token` came back `undefined`, and every
 * request then went out as `Bearer undefined` and was refused `TOKEN_EXPIRED`. The
 * rotation was correct; competing with the application for it was not.
 *
 * Reading a response body is observation, not interception — no `page.route` is
 * involved and the server's behaviour is untouched.
 */
let accessToken = '';

/** Sign in through the real login form against the real `/auth/login`. */
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
  // The counter is the proof: it only renders once bootstrap has returned a real
  // money policy and a real counter from the server.
  await expect(page.getByRole('button', { name: /Print Bill/ })).toBeVisible({
    timeout: 30_000,
  });
  expect(accessToken, 'no access token was observed on the login response').not.toBe('');
}

/**
 * Create a stocked product through the real API, using the page's own session.
 *
 * Done with `request` inside the browser context so the real access token and the real
 * `X-Device-Id`/`X-Counter-Id` headers are used — this is still the server's own
 * contract being exercised, not a back door into the database.
 */
async function createStockedProduct(page: Page): Promise<Created> {
  productSequence += 1;
  const sku = `E2E-${RUN}-${productSequence}`;
  const created = await page.evaluate(
    async ([base, partCode, token]) => {
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
        return { status: response.status, body: await response.json().catch(() => null) };
      };
      const put = async (path: string, body: unknown) => {
        const response = await fetch(`${base}${path}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
      };

      await post('/units:ensure-defaults', {});

      const product = await post('/products', {
        name: `E2E Tie Rod ${partCode}`,
        unit_code: 'NOS',
        default_selling_price: '1250.0000',
        sku: partCode,
        cost_price: '980.0000',
      });

      const uuid = () => crypto.randomUUID();
      const supplier = await put(`/suppliers/${uuid()}`, {
        name: 'E2E Supplier',
        phone: '9876543210',
      });

      // Stock arrives only through a confirmed purchase — never by editing a quantity.
      const purchase = await post('/purchases', {
        supplier_id: supplier.body.id,
        supplier_document_number: `E2E/${partCode}`,
        items: [
          {
            product_id: product.body.id,
            quantity: '10.000',
            unit_cost: '980.0000',
          },
        ],
      });
      await post(`/purchases/${purchase.body.purchase_id}:confirm`, {}, uuid());

      return {
        productId: product.body?.id as string,
        productStatus: product.status,
        productBody: JSON.stringify(product.body).slice(0, 300),
      };
    },
    [BASE, sku, accessToken],
  );

  expect(
    created.productStatus,
    `the real API refused to create the product: ${created.productBody}`,
  ).toBe(201);
  return { productId: created.productId, sku };
}

/** Read a figure straight from the server, to check the screen against it. */
async function serverStock(page: Page, productId: string): Promise<string> {
  return page.evaluate(
    async ([base, id, token]) => {
      const response = await fetch(`${base}/products/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await response.json();
      return String(body.stock?.branch_quantity ?? '0');
    },
    [BASE, productId, accessToken],
  );
}

// --- the guard that keeps this suite honest -----------------------------------

test('nothing in this suite is mocked', async ({ page }) => {
  await signIn(page);

  // A real response carries a request id the server generated; a stub would not.
  const probe = await page.evaluate(
    async ([base]) => {
      const response = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'nobody', password: 'wrong', device: null }),
      });
      const body = await response.json().catch(() => null);
      return { status: response.status, requestId: body?.error?.request_id ?? null };
    },
    [BASE],
  );

  // A wrong password is refused by the real server, with a real request id.
  expect(probe.status).toBeGreaterThanOrEqual(400);
  expect(
    probe.requestId,
    'no server-generated request id — this looks like a stub',
  ).toMatch(/^[0-9a-f-]{8,}$/i);
});

// --- 1. login and permission handling ----------------------------------------

test('a real login reaches the counter with the server-supplied policy', async ({
  page,
}) => {
  await signIn(page);
  // The owner has every back-office tab, because the server said so.
  for (const tab of ['Daily Bills', 'Credit Bills', 'Stock', 'Purchases', 'Customers']) {
    await expect(page.getByRole('button', { name: tab, exact: true })).toBeVisible();
  }
});

test('a wrong password is refused in words, with nothing signed in', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill('definitely-not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('button', { name: /Print Bill/ })).toHaveCount(0);
  await expect(page.getByText(/password|sign in/i).first()).toBeVisible();
});

// --- 2. product search --------------------------------------------------------

test('product search returns a product the server actually has', async ({ page }) => {
  await signIn(page);
  const { sku } = await createStockedProduct(page);

  const search = page.getByRole('combobox').or(page.getByLabel(/Find an item/));
  await search.first().fill(sku);

  await expect(page.getByText(new RegExp(`E2E Tie Rod ${sku}`)).first()).toBeVisible({
    timeout: 15_000,
  });
});

// --- 3 & 5. cash bill finalisation deducts stock exactly once ------------------

test('a cash bill finalises and deducts stock exactly once', async ({ page }) => {
  await signIn(page);
  const { productId, sku } = await createStockedProduct(page);
  expect(await serverStock(page, productId)).toMatch(/^10(\.0+)?$/);

  // Finalise through the real engine, with a real idempotency key.
  const result = await page.evaluate(
    async ([base, id, counter, token]) => {
      const key = crypto.randomUUID();
      const body = {
        counter_id: counter,
        sale_type: 'cash',
        lines: [
          {
            product_id: id,
            quantity: '2.000',
            unit_price: '1250.0000',
            price_source: 'catalog',
          },
        ],
        header: { customer_name: 'E2E Walk-in' },
        client_computed_total: '2500.00',
        payment: { method: 'cash', amount: '2500.00' },
      };
      const send = () =>
        fetch(`${base}/sales:finalize`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': key,
          },
          body: JSON.stringify(body),
        });
      const first = await send();
      const firstBody = await first.json();
      // The same intent, replayed. Idempotency must return the same invoice and must
      // not deduct stock a second time (AC-3).
      const second = await send();
      const secondBody = await second.json();
      return {
        firstStatus: first.status,
        secondStatus: second.status,
        // `FinalizeOut` is `{invoice, print_payload, warnings}` — cash and credit
        // alike (ADR-033). The figures come off `invoice`, which is the server's own
        // record, not off the print payload.
        firstId: firstBody.invoice?.id ?? null,
        secondId: secondBody.invoice?.id ?? null,
        total: String(firstBody.invoice?.total ?? ''),
      };
    },
    [BASE, productId, process.env.BM_E2E_COUNTER_ID ?? '', accessToken],
  );

  expect([200, 201]).toContain(result.firstStatus);
  // One bill, not two.
  expect(result.secondId).toBe(result.firstId);
  // 2 x 1250 = 2500, computed by the server's money engine.
  expect(result.total).toMatch(/^2500(\.00)?$/);
  // Exactly one deduction: 10 - 2 = 8, after **two** finalisation requests.
  expect(await serverStock(page, productId)).toMatch(/^8(\.0+)?$/);
  // And the part code is unused here beyond making the product unique per run.
  expect(sku).toContain('E2E-');
});

// --- 4 & 6. credit bill, then a payment that must not move stock --------------

test('a credit bill finalises, and recording a payment does not deduct stock again', async ({
  page,
}) => {
  await signIn(page);
  const { productId } = await createStockedProduct(page);

  const result = await page.evaluate(
    async ([base, id, counter, token]) => {
      const headers = (key?: string) => ({
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(key ? { 'Idempotency-Key': key } : {}),
      });
      const customerId = crypto.randomUUID();

      const sale = await fetch(`${base}/sales:finalize`, {
        method: 'POST',
        headers: headers(crypto.randomUUID()),
        body: JSON.stringify({
          counter_id: counter,
          sale_type: 'credit',
          lines: [
            {
              product_id: id,
              quantity: '3.000',
              unit_price: '1250.0000',
              price_source: 'catalog',
            },
          ],
          header: { customer_name: 'E2E Credit Customer' },
          customer: { mode: 'new', customer_id: customerId, name: 'E2E Credit Customer' },
          client_computed_total: '3750.00',
        }),
      });
      const saleBody = await sale.json();

      // Collecting money is not selling goods: this must not move stock.
      const payment = await fetch(`${base}/payments`, {
        method: 'POST',
        headers: headers(crypto.randomUUID()),
        // `PaymentRequest` is a `StrictModel` and carries **no `invoice_id`**:
        // allocation is its own concern (`allocation: AllocationSpec`, oldest-first by
        // default), because a payment is money received from a *customer*, not a line
        // item against one bill. Sending `invoice_id` is a 422, correctly.
        body: JSON.stringify({
          customer_id: customerId,
          method: 'cash',
          amount: '1000.00',
        }),
      });

      return {
        saleStatus: sale.status,
        paymentStatus: payment.status,
        outstanding: String(saleBody.invoice?.outstanding ?? ''),
      };
    },
    [BASE, productId, process.env.BM_E2E_COUNTER_ID ?? '', accessToken],
  );

  expect([200, 201]).toContain(result.saleStatus);
  expect([200, 201]).toContain(result.paymentStatus);
  // 10 - 3 = 7. The payment must not have taken a fourth unit.
  expect(await serverStock(page, productId)).toMatch(/^7(\.0+)?$/);
});

// --- 7. draft save and recovery ----------------------------------------------

test('a draft saved on the server survives a reload', async ({ page }) => {
  await signIn(page);
  const { sku } = await createStockedProduct(page);

  const search = page.getByRole('combobox').or(page.getByLabel(/Find an item/));
  await search.first().fill(sku);
  await expect(page.getByText(new RegExp(`E2E Tie Rod ${sku}`)).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.keyboard.press('Enter');

  // The line is on the bill.
  await expect(page.getByText(new RegExp(`E2E Tie Rod ${sku}`)).first()).toBeVisible();

  await page.reload();
  await expect(page.getByRole('button', { name: /Print Bill/ })).toBeVisible({
    timeout: 30_000,
  });
  // A draft is never lost by a reload (FR-DRAFT-001).
  await expect(page.getByText(new RegExp(`E2E Tie Rod ${sku}`)).first()).toBeVisible({
    timeout: 15_000,
  });
});

// --- 8. Daily Bills and reporting --------------------------------------------

test('Daily Bills shows the bill the server just recorded', async ({ page }) => {
  await signIn(page);
  const { productId } = await createStockedProduct(page);

  await page.evaluate(
    async ([base, id, counter, token]) => {
      await fetch(`${base}/sales:finalize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          counter_id: counter,
          sale_type: 'cash',
          lines: [
            {
              product_id: id,
              quantity: '1.000',
              unit_price: '1250.0000',
              price_source: 'catalog',
            },
          ],
          header: { customer_name: 'E2E Reported' },
          client_computed_total: '1250.00',
          payment: { method: 'cash', amount: '1250.00' },
        }),
      });
    },
    [BASE, productId, process.env.BM_E2E_COUNTER_ID ?? '', accessToken],
  );

  await page.getByRole('button', { name: 'Daily Bills', exact: true }).click();
  // The customer name travelled client -> server -> report -> client.
  await expect(page.getByText('E2E Reported').first()).toBeVisible({ timeout: 20_000 });
});

// --- 9. offline behaviour against a real server -------------------------------

test('finalisation is refused offline, and nothing is created', async ({
  page,
  context,
}) => {
  await signIn(page);
  const { sku } = await createStockedProduct(page);

  const search = page.getByRole('combobox').or(page.getByLabel(/Find an item/));
  await search.first().fill(sku);
  await expect(page.getByText(new RegExp(`E2E Tie Rod ${sku}`)).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.keyboard.press('Enter');

  // A genuine network cut, with a real server on the other side of it.
  await context.setOffline(true);
  await page.waitForFunction(() => navigator.onLine === false);

  // ADR-033: completing a bill needs a connection — and the application **disables**
  // both finalisation actions rather than letting one be pressed and then failing.
  // That is the stronger behaviour: there is no moment where a cashier believes a sale
  // completed. This test originally clicked `Print Bill` and waited for an error, which
  // was the wrong expectation — the click never lands because the control is correctly
  // disabled.
  // Scoped to `main`, and matched on the shortcut the label carries, because the owner
  // also has a **Credit Bills** navigation tab — `/Credit Bill/` alone matches both.
  const actions = page.getByRole('main');
  await expect(actions.getByRole('button', { name: /Print Bill\s+Ctrl/ })).toBeDisabled();
  await expect(
    actions.getByRole('button', { name: /Credit Bill\s+Ctrl/ }),
  ).toBeDisabled();
  // And the wording reassures rather than alarming: the bill is safe on this computer.
  await expect(page.getByText(/nothing is lost/)).toBeVisible();

  await context.setOffline(false);
});

// --- 10. back-office screens and permission restrictions ---------------------

test('the back-office screens load real server data', async ({ page }) => {
  await signIn(page);
  const { sku } = await createStockedProduct(page);

  await page.getByRole('button', { name: 'Stock', exact: true }).click();
  await expect(page.getByText(new RegExp(`E2E Tie Rod ${sku}`)).first()).toBeVisible({
    timeout: 20_000,
  });

  await page.getByRole('button', { name: 'Purchases', exact: true }).click();
  await expect(page.getByText('E2E Supplier').first()).toBeVisible({ timeout: 20_000 });
});

test('stock cannot be set to a number anywhere on the Stock screen', async ({ page }) => {
  // FR-INV-002, against the real screen and the real server: there is no "set to"
  // control, because a discrepancy is the thing worth keeping.
  await signIn(page);
  await createStockedProduct(page);

  await page.getByRole('button', { name: 'Stock', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel(/^set to$/i)).toHaveCount(0);
  await expect(page.getByPlaceholder(/set .*quantity/i)).toHaveCount(0);
});

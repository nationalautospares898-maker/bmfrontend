/**
 * The Stock Movement Report, against a real backend and a real database.
 *
 * This is an inventory report, so the tests are about **the figures being right**, not
 * about the panel opening. Every scenario builds the data through the real workflows —
 * a confirmed purchase for stock in, a finalised bill for stock out — and then checks
 * that the report says what actually happened:
 *
 * * the quantity moved, and the stock **before** and **after** that movement;
 * * the document behind it (a supplier's number, or an invoice reference);
 * * cash or credit, for a sale;
 * * and that the things which move no stock — a draft, a reprint, a credit payment —
 *   are nowhere to be seen.
 *
 * `stock_before` is `balance_after - quantity_delta` taken from the ledger, so a wrong
 * figure here means the ledger itself is being misread. That is why the assertions are on
 * exact numbers rather than on "a row appeared".
 *
 * Scenario C is the regression half: the Stock screen's existing controls are all still
 * there and still work while the report is open.
 *
 * Nothing is mocked. The owner's `bm` database is never touched — this runs against the
 * disposable `bm_accept` tenant.
 */

import { expect, test, type Page } from '@playwright/test';

const API_URL = process.env.BM_E2E_API_URL;
const PROXIED = Boolean(process.env.BM_DEV_API_PROXY);
const USERNAME = process.env.BM_E2E_USERNAME ?? 'e2e-owner';
const PASSWORD = process.env.BM_E2E_PASSWORD ?? 'e2e-only-not-a-real-password-01';
// Matches `full-stack.spec.ts`'s own `BASE`: under `BM_E2E_API_URL` (not proxied), the
// built app's own API calls go to an **absolute** URL (`vite.config.ts` bakes
// `VITE_API_BASE_URL` in at build time) — a relative `/api/v1` fetch from this helper
// has no proxy to reach it under that mode and would silently hit the preview server's
// own SPA fallback instead, parsing its HTML as JSON and failing with a null body.
const BASE = PROXIED ? '/api/v1' : `${API_URL ?? ''}/api/v1`;

test.skip(
  !API_URL && !PROXIED,
  'Needs a real backend: set BM_DEV_API_PROXY (preferred — works with an isolated ' +
    'database) or BM_E2E_API_URL, and seed scripts/seed_e2e_tenant.py first.',
);

let token = '';
let businessDate = '';

async function signIn(page: Page): Promise<void> {
  token = '';
  page.on('response', (response) => {
    if (response.url().includes('/auth/login') && response.status() === 200) {
      void response
        .json()
        .then((body: { access_token?: string }) => {
          if (body.access_token) token = body.access_token;
        })
        .catch(() => {});
    }
  });
  await page.goto('/');
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // The **shop's** date, from the server. The report opens on it, and a test that used
  // the runner's clock would disagree with the application for five and a half hours a
  // day.
  const bootstrap = await api<{ business_date: string }>(page, '/sync/bootstrap');
  businessDate = bootstrap.body.business_date;

  // A freshly reset tenant has no units, and a product cannot be created without one.
  // Idempotent, so calling it per test costs nothing.
  const units = await api(page, '/units:ensure-defaults', { method: 'POST' });
  expect([200, 201]).toContain(units.status);
}

async function api<T>(
  page: Page,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ base, p, bearer, method, body }) => {
      const response = await fetch(`${base}${p}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
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
    {
      base: BASE,
      p: path,
      bearer: token,
      method: init?.method ?? 'GET',
      body: init?.body ?? null,
    },
  );
}

/** A product with no stock at all, so the before/after figures start from a known zero. */
async function newProduct(
  page: Page,
  label: string,
): Promise<{ id: string; name: string }> {
  const name = `RPT ${label} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const created = await api<{ id: string }>(page, '/products', {
    method: 'POST',
    body: {
      name,
      unit_code: 'NOS',
      default_selling_price: '100.0000',
      sku: name.replace(/\s+/g, '-'),
    },
  });
  expect(created.status, `product: ${JSON.stringify(created.body)}`).toBe(201);
  return { id: created.body.id, name };
}

/** Stock in through a confirmed purchase — the sanctioned receiving path. */
async function receive(
  page: Page,
  productId: string,
  quantity: string,
  document: string,
): Promise<void> {
  const supplier = await api<{ id: string }>(page, `/suppliers/${crypto.randomUUID()}`, {
    method: 'PUT',
    body: { name: 'Report Supplier' },
  });
  expect(supplier.status).toBe(200);

  // The document number is made unique per call. A supplier bill number may be received
  // only once — `DUPLICATE_SUPPLIER_DOCUMENT` is a real business rule protecting against
  // booking the same delivery twice — so a fixed string collides on the second run
  // against a shared tenant. The caller's label stays as the prefix, which is what the
  // assertions match on.
  const reference = `${document}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

  const purchase = await api<{ purchase_id: string }>(page, '/purchases', {
    method: 'POST',
    body: {
      supplier_id: supplier.body.id,
      supplier_document_number: reference,
      items: [{ product_id: productId, quantity, unit_cost: '60.0000' }],
    },
  });
  expect(purchase.status, `purchase: ${JSON.stringify(purchase.body)}`).toBe(201);

  const confirmed = await api(page, `/purchases/${purchase.body.purchase_id}:confirm`, {
    method: 'POST',
  });
  expect(confirmed.status, `confirm: ${JSON.stringify(confirmed.body)}`).toBe(200);
}

/** Finalise a bill — the only thing that deducts stock. */
async function sell(
  page: Page,
  productId: string,
  quantity: string,
  options: { credit?: boolean; customerId?: string } = {},
): Promise<string> {
  const total = `${Number(quantity) * 100}.00`;
  const body: Record<string, unknown> = {
    counter_id: process.env.BM_E2E_COUNTER_ID ?? '0192f100-0000-7000-8000-0000000000c1',
    sale_type: options.credit ? 'credit' : 'cash',
    lines: [
      {
        product_id: productId,
        quantity,
        unit_price: '100.0000',
        price_source: 'catalog',
      },
    ],
    header: { customer_name: 'Report Customer' },
    client_computed_total: total,
  };
  if (options.credit) {
    body.customer = { mode: 'existing', customer_id: options.customerId };
  } else {
    body.payment = { method: 'cash', amount: total };
  }

  const sale = await api<{ invoice: { internal_reference: string } }>(
    page,
    '/sales:finalize',
    { method: 'POST', body },
  );
  expect(sale.status, `finalize: ${JSON.stringify(sale.body)}`).toBe(201);
  return sale.body.invoice.internal_reference;
}

/** Open Stock, then the report. */
async function openReport(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: 'Stock', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Stock Movement Report' })).toBeVisible();
  await page.getByRole('button', { name: 'Stock Movement Report' }).click();
  await expect(
    page.getByRole('region', { name: /Stock movement on one day/i }),
  ).toBeVisible();
}

/**
 * Choose a single day — the whole suite's original semantics, before the date range
 * existed. Sets **both** fields to the same value rather than leaving End date at
 * whatever it was, because this tenant is shared across every test in this file: an
 * isolated single day (e.g. `chooseDate(page, '2019-01-01')`, meant to find nothing)
 * would otherwise silently widen into a range ending today and pick up every other
 * test's activity. A test that wants an actual range calls `chooseEndDate` afterwards
 * to override just the end.
 */
async function chooseDate(page: Page, date: string): Promise<void> {
  // Exact match: the panel also has an "End date" field (owner request, 2026-11-11),
  // and `getByLabel('Date')` would otherwise resolve to both.
  await panel(page).getByLabel('Start date', { exact: true }).fill(date);
  await panel(page).getByLabel('End date', { exact: true }).fill(date);
}

async function chooseEndDate(page: Page, date: string): Promise<void> {
  await panel(page).getByLabel('End date', { exact: true }).fill(date);
}

/**
 * The report panel.
 *
 * Every query below is scoped to it. The stock table behind the report lists the same
 * products, so an unscoped `getByRole('row', …)` matches twice and Playwright refuses —
 * which is the right refusal: "the product is on screen" is not the same claim as "the
 * report has a row for it".
 */
function panel(page: Page) {
  return page.getByRole('region', { name: /Stock movement on one day/i });
}

/** Rows of the report for one product. */
function reportRows(page: Page, product: string) {
  return panel(page).getByRole('row', { name: new RegExp(product) });
}

/** The cells of the report row for a product, trimmed. */
async function rowCells(page: Page, product: string): Promise<string[]> {
  const row = reportRows(page, product);
  await expect(row).toBeVisible({ timeout: 15_000 });
  return (await row.getByRole('cell').allInnerTexts()).map((text) => text.trim());
}

/** A summary figure, by its label. */
async function summary(page: Page, label: string): Promise<string> {
  const term = panel(page).getByText(label, { exact: true });
  await expect(term).toBeVisible();
  return (
    (await term.locator('xpath=following-sibling::dd[1]').innerText()) ?? ''
  ).trim();
}

// ---------------------------------------------------------------------------
// Scenario A — Stock Added
// ---------------------------------------------------------------------------

test.describe('A. stock added', () => {
  test('a purchase receipt shows its quantity, before, after and document', async ({
    page,
  }) => {
    await signIn(page);
    const product = await newProduct(page, 'ADD');
    await receive(page, product.id, '12.000', 'SUP/A/001');

    await openReport(page);
    await chooseDate(page, businessDate);
    await panel(page).getByRole('button', { name: 'Stock Added' }).click();

    const cells = await rowCells(page, product.name);
    // code, quantity added, before, after, movement type, reference, time
    expect(cells[1]).toBe('12');
    // Nothing on the shelf before this delivery; twelve after. Both from the ledger.
    expect(cells[2]).toBe('0');
    expect(cells[3]).toBe('12');
    expect(cells[4]).toBe('Purchase');
    expect(cells[5]).toContain('SUP/A/001');
    // A real time of day, not an empty cell.
    expect(cells[6]).toMatch(/\d/);
  });

  test('three deliveries of one product stay separate and chain correctly', async ({
    page,
  }) => {
    // The case a naive report merges. Each delivery is its own row, and each starts
    // where the previous one finished.
    await signIn(page);
    const product = await newProduct(page, 'CHAIN');
    await receive(page, product.id, '5.000', 'SUP/C/1');
    await receive(page, product.id, '3.000', 'SUP/C/2');
    await receive(page, product.id, '2.000', 'SUP/C/3');

    await openReport(page);
    await chooseDate(page, businessDate);
    await panel(page).getByRole('button', { name: 'Stock Added' }).click();

    const rows = reportRows(page, product.name);
    await expect(rows).toHaveCount(3, { timeout: 15_000 });

    const chain: Array<[string, string, string]> = [];
    for (let index = 0; index < 3; index += 1) {
      const cells = (await rows.nth(index).getByRole('cell').allInnerTexts()).map((t) =>
        t.trim(),
      );
      chain.push([cells[1]!, cells[2]!, cells[3]!]);
    }
    expect(chain).toEqual([
      ['5', '0', '5'],
      ['3', '5', '8'],
      ['2', '8', '10'],
    ]);
  });

  test('the owner’s stock sheet appears as an addition too', async ({ page }) => {
    await signIn(page);
    const name = `RPT SHEET ${Date.now().toString(36)}`;
    const saved = await api(page, '/inventory/stock-entries', {
      method: 'POST',
      body: {
        entries: [
          { item: name, price: '100.0000', min_qty: '2.000', stock_qty: '9.000' },
        ],
      },
    });
    expect(saved.status).toBe(200);

    await openReport(page);
    await chooseDate(page, businessDate);
    await panel(page).getByRole('button', { name: 'Stock Added' }).click();

    const cells = await rowCells(page, name);
    expect(cells[1]).toBe('9');
    expect(cells[3]).toBe('9');
    // A sheet entry has no document, and the screen says so rather than inventing one.
    expect(cells[5]).toBe('—');
  });

  test('a day with nothing on it says so', async ({ page }) => {
    await signIn(page);
    await openReport(page);

    await chooseDate(page, '2019-01-01');
    await panel(page).getByRole('button', { name: 'Stock Added' }).click();

    await expect(panel(page).getByText(/No stock was added in this period/)).toBeVisible({
      timeout: 15_000,
    });
    // An empty day is not an empty table — the report shows none at all.
    await expect(panel(page).getByRole('table')).toHaveCount(0);
  });

  test('changing the date reloads the report', async ({ page }) => {
    await signIn(page);
    const product = await newProduct(page, 'DATE');
    await receive(page, product.id, '4.000', 'SUP/D/1');

    await openReport(page);
    await chooseDate(page, businessDate);
    await panel(page).getByRole('button', { name: 'Stock Added' }).click();
    await expect(reportRows(page, product.name)).toBeVisible({ timeout: 15_000 });

    // A day the movement cannot be on.
    await chooseDate(page, '2019-01-02');
    await expect(panel(page).getByText(/No stock was added in this period/)).toBeVisible({
      timeout: 15_000,
    });

    // ...and back again, without a reload of the page.
    await chooseDate(page, businessDate);
    await expect(reportRows(page, product.name)).toBeVisible({ timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// Scenario B — Stock Sold
// ---------------------------------------------------------------------------

test.describe('B. stock sold', () => {
  test('a cash bill and a credit bill both appear, correctly classified', async ({
    page,
  }) => {
    await signIn(page);
    const product = await newProduct(page, 'SOLD');
    await receive(page, product.id, '20.000', 'SUP/S/1');

    const cashRef = await sell(page, product.id, '2.000');

    const customer = await api<{ customer: { id: string } }>(
      page,
      `/customers/${crypto.randomUUID()}`,
      { method: 'PUT', body: { name: `Report Credit ${Date.now().toString(36)}` } },
    );
    expect(customer.status).toBe(200);
    const creditRef = await sell(page, product.id, '3.000', {
      credit: true,
      customerId: customer.body.customer.id,
    });

    await openReport(page);
    await chooseDate(page, businessDate);
    await panel(page).getByRole('button', { name: 'Stock Sold' }).click();

    const rows = reportRows(page, product.name);
    await expect(rows).toHaveCount(2, { timeout: 15_000 });

    // code, quantity sold, before, after, invoice, sale type, time
    const first = (await rows.nth(0).getByRole('cell').allInnerTexts()).map((t) =>
      t.trim(),
    );
    expect(first[1]).toBe('2');
    expect(first[2]).toBe('20');
    expect(first[3]).toBe('18');
    expect(first[4]).toContain(cashRef);
    expect(first[5]).toBe('Cash');

    const second = (await rows.nth(1).getByRole('cell').allInnerTexts()).map((t) =>
      t.trim(),
    );
    expect(second[1]).toBe('3');
    // Starts where the first finished — the chain the owner reads down the column.
    expect(second[2]).toBe('18');
    expect(second[3]).toBe('15');
    expect(second[4]).toContain(creditRef);
    expect(second[5]).toBe('Credit');
  });

  test('the summary counts products, quantity, movements and bills', async ({ page }) => {
    await signIn(page);
    const one = await newProduct(page, 'SUM1');
    const two = await newProduct(page, 'SUM2');
    await receive(page, one.id, '10.000', 'SUP/M/1');
    await receive(page, two.id, '10.000', 'SUP/M/2');
    await sell(page, one.id, '2.000');
    await sell(page, two.id, '4.000');

    await openReport(page);
    await chooseDate(page, businessDate);
    await panel(page).getByRole('button', { name: 'Stock Sold' }).click();
    await expect(reportRows(page, one.name)).toBeVisible({ timeout: 15_000 });

    // These are the whole day's figures for the shared tenant, so they are asserted as
    // "at least what this test created" rather than as exact totals.
    expect(Number(await summary(page, 'Products affected'))).toBeGreaterThanOrEqual(2);
    expect(Number(await summary(page, 'Total quantity sold'))).toBeGreaterThanOrEqual(6);
    expect(Number(await summary(page, 'Stock movements'))).toBeGreaterThanOrEqual(2);
    expect(Number(await summary(page, 'Invoices'))).toBeGreaterThanOrEqual(2);
  });

  test('a draft, a reprint and a credit payment move no stock', async ({ page }) => {
    /**
     * The three exclusions, each exercised for real rather than assumed. None of them
     * writes a `stock_movements` row, so the report cannot show them whatever it does —
     * but "cannot by construction" is worth demonstrating once.
     */
    await signIn(page);
    const product = await newProduct(page, 'EXCL');
    await receive(page, product.id, '30.000', 'SUP/E/1');

    const customer = await api<{ customer: { id: string } }>(
      page,
      `/customers/${crypto.randomUUID()}`,
      { method: 'PUT', body: { name: `Report Excl ${Date.now().toString(36)}` } },
    );
    const reference = await sell(page, product.id, '5.000', {
      credit: true,
      customerId: customer.body.customer.id,
    });

    await openReport(page);
    await chooseDate(page, businessDate);
    await panel(page).getByRole('button', { name: 'Stock Sold' }).click();
    const before = await rowCells(page, product.name);
    expect(before[1]).toBe('5');

    // A draft holding ten of the same product.
    const draft = await api(page, `/drafts/${crypto.randomUUID()}`, {
      method: 'PUT',
      body: {
        counter_id:
          process.env.BM_E2E_COUNTER_ID ?? '0192f100-0000-7000-8000-0000000000c1',
        items: [
          {
            id: crypto.randomUUID(),
            line_no: 1,
            product_id: product.id,
            quantity: '10.000',
            unit_price: '100.0000',
            price_source: 'catalog',
          },
        ],
      },
    });
    expect([200, 201]).toContain(draft.status);

    // A payment settling the credit bill.
    const payment = await api(page, '/payments', {
      method: 'POST',
      body: {
        customer_id: customer.body.customer.id,
        amount: '500.00',
        method: 'cash',
        allocation: { strategy: 'oldest_first' },
      },
    });
    expect([200, 201]).toContain(payment.status);

    await panel(page).getByRole('button', { name: 'Refresh report' }).click();

    // Still exactly one deduction of five, and the stock after is unchanged. The draft
    // and the payment have added nothing.
    const after = await rowCells(page, product.name);
    expect(after[1]).toBe('5');
    expect(after[3]).toBe(before[3]);
    expect(after[4]).toContain(reference);
    await expect(reportRows(page, product.name)).toHaveCount(1);
  });

  test('switching between added and sold reloads each view', async ({ page }) => {
    await signIn(page);
    const product = await newProduct(page, 'SWITCH');
    await receive(page, product.id, '8.000', 'SUP/W/1');
    await sell(page, product.id, '3.000');

    await openReport(page);
    await chooseDate(page, businessDate);

    await panel(page).getByRole('button', { name: 'Stock Added' }).click();
    expect((await rowCells(page, product.name))[1]).toBe('8');

    await panel(page).getByRole('button', { name: 'Stock Sold' }).click();
    expect((await rowCells(page, product.name))[1]).toBe('3');

    await panel(page).getByRole('button', { name: 'Stock Added' }).click();
    expect((await rowCells(page, product.name))[1]).toBe('8');
  });
});

// ---------------------------------------------------------------------------
// Scenario C — nothing that worked before has stopped
// ---------------------------------------------------------------------------

test.describe('C. the Stock screen still works', () => {
  test('every existing control is present and usable with the report open', async ({
    page,
  }) => {
    await signIn(page);
    const product = await newProduct(page, 'REG');
    await receive(page, product.id, '15.000', 'SUP/R/1');

    await openReport(page);

    // Add Items, the filter, the low-stock toggle and Refresh are all still there.
    await expect(page.getByRole('button', { name: 'Add Items' })).toBeVisible();
    await expect(page.getByLabel(/Find an item/)).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Only what is running low/i }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Refresh', exact: true }),
    ).toBeVisible();

    // The stock table is still the stock table.
    const table = page.getByRole('table', { name: /Stock on hand/i });
    await expect(table).toBeVisible();

    // The filter still filters.
    await page.getByLabel(/Find an item/).fill(product.name);
    await expect(table.getByText(product.name).first()).toBeVisible({ timeout: 15_000 });
  });

  test('the per-product History still opens and shows its own ledger', async ({
    page,
  }) => {
    // The feature this report sits beside, not on top of.
    await signIn(page);
    const product = await newProduct(page, 'HIST');
    await receive(page, product.id, '7.000', 'SUP/H/1');

    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('button', { name: 'Stock', exact: true })
      .click();
    await page.getByLabel(/Find an item/).fill(product.name);

    const row = page
      .getByRole('table', { name: /Stock on hand/i })
      .getByRole('row', { name: new RegExp(product.name) });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole('button', { name: 'History' }).click();

    await expect(page.getByText(/Stock history/i).first()).toBeVisible();
    // Its own running balance, from the same ledger the report reads.
    await expect(page.getByText('7', { exact: false }).first()).toBeVisible();
  });

  test('the report can be closed, leaving the screen as it was', async ({ page }) => {
    await signIn(page);
    await openReport(page);

    await panel(page).getByRole('button', { name: 'Close report' }).click();

    await expect(
      page.getByRole('region', { name: /Stock movement on one day/i }),
    ).toHaveCount(0);
    await expect(page.getByRole('table', { name: /Stock on hand/i })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add Items' })).toBeVisible();
  });

  test('the report is reachable and operable with the keyboard', async ({ page }) => {
    await signIn(page);
    await openReport(page);

    /**
     * Both dates, the three views, refresh and close, in that order.
     *
     * Stops with no label are skipped deliberately: `<input type="date">` is a composite
     * control, and Chromium gives its day, month and year segments their own tab stops
     * before focus leaves the field — true of **both** date fields now (owner request,
     * 2026-11-11: a start and an end). That is the platform's behaviour for every date
     * field on the web, so the assertion is about the **order of the panel's controls**,
     * not about how many presses the browser spends inside either widget.
     */
    await panel(page).getByLabel('Start date', { exact: true }).focus();
    const seen: string[] = [];
    for (let step = 0; step < 20 && seen.length < 5; step += 1) {
      await page.keyboard.press('Tab');
      const label = await page.evaluate(() =>
        (document.activeElement?.textContent ?? '').trim().slice(0, 24),
      );
      if (label) seen.push(label);
    }
    expect(seen).toEqual([
      'Stock Added',
      'Stock Sold',
      'Adjustments',
      'Refresh report',
      'Close report',
    ]);

    // And Enter on a focused view actually loads it.
    await panel(page).getByRole('button', { name: 'Stock Sold' }).focus();
    await page.keyboard.press('Enter');
    await expect(panel(page).getByRole('button', { name: 'Stock Sold' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario D — the date range and Adjustments (owner request, 2026-11-11)
// ---------------------------------------------------------------------------

test.describe('D. the date range and adjustments', () => {
  test('widening the end date includes a movement the single day would miss', async ({
    page,
  }) => {
    await signIn(page);
    const product = await newProduct(page, 'RANGE');
    await receive(page, product.id, '6.000', 'SUP/RANGE/1');

    await openReport(page);
    await chooseDate(page, businessDate);
    await panel(page).getByRole('button', { name: 'Stock Added' }).click();
    await expect(reportRows(page, product.name)).toBeVisible({ timeout: 15_000 });

    // A single day ahead of today: nothing in range, so the movement disappears —
    // proving the end date is actually read, not ignored.
    const tomorrow = new Date(`${businessDate}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    await chooseDate(page, tomorrowStr);
    await chooseEndDate(page, tomorrowStr);
    await expect(panel(page).getByText(/No stock was added in this period/)).toBeVisible({
      timeout: 15_000,
    });

    // Widen the range back to cover today: the same movement is visible again.
    await chooseDate(page, businessDate);
    await chooseEndDate(page, tomorrowStr);
    await expect(reportRows(page, product.name)).toBeVisible({ timeout: 15_000 });
  });

  test('a downward correction appears under Adjustments, not Stock Added or Stock Sold', async ({
    page,
  }) => {
    await signIn(page);
    const product = await newProduct(page, 'ADJ');
    await receive(page, product.id, '10.000', 'SUP/ADJ/1');
    const adjust = await api(page, '/inventory/adjustments', {
      method: 'POST',
      body: {
        product_id: product.id,
        quantity_delta: '-4.000',
        reason_code: 'adjustment_decrease',
        reason_text: 'E2E: damaged in the stockroom',
      },
    });
    expect([200, 201]).toContain(adjust.status);

    await openReport(page);
    await chooseDate(page, businessDate);

    await panel(page).getByRole('button', { name: 'Stock Added' }).click();
    const added = await rowCells(page, product.name);
    expect(added[1]).toBe('10'); // only the receipt, not the correction

    await panel(page).getByRole('button', { name: 'Stock Sold' }).click();
    await expect(reportRows(page, product.name)).toHaveCount(0);

    await panel(page).getByRole('button', { name: 'Adjustments' }).click();
    const adjusted = await rowCells(page, product.name);
    // code, quantity adjusted, before, after, movement type, source, reference, time
    expect(adjusted[1]).toBe('4');
    expect(adjusted[2]).toBe('10');
    expect(adjusted[3]).toBe('6');
    expect(adjusted[4]).toBe('Correction (less)');
  });
});

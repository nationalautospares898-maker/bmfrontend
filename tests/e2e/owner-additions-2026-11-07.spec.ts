/**
 * The owner's 2026-11-07 additions, in a real browser against the real backend.
 *
 * Nothing here is stubbed. The bundle is built with `BM_DEV_API_PROXY` pointing at a
 * live FastAPI process talking to a real PostgreSQL, so every figure asserted below came
 * out of the real money engine and every row written is a real row.
 *
 * What each test is actually proving, as opposed to what it looks like it checks:
 *
 * | Feature | The assertion that matters |
 * |---|---|
 * | F1 add-missing-item | the product **persists** and is findable by a *second* search |
 * | F1 stock correctness | creating a catalogue entry writes **no** stock movement |
 * | F2 mechanic | the name typed on bill 1 is **suggested** on bill 2 |
 * | F4 packing tick | ticking it does not move the total |
 * | F12 advance | the server's `outstanding` is total − advance, and `total` is unchanged |
 * | F13 per-invoice payment | the named invoice's own paid/outstanding move |
 * | F7–F10 edit in place | the bill keeps its id and reference, and its revision is recorded |
 *
 * Skipped, loudly, without a backend — a full-stack suite that passes with no server is
 * worse than one that does not run.
 */

import { expect, test, type Page } from '@playwright/test';

const API_URL = process.env.BM_E2E_API_URL;
const PROXIED = Boolean(process.env.BM_DEV_API_PROXY);
const BASE = PROXIED ? '/api/v1' : `${API_URL ?? ''}/api/v1`;

const USERNAME = process.env.BM_E2E_USERNAME ?? 'e2e-owner';
const PASSWORD = process.env.BM_E2E_PASSWORD ?? 'e2e-only-not-a-real-password-01';
const PROVISIONED_DEVICE_ID =
  process.env.BM_E2E_DEVICE_ID ?? '0192f100-0000-7000-8000-0000000000d1';

test.skip(
  !API_URL && !PROXIED,
  'Needs a real backend: set BM_DEV_API_PROXY (preferred) or BM_E2E_API_URL, and seed ' +
    'scripts/seed_e2e_tenant.py first.',
);

/**
 * A name the catalogue genuinely cannot match — including by trigram, including across
 * runs.
 *
 * This matters more than it looks. "Add New Item to Stock" is offered **only when the
 * search found nothing**, and that search has a fuzzy tier. Any shared stem is enough
 * for `pg_trgm` to match: names like `E2E Brake abc-1` and `E2E Clutch abc-2` matched
 * each other within a run, and names reused across runs matched the products the
 * previous run had left behind. Both times the affordance correctly did **not** appear
 * and the test was wrong.
 *
 * So a name here is fourteen random letters and nothing else. Two such names share
 * essentially no trigrams, so similarity sits near zero whatever is already in the
 * catalogue. Unreadable in the database, which is the right trade for a disposable one.
 */
function unique(): string {
  return Array.from({ length: 14 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join('');
}

let accessToken = '';

/**
 * The id of the invoice the UI most recently finalised.
 *
 * Captured from the `sales:finalize` response rather than looked up afterwards. The
 * lookup approach is what made the advance test unreliable: `GET /invoices` is not
 * newest-first, so `items[0]` was an invoice from an earlier run of the same test, and
 * matching on `customer_name` did not work either because the summary carries the
 * customer *record's* name, which a just-created customer has not necessarily had
 * written back by the time the assertion runs.
 *
 * Reading the id the server returned to the browser removes the guess entirely — and it
 * is the id the UI itself is working with, which is what the test should be asserting
 * against.
 */
let lastInvoiceId = '';

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
          tx.oncomplete = () => {
            database.close();
            resolve();
          };
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

  lastInvoiceId = '';
  page.on('response', (response) => {
    if (!response.url().includes('/sales:finalize')) return;
    if (response.status() !== 201) return;
    void response
      .json()
      .then((body: { invoice?: { id?: string } }) => {
        if (body.invoice?.id) lastInvoiceId = body.invoice.id;
      })
      .catch(() => {
        /* a refused finalisation has no invoice to capture */
      });
  });

  await provisionDevice(page);
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // The counter renders only once bootstrap has returned a real money policy and a
  // real counter from the server.
  await expect(page.getByRole('button', { name: /Print Bill/ })).toBeVisible({
    timeout: 30_000,
  });
  expect(accessToken, 'no access token was observed on the login response').not.toBe('');
}

/** A direct read from the server, to check the screen against it. */
async function serverGet(page: Page, path: string): Promise<Record<string, unknown>> {
  return page.evaluate(
    async ([base, p, token]) => {
      const response = await fetch(`${base}${p}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return (await response.json()) as Record<string, unknown>;
    },
    [BASE, path, accessToken] as const,
  );
}

/**
 * Make sure the default units exist.
 *
 * `POST /products` resolves `unit_code: 'NOS'` against the business's own `units`, and
 * `seed_e2e_tenant.py --reset` removes them along with the business — so on a freshly
 * reset tenant a product create fails until this has run. `full-stack.spec.ts` does the
 * same thing inside its own fixture for the same reason. It is environment provisioning,
 * not a workaround: a real deployment gets its units from migration `0016_seed_units`.
 */
async function ensureUnits(page: Page): Promise<void> {
  await page.evaluate(
    async ([base, token]) => {
      await fetch(`${base}/units:ensure-defaults`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: '{}',
      });
    },
    [BASE, accessToken] as const,
  );
}

/**
 * A product with real stock, created through the real API.
 *
 * Stock arrives only through a confirmed purchase — never by setting a number — so that
 * is what this does. Used by the money tests, which must not be entangled with the
 * oversell path that a zero-stock product would (correctly) trigger.
 */
async function stockedProduct(page: Page, name: string, price: string): Promise<string> {
  return page.evaluate(
    async ([base, token, productName, sellingPrice]) => {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      };
      const uuid = () => crypto.randomUUID();
      // Typed as `Record<string, string>` rather than left as `any`: these responses
      // are only ever read for an `id`, and an implicit `any` return trips
      // `no-unsafe-return`.
      const post = async (
        path: string,
        body: unknown,
        key?: string,
      ): Promise<Record<string, string>> => {
        const response = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: key ? { ...headers, 'Idempotency-Key': key } : headers,
          body: JSON.stringify(body),
        });
        return (await response.json()) as Record<string, string>;
      };
      const put = async (
        path: string,
        body: unknown,
      ): Promise<Record<string, string>> => {
        const response = await fetch(`${base}${path}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(body),
        });
        return (await response.json()) as Record<string, string>;
      };

      await post('/units:ensure-defaults', {});
      const product = await post('/products', {
        name: productName,
        unit_code: 'NOS',
        default_selling_price: sellingPrice,
      });
      const supplier = await put(`/suppliers/${uuid()}`, { name: 'E2E Supplier' });
      const purchase = await post('/purchases', {
        supplier_id: supplier.id,
        supplier_document_number: `E2E/${productName}`,
        items: [{ product_id: product.id, quantity: '10.000', unit_cost: '1.0000' }],
      });
      await post(`/purchases/${purchase.purchase_id}:confirm`, {}, uuid());
      // `Record<string, string>` indexes as possibly-undefined under
      // `noUncheckedIndexedAccess`; the create is asserted below by the caller.
      return product.id ?? '';
    },
    [BASE, accessToken, name, price] as const,
  );
}

// --- F1: adding a missing item from the bill ----------------------------------

test('a missing part can be created from the bill, and is then findable', async ({
  page,
}) => {
  await signIn(page);
  await ensureUnits(page);
  const name = unique();

  await page.locator('[data-cell="0-item"]').fill(name);

  // Offered because the real catalogue search came back with nothing.
  const create = page.getByRole('button', { name: 'Add New Item to Stock' });
  await expect(create).toBeVisible({ timeout: 15_000 });
  await create.click();

  await expect(page.getByLabel('Minimum quantity')).toHaveValue('10');
  await page.getByLabel('Selling price').fill('450');
  await page.getByRole('button', { name: 'Create and add to the bill' }).click();

  // It landed on the bill being written, with no "search for it again" step.
  await expect(page.locator('[data-cell="0-item"][aria-readonly="true"]')).toContainText(
    name,
    { timeout: 15_000 },
  );

  // And it genuinely persisted: a fresh search of the real catalogue finds it.
  const found = await serverGet(
    page,
    `/products/search?query=${encodeURIComponent(name)}`,
  );
  const items = found.items as { name: string; default_selling_price: string }[];
  expect(items.map((i) => i.name)).toContain(name);
  // The price typed on the bill became the product's selling price.
  expect(items[0]?.default_selling_price).toBe('450.0000');
});

test('creating a product from the bill adds NO stock', async ({ page }) => {
  // The correctness point from the brief: a catalogue entry is not a delivery.
  await signIn(page);
  await ensureUnits(page);
  const name = unique();

  await page.locator('[data-cell="0-item"]').fill(name);
  await page.getByRole('button', { name: 'Add New Item to Stock' }).click();
  await page.getByLabel('Selling price').fill('300');
  await page.getByRole('button', { name: 'Create and add to the bill' }).click();
  await expect(page.locator('[data-cell="0-item"][aria-readonly="true"]')).toContainText(
    name,
    { timeout: 15_000 },
  );

  const found = await serverGet(
    page,
    `/products/search?query=${encodeURIComponent(name)}`,
  );
  const product = (found.items as { id: string }[])[0];
  const detail = await serverGet(page, `/products/${product?.id}`);
  const stock = detail.stock as { branch_quantity?: string } | null;

  // Zero, or absent — never a fabricated quantity.
  expect(stock?.branch_quantity ?? '0').toMatch(/^0(\.0+)?$/);

  // And no movement row was written for it at all.
  const movements = await serverGet(
    page,
    `/inventory/movements?product_id=${product?.id}`,
  );
  expect((movements.items as unknown[]) ?? []).toHaveLength(0);
});

async function sellNewZeroStockProduct(
  page: Page,
  saleType: 'cash' | 'credit',
): Promise<void> {
  await signIn(page);
  await ensureUnits(page);
  const name = unique();
  await page.locator('[data-cell="0-item"]').fill(name);
  await page.getByRole('button', { name: 'Add New Item to Stock' }).click();
  await page.getByLabel('Selling price').fill('1250');
  await page.getByRole('button', { name: 'Create and add to the bill' }).click();
  await expect(page.locator('[data-cell="0-item"][aria-readonly="true"]')).toContainText(
    name,
    { timeout: 15_000 },
  );

  const found = await serverGet(
    page,
    `/products/search?query=${encodeURIComponent(name)}`,
  );
  const product = (found.items as { id: string }[])[0];
  expect(product?.id).toBeTruthy();
  const detail = await serverGet(page, `/products/${product?.id}`);
  const stock = detail.stock as { branch_quantity?: string } | null;
  expect(stock?.branch_quantity ?? '0').toMatch(/^0(\.0+)?$/);
  const before = await serverGet(page, `/inventory/movements?product_id=${product?.id}`);
  expect((before.items as unknown[]) ?? []).toHaveLength(0);

  let customer = '';
  if (saleType === 'credit') {
    customer = unique();
    await page.getByLabel(/Customer Name/).fill(customer);
    await page.getByRole('button', { name: /Save as a new customer/ }).click();
    await expect(page.getByText(customer)).toBeVisible({ timeout: 15_000 });
  }

  const actionButton =
    saleType === 'cash'
      ? page.getByRole('button', { name: /Print Bill/ })
      : page.getByRole('button', {
          name: 'Credit Bill Ctrl+Shift+Enter',
          exact: true,
        });
  await actionButton.click();
  const approval = page.getByRole('checkbox', {
    name: 'I approve this sale against insufficient recorded stock',
  });
  await expect(approval).toBeVisible({ timeout: 15_000 });
  await approval.check();
  await page
    .getByLabel('Reason (required)')
    .fill('Verified item supplied and owner approved the exception');
  await actionButton.click();
  await expect(page.getByText(/completed|Print now/i).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect.poll(() => lastInvoiceId, { timeout: 20_000 }).not.toBe('');

  const invoice = await serverGet(page, `/invoices/${lastInvoiceId}`);
  expect(invoice.total).toBe('1250.00');
  expect(invoice.is_credit).toBe(saleType === 'credit');
  expect(invoice.payment_status).toBe(saleType === 'cash' ? 'paid' : 'unpaid');
  expect(invoice.oversell_override).toBe(true);
  expect(invoice.oversell_reason).toBe(
    'Verified item supplied and owner approved the exception',
  );
  const after = await serverGet(page, `/inventory/movements?product_id=${product?.id}`);
  const moves = after.items as Array<Record<string, unknown>>;
  expect(moves).toHaveLength(1);
  expect(moves[0]?.quantity_delta).toBe('-1.000');
  expect(moves[0]?.oversell_override).toBe(true);
  expect(moves[0]?.override_reason).toBe(invoice.oversell_reason);
}

test('a zero-stock catalogue product can be sold for cash with a reasoned override', async ({
  page,
}) => {
  await sellNewZeroStockProduct(page, 'cash');
});

test('a zero-stock catalogue product can be sold on credit with a reasoned override', async ({
  page,
}) => {
  await sellNewZeroStockProduct(page, 'credit');
});

// --- F2: the mechanic list ----------------------------------------------------

test('a mechanic typed on one bill is suggested on the next', async ({ page }) => {
  await signIn(page);
  const mechanic = unique();

  const field = page.getByLabel('Mechanic Name');
  await field.fill(mechanic);
  // Blur commits the name to the draft and saves it for next time.
  await page.locator('[data-bill-field="vehicle"]').click();

  // Reload, which is the strongest form of "the next bill": nothing is left in memory.
  await page.reload();
  await expect(page.getByRole('button', { name: /Print Bill/ })).toBeVisible({
    timeout: 30_000,
  });

  await page.getByLabel('Mechanic Name').fill(mechanic.slice(0, 8));
  await expect(page.getByRole('option', { name: new RegExp(mechanic) })).toBeVisible({
    timeout: 15_000,
  });
});

test('the same mechanic typed in three casings is one saved mechanic', async ({
  page,
}) => {
  await signIn(page);
  const base = unique().replace(/\s/g, '');

  for (const variant of [base, base.toUpperCase(), base.toLowerCase()]) {
    await page.getByLabel('Mechanic Name').fill(variant);
    await page.locator('[data-bill-field="vehicle"]').click();
    await page.waitForTimeout(400);
  }

  const list = await serverGet(page, `/mechanics?query=${encodeURIComponent(base)}`);
  const exact = (list.items as { name: string }[]).filter(
    (m) => m.name.toLowerCase() === base.toLowerCase(),
  );
  // One mechanic, not three — the duplicate problem the owner reported. Filtered to the
  // exact name because the suggestion search has a fuzzy tier, so a similarly-stemmed
  // mechanic from another test in this run is a correct hit rather than a duplicate.
  expect(exact).toHaveLength(1);
});

// --- F4: the packing tick -----------------------------------------------------

test('the packing tick does not change the bill total', async ({ page }) => {
  await signIn(page);
  await ensureUnits(page);
  const name = unique();

  await stockedProduct(page, name, '200.0000');
  await page.locator('[data-cell="0-item"]').fill(name);
  await page
    .getByRole('option', { name: new RegExp(name) })
    .first()
    .click();
  // The row's own Item cell, not `getByText` — the bill **tab** is renamed to the
  // product as well, so a bare text match is ambiguous under Playwright strict mode.
  await expect(page.locator('[data-cell="0-item"][aria-readonly="true"]')).toContainText(
    name,
    { timeout: 15_000 },
  );

  await page.locator('[data-cell="0-quantity"]').fill('2');
  await page.locator('[data-cell="0-item"]').click();

  // 2 x 200. The line total is the money; the tick must not touch it.
  const row = page.locator('tr', { has: page.locator('[data-cell="0-item"]') });
  await expect(row).toContainText('400');

  const tick = page.getByRole('checkbox', {
    name: new RegExp(`${name} has been brought`),
  });
  // The quantity commits on blur and re-renders the row, so the tick is taken only once
  // the row has settled — otherwise the click can land on a node React is replacing and
  // the change event is lost. (The behaviour itself is pinned without a browser by
  // "the packing tick actually sticks, through the real draft store".)
  await expect(tick).toBeVisible();
  await page.waitForTimeout(300);
  await tick.click();
  await expect(tick).toBeChecked();

  // Still 400, and the tick is not on the bill anywhere as a figure.
  await expect(row).toContainText('400');
});

// --- F12 and F13: the advance, and a payment on one invoice -------------------

test('an advance on a credit bill leaves the total alone and reduces the outstanding', async ({
  page,
}) => {
  await signIn(page);
  await ensureUnits(page);
  const name = unique();

  // Stocked through the real purchase path, so this test is about the money and not
  // about the oversell override a zero-stock part would correctly demand.
  await stockedProduct(page, name, '1000.0000');

  // Onto the bill through the ordinary search, one unit at ₹1,000.
  await page.locator('[data-cell="0-item"]').fill(name);
  await page
    .getByRole('option', { name: new RegExp(name) })
    .first()
    .click();
  await expect(page.locator('[data-cell="0-item"][aria-readonly="true"]')).toContainText(
    name,
    { timeout: 15_000 },
  );
  await page.locator('[data-cell="0-quantity"]').fill('1');
  await page.locator('[data-cell="0-item"]').click();

  // A credit bill needs a saved customer (FR-CREDIT-009).
  const customer = unique();
  await page.getByLabel(/Customer Name/).fill(customer);
  await page.getByRole('button', { name: /Save as a new customer/ }).click();
  await expect(page.getByText(customer)).toBeVisible({ timeout: 15_000 });

  // The advance.
  await page.getByLabel(/Advance received/).fill('200');
  await expect(page.getByText(/The bill total stays/)).toBeVisible();

  await page
    .getByRole('button', { name: 'Credit Bill Ctrl+Shift+Enter', exact: true })
    .click();
  // The confirmation card is the proof the sale committed.
  await expect(page.getByText(/Credit Bills|completed|Print now/i).first()).toBeVisible({
    timeout: 30_000,
  });

  // The server's own figures, not the screen's.
  // The id the server handed the browser, captured from the finalisation response.
  await expect.poll(() => lastInvoiceId, { timeout: 20_000 }).not.toBe('');
  const bill = (await serverGet(page, `/invoices/${lastInvoiceId}`)) as unknown as {
    id: string;
    total: string;
    amount_paid: string;
    outstanding: string;
  };

  // ₹1,000 bill, ₹200 advance, ₹800 outstanding — and the total is still ₹1,000.
  expect(bill.total).toBe('1000.00');
  expect(bill.amount_paid).toBe('200.00');
  expect(bill.outstanding).toBe('800.00');

  // --- F13: a payment against this exact invoice -----------------------------
  await page.getByRole('button', { name: 'Credit Bills', exact: true }).click();
  // The folder list is fetched, so wait for this customer's folder rather than assuming
  // it has rendered.
  const folder = page.getByRole('button', { name: new RegExp(customer) });
  await expect(folder).toBeVisible({ timeout: 20_000 });
  await folder.click();
  // The bill inside it. Its label is the internal reference, which is why this matches
  // loosely — the reference's series prefix is the server's to choose.
  const billButton = page.getByRole('button', { name: /\/|Open/ }).first();
  await expect(billButton).toBeVisible({ timeout: 20_000 });
  await billButton.click();

  // F6: the whole bill, not a summary.
  await expect(page.getByText('Credit amount')).toBeVisible({ timeout: 15_000 });
  // F6: the item the bill was for, in the viewer's own table.
  await expect(page.getByRole('cell', { name })).toBeVisible();

  await page.getByRole('button', { name: 'Receive Payment' }).click();
  await page.getByLabel('Amount received').fill('300');
  await page.getByRole('button', { name: 'Record the payment' }).click();
  await expect(page.getByText('Payment recorded.')).toBeVisible({ timeout: 15_000 });

  // The named invoice moved, by the server's reckoning.
  const after = (await serverGet(page, `/invoices/${bill.id}`)) as unknown as {
    total: string;
    amount_paid: string;
    outstanding: string;
    payment_status: string;
  };
  expect(after.total).toBe('1000.00');
  expect(after.amount_paid).toBe('500.00');
  expect(after.outstanding).toBe('500.00');
  expect(after.payment_status).toBe('partially_paid');

  // And the payment history shows both events.
  await page.getByRole('button', { name: 'Payment History' }).click();
  const history = await serverGet(page, `/payments?invoice_id=${bill.id}`);
  expect((history.items as unknown[]).length).toBeGreaterThanOrEqual(2);
});

// --- F7–F10: editing a finalised bill in place --------------------------------

test('a finalised bill can be edited in place, keeping its identity', async ({
  page,
}) => {
  await signIn(page);
  await ensureUnits(page);
  const name = unique();

  await stockedProduct(page, name, '100.0000');
  await page.locator('[data-cell="0-item"]').fill(name);
  await page
    .getByRole('option', { name: new RegExp(name) })
    .first()
    .click();
  await expect(page.locator('[data-cell="0-item"][aria-readonly="true"]')).toContainText(
    name,
    { timeout: 15_000 },
  );
  await page.locator('[data-cell="0-quantity"]').fill('2');
  await page.locator('[data-cell="0-item"]').click();

  // A distinctive customer name, so the Daily Bills row for *this* bill can be found.
  // `Edit Bill` with `.first()` opened whichever bill was at the top of the day's list
  // — an earlier test's — and the editor then showed a different invoice entirely.
  const customer = unique();
  await page.getByLabel(/Customer Name/).fill(customer);
  await page.locator('[data-bill-field="mechanic"]').click();

  await page.getByRole('button', { name: 'Print Bill Ctrl+Enter', exact: true }).click();
  await expect.poll(() => lastInvoiceId, { timeout: 30_000 }).not.toBe('');
  const invoiceId = lastInvoiceId;

  const before = (await serverGet(page, `/invoices/${invoiceId}`)) as unknown as {
    internal_reference: string;
    total: string;
    version: number;
  };
  expect(before.total).toBe('200.00');

  // Daily Bills → Edit Bill. F7: straight into the editor, no interstitial to dismiss.
  await page.getByRole('button', { name: 'Daily Bills', exact: true }).click();
  // `.first()` on the **row**: the print layout is also in the document and carries the
  // customer name, so two rows can match the text even though only one is the Daily
  // Bills row. Narrowing the row rather than the button keeps the assertion about
  // "this bill's row" rather than "some Edit button".
  const row = page.locator('tr', { hasText: customer }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Edit Bill' }).click();

  // F8: the line arrives prefilled with its own saved quantity.
  const quantity = page.getByLabel(new RegExp(`Quantity for ${name}`));
  await expect(quantity).toBeVisible({ timeout: 20_000 });
  await expect(quantity).toHaveValue('2.000');

  await quantity.fill('5');
  await page
    .getByLabel(/Why is this bill being changed/)
    .fill('Customer took three more off the shelf');
  await page.getByRole('button', { name: 'Save the changes' }).click();
  await expect(page.getByText(/keeps its original reference/i)).toBeVisible({
    timeout: 20_000,
  });

  // F9: the server's own figures. Same id, same reference, new total.
  const after = (await serverGet(page, `/invoices/${invoiceId}`)) as unknown as {
    id: string;
    internal_reference: string;
    total: string;
    version: number;
  };
  expect(after.id).toBe(invoiceId);
  expect(after.internal_reference).toBe(before.internal_reference);
  expect(after.total).toBe('500.00');
  expect(after.version).toBe(before.version + 1);

  // The before-state is recorded, immutably.
  const history = await serverGet(page, `/invoices/${invoiceId}/revisions`);
  const revisions = history.items as {
    revision_number: number;
    reason: string;
    total: string;
  }[];
  expect(revisions).toHaveLength(1);
  expect(revisions[0]?.total).toBe('200.00');
  expect(revisions[0]?.reason).toBe('Customer took three more off the shelf');
});

test('an edit below what has already been paid is refused in the browser', async ({
  page,
}) => {
  // The owner's explicit rule, seen the way the counter sees it.
  await signIn(page);
  await ensureUnits(page);
  const name = unique();

  await stockedProduct(page, name, '100.0000');
  await page.locator('[data-cell="0-item"]').fill(name);
  await page
    .getByRole('option', { name: new RegExp(name) })
    .first()
    .click();
  await expect(page.locator('[data-cell="0-item"][aria-readonly="true"]')).toContainText(
    name,
    { timeout: 15_000 },
  );
  await page.locator('[data-cell="0-quantity"]').fill('4');
  await page.locator('[data-cell="0-item"]').click();

  const customer = unique();
  await page.getByLabel(/Customer Name/).fill(customer);
  await page.locator('[data-bill-field="mechanic"]').click();

  // A cash bill is paid in full, so any reduction breaks the rule.
  await page.getByRole('button', { name: 'Print Bill Ctrl+Enter', exact: true }).click();
  await expect.poll(() => lastInvoiceId, { timeout: 30_000 }).not.toBe('');
  const invoiceId = lastInvoiceId;

  await page.getByRole('button', { name: 'Daily Bills', exact: true }).click();
  // `.first()` on the **row**: the print layout is also in the document and carries the
  // customer name, so two rows can match the text even though only one is the Daily
  // Bills row. Narrowing the row rather than the button keeps the assertion about
  // "this bill's row" rather than "some Edit button".
  const row = page.locator('tr', { hasText: customer }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Edit Bill' }).click();

  const quantity = page.getByLabel(new RegExp(`Quantity for ${name}`));
  await expect(quantity).toBeVisible({ timeout: 20_000 });
  await quantity.fill('1');
  await page.getByLabel(/Why is this bill being changed/).fill('Returned three of them');
  await page.getByRole('button', { name: 'Save the changes' }).click();

  // Told what to do instead, not merely refused.
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: /return or a credit note/i })
      .first(),
  ).toBeVisible({ timeout: 20_000 });

  // And the bill is untouched: no revision, same total.
  const after = (await serverGet(page, `/invoices/${invoiceId}`)) as unknown as {
    total: string;
  };
  expect(after.total).toBe('400.00');
  const history = await serverGet(page, `/invoices/${invoiceId}/revisions`);
  expect(history.items as unknown[]).toHaveLength(0);
});

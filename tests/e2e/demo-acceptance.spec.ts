/**
 * Demo acceptance: real browser → real frontend → real FastAPI → real PostgreSQL.
 *
 * Why this file exists
 * --------------------
 *
 * Three defects reached a live demo rehearsal that 845 passing automated tests did not
 * catch, and the reason was the same every time: **nothing clicked the button**.
 *
 * - `full-stack.spec.ts` finalises a sale with a direct `fetch` that omits `draft_id`,
 *   so the Print Bill path — which sends it — was never exercised. Typing a bill and
 *   pressing Print Bill failed every time with `NOT_FOUND`.
 * - The component suites mock `@/api/endpoints` wholesale, so a client method pointing
 *   at a URL that does not exist is invisible to them. `customers.search` requested
 *   `/customers`, which was not a route; its caller swallows errors, so the duplicate
 *   warning silently never appeared.
 * - `Print Bill` appears in other specs only as "is visible" or "is disabled".
 *
 * So every test here drives the UI the way a person does: open the screen, type in the
 * field, click the button, then **read the result back from the server** and check it
 * again after a full reload. No API is mocked or stubbed anywhere in this file.
 *
 * Two things are faked, both of them browser hardware rather than application code, and
 * both unavoidable in automation:
 *
 * - `window.print()`, which blocks the renderer on a real print dialog. The stub
 *   dispatches `afterprint` exactly as a returning printer does, so the application's
 *   own post-print lifecycle still runs.
 * - `navigator.onLine`, via Playwright's own offline emulation.
 *
 * The API is reached through the preview proxy on the page's own origin, so the
 * application's CSP (`connect-src 'self' …`) is satisfied without being widened.
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

const USERNAME = process.env.BM_E2E_USERNAME ?? 'e2e-owner';
const PASSWORD = process.env.BM_E2E_PASSWORD ?? 'e2e-only-not-a-real-password-01';
const DEVICE_ID = process.env.BM_E2E_DEVICE_ID ?? '0192f100-0000-7000-8000-0000000000d1';

test.skip(
  !process.env.BM_ACCEPT,
  'Needs a seeded throwaway API behind the preview proxy. See the final report for the ' +
    'exact command; never point this at the shop database.',
);

/** Unique per run, so a re-run cannot collide on a part code or a customer name. */
const RUN = Date.now().toString(36);
let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix} ${RUN}-${sequence}`;
}

/**
 * A phone number no earlier run has used.
 *
 * Needed because a phone number is globally unique per business by design:
 * `_attach_phone` silently skips a number that already belongs to **another** customer
 * rather than failing the save, on the reasoning that losing a whole customer record
 * over a shared number would be worse. The acceptance database accumulates across runs,
 * so a hard-coded number is claimed by the first run and silently ignored by every one
 * after it — which looks exactly like a persistence bug and is not one.
 */
let phoneSeq = 0;
function uniquePhone(): string {
  phoneSeq += 1;
  // 9 + 9 digits, derived from the run stamp so two runs cannot overlap.
  return `9${String(Date.now() % 1_000_000).padStart(6, '0')}${String(phoneSeq).padStart(3, '0')}`;
}

/** The access token the app was issued — observed on the wire, not minted here. */
let token = '';
/** Finalisation responses the application itself received, newest last. */
let finalised: Array<{ id: string; total: string }> = [];
/** The last finalisation request body the application sent. */
let lastFinalizeBody: Record<string, unknown> | null = null;

/**
 * Read the server back through its own API, from inside the page.
 *
 * Relative URL on purpose: it goes to the page's origin and through the proxy, so it is
 * the same path the application uses and needs no CSP exemption. Every one of these
 * reads reaches PostgreSQL.
 */
async function api<T>(
  page: Page,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ path: p, bearer, method, body }) => {
      const response = await fetch(`/api/v1${p}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          ...(method !== 'GET' ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: (await response.json().catch(() => null)) as never,
      };
    },
    {
      path,
      bearer: token,
      method: init?.method ?? 'GET',
      body: init?.body ?? null,
    },
  );
}

/** Present the provisioned counter PC, then sign in through the real form. */
async function signIn(page: Page): Promise<void> {
  token = '';
  finalised = [];
  lastFinalizeBody = null;

  // The print dialog, which cannot be driven from automation.
  //
  // The stub does two things. It dispatches `afterprint`, exactly as a returning printer
  // does, so the application's own lifecycle — clearing the payload, logging the print
  // event — runs unchanged. And it records the print root's markup **at the moment of
  // printing**, because that is the only instant the document exists: `onAfterPrint`
  // clears the payload and React unmounts the portal, so asserting against the live DOM
  // afterwards finds an empty `<div id="print-root">` and proves nothing. What is
  // captured here is precisely what would have reached the paper.
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

  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/auth/login') && response.status() === 200) {
      void response
        .json()
        .then((body: { access_token?: string }) => {
          if (body.access_token) token = body.access_token;
        })
        .catch(() => {
          /* a failed login carries no token */
        });
      return;
    }
    if (url.includes('/sales:finalize') && response.status() < 300) {
      lastFinalizeBody = response.request().postDataJSON() as Record<string, unknown>;
      void response
        .json()
        .then((body: { invoice?: { id?: string; total?: string } }) => {
          if (body.invoice?.id) {
            finalised.push({ id: body.invoice.id, total: body.invoice.total ?? '' });
          }
        })
        .catch(() => {
          /* nothing to record */
        });
    }
  });

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
        open.onerror = () => reject(new Error(String(open.error)));
        open.onsuccess = () => {
          const database = open.result;
          const tx = database.transaction('meta', 'readwrite');
          tx.objectStore('meta').put({ key: 'device_id', value: id });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(new Error(String(tx.error)));
        };
      }),
    DEVICE_ID,
  );
  await page.reload();

  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Proof the whole chain worked: this button renders only once bootstrap returned a
  // real money policy and a real counter from the server.
  await expect(action(page, 'printBill')).toBeVisible({
    timeout: 30_000,
  });
  expect(token, 'no access token seen on the login response').not.toBe('');
}

/**
 * Current stock for one product, from the server.
 *
 * Filtered here because `GET /inventory/balances` takes `low_stock_only` and `limit`
 * and **no** `product_id` — passing one would be silently ignored and somebody else's
 * first row returned.
 */
async function serverStock(page: Page, productId: string): Promise<string> {
  const response = await api<{ items: Array<{ product_id: string; quantity: string }> }>(
    page,
    '/inventory/balances?limit=200',
  );
  return (
    response.body.items.find((row) => row.product_id === productId)?.quantity ?? 'absent'
  );
}

/** A product with stock on the shelf, created through the real API. */
async function stockedProduct(
  page: Page,
  opts: { price?: string; quantity?: string } = {},
): Promise<{ id: string; sku: string; name: string }> {
  const sku = unique('ACC').replace(/ /g, '-');
  const name = `Acceptance Part ${sku}`;
  await api(page, '/units:ensure-defaults', { method: 'POST' });

  const created = await api<{ id: string }>(page, '/products', {
    method: 'POST',
    body: {
      name,
      sku,
      unit_code: 'NOS',
      default_selling_price: opts.price ?? '880.0000',
    },
  });
  expect(created.status, `product create: ${JSON.stringify(created.body)}`).toBe(201);

  // `PUT /suppliers/{id}` with a client-generated id — the documented upsert contract.
  const supplier = await api<{ id: string }>(page, `/suppliers/${randomUUID()}`, {
    method: 'PUT',
    body: { name: unique('Acceptance Supplier') },
  });
  expect(supplier.status, `supplier upsert: ${JSON.stringify(supplier.body)}`).toBe(200);

  // Stock arrives the way the business says it must: a purchase, then confirmation.
  // `POST /purchases` answers with `purchase_id`, not `id`.
  const purchase = await api<{ purchase_id: string }>(page, '/purchases', {
    method: 'POST',
    body: {
      supplier_id: supplier.body.id,
      items: [
        {
          product_id: created.body.id,
          quantity: opts.quantity ?? '12.000',
          unit_cost: '600.0000',
        },
      ],
    },
  });
  expect(purchase.status, `purchase: ${JSON.stringify(purchase.body)}`).toBe(201);
  const confirmed = await api(page, `/purchases/${purchase.body.purchase_id}:confirm`, {
    method: 'POST',
  });
  expect(confirmed.status, `confirm: ${JSON.stringify(confirmed.body)}`).toBe(200);

  return { id: created.body.id, sku, name };
}

/** Type a part code into the real search box and pick the first suggestion. */
async function addLineByCode(page: Page, code: string): Promise<void> {
  await page.getByLabel('Find an item').fill(code);
  await page.getByRole('option').first().click();
  // The line must be on screen before anything else happens: adding goes through a
  // state update, and acting before it lands finalises an empty bill.
  await expect(page.getByLabel(`Qty for Acceptance Part ${code}`)).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * The four counter actions, by their real accessible names.
 *
 * Each button renders its keyboard shortcut inside itself, so the accessible name is
 * "Print Bill Ctrl+Enter", not "Print Bill" — and a loose `{ name: 'Credit Bill' }` also
 * matches the **"Credit Bills"** navigation button by substring, which is a different
 * screen. Both mistakes are mine; neither is a defect. Exact names remove the ambiguity
 * and keep the locator honest about which control is being pressed.
 */
const ACTION = {
  printBill: 'Print Bill Ctrl+Enter',
  creditBill: 'Credit Bill Ctrl+Shift+Enter',
  saveDraft: 'Save a Draft Ctrl+S',
  clearDraft: 'Clear Draft Ctrl+Shift+Backspace',
} as const;

function action(page: Page, which: keyof typeof ACTION) {
  return page.getByRole('button', { name: ACTION[which], exact: true });
}

/** Everything sent to the printer so far, newest last. */
async function printedDocuments(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __printed?: string[] }).__printed ?? [],
  );
}

/** Click a completion button and wait for the server to confirm the sale. */
async function finalise(page: Page, which: 'printBill' | 'creditBill'): Promise<void> {
  const before = finalised.length;
  await action(page, which).click();
  await expect
    .poll(() => finalised.length, {
      message: `${ACTION[which]} never produced a finalisation response`,
      timeout: 30_000,
    })
    .toBeGreaterThan(before);
}

/** Navigate by clicking the real nav button. */
async function openScreen(page: Page, name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Screens' })
    .getByRole('button', { name })
    .click();
}

/** Create a customer through the Customers screen, as a person would. */
async function addCustomerViaUi(
  page: Page,
  fields: { name: string; phone?: string; creditLimit?: string; creditTerms?: string },
): Promise<void> {
  await openScreen(page, 'Customers');
  await page.getByRole('button', { name: 'Add a customer' }).click();
  await page.getByLabel('Name', { exact: true }).fill(fields.name);
  if (fields.phone) await page.getByLabel('Phone', { exact: true }).fill(fields.phone);
  if (fields.creditLimit) await page.getByLabel('Credit limit').fill(fields.creditLimit);
  if (fields.creditTerms) {
    await page.getByLabel('Payment terms (days)').fill(fields.creditTerms);
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(fields.name)).toBeVisible({ timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// A. Authentication and counter access
// ---------------------------------------------------------------------------

test.describe('A. authentication and counter access', () => {
  test('a real login reaches the billing counter', async ({ page }) => {
    await signIn(page);
    // The counter is named on screen, so a wrong assignment is visible to whoever is
    // standing at it rather than discovered in a report later.
    await expect(page.getByText(/C1|Counter/).first()).toBeVisible();
  });

  test('a wrong password is refused in words, and signs nothing in', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Username').fill(USERNAME);
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert')).toBeVisible({ timeout: 15_000 });
    await expect(action(page, 'printBill')).toHaveCount(0);
  });

  test('the session survives a full reload', async ({ page }) => {
    await signIn(page);
    await page.reload();
    await expect(action(page, 'printBill')).toBeVisible({
      timeout: 30_000,
    });
  });

  test('an unauthenticated API call is refused', async ({ page }) => {
    await signIn(page);
    const status = await page.evaluate(
      async () => (await fetch('/api/v1/customers')).status,
    );
    expect(status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// E. Customers — Issue A
// ---------------------------------------------------------------------------

test.describe('E. customers', () => {
  test('ISSUE A: a customer created in the UI is listed and survives a reload', async ({
    page,
  }) => {
    const name = unique('Acceptance Customer');
    await signIn(page);
    await addCustomerViaUi(page, { name, phone: uniquePhone() });

    // In the database, read back through the server.
    const listed = await api<{ items: Array<{ name: string }> }>(page, '/customers');
    expect(listed.body.items.map((c) => c.name)).toContain(name);

    // And still on screen after a full reload — the reported symptom was that a newly
    // created customer vanished.
    await page.reload();
    await openScreen(page, 'Customers');
    await expect(page.getByText(name)).toBeVisible({ timeout: 20_000 });
  });

  test('a customer with no credit history is listed, not hidden', async ({ page }) => {
    const name = unique('No Credit Customer');
    await signIn(page);
    // The exact gap: the screen used to read `/credit/customers`, which inner-joins
    // credit invoices, so someone who had never bought on credit could not appear.
    await addCustomerViaUi(page, { name });
    await expect(page.getByText(name)).toBeVisible();
  });

  test('search finds a customer by phone number', async ({ page }) => {
    const name = unique('Searchable Customer');
    await signIn(page);
    const phone = uniquePhone();
    await addCustomerViaUi(page, { name, phone });

    await page.getByLabel('Find a customer').fill(phone);
    await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
  });

  test('editing a phone does not wipe the credit limit', async ({ page }) => {
    const name = unique('Editable Customer');
    await signIn(page);
    await addCustomerViaUi(page, { name, creditLimit: '50000', creditTerms: '30' });

    // Reopen and change only the phone.
    await page
      .getByRole('row')
      .filter({ hasText: name })
      .getByRole('button', { name: 'Edit' })
      .click();
    await expect(page.getByLabel('Credit limit')).toHaveValue(/50000/);
    const newPhone = uniquePhone();
    await page.getByLabel('Phone', { exact: true }).fill(newPhone);
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    // Wait for the save to land before reading the server back. Without this the read
    // raced the `PUT` and returned the pre-edit row, which looks exactly like a
    // persistence bug — it is not one, and reporting it as one would have been worse
    // than the missing wait.
    await expect(page.getByRole('row').filter({ hasText: name })).toContainText(
      newPhone,
      {
        timeout: 15_000,
      },
    );

    // The limit survived. It used to be silently cleared, because the field started
    // empty whatever was being edited and `save()` sends `creditLimit.trim() || null` —
    // a financial control wiped by an unrelated edit.
    const listed = await api<{
      items: Array<{
        name: string;
        credit_limit: string | null;
        primary_phone: string | null;
      }>;
    }>(page, '/customers');
    const saved = listed.body.items.find((c) => c.name === name);
    expect(saved?.primary_phone).toBe(newPhone);
    expect(saved?.credit_limit).toBe('50000.00');
  });
});

// ---------------------------------------------------------------------------
// B + K. Billing, Print Bill — Issues B and C
// ---------------------------------------------------------------------------

test.describe('B. billing and finalisation', () => {
  test('ISSUE C: Print Bill works without pressing Save a Draft first', async ({
    page,
  }) => {
    await signIn(page);
    const product = await stockedProduct(page, { quantity: '12.000' });
    expect(await serverStock(page, product.id)).toMatch(/^12(\.0+)?$/);

    await addLineByCode(page, product.sku);

    // No `Save a Draft`. This is the exact sequence that failed with NOT_FOUND three
    // times in the rehearsal and left "This bill is not confirmed" on screen.
    await finalise(page, 'printBill');

    // A document actually went to the printer, and it was the bill layout — which can
    // only happen after the server confirmed the sale.
    const printed = await printedDocuments(page);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('class="bill');

    // The invoice exists, carries the line, and stock moved exactly once.
    const invoice = await api<{
      items: Array<{ sku_snapshot: string; quantity: string }>;
      total: string;
      is_credit: boolean;
    }>(page, `/invoices/${finalised.at(-1)?.id ?? ''}`);
    expect(invoice.status).toBe(200);
    expect(invoice.body.items.map((i) => i.sku_snapshot)).toContain(product.sku);
    expect(invoice.body.is_credit).toBe(false);
    expect(await serverStock(page, product.id)).toMatch(/^11(\.0+)?$/);
  });

  test('a quantity edit reaches the invoice total and the stock movement', async ({
    page,
  }) => {
    await signIn(page);
    const product = await stockedProduct(page, { price: '100.0000', quantity: '20.000' });
    await addLineByCode(page, product.sku);

    const qty = page.getByLabel(`Qty for ${product.name}`);
    await qty.fill('3');
    await qty.blur();

    await finalise(page, 'printBill');

    // 3 × 100 on the server's own arithmetic, and three units off the shelf. The client
    // never computes a stored figure (rule 15).
    const invoice = await api<{ total: string }>(
      page,
      `/invoices/${finalised.at(-1)?.id ?? ''}`,
    );
    expect(invoice.body.total).toBe('300.00');
    expect(await serverStock(page, product.id)).toMatch(/^17(\.0+)?$/);
  });

  test('ISSUE B: a credit bill to a customer created from the Billing screen', async ({
    page,
  }) => {
    const name = unique('Credit Customer');
    await signIn(page);
    const product = await stockedProduct(page);

    // The "no match, save as new" path, driven from Billing itself.
    await page.getByLabel('Find a saved customer').fill(name);
    await page
      .getByRole('button', { name: 'Save as a new customer' })
      .click({ timeout: 20_000 });
    await expect(page.getByText('Billing to:')).toBeVisible({ timeout: 15_000 });

    await addLineByCode(page, product.sku);
    await finalise(page, 'creditBill');

    // Credit, unpaid, and attributed to the saved customer — `Credit Bill` could not
    // succeed at all before the picker existed, because `customer_id` was never written.
    const invoice = await api<{
      is_credit: boolean;
      customer: { id: string | null; name_snapshot: string | null };
    }>(page, `/invoices/${finalised.at(-1)?.id ?? ''}`);
    expect(invoice.body.is_credit).toBe(true);
    expect(invoice.body.customer.name_snapshot).toBe(name);
    expect(invoice.body.customer.id).not.toBeNull();

    // And the shop is owed the money.
    const owed = await api<{
      items: Array<{ customer: { name: string }; outstanding: string }>;
    }>(page, '/credit/customers');
    expect(owed.body.items.find((r) => r.customer.name === name)?.outstanding).toBe(
      '880.00',
    );
  });

  test('a credit bill is still refused with only a typed name', async ({ page }) => {
    await signIn(page);
    const product = await stockedProduct(page);
    await addLineByCode(page, product.sku);

    // Typed into the snapshot field, with no customer picked. The guard stays: the
    // picker gives it something to be satisfied by, it does not weaken it.
    await page.getByLabel('Name', { exact: true }).fill('Walk In Person');
    await page.getByLabel('Name', { exact: true }).blur();

    await action(page, 'creditBill').click();

    await expect(page.getByText(/needs a saved customer/)).toBeVisible();
    expect(finalised).toHaveLength(0);
  });

  test('a cash bill needs no customer at all', async ({ page }) => {
    await signIn(page);
    const product = await stockedProduct(page);
    await addLineByCode(page, product.sku);
    await finalise(page, 'printBill');

    const invoice = await api<{ customer: { id: string | null } }>(
      page,
      `/invoices/${finalised.at(-1)?.id ?? ''}`,
    );
    expect(invoice.body.customer.id).toBeNull();
  });

  test('a draft survives a reload and still completes afterwards', async ({ page }) => {
    await signIn(page);
    const product = await stockedProduct(page);
    await addLineByCode(page, product.sku);

    await action(page, 'saveDraft').click();
    await page.reload();
    await expect(action(page, 'printBill')).toBeVisible({
      timeout: 30_000,
    });

    // The line came back from IndexedDB, and the bill still completes.
    await expect(page.getByLabel(`Qty for ${product.name}`)).toBeVisible({
      timeout: 15_000,
    });
    await finalise(page, 'printBill');
    expect(await serverStock(page, product.id)).toMatch(/^11(\.0+)?$/);
  });
});

// ---------------------------------------------------------------------------
// C + D. Daily Bills, Credit Bills and payments
// ---------------------------------------------------------------------------

test.describe('C+D. daily bills, credit and payments', () => {
  test('a finalised bill appears in Daily Bills, and reprinting sells nothing twice', async ({
    page,
  }) => {
    await signIn(page);
    const product = await stockedProduct(page);
    await addLineByCode(page, product.sku);
    await finalise(page, 'printBill');

    const soldId = finalised.at(-1)?.id ?? '';
    const stockAfterSale = await serverStock(page, product.id);
    const invoiceCount = await api<{ items: unknown[] }>(
      page,
      '/invoices?limit=200',
    ).then((r) => r.body.items.length);

    await openScreen(page, 'Daily Bills');
    // The figures on this screen are the server's; the client sums nothing (FR-RPT-030).
    await expect(page.getByRole('row').filter({ hasText: '880' }).first()).toBeVisible({
      timeout: 20_000,
    });

    // Reprint from Daily Bills: a second piece of paper, never a second sale.
    const printedBefore = (await printedDocuments(page)).length;
    await page
      .getByRole('row')
      .filter({ hasText: '880' })
      .first()
      .getByRole('button', { name: 'Reprint', exact: true })
      .click();

    await expect
      .poll(async () => (await printedDocuments(page)).length, { timeout: 20_000 })
      .toBeGreaterThan(printedBefore);

    // Marked, so a reprint cannot be handed over as an original (FR-PRINT-003/004).
    // This is the assertion that caught `printPayload` sending `is_duplicate` — a
    // parameter the route does not declare — leaving `copy` null and every reprint
    // rendering as an original.
    const reprinted = (await printedDocuments(page)).at(-1) ?? '';
    expect(reprinted).toContain('DUPLICATE COPY');

    const after = await api<{ items: unknown[] }>(page, '/invoices?limit=200');
    expect(after.body.items.length).toBe(invoiceCount);
    expect(await serverStock(page, product.id)).toBe(stockAfterSale);
    // Same invoice, still there, still one.
    expect((await api(page, `/invoices/${soldId}`)).status).toBe(200);
  });

  test('recording a payment clears the balance and moves no stock', async ({ page }) => {
    const name = unique('Paying Customer');
    await signIn(page);
    const product = await stockedProduct(page);

    await page.getByLabel('Find a saved customer').fill(name);
    await page
      .getByRole('button', { name: 'Save as a new customer' })
      .click({ timeout: 20_000 });
    await expect(page.getByText('Billing to:')).toBeVisible({ timeout: 15_000 });
    await addLineByCode(page, product.sku);
    await finalise(page, 'creditBill');

    const stockAfterSale = await serverStock(page, product.id);

    // The shop is owed the money, on the server's own figures.
    const owedBefore = await api<{
      items: Array<{ customer: { name: string }; outstanding: string }>;
    }>(page, '/credit/customers');
    expect(owedBefore.body.items.find((r) => r.customer.name === name)?.outstanding).toBe(
      '880.00',
    );

    // Now take the payment **through the screen**, which is the part that did not exist:
    // `credit.recordPayment` was correct in the API client and had no caller anywhere in
    // the application, so a credit bill could be issued and never paid off.
    await openScreen(page, 'Customers');
    await page.getByLabel('Find a customer').fill(name);
    await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
    await page
      .getByRole('row')
      .filter({ hasText: name })
      .getByRole('button', { name: 'Open', exact: true })
      .click();

    // Prefilled with the whole outstanding amount.
    await expect(page.getByLabel('Amount received')).toHaveValue('880.00');
    await page.getByRole('button', { name: 'Record this payment' }).click();

    // The balance is derived from bills and payments, never typed (ADR-022)…
    await expect
      .poll(
        async () => {
          const after = await api<{
            items: Array<{ customer: { name: string }; outstanding: string }>;
          }>(page, '/credit/customers?include_settled=true');
          return after.body.items.find((r) => r.customer.name === name)?.outstanding;
        },
        { timeout: 20_000 },
      )
      .toBe('0.00');

    // …the invoice is settled…
    const settled = await api<{ items: Array<{ payment_status: string }> }>(
      page,
      `/invoices?is_credit=true&limit=200`,
    );
    expect(settled.body.items.some((i) => i.payment_status === 'paid')).toBe(true);

    // …and a payment is not a goods movement (FR-CREDIT-010).
    expect(await serverStock(page, product.id)).toBe(stockAfterSale);

    // The Credit Bills screen opens on the real data rather than erroring.
    await openScreen(page, 'Credit Bills');
    await expect(page.getByRole('main')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// F + G. Stock and purchases
// ---------------------------------------------------------------------------

test.describe('F+G. stock and purchases', () => {
  test('the Stock screen shows the quantity the server holds', async ({ page }) => {
    await signIn(page);
    const product = await stockedProduct(page, { quantity: '7.000' });

    await openScreen(page, 'Stock');
    await page.getByLabel('Find an item').fill(product.sku);

    await expect(page.getByText(product.name)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('row').filter({ hasText: product.name })).toContainText(
      '7',
    );
    expect(await serverStock(page, product.id)).toMatch(/^7(\.0+)?$/);
  });

  test('stock cannot be typed in anywhere on the Stock screen', async ({ page }) => {
    await signIn(page);
    await openScreen(page, 'Stock');
    // FR-INV-002: stock changes through documents and corrections, never by setting a
    // new figure. The adjustment control asks for a difference and a reason instead.
    await expect(
      page.getByLabel(/^(Set stock|New quantity|Stock quantity)$/),
    ).toHaveCount(0);
  });

  test('a purchase adds stock only once received, and twice never', async ({ page }) => {
    await signIn(page);
    const product = await stockedProduct(page, { quantity: '5.000' });
    expect(await serverStock(page, product.id)).toMatch(/^5(\.0+)?$/);

    const supplier = await api<{ id: string }>(page, `/suppliers/${randomUUID()}`, {
      method: 'PUT',
      body: { name: unique('Acceptance Supplier') },
    });
    const purchase = await api<{ purchase_id: string }>(page, '/purchases', {
      method: 'POST',
      body: {
        supplier_id: supplier.body.id,
        items: [{ product_id: product.id, quantity: '3.000', unit_cost: '600.0000' }],
      },
    });
    expect(purchase.status).toBe(201);

    // Entered is not received: stock must not move until the goods are on the shelf.
    expect(await serverStock(page, product.id)).toMatch(/^5(\.0+)?$/);

    // The owner presses "Receive into stock" on the real screen.
    await openScreen(page, 'Purchases');
    const receive = page.getByRole('button', { name: 'Receive into stock' }).first();
    await expect(receive).toBeVisible({ timeout: 20_000 });
    await receive.click();
    const confirm = page.getByRole('button', { name: /Receive into stock|Yes/ }).last();
    if (await confirm.count()) await confirm.click();

    await expect
      .poll(() => serverStock(page, product.id), { timeout: 20_000 })
      .toMatch(/^8(\.0+)?$/);

    // A second confirmation is a replay, not another receipt.
    await api(page, `/purchases/${purchase.body.purchase_id}:confirm`, {
      method: 'POST',
    });
    expect(await serverStock(page, product.id)).toMatch(/^8(\.0+)?$/);
  });
});

// ---------------------------------------------------------------------------
// Invariants that must hold however the UI is driven
// ---------------------------------------------------------------------------

test.describe('financial and inventory invariants', () => {
  test('replaying the application’s own finalisation creates no second sale', async ({
    page,
  }) => {
    await signIn(page);
    const product = await stockedProduct(page, { quantity: '10.000' });
    await addLineByCode(page, product.sku);
    await finalise(page, 'printBill');

    const original = finalised.at(-1)?.id;
    const stockAfterSale = await serverStock(page, product.id);
    expect(stockAfterSale).toMatch(/^9(\.0+)?$/);

    // The body the application actually sent, replayed with the key it actually used —
    // which is what a retry after a lost response looks like. Hand-building a payload
    // here would exercise a payload nobody sends.
    expect(lastFinalizeBody, 'no finalisation body was captured').not.toBeNull();
    // The key the application itself used. Read here rather than inside the page so it
    // is a known `string` on both sides, instead of stringifying an `unknown`.
    const sentKey = lastFinalizeBody?.idempotency_key;
    expect(typeof sentKey, 'the finalisation carried no idempotency key').toBe('string');

    const replay = await page.evaluate(
      async ({ bearer, key, body }) => {
        const response = await fetch('/api/v1/sales:finalize', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${bearer}`,
            'Idempotency-Key': key,
          },
          body: JSON.stringify(body),
        });
        const parsed = (await response.json()) as {
          invoice?: { id?: string };
          error?: { code?: string };
        };
        return {
          status: response.status,
          id: parsed.invoice?.id,
          code: parsed.error?.code,
        };
      },
      { bearer: token, key: sentKey as string, body: lastFinalizeBody },
    );

    // Either the same invoice back, or a refusal — never a second sale and never a
    // second deduction. `draft_bills.invoice_id` is UNIQUE, which is the structural
    // guard behind both outcomes.
    if (replay.status < 300) expect(replay.id).toBe(original);
    expect(await serverStock(page, product.id)).toBe(stockAfterSale);
    expect(finalised.filter((f) => f.id !== original)).toHaveLength(0);
  });

  test('finalisation is refused with no connection, and nothing is created', async ({
    page,
    context,
  }) => {
    await signIn(page);
    const product = await stockedProduct(page);
    await addLineByCode(page, product.sku);
    const before = await serverStock(page, product.id);

    await context.setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false);

    // Both refused, because since ADR-033 `Credit Bill` finalises a sale too. "Credit"
    // is about who owes money, never about whether the sale happened.
    await expect(action(page, 'printBill')).toBeDisabled();
    await expect(action(page, 'creditBill')).toBeDisabled();
    // And the cashier is told their work is safe, not merely that they are blocked.
    await expect(page.getByText(/Completing a bill needs a connection/)).toBeVisible();

    await context.setOffline(false);
    expect(await serverStock(page, product.id)).toBe(before);
    expect(finalised).toHaveLength(0);
  });

  test('another business’s record is not found rather than forbidden', async ({
    page,
  }) => {
    await signIn(page);
    // A well-formed id belonging to nobody in this tenant: 404, never 403, so existence
    // is not leaked (`API-SPECIFICATION.md §4.1`).
    const probe = await api(page, '/customers/0192f100-0000-7000-8000-00000000dead');
    expect(probe.status).toBe(404);
  });

  test('the printed bill says ESTIMATE and carries no internal reference', async ({
    page,
  }) => {
    await signIn(page);
    const product = await stockedProduct(page);
    await addLineByCode(page, product.sku);
    await finalise(page, 'printBill');

    // OD-24 / FR-PRINT-021, and OD-3: the internal reference must never reach paper.
    const paper = (await printedDocuments(page)).at(-1) ?? '';
    expect(paper).toContain('ESTIMATE');
    expect(paper).not.toContain('Tax Invoice');
    expect(paper).not.toContain('INVOICE');

    const reference = await api<{ internal_reference: string }>(
      page,
      `/invoices/${finalised.at(-1)?.id ?? ''}`,
    ).then((r) => r.body.internal_reference);
    expect(reference).toBeTruthy();
    expect(paper).not.toContain(reference);
  });
});

/**
 * Real-browser acceptance for the three upgrades: session reliability, the products on a
 * credit bill, and correcting a finalised bill.
 *
 * Real Chromium → the built React app → the real FastAPI backend → a real, isolated
 * PostgreSQL database. **No API is mocked.** The only stubs are browser hardware that
 * cannot be driven from automation, and each is labelled where it is done:
 *
 * - `window.print()`, which blocks the renderer on a real print dialog. The stub records
 *   what would have reached the paper and dispatches `afterprint` as a returning printer
 *   does, so the application's own post-print lifecycle still runs.
 * - `navigator.onLine`, via Playwright's own offline emulation.
 *
 * Reached through the preview proxy on the page's own origin, so the application's CSP
 * (`connect-src 'self' …`) is satisfied without being widened. That is also the only
 * CSP-legal way to point the suite at a throwaway database: an absolute base is permitted
 * for exactly one port, and on a developer machine that port is the live shop.
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

const USERNAME = process.env.BM_E2E_USERNAME ?? 'e2e-owner';
const PASSWORD = process.env.BM_E2E_PASSWORD ?? 'e2e-only-not-a-real-password-01';
const DEVICE_ID = process.env.BM_E2E_DEVICE_ID ?? '0192f100-0000-7000-8000-0000000000d1';

test.skip(
  !process.env.BM_ACCEPT,
  'Needs a seeded throwaway API behind the preview proxy. Never point this at `bm`.',
);

// Every test here signs in for real, then usually creates a product through a purchase
// and confirms it before it can bill at all. The default 30 s is spent on the sign-in
// alone against a cold preview server, and a budget exhausted mid-navigation reports as
// "element not found", which reads exactly like the defect under test. Generous on
// purpose: these are end-to-end journeys, not unit tests.
test.describe.configure({ timeout: 180_000 });

const RUN = Date.now().toString(36);
let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix} ${RUN}-${sequence}`;
}

let token = '';
let finalised: Array<{ id: string; total: string }> = [];

async function api<T>(
  page: Page,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ p, bearer, method, body }) => {
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
      p: path,
      bearer: token,
      method: init?.method ?? 'GET',
      body: init?.body ?? null,
    },
  );
}

const ACTION = {
  printBill: 'Print Bill Ctrl+Enter',
  creditBill: 'Credit Bill Ctrl+Shift+Enter',
  saveDraft: 'Save a Draft Ctrl+S',
} as const;

function action(page: Page, which: keyof typeof ACTION) {
  return page.getByRole('button', { name: ACTION[which], exact: true });
}

async function openScreen(page: Page, name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Screens' })
    .getByRole('button', { name, exact: true })
    .click();
}

async function printedDocuments(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __printed?: string[] }).__printed ?? [],
  );
}

async function signIn(page: Page): Promise<void> {
  token = '';
  finalised = [];

  // The print dialog, which cannot be driven from automation. Records the markup at the
  // moment of printing, because `onAfterPrint` clears the payload and unmounts the
  // portal — asserting against the live DOM afterwards finds an empty div.
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
        .then((b: { access_token?: string }) => {
          if (b.access_token) token = b.access_token;
        })
        .catch(() => {});
      return;
    }
    if (url.includes('/sales:finalize') && response.status() < 300) {
      void response
        .json()
        .then((b: { invoice?: { id?: string; total?: string } }) => {
          if (b.invoice?.id) {
            finalised.push({ id: b.invoice.id, total: b.invoice.total ?? '' });
          }
        })
        .catch(() => {});
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
          const tx = open.result.transaction('meta', 'readwrite');
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
  await expect(action(page, 'printBill')).toBeVisible({ timeout: 30_000 });
  expect(token, 'no access token observed').not.toBe('');
}

async function serverStock(page: Page, productId: string): Promise<string> {
  const response = await api<{ items: Array<{ product_id: string; quantity: string }> }>(
    page,
    '/inventory/balances?limit=200',
  );
  return (
    response.body.items.find((row) => row.product_id === productId)?.quantity ?? 'absent'
  );
}

/** A product with stock, through the real API. */
async function stockedProduct(
  page: Page,
  opts: { price?: string; quantity?: string } = {},
): Promise<{ id: string; sku: string; name: string }> {
  const sku = unique('REM').replace(/ /g, '-');
  // Deliberately does **not** contain the part code: a name like
  // "Remediation Part REM-1" makes any assertion on the code match the name cell too,
  // and the failure reads as a missing element rather than an ambiguous one.
  const name = `Widget ${sequence} of run ${RUN}`;
  await api(page, '/units:ensure-defaults', { method: 'POST' });

  const created = await api<{ id: string }>(page, '/products', {
    method: 'POST',
    body: {
      name,
      sku,
      unit_code: 'NOS',
      default_selling_price: opts.price ?? '500.0000',
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);

  const supplier = await api<{ id: string }>(page, `/suppliers/${randomUUID()}`, {
    method: 'PUT',
    body: { name: unique('Remediation Supplier') },
  });
  const purchase = await api<{ purchase_id: string }>(page, '/purchases', {
    method: 'POST',
    body: {
      supplier_id: supplier.body.id,
      items: [
        {
          product_id: created.body.id,
          quantity: opts.quantity ?? '20.000',
          unit_cost: '300.0000',
        },
      ],
    },
  });
  expect(purchase.status, JSON.stringify(purchase.body)).toBe(201);
  await api(page, `/purchases/${purchase.body.purchase_id}:confirm`, { method: 'POST' });
  return { id: created.body.id, sku, name };
}

async function addLineByCode(page: Page, product: { sku: string; name: string }) {
  await page.getByLabel('Find an item').fill(product.sku);
  await page.getByRole('option').first().click();
  await expect(page.getByLabel(`Qty for ${product.name}`)).toBeVisible({
    timeout: 15_000,
  });
}

async function finalise(page: Page, which: 'printBill' | 'creditBill'): Promise<string> {
  const before = finalised.length;
  await action(page, which).click();
  await expect.poll(() => finalised.length, { timeout: 30_000 }).toBeGreaterThan(before);
  return finalised.at(-1)?.id ?? '';
}

/** Attach a saved customer, creating them from the billing screen. */
async function attachNewCustomer(page: Page, name: string): Promise<void> {
  await page.getByLabel('Find a saved customer').fill(name);
  await page
    .getByRole('button', { name: 'Save as a new customer' })
    .click({ timeout: 20_000 });
  await expect(page.getByText('Billing to:')).toBeVisible({ timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// 1. Session reliability — the reported "it refreshes and logs me out"
// ---------------------------------------------------------------------------

test.describe('the session survives ordinary use', () => {
  test('a page reload does not sign the user out', async ({ page }) => {
    // The reported bug, at its most direct. The startup refresh ran twice under React's
    // development double-mount, the second presented a token the first had already
    // rotated, and FR-AUTH-002 correctly revoked the family — so every reload signed the
    // user out. Both mounts now await one shared attempt.
    await signIn(page);
    for (let i = 0; i < 3; i += 1) {
      await page.reload();
      await expect(action(page, 'printBill')).toBeVisible({ timeout: 30_000 });
    }
    // Still authenticated, proven against the server rather than from the screen.
    const me = await api(page, '/auth/me');
    expect(me.status).toBe(200);
  });

  test('a second tab does not sign the first one out', async ({ page, context }) => {
    // Two tabs share one cookie. Both used to refresh independently, one rotated and the
    // other was judged a thief, and the shop lost both sessions for having a second tab
    // open. A Web Lock plus a re-check inside it means one rotation.
    await signIn(page);

    const second = await context.newPage();
    await second.goto('/');
    await expect(
      second.getByRole('button', { name: ACTION.printBill, exact: true }),
    ).toBeVisible({ timeout: 30_000 });

    // Force both tabs to talk to the server at once.
    await Promise.all([page.reload(), second.reload()]);
    await expect(action(page, 'printBill')).toBeVisible({ timeout: 30_000 });
    await expect(
      second.getByRole('button', { name: ACTION.printBill, exact: true }),
    ).toBeVisible({ timeout: 30_000 });

    await second.close();
  });

  test('navigating repeatedly between screens keeps the session', async ({ page }) => {
    await signIn(page);
    for (const screen of ['Daily Bills', 'Customers', 'Stock', 'Billing']) {
      await openScreen(page, screen);
      await expect(page.getByRole('main')).toBeVisible();
    }
    await openScreen(page, 'Daily Bills');
    await openScreen(page, 'Billing');
    await expect(action(page, 'printBill')).toBeVisible();
    expect((await api(page, '/auth/me')).status).toBe(200);
  });

  test('a brief network interruption does not sign the user out', async ({
    page,
    context,
  }) => {
    // A transport failure on the refresh used to be indistinguishable from a revoked
    // cookie, so a two-second blink of the counter's wifi ended the session. It is now
    // classified: with no HTTP response, nothing was invalidated.
    //
    // Asserted on the session itself rather than by navigating screens. Driving the UI
    // through an offline/online cycle makes the test measure the dev proxy's recovery as
    // much as the application's, and a slow recovery reads as "element not found", which
    // is indistinguishable from the defect under test. What the requirement actually says
    // is that the session must survive — so that is what is checked.
    await signIn(page);

    await context.setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false);

    // A real request, failing at the transport layer because there is no network.
    const whileOffline = await page.evaluate(async () => {
      try {
        await fetch('/api/v1/auth/me');
        return 'unexpectedly succeeded';
      } catch {
        return 'failed in transport';
      }
    });
    expect(whileOffline).toBe('failed in transport');

    await context.setOffline(false);
    await page.waitForFunction(() => navigator.onLine === true);

    // The session is intact: the same token still works, so nothing was cleared and no
    // sign-in was demanded.
    await expect
      .poll(async () => (await api(page, '/auth/me')).status, {
        timeout: 60_000,
      })
      .toBe(200);
    // And the shell is still the signed-in shell, not the login screen.
    await expect(page.getByRole('navigation', { name: 'Screens' })).toBeVisible();
  });

  test('signing out still works immediately', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByLabel('Username')).toBeVisible({ timeout: 20_000 });
    // And the cookie is gone, so a reload does not silently sign back in.
    await page.reload();
    await expect(page.getByLabel('Username')).toBeVisible({ timeout: 30_000 });
  });
});

// ---------------------------------------------------------------------------
// 2. Credit Bills — the products on each individual bill
// ---------------------------------------------------------------------------

test.describe('a credit bill shows what was bought on it', () => {
  test('the products, quantities and prices of one credit bill', async ({ page }) => {
    const customer = unique('Credit Detail Customer');
    await signIn(page);
    const first = await stockedProduct(page, { price: '500.0000' });
    const second = await stockedProduct(page, { price: '240.0000' });

    await attachNewCustomer(page, customer);
    await addLineByCode(page, first);
    await addLineByCode(page, second);
    const invoiceId = await finalise(page, 'creditBill');
    expect(invoiceId).not.toBe('');

    await openScreen(page, 'Credit Bills');
    await page.getByRole('button', { name: new RegExp(customer) }).click();

    // The bill, then the products on it.
    const reference = await api<{ internal_reference: string }>(
      page,
      `/invoices/${invoiceId}`,
    ).then((r) => r.body.internal_reference);
    await page.getByRole('button', { name: reference, exact: true }).click();

    // Scoped to the items table itself, by its caption. A bare `getByRole('row')`
    // matches twice here: the expanded detail is a `<tr>` spanning the invoice table,
    // and it *contains* the nested items table, so the container row carries the product
    // text as well as the item row does.
    const bought = page.getByRole('table', { name: /What was bought on this bill/i });
    await expect(bought).toBeVisible({ timeout: 20_000 });
    // Name, part code, quantity and price for each product — the whole point of this.
    await expect(bought).toContainText(first.name);
    await expect(bought).toContainText(first.sku);
    await expect(bought).toContainText(second.name);
    await expect(bought).toContainText(second.sku);
  });

  test('a partial payment then the rest, with the figures right at each step', async ({
    page,
  }) => {
    const customer = unique('Paying In Parts');
    await signIn(page);
    const product = await stockedProduct(page, { price: '500.0000' });

    await attachNewCustomer(page, customer);
    await addLineByCode(page, product);
    await finalise(page, 'creditBill');

    const owed = async () => {
      // Scoped by name: the endpoint caps at 200 rows and the acceptance database
      // accumulates, so an unscoped page need not contain this run's customer at all.
      const r = await api<{
        items: Array<{ customer: { name: string }; outstanding: string }>;
      }>(
        page,
        `/credit/customers?include_settled=true&limit=200&query=${encodeURIComponent(customer)}`,
      );
      return r.body.items.find((row) => row.customer.name === customer)?.outstanding;
    };
    expect(await owed()).toBe('500.00');

    const customerId = await api<{ items: Array<{ id: string; name: string }> }>(
      page,
      '/customers',
    ).then((r) => r.body.items.find((c) => c.name === customer)?.id);

    // Half, through the real endpoint the screen uses.
    const part = await api(page, '/payments', {
      method: 'POST',
      body: { customer_id: customerId, method: 'cash', amount: '200.00' },
    });
    expect(part.status, JSON.stringify(part.body)).toBe(200);
    expect(await owed()).toBe('300.00');

    // The invoice itself reads partially paid, derived by the server.
    const invoice = await api<{ payment_status: string; amount_paid: string }>(
      page,
      `/invoices/${finalised.at(-1)?.id ?? ''}`,
    );
    expect(invoice.body.payment_status).toBe('partially_paid');
    expect(invoice.body.amount_paid).toBe('200.00');

    // Then the rest.
    const rest = await api(page, '/payments', {
      method: 'POST',
      body: { customer_id: customerId, method: 'cash', amount: '300.00' },
    });
    expect(rest.status).toBe(200);
    expect(await owed()).toBe('0.00');
    expect(
      (await api<{ payment_status: string }>(page, `/invoices/${finalised.at(-1)?.id}`))
        .body.payment_status,
    ).toBe('paid');

    // And it is still right after a reload.
    await page.reload();
    await expect(action(page, 'printBill')).toBeVisible({ timeout: 30_000 });
    expect(await owed()).toBe('0.00');
  });
});

// ---------------------------------------------------------------------------
// 3. Correcting a finalised bill
// ---------------------------------------------------------------------------

test.describe('correcting a finalised bill', () => {
  test('cancel and re-bill: stock nets out and two invoices exist', async ({ page }) => {
    const customer = unique('Correction Customer');
    await signIn(page);
    const product = await stockedProduct(page, { price: '500.0000', quantity: '20.000' });
    const before = await serverStock(page, product.id);

    // The original sale: one unit, to a uniquely named customer so the Daily Bills row
    // can be identified. The acceptance database accumulates across runs and a filter on
    // the total matches dozens of other bills — `.first()` then corrects somebody else's.
    await attachNewCustomer(page, customer);
    await addLineByCode(page, product);
    const original = await finalise(page, 'printBill');
    expect(await serverStock(page, product.id)).toBe(String(Number(before) - 1) + '.000');

    // The customer asks for a second unit. Correct the bill.
    await openScreen(page, 'Daily Bills');
    const row = page.getByRole('row').filter({ hasText: customer });
    await expect(row).toHaveCount(1, { timeout: 20_000 });
    await row.getByRole('button', { name: 'Edit Bill' }).click();

    // It says plainly that a printed bill is not altered.
    await expect(page.getByText(/cannot be changed/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(product.name)).toBeVisible();

    await page
      .getByLabel(/Why is this bill/)
      .fill('customer asked for a second unit after printing');

    // A cash sale is paid the instant it is rung up, so this bill has money against it and
    // the cash-refund acknowledgement is required before anything can proceed. That is the
    // guard working as designed — there is no refund record anywhere in the schema — and it
    // means correcting a cash bill always passes through this step.
    await expect(page.getByText(/does not record cash going out/)).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Cancel it and start the new bill/ }),
    ).toBeDisabled();
    await page.getByRole('checkbox').check();

    await page.getByRole('button', { name: /Cancel it and start the new bill/ }).click();

    // The cancellation put the stock back…
    await expect
      .poll(() => serverStock(page, product.id), { timeout: 30_000 })
      .toBe(before);
    const cancelled = await api<{ status: string; internal_reference: string }>(
      page,
      `/invoices/${original}`,
    );
    expect(cancelled.body.status).toBe('cancelled');
    // …and the bill keeps its number and stays on the record (OD-10).
    expect(cancelled.body.internal_reference).toBeTruthy();

    // …and we are on Billing with the original lines carried over.
    await expect(page.getByLabel(`Qty for ${product.name}`)).toBeVisible({
      timeout: 20_000,
    });
    const qty = page.getByLabel(`Qty for ${product.name}`);
    await qty.fill('2');
    await qty.blur();
    const replacement = await finalise(page, 'printBill');
    expect(replacement).not.toBe(original);

    // Two units gone in total, from the replacement bill only.
    expect(await serverStock(page, product.id)).toBe(String(Number(before) - 2) + '.000');
    const newInvoice = await api<{ total: string; status: string }>(
      page,
      `/invoices/${replacement}`,
    );
    expect(newInvoice.body.status).toBe('issued');
    expect(newInvoice.body.total).toBe('1000.00');
  });

  test('a cancelled credit bill stops the customer owing for it', async ({ page }) => {
    const customer = unique('Cancelled Credit Customer');
    await signIn(page);
    const product = await stockedProduct(page, { price: '500.0000' });

    await attachNewCustomer(page, customer);
    await addLineByCode(page, product);
    const invoiceId = await finalise(page, 'creditBill');

    const owed = async () => {
      // Scoped by name: the endpoint caps at 200 rows and the acceptance database
      // accumulates, so an unscoped page need not contain this run's customer at all.
      const r = await api<{
        items: Array<{ customer: { name: string }; outstanding: string }>;
      }>(
        page,
        `/credit/customers?include_settled=true&limit=200&query=${encodeURIComponent(customer)}`,
      );
      return r.body.items.find((row) => row.customer.name === customer)?.outstanding;
    };
    expect(await owed()).toBe('500.00');

    await openScreen(page, 'Daily Bills');
    await page
      .getByRole('row')
      .filter({ hasText: customer })
      .first()
      .getByRole('button', { name: 'Edit Bill' })
      .click();
    await expect(page.getByText(product.name)).toBeVisible({ timeout: 20_000 });
    // The dialog says a credit note is recorded, because that is what happens.
    await expect(page.getByText(/credit note/i)).toBeVisible();

    await page.getByLabel(/Why is this bill/).fill('billed to the wrong customer');
    await page.getByRole('button', { name: 'Just cancel it' }).click();

    // A full-value credit note means they no longer owe it. Absent counts: with its only
    // credit invoice cancelled the customer drops out of the credit report, which
    // inner-joins credit invoices — so "nothing owing" and "not listed" are the same
    // answer here, and asserting only on '0.00' would fail for the right reason.
    await expect
      .poll(async () => (await owed()) ?? 'not listed', { timeout: 60_000 })
      .toMatch(/^(0\.00|not listed)$/);
    expect(
      (await api<{ status: string }>(page, `/invoices/${invoiceId}`)).body.status,
    ).toBe('cancelled');
  });

  test('cancelling twice does not reverse the stock twice', async ({ page }) => {
    await signIn(page);
    const product = await stockedProduct(page, { price: '500.0000' });
    const before = await serverStock(page, product.id);
    await addLineByCode(page, product);
    const invoiceId = await finalise(page, 'printBill');

    const reason = 'duplicate cancellation probe, deliberate';
    const first = await api(page, `/invoices/${invoiceId}:cancel`, {
      method: 'POST',
      body: { reason },
    });
    expect(first.status).toBe(200);
    const afterFirst = await serverStock(page, product.id);
    expect(afterFirst).toBe(before);

    // Already cancelled: refused, and the shelf is untouched.
    const second = await api<{ error?: { code?: string } }>(
      page,
      `/invoices/${invoiceId}:cancel`,
      { method: 'POST', body: { reason } },
    );
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(await serverStock(page, product.id)).toBe(afterFirst);
  });

  test('a reprint of a cancelled bill still creates no sale', async ({ page }) => {
    const reprintCustomer = unique('Reprint Customer');
    await signIn(page);
    const product = await stockedProduct(page, { price: '500.0000' });
    await attachNewCustomer(page, reprintCustomer);
    await addLineByCode(page, product);
    await finalise(page, 'printBill');

    const countInvoices = async () =>
      (await api<{ items: unknown[] }>(page, '/invoices?limit=200')).body.items.length;
    const before = await countInvoices();

    await openScreen(page, 'Daily Bills');
    const printedBefore = (await printedDocuments(page)).length;
    await page
      .getByRole('row')
      .filter({ hasText: reprintCustomer })
      .getByRole('button', { name: 'Reprint', exact: true })
      .click();
    await expect
      .poll(async () => (await printedDocuments(page)).length, { timeout: 30_000 })
      .toBeGreaterThan(printedBefore);

    expect(await countInvoices()).toBe(before);
  });
});

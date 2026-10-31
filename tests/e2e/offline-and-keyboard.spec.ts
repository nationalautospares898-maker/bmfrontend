/**
 * End-to-end: the offline boundary and the keyboard-only flow.
 *
 * These run against the **built** app with the API intercepted at the network layer, so
 * the whole stack below the component boundary is real — the client, Dexie, the service
 * worker, the print stylesheet.
 *
 * Two things are verified here that no unit test can:
 *
 * 1. **Real offline.** `context.setOffline(true)` is a genuine network cut, not a
 *    mocked flag. A bill typed offline has to survive a reload, and finalisation has to
 *    be refused without creating anything.
 * 2. **Keyboard only.** A whole bill completed without touching the mouse, because at a
 *    counter the mouse is the slow path (NFR-FE-PERF-001/002, and an explicit Phase 2
 *    acceptance criterion).
 */

import { expect, test, type Page, type Route } from '@playwright/test';

const API = '**/api/v1';

const MONEY_POLICY = {
  version: 1,
  currency: 'INR',
  amount_scale: 2,
  unit_price_scale: 4,
  quantity_scale: 3,
  percent_scale: 3,
  rounding_mode: 'reject_fractional',
  round_grand_total_to_rupee: false,
  require_integral_amounts: true,
  display_decimal_places: 0,
};

const COUNTER = {
  id: '0192f000-0000-7000-8000-00000000c001',
  code: 'C1',
  name: 'Counter 1',
  max_open_drafts: 4,
};

const SESSION = {
  access_token: 'e2e-token',
  token_type: 'bearer',
  expires_in: 900,
  user: { id: 'u1', full_name: 'Ravi', must_change_password: false },
  business: { id: 'b1', display_name: 'National Auto Spares' },
  branches: [{ id: 'br1', code: 'MAIN', name: 'Main' }],
  active_branch_id: 'br1',
  role: 'cashier',
  permissions: ['billing.sale.finalize', 'catalog.read', 'reports.sales.read'],
  server_time: '2026-10-30T10:00:00+05:30',
};

const PRODUCT = {
  id: 'p1',
  name: 'Brake Shoe Set - Tata 407',
  sku: 'TT-407-BS',
  barcode: null,
  brand: 'Allied',
  category: null,
  unit: { code: 'SET', allows_fraction: false },
  default_selling_price: '1250.0000',
  stock: { branch_quantity: '10.000', as_of: '2026-10-30T10:00:00+05:30' },
  is_active: true,
  is_low_stock: false,
  hsn_code: null,
  match: { kind: 'exact_sku', score: 100 },
};

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/** Intercept the API so the suite exercises the client, not a server. */
async function stubApi(
  page: Page,
  options: { finalize?: 'ok' | 'conflict' } = {},
): Promise<void> {
  await page.route(`${API}/auth/refresh`, (route) => json(route, SESSION));
  await page.route(`${API}/auth/login`, (route) => json(route, SESSION));
  await page.route(`${API}/sync/bootstrap`, (route) =>
    json(route, {
      business_id: 'b1',
      branch_id: 'br1',
      counter: COUNTER,
      permissions: SESSION.permissions,
      money_policy: MONEY_POLICY,
      settings: {},
      sync: {
        allowed_operation_types: ['draft.upsert', 'draft.delete', 'customer.upsert'],
        offline_finalisation: 'refused',
        max_batch_size: 100,
      },
      server_time: '2026-10-30T10:00:00+05:30',
      catalog_cursor: null,
    }),
  );
  await page.route(`${API}/sync/catalog**`, (route) =>
    json(route, {
      products: [
        {
          id: PRODUCT.id,
          name: PRODUCT.name,
          sku: PRODUCT.sku,
          barcode: null,
          unit: PRODUCT.unit,
          default_selling_price: PRODUCT.default_selling_price,
          is_active: true,
          stock: PRODUCT.stock,
        },
      ],
      next_cursor: '2026-10-30T10:00:00+05:30',
      has_more: false,
      reset_required: false,
      cache_policy: { max_rows: 500 },
      as_of: '2026-10-30T10:00:00+05:30',
      warnings: [],
    }),
  );
  await page.route(`${API}/sync/operations`, (route) =>
    json(route, { results: [], server_time: '2026-10-30T10:00:00+05:30' }),
  );
  await page.route(`${API}/products/search**`, (route) =>
    json(route, {
      items: [PRODUCT],
      page: { next_cursor: null, has_more: false, limit: 20 },
    }),
  );
  await page.route(`${API}/drafts**`, (route) => json(route, { items: [] }));

  if (options.finalize === 'conflict') {
    await page.route(`${API}/sales:finalize`, (route) =>
      json(
        route,
        {
          error: {
            code: 'INSUFFICIENT_STOCK',
            message: 'no',
            details: {
              shortfalls: [
                {
                  product_id: 'p1',
                  product_name: PRODUCT.name,
                  requested: '2.000',
                  available: '1.000',
                },
              ],
            },
            request_id: 'req-1',
            retryable: false,
          },
        },
        409,
      ),
    );
  }
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  // The silent refresh happens on load, so the billing screen appears without a login.
  await expect(page.getByRole('button', { name: /Print Bill/ })).toBeVisible({
    timeout: 20_000,
  });
}

test.describe('the offline boundary (FR-OFFLINE-002, ADR-033)', () => {
  test('refuses both finalisation actions and offers a counter slip', async ({
    page,
    context,
  }) => {
    await stubApi(page);
    await signIn(page);

    // Type a bill while still online.
    await page.getByLabel('Find an item').fill('TT-407-BS');
    await page.getByRole('option').first().click();
    await expect(page.getByText(PRODUCT.name, { exact: true })).toBeVisible();

    // A real network cut, not a flag.
    await context.setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false);

    // Scoped to the banner: the connection indicator in the header says "Working
    // offline" too, which is deliberate redundancy rather than an ambiguity to remove.
    await expect(
      page.getByRole('alert').filter({ hasText: /Working offline/ }),
    ).toBeVisible();
    // Both, for the same reason: since ADR-033 `Credit Bill` finalises a sale.
    await expect(page.getByRole('button', { name: /Print Bill/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: /Credit Bill/ })).toBeDisabled();
    // And the wording reassures rather than alarming.
    await expect(page.getByText(/nothing is lost/)).toBeVisible();

    await context.setOffline(false);
  });

  test('a bill typed offline survives a reload', async ({ page, context }) => {
    await stubApi(page);
    await signIn(page);

    await context.setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false);

    // Offline search comes from the Dexie cache warmed at startup.
    await page.getByLabel('Find an item').fill('tt407bs');
    await expect(page.getByText(/saved on this computer/)).toBeVisible();
    await page.getByRole('option').first().click();
    await expect(page.getByText(PRODUCT.name, { exact: true })).toBeVisible();

    // The reload is the test. Everything in memory is gone; only IndexedDB remains.
    await context.setOffline(false);
    await page.reload();

    await expect(page.getByText(PRODUCT.name, { exact: true })).toBeVisible({
      timeout: 20_000,
    });
  });

  test('Save a Draft works offline and queues the bill', async ({ page, context }) => {
    await stubApi(page);
    await signIn(page);

    await page.getByLabel('Find an item').fill('TT-407-BS');
    await page.getByRole('option').first().click();

    await context.setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false);

    // Pressing it offline is a success, not an error: the bill is already on disk and
    // the outbox carries it up when there is a connection.
    await page.getByRole('button', { name: /Save a Draft/ }).click();
    await expect(page.getByRole('button', { name: /Save a Draft/ })).toBeEnabled();

    // Polled rather than read once. Saving the draft and enqueuing it are separate
    // asynchronous writes, and the only thing asserted between the click and the read
    // was that the button is enabled again — which it is immediately. So a single
    // `evaluate` could run before the outbox write had committed, and did on CI while
    // never doing so on a developer machine. The claim is unchanged — the bill must
    // reach the outbox — it is simply no longer tied to one instant.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              new Promise<number>((resolve, reject) => {
                const request = indexedDB.open('nas-counter');
                request.onsuccess = () => {
                  const transaction = request.result.transaction('outbox', 'readonly');
                  const count = transaction.objectStore('outbox').count();
                  count.onsuccess = () => resolve(count.result);
                  count.onerror = () => reject(new Error('count failed'));
                };
                request.onerror = () => reject(new Error('open failed'));
              }),
          ),
        { message: 'the offline bill never reached the outbox', timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    await context.setOffline(false);
  });
});

test.describe('keyboard-only billing', () => {
  test('completes a whole bill without the mouse', async ({ page }) => {
    const finalizeBodies: unknown[] = [];
    await stubApi(page);
    await page.route(`${API}/sales:finalize`, async (route) => {
      finalizeBodies.push(route.request().postDataJSON());
      await json(
        route,
        {
          invoice: {
            id: 'inv-1',
            internal_reference: 'EST/2026-27/0001',
            sequence_number: 1,
            document_kind: 'estimate',
            status: 'issued',
            issued_at: '2026-10-30T10:05:00+05:30',
            is_credit: false,
            due_date: null,
            customer: {
              id: null,
              name_snapshot: null,
              business_name_snapshot: null,
              vehicle_number_snapshot: null,
              mechanic_name_snapshot: null,
              phone_snapshot: null,
            },
            items: [],
            subtotal: '1250.00',
            discount_total: '0.00',
            tax_total: '0.00',
            rounding_adjustment: '0.00',
            total: '1250.00',
            amount_paid: '1250.00',
            outstanding: '0.00',
            payment_status: 'paid',
            oversell_override: false,
            oversell_reason: null,
            money_policy_version: 1,
            cancelled_at: null,
            cancellation_reason: null,
          },
          print_payload: {
            document_title: 'ESTIMATE',
            is_duplicate: false,
            business: {
              display_name: 'National Auto Spares',
              address_lines: [],
              phone_numbers: [],
              tax_identifier: null,
              tax_identifier_label: null,
            },
            issued_at: '2026-10-30T10:05:00+05:30',
            customer: {
              name: null,
              business_name: null,
              vehicle_number: null,
              mechanic_name: null,
              phone: null,
            },
            columns: ['sl_no', 'item', 'quantity', 'price', 'total'],
            lines: [
              {
                sl_no: 1,
                item: PRODUCT.name,
                quantity: '1.000',
                price: '1250.00',
                total: '1250.00',
              },
            ],
            totals: {
              subtotal: '1250.00',
              discount: '0.00',
              tax: null,
              rounding: '0.00',
              grand_total: '1250.00',
            },
            amount_in_words: 'x',
            payment: {
              status: 'paid',
              amount_paid: '1250.00',
              outstanding: '0.00',
              method: null,
              due_date: null,
              is_credit: false,
            },
            footer_notes: [],
            tax_mode: 'estimate_only',
            print_profile: 'a5_portrait',
            date_format: 'MM-DD-YYYY',
            show_credit_block: false,
            item_row_capacity: 25,
          },
          warnings: [],
        },
        201,
      );
    });

    // The print dialog would block the run, so it is suppressed. What is being tested
    // is the keyboard path to finalisation, not the browser's dialog.
    await page.addInitScript(() => {
      window.print = () => undefined;
    });

    await signIn(page);

    // Search, arrow to the result, Enter to add — no mouse.
    await page.getByLabel('Find an item').focus();
    await page.keyboard.type('TT-407-BS');
    await expect(page.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByText(PRODUCT.name, { exact: true })).toBeVisible();

    // `Ctrl+Enter` finalises a cash bill.
    await page.keyboard.press('Control+Enter');

    await expect(page.getByText('Stock has been updated.')).toBeVisible({
      timeout: 20_000,
    });
    expect(finalizeBodies).toHaveLength(1);

    const body = finalizeBodies[0] as Record<string, unknown>;
    expect(body.sale_type).toBe('cash');
    // A cross-check only; the server recomputes it.
    expect(body.client_computed_total).toBe('1250.00');
  });

  test('shows a shortfall inline, above the buttons, with the per-line detail', async ({
    page,
  }) => {
    await stubApi(page, { finalize: 'conflict' });
    await signIn(page);

    await page.getByLabel('Find an item').focus();
    await page.keyboard.type('TT-407-BS');
    await expect(page.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('Enter');
    // Confirms the line actually landed before finalising. `Enter` adds it through a
    // state update, so pressing `Ctrl+Enter` in the same breath can finalise an empty
    // bill — which is refused, and then nothing under test ever happens. The sibling
    // test above already waits here; these two did not, and one of them failed on CI
    // having never failed locally.
    await expect(page.getByText(PRODUCT.name, { exact: true })).toBeVisible();

    await page.keyboard.press('Control+Enter');

    // An inline panel, not a toast — a toast can be missed while a customer waits.
    const panel = page.getByRole('alert').filter({ hasText: /not enough stock/i });
    await expect(panel).toBeVisible({ timeout: 20_000 });
    // Naming the item and the figures, so the cashier can act without guessing.
    await expect(panel).toContainText(PRODUCT.name);
    await expect(panel).toContainText('only 1.000 in stock');

    // And no retry affordance appeared.
    await expect(page.getByRole('button', { name: /^Retry$/ })).toHaveCount(0);
  });
});

test.describe('the printed bill', () => {
  test('renders into the print root and carries no invoice number', async ({ page }) => {
    await stubApi(page);
    await page.addInitScript(() => {
      window.print = () => undefined;
    });
    await page.route(`${API}/sales:finalize`, (route) =>
      json(
        route,
        {
          invoice: {
            id: 'inv-1',
            internal_reference: 'EST/2026-27/0001',
            sequence_number: 1,
            document_kind: 'estimate',
            status: 'issued',
            issued_at: '2026-10-30T10:05:00+05:30',
            is_credit: false,
            due_date: null,
            customer: {
              id: null,
              name_snapshot: null,
              business_name_snapshot: null,
              vehicle_number_snapshot: null,
              mechanic_name_snapshot: null,
              phone_snapshot: null,
            },
            items: [],
            subtotal: '1250.00',
            discount_total: '0.00',
            tax_total: '0.00',
            rounding_adjustment: '0.00',
            total: '1250.00',
            amount_paid: '1250.00',
            outstanding: '0.00',
            payment_status: 'paid',
            oversell_override: false,
            oversell_reason: null,
            money_policy_version: 1,
            cancelled_at: null,
            cancellation_reason: null,
          },
          print_payload: {
            document_title: 'ESTIMATE',
            is_duplicate: false,
            business: {
              display_name: 'National Auto Spares',
              address_lines: ['Main Road'],
              phone_numbers: ['9876543210'],
              tax_identifier: null,
              tax_identifier_label: null,
            },
            issued_at: '2026-10-30T10:05:00+05:30',
            customer: {
              name: null,
              business_name: null,
              vehicle_number: null,
              mechanic_name: null,
              phone: null,
            },
            columns: ['sl_no', 'item', 'quantity', 'price', 'total'],
            lines: [
              {
                sl_no: 1,
                item: PRODUCT.name,
                quantity: '1.000',
                price: '1250.00',
                total: '1250.00',
              },
            ],
            totals: {
              subtotal: '1250.00',
              discount: '0.00',
              tax: null,
              rounding: '0.00',
              grand_total: '1250.00',
            },
            amount_in_words: 'x',
            payment: {
              status: 'paid',
              amount_paid: '1250.00',
              outstanding: '0.00',
              method: null,
              due_date: null,
              is_credit: false,
            },
            footer_notes: [],
            tax_mode: 'estimate_only',
            print_profile: 'a5_portrait',
            date_format: 'MM-DD-YYYY',
            show_credit_block: false,
            item_row_capacity: 25,
          },
          warnings: [],
        },
        201,
      ),
    );

    await signIn(page);
    await page.getByLabel('Find an item').focus();
    await page.keyboard.type('TT-407-BS');
    await expect(page.getByRole('option').first()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByText(PRODUCT.name, { exact: true })).toBeVisible();
    await page.keyboard.press('Control+Enter');

    const bill = page.locator('#print-root .bill');
    await expect(bill).toBeAttached({ timeout: 20_000 });

    const text = (await bill.textContent()) ?? '';
    // OD-3, verified on the rendered output rather than on the payload.
    expect(text).not.toMatch(/invoice\s*(no|number|#)/i);
    expect(text).not.toContain('EST/2026-27/0001');
    // OD-24: `ESTIMATE`, from the server.
    expect(text).toContain('ESTIMATE');
    // FR-PRINT-012: no tax row at all.
    expect(text).not.toContain('Tax');
    // OD-22: no credit block on a cash bill.
    expect(text).not.toContain('Balance');
    // The 25-row capacity is honoured so the total lands in the same place every time.
    await expect(page.locator('#print-root .bill__items tbody tr')).toHaveCount(25);
  });
});

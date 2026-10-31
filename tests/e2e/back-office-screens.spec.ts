/**
 * End-to-end: the M25 back-office screens in the **built** application.
 *
 * What these add over the component suites: the real bundle, the real lazy-route split,
 * the real permission gating in the shell, and the real navigation between screens. A
 * component test renders one screen in isolation and cannot tell you that the Stock tab
 * is missing for a cashier, or that the Imports chunk fails to load.
 *
 * Two behaviours are worth an end-to-end check specifically:
 *
 * 1. **Permission gating is in the shell, not only in the screen.** A role without
 *    `imports.manage` must never see the tab, because a tab that leads to a 403 is worse
 *    than no tab.
 * 2. **The import review blocks apply until every row is decided** (FR-IMP-007) —
 *    across a lazy chunk boundary, with the real store and the real polling.
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

/** The owner: every M25 permission. */
const OWNER_PERMISSIONS = [
  'billing.sale.finalize',
  'catalog.read',
  'reports.sales.read',
  'credit.read',
  'customer.manage',
  'inventory.adjust',
  'inventory.receive',
  'imports.manage',
];

/** A cashier: billing only. None of the back-office tabs may appear. */
const CASHIER_PERMISSIONS = ['billing.sale.finalize', 'catalog.read'];

function session(permissions: string[], role: string) {
  return {
    access_token: 'e2e-token',
    token_type: 'bearer',
    expires_in: 900,
    user: { id: 'u1', full_name: 'Ravi', must_change_password: false },
    business: { id: 'b1', display_name: 'National Auto Spares' },
    branches: [{ id: 'br1', code: 'MAIN', name: 'Main' }],
    active_branch_id: 'br1',
    role,
    permissions,
    server_time: '2026-10-30T10:00:00+05:30',
  };
}

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

const IMPORT_JOB = {
  id: 'j1',
  intent: 'price_list',
  status: 'needs_review',
  original_filename: 'balaji-prices.csv',
  file_size_bytes: 2048,
  supplier_id: null,
  row_count: 2,
  rows_applied: 0,
  rows_skipped: 0,
  rows_failed: 0,
  rows_pending_decision: 1,
  error_summary: null,
  created_purchase_id: null,
  duplicate_of_job_id: null,
  created_at: '2026-10-30T10:00:00Z',
  applied_at: null,
};

const IMPORT_ROWS = [
  {
    id: 'r1',
    row_index: 1,
    raw_values: { 'Part No': 'TT-407-BS', MRP: '480.00' },
    parsed_name: 'Tie Rod End',
    parsed_sku: 'TT-407-BS',
    parsed_quantity: null,
    parsed_unit_cost: null,
    parsed_selling_price: '480.0000',
    match_status: 'exact_sku',
    matched_product_id: 'p1',
    matched_product_name: 'Tie Rod End Bolero',
    candidate_product_ids: [],
    match_confidence: '1.0000',
    decision: 'pending',
    apply_result: null,
    apply_error: null,
    needs_decision: false,
  },
  {
    id: 'r2',
    row_index: 2,
    raw_values: { 'Part No': 'ZZ-999', MRP: '100.00' },
    parsed_name: 'Unknown Thing',
    parsed_sku: 'ZZ-999',
    parsed_quantity: null,
    parsed_unit_cost: null,
    parsed_selling_price: '100.0000',
    match_status: 'new_product',
    matched_product_id: null,
    matched_product_name: null,
    candidate_product_ids: [],
    match_confidence: null,
    decision: 'pending',
    apply_result: null,
    apply_error: 'Nothing in the catalogue looks like this.',
    needs_decision: true,
  },
];

async function stub(page: Page, permissions: string[], role = 'owner'): Promise<void> {
  const body = session(permissions, role);
  await page.route(`${API}/auth/refresh`, (route) => json(route, body));
  await page.route(`${API}/auth/login`, (route) => json(route, body));
  await page.route(`${API}/sync/bootstrap`, (route) =>
    json(route, {
      business_id: 'b1',
      branch_id: 'br1',
      counter: COUNTER,
      permissions,
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
    json(route, { products: [], cursor: null, has_more: false, truncated: false }),
  );
  await page.route(`${API}/sync/operations`, (route) =>
    json(route, { results: [], server_time: '2026-10-30T10:00:00+05:30' }),
  );
  await page.route(`${API}/drafts**`, (route) => json(route, { items: [] }));
  await page.route(`${API}/products/search**`, (route) =>
    json(route, { items: [], page: { has_more: false, limit: 20, next_cursor: null } }),
  );

  // --- the M25 endpoints ---
  await page.route(`${API}/inventory/balances**`, (route) =>
    json(route, {
      items: [
        {
          product_id: 'p1',
          name: 'Tie Rod End Bolero',
          quantity: '4.000',
          reorder_level: '10.000',
        },
      ],
      as_of: '2026-10-30T10:00:00Z',
    }),
  );
  await page.route(`${API}/inventory/movements**`, (route) =>
    json(route, { items: [], as_of: '2026-10-30T10:00:00Z' }),
  );
  await page.route(`${API}/suppliers`, (route) =>
    json(route, { items: [{ id: 's1', name: 'Sri Balaji Auto Parts', phone: null }] }),
  );
  await page.route(`${API}/purchases**`, (route) =>
    json(route, {
      items: [
        {
          id: 'pu1',
          supplier_id: 's1',
          supplier_name: 'Sri Balaji Auto Parts',
          supplier_document_number: 'SB/2026/118',
          document_date: '2026-10-28',
          status: 'draft',
          subtotal: '12000.00',
          total: '12000.00',
          line_count: 3,
        },
      ],
    }),
  );
  await page.route(`${API}/credit/customers**`, (route) =>
    json(route, {
      items: [
        {
          customer: { id: 'c1', name: 'Rakesh Motors', primary_phone: '9876500011' },
          outstanding: '7400.00',
          total_invoiced: '21000.00',
          total_paid: '13600.00',
          invoice_count: 6,
          open_invoice_count: 2,
          oldest_due_date: '2026-09-15',
          days_overdue: 45,
          ageing: {},
        },
      ],
      as_of: '2026-10-30T10:00:00Z',
    }),
  );
  await page.route(`${API}/payments**`, (route) => json(route, { items: [] }));
  // The customer **directory** (`GET /customers`), which the Customers screen now reads
  // for *who exists* before merging the credit aggregates above onto it. Without this
  // route the request escapes the stub entirely and the table never leaves "Loading…":
  // the screen used to read only `/credit/customers`, which cannot contain a customer
  // who has never bought on credit. Note the `page` block — the directory is
  // keyset-paged, and a stub without one cannot catch a paging bug.
  await page.route(`${API}/customers**`, (route) =>
    json(route, {
      items: [
        {
          id: 'c1',
          name: 'Rakesh Motors',
          business_name: 'Rakesh Transport',
          primary_phone: '9876500011',
          phones: ['9876500011'],
          vehicles: ['KA01AB1234'],
          address_lines: [],
          default_mechanic_name: null,
          credit_terms_days: 30,
          credit_limit: '50000.00',
          is_active: true,
        },
      ],
      page: { next_cursor: null, has_more: false, limit: 50 },
    }),
  );

  // Playwright matches routes in **reverse** registration order, so the catch-all goes
  // first and the specific patterns last. Registered the other way round, `/imports**`
  // shadows `/imports/j1` and the job request is answered with the job *list* — which
  // is exactly how the review dialog came up empty.
  await page.route(`${API}/imports**`, (route) => json(route, { jobs: [IMPORT_JOB] }));
  await page.route(`${API}/imports/j1`, (route) => json(route, IMPORT_JOB));
  await page.route(`${API}/imports/j1/rows**`, (route) =>
    json(route, { rows: IMPORT_ROWS }),
  );
}

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Print Bill/ })).toBeVisible({
    timeout: 20_000,
  });
}

test.describe('M25 — the back-office screens load and show real data', () => {
  test('stock shows what is running low, in words', async ({ page }) => {
    await stub(page, OWNER_PERMISSIONS);
    await open(page);

    await page.getByRole('button', { name: 'Stock', exact: true }).click();
    await expect(page.getByText('Tie Rod End Bolero')).toBeVisible();
    // 4 on hand against a reorder level of 10. The badge is words, not just a colour.
    //
    // Scoped to the table: "Only what is running low" is also the filter button's
    // label, so an unscoped match is ambiguous.
    await expect(page.getByRole('table').getByText('Running low')).toBeVisible();
  });

  test('purchases says a saved bill has not moved stock', async ({ page }) => {
    await stub(page, OWNER_PERMISSIONS);
    await open(page);

    await page.getByRole('button', { name: 'Purchases', exact: true }).click();
    await expect(page.getByText('Sri Balaji Auto Parts')).toBeVisible();
    // FR-PUR-003, as the shopkeeper reads it.
    await expect(page.getByText('Entered, not received')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Receive into stock' })).toBeVisible();
  });

  test('customers states that a balance cannot be typed in', async ({ page }) => {
    await stub(page, OWNER_PERMISSIONS);
    await open(page);

    await page.getByRole('button', { name: 'Customers', exact: true }).click();
    await expect(page.getByText('Rakesh Motors')).toBeVisible();
    await expect(page.getByText(/It cannot be typed in/)).toBeVisible();
  });

  test('imports blocks apply until every row is decided (FR-IMP-007)', async ({
    page,
  }) => {
    await stub(page, OWNER_PERMISSIONS);
    await open(page);

    await page.getByRole('button', { name: 'Imports', exact: true }).click();
    await expect(page.getByText('balaji-prices.csv')).toBeVisible();
    await page.getByRole('button', { name: 'Open' }).click();

    // The count is stated, not left to be inferred from a greyed-out control.
    await expect(page.getByText(/1 row still needs your decision/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply this import' })).toBeDisabled();
    // And the row that needs it says why.
    await expect(
      page.getByText('Nothing in the catalogue looks like this.'),
    ).toBeVisible();
  });
});

test.describe('SECURITY.md §3 — the shell gates on permission, not the screen', () => {
  test('a cashier sees none of the back-office tabs', async ({ page }) => {
    await stub(page, CASHIER_PERMISSIONS, 'cashier');
    await open(page);

    // A tab that leads to a 403 is worse than no tab.
    for (const name of ['Purchases', 'Customers', 'Imports']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    // Billing is still there, and still the default.
    await expect(page.getByRole('button', { name: /Print Bill/ })).toBeVisible();
  });

  test('a cashier with catalog.read may still look at stock but not adjust it', async ({
    page,
  }) => {
    await stub(page, CASHIER_PERMISSIONS, 'cashier');
    await open(page);

    await page.getByRole('button', { name: 'Stock', exact: true }).click();
    await expect(page.getByText('Tie Rod End Bolero')).toBeVisible();
    // `inventory.adjust` is absent, so the control is too.
    await expect(page.getByRole('button', { name: 'Adjust' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'History' })).toBeVisible();
  });
});

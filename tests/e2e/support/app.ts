/**
 * Shared end-to-end scaffolding: a stubbed API and a booted application.
 *
 * Extracted so the accessibility suite can reach every screen without a third copy of
 * the bootstrap stubs. The existing specs keep their own local copies deliberately —
 * they were written against them and rewriting a passing suite to share a helper is a
 * change with risk and no benefit.
 *
 * **These stubs are for the screens-reachable suites only.** The full-stack suite
 * (`full-stack.spec.ts`) talks to a real backend and must never import from here; that
 * is the whole point of it.
 */

import { expect, type Page, type Route } from '@playwright/test';

export const API = '**/api/v1';

export const MONEY_POLICY = {
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

export const COUNTER = {
  id: '0192f000-0000-7000-8000-00000000c001',
  code: 'C1',
  name: 'Counter 1',
  max_open_drafts: 4,
};

/** Every permission the back-office screens gate on. */
export const OWNER_PERMISSIONS = [
  'billing.sale.finalize',
  'catalog.read',
  'catalog.write',
  'reports.sales.read',
  'reports.financial.read',
  'credit.read',
  'customer.manage',
  'inventory.adjust',
  'inventory.receive',
  'imports.manage',
];

export function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

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

const PRODUCT = {
  id: 'p1',
  name: 'Tie Rod End Bolero',
  sku: 'TT-407-TR',
  barcode: null,
  brand: 'Allied',
  category: null,
  unit: { code: 'NOS', allows_fraction: false },
  default_selling_price: '1250.0000',
  stock: { branch_quantity: '4.000', as_of: '2026-10-30T10:00:00Z' },
  is_active: true,
  is_low_stock: true,
  hsn_code: null,
  match: { kind: 'sku_prefix', score: 80 },
};

const INVOICE_ROW = {
  id: 'inv-1',
  issued_at: '2026-10-30T10:15:00Z',
  customer_name: 'Ramesh Motors',
  counter: 'C1',
  is_credit: true,
  total: '5000',
  outstanding: '2000',
  amount_paid: '3000',
  status: 'issued',
  payment_status: 'partially_paid',
  due_date: '2026-11-15',
};

/** Install the full set of stubs the shell and every screen need to render. */
export async function stubApi(
  page: Page,
  permissions: string[] = OWNER_PERMISSIONS,
  role = 'owner',
): Promise<void> {
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
    json(route, {
      items: [PRODUCT],
      page: { has_more: false, limit: 20, next_cursor: null },
    }),
  );

  // --- reports -------------------------------------------------------------
  await page.route(`${API}/invoices**`, (route) => json(route, { items: [INVOICE_ROW] }));
  await page.route(`${API}/reports/daily-sales**`, (route) =>
    json(route, {
      as_of: '2026-10-30T10:00:00Z',
      filters: { from: '2026-10-30', to: '2026-10-30' },
      bill_count: 7,
      net: '12345',
      collected: '9000',
      credit_sales: '3345',
      cash_sales: '9000',
      excluded: { cancelled_bill_count: 2 },
    }),
  );
  await page.route(`${API}/credit/customers**`, (route) =>
    json(route, {
      items: [
        {
          customer: { id: 'c1', name: 'Ramesh Motors', primary_phone: '9876543210' },
          outstanding: '2000',
          invoice_count: 5,
          open_invoice_count: 2,
          days_overdue: 12,
          ageing: { '0_30': '1000', '31_60': '1000' },
        },
      ],
      summary: { customer_count: 1, outstanding: '2000' },
    }),
  );

  // --- back office ---------------------------------------------------------
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
  // The customer **directory** (`GET /customers`). It carries a `page` block, because
  // it is keyset-paged — a stub without one is a stub that cannot catch a paging bug,
  // and the screen reads `page.next_cursor` to decide whether to offer "Show more".
  await page.route(`${API}/customers**`, (route) =>
    json(route, {
      items: [
        {
          id: 'c1',
          name: 'Rakesh Motors',
          business_name: 'Rakesh Transport',
          primary_phone: '9876543210',
          phones: ['9876543210'],
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
  await page.route(`${API}/imports**`, (route) => json(route, { items: [] }));
  await page.route(`${API}/notifications**`, (route) => json(route, { items: [] }));
}

/** Boot the built application and wait until the counter is actually usable. */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Print Bill/ })).toBeVisible({
    timeout: 20_000,
  });
}

/** The screens reachable from the shell, by the tab that opens them. */
export const SCREENS = [
  'Stock',
  'Purchases',
  'Customers',
  'Daily Bills',
  'Credit Bills',
  'Imports',
] as const;

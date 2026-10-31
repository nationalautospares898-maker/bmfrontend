/**
 * Daily Bills and Credit Bills, rendered.
 *
 * The 30 October 2026 audit measured this file at **0% coverage**. It is the screen the
 * owner reconciles the till against, so the assertions here are the ones that would let
 * a wrong number reach that reconciliation unnoticed:
 *
 * - **every figure comes off the response verbatim.** `collected` is not `net` and the
 *   screen must never derive one from the other (FR-RPT-002, ADR-032). The fixture gives
 *   the four figures four different values precisely so a swap or a client-side sum
 *   fails here;
 * - the **excluded** note is stated rather than silently applied — a day's total that
 *   quietly omits cancelled bills cannot be reconciled against the drawer;
 * - **status is displayed, never decided.** A cancelled bill reads "Cancelled" and there
 *   is no control anywhere that sets it (ADR-022);
 * - **reprint creates nothing** and asks for `is_duplicate=true` (FR-PRINT-004);
 * - loading, empty, error and permission-error states all say what happened;
 * - a response that arrives after the day changed is **discarded**, so a slow first
 *   request cannot overwrite a newer one;
 * - Credit Bills groups on `customer_id`, shows server-computed ageing, and never
 *   hides a settled customer permanently (FR-RPT-029/030/031);
 * - both screens pass axe.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/errors';
import type { MoneyPolicy } from '@/lib/money';
import { CreditBills, DailyBills } from './DailyBills';

const list = vi.fn();
const dailySales = vi.fn();
const printPayload = vi.fn();
const recordPrintEvent = vi.fn();
const customers = vi.fn();
/** The `window.print` stub, so the assertion does not reference an unbound method. */
let printSpy = vi.fn();

vi.mock('@/api/endpoints', () => ({
  invoices: {
    list: (...args: unknown[]) => list(...args) as unknown,
    printPayload: (...args: unknown[]) => printPayload(...args) as unknown,
    recordPrintEvent: (...args: unknown[]) => recordPrintEvent(...args) as unknown,
  },
  reports: {
    dailySales: (...args: unknown[]) => dailySales(...args) as unknown,
  },
  credit: {
    customers: (...args: unknown[]) => customers(...args) as unknown,
  },
}));

/** The whole-rupee v1 policy, as the settings endpoint publishes it. */
const POLICY: MoneyPolicy = {
  version: 1,
  currency: 'INR',
  amount_scale: 2,
  unit_price_scale: 4,
  quantity_scale: 3,
  percent_scale: 2,
  rounding_mode: 'reject_fractional',
  round_grand_total_to_rupee: true,
  require_integral_amounts: true,
  display_decimal_places: 0,
};

/** Four deliberately different figures, so a swap cannot pass. */
const SUMMARY = {
  bill_count: 7,
  net: '12345',
  collected: '9000',
  credit_sales: '3345',
  excluded: { cancelled_bill_count: 2 },
};

const ROWS = [
  {
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
  },
  {
    id: 'inv-2',
    issued_at: '2026-10-30T11:30:00Z',
    // A walk-in. Must render as an em dash, not "null".
    customer_name: null,
    counter: 'C2',
    is_credit: false,
    total: '1200',
    outstanding: '0',
    amount_paid: '1200',
    // Cancelled must win over payment_status in the status column.
    status: 'cancelled',
    payment_status: 'paid',
    due_date: null,
  },
];

/**
 * A complete reprint payload, as `GET /invoices/{id}/print-payload` returns it.
 *
 * Complete rather than minimal on purpose: `PrintRoot` portals it into
 * `InvoicePrintLayout`, so a payload missing `business` or `totals` throws inside the
 * portal and `window.print()` is never reached — which would make the reprint
 * assertions pass for the wrong reason.
 *
 * `is_duplicate: true` because this is a reprint, and only the server decides that
 * (FR-PRINT-004).
 */
const PRINT_PAYLOAD = {
  document_title: 'ESTIMATE',
  is_duplicate: true,
  business: {
    display_name: 'National Auto Spares',
    address_lines: ['Main Road', 'Hyderabad'],
    phone_numbers: ['9876543210'],
    tax_identifier: null,
    tax_identifier_label: null,
  },
  issued_at: '2026-10-30T10:15:00+05:30',
  customer: {
    name: 'Ramesh Motors',
    business_name: null,
    vehicle_number: 'KA01AB1234',
    mechanic_name: null,
    phone: null,
  },
  columns: ['sl_no', 'item', 'quantity', 'price', 'total'],
  lines: [
    {
      sl_no: 1,
      item: 'Brake Shoe Set',
      quantity: '2.000',
      price: '2500.00',
      total: '5000.00',
    },
  ],
  totals: {
    subtotal: '5000.00',
    discount: '0.00',
    tax: null,
    rounding: '0.00',
    grand_total: '5000.00',
  },
  amount_in_words: 'Five thousand rupees only',
  payment: {
    status: 'partially_paid',
    amount_paid: '3000.00',
    outstanding: '2000.00',
    method: null,
    due_date: '2026-11-15',
    is_credit: true,
  },
  footer_notes: [],
  tax_mode: 'estimate_only',
  print_profile: 'a5_portrait',
  date_format: 'MM-DD-YYYY',
  show_credit_block: true,
  item_row_capacity: 25,
};

/**
 * The first row's Reprint control.
 *
 * `getAllByRole(...)[0]` is `HTMLElement | undefined` under `noUncheckedIndexedAccess`,
 * which the project enables deliberately (ADR-023). Asserting non-empty here keeps the
 * strictness and still fails loudly if the control disappears.
 */
function firstReprintButton(): HTMLElement {
  const buttons = screen.getAllByRole('button', { name: 'Reprint' });
  const first = buttons[0];
  if (!first) throw new Error('no Reprint button rendered');
  return first;
}

function apiError(code: string, message = 'nope'): ApiError {
  return new ApiError(403, {
    error: {
      code: code as never,
      message,
      details: {},
      request_id: 'req-1',
      retryable: false,
    },
  });
}

beforeEach(() => {
  vi.useRealTimers();
  list.mockReset();
  dailySales.mockReset();
  printPayload.mockReset();
  recordPrintEvent.mockReset();
  customers.mockReset();
  list.mockResolvedValue({ items: ROWS });
  dailySales.mockResolvedValue(SUMMARY);
  printPayload.mockResolvedValue(PRINT_PAYLOAD);
  recordPrintEvent.mockResolvedValue(undefined);
  customers.mockResolvedValue({ items: [], summary: null });
  // `window.print` does not exist in jsdom; PrintRoot calls it after a frame. Held in a
  // variable rather than asserted through `window.print`, which reads as an unbound
  // method to the type-aware lint rules.
  printSpy = vi.fn();
  vi.stubGlobal('print', printSpy);
  // `#print-root` lives in `index.html`, **outside** the application layout, so that
  // one `@media print` rule can hide the app and leave only the bill. A component test
  // has to supply it, or `PrintRoot` finds no portal target and renders nothing —
  // which would make the reprint assertions below quietly vacuous.
  const root = document.createElement('div');
  root.id = 'print-root';
  document.body.append(root);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.getElementById('print-root')?.remove();
});

// --- Daily Bills --------------------------------------------------------------

describe('Daily Bills', () => {
  it('says it is loading before the first response arrives', () => {
    list.mockReturnValue(new Promise(() => {}));
    dailySales.mockReturnValue(new Promise(() => {}));
    render(<DailyBills policy={POLICY} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });

  it('asks for exactly one day, both ends inclusive', async () => {
    render(<DailyBills policy={POLICY} />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    const today = new Date().toISOString().slice(0, 10);
    expect(list).toHaveBeenCalledWith({ from: today, to: today, limit: 200 });
    expect(dailySales).toHaveBeenCalledWith({ from: today, to: today });
  });

  it('renders the four summary figures off the response, without deriving any of them', async () => {
    render(<DailyBills policy={POLICY} />);
    // Each figure must appear as its own value. If the screen summed the rows, or
    // reused `net` for `collected`, these would not all be present.
    expect(await screen.findByText('7')).toBeInTheDocument();
    expect(screen.getByText('12345')).toBeInTheDocument();
    expect(screen.getByText('9000')).toBeInTheDocument();
    expect(screen.getByText('3345')).toBeInTheDocument();
  });

  it('pairs each figure with its own label', async () => {
    render(<DailyBills policy={POLICY} />);
    await screen.findByText('12345');
    for (const [label, value] of [
      ['Bills', '7'],
      ['Net sales', '12345'],
      ['Cash collected', '9000'],
      ['Credit sales', '3345'],
    ] as const) {
      const term = screen.getByText(label);
      // <dt> immediately followed by its <dd>.
      expect(term.nextElementSibling).toHaveTextContent(value);
    }
  });

  it('states what the totals exclude rather than applying it silently', async () => {
    render(<DailyBills policy={POLICY} />);
    expect(
      await screen.findByText(/Excludes\s+cancelled bill count: 2/),
    ).toBeInTheDocument();
  });

  it('omits the excluded note when the server reports nothing excluded', async () => {
    dailySales.mockResolvedValue({ ...SUMMARY, excluded: null });
    render(<DailyBills policy={POLICY} />);
    await screen.findByText('12345');
    expect(screen.queryByText(/Excludes/)).not.toBeInTheDocument();
  });

  it('falls back to zero for absent figures instead of rendering "undefined"', async () => {
    dailySales.mockResolvedValue({});
    render(<DailyBills policy={POLICY} />);
    await waitFor(() => expect(screen.getByText('Bills')).toBeInTheDocument());
    expect(screen.getByText('Bills').nextElementSibling).toHaveTextContent('0');
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it('lists each bill with its figures', async () => {
    render(<DailyBills policy={POLICY} />);
    const row = (await screen.findByText('Ramesh Motors')).closest('tr');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('C1')).toBeInTheDocument();
    expect(within(row!).getByText('Credit')).toBeInTheDocument();
    expect(within(row!).getByText('5000')).toBeInTheDocument();
    expect(within(row!).getByText('2000')).toBeInTheDocument();
  });

  it('shows an em dash for a walk-in rather than the word null', async () => {
    render(<DailyBills policy={POLICY} />);
    const row = (await screen.findByText('C2')).closest('tr');
    expect(within(row!).getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('null')).not.toBeInTheDocument();
  });

  it('shows a cancelled bill as cancelled, not as its payment status', async () => {
    render(<DailyBills policy={POLICY} />);
    const row = (await screen.findByText('C2')).closest('tr');
    expect(within(row!).getByText('Cancelled')).toBeInTheDocument();
    // `payment_status` was 'paid'; it must not be what the status column shows.
    expect(within(row!).queryByText('paid')).not.toBeInTheDocument();
  });

  it('shows the payment status for a bill that was not cancelled', async () => {
    render(<DailyBills policy={POLICY} />);
    const row = (await screen.findByText('Ramesh Motors')).closest('tr');
    expect(within(row!).getByText('partially_paid')).toBeInTheDocument();
  });

  it('says there is nothing to show when the day is empty', async () => {
    list.mockResolvedValue({ items: [] });
    render(<DailyBills policy={POLICY} />);
    expect(await screen.findByText('Nothing to show yet.')).toBeInTheDocument();
  });

  it('does not show the empty row while still loading', async () => {
    let resolve: ((value: unknown) => void) | undefined;
    list.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    render(<DailyBills policy={POLICY} />);
    expect(screen.queryByText('Nothing to show yet.')).not.toBeInTheDocument();
    resolve?.({ items: [] });
    expect(await screen.findByText('Nothing to show yet.')).toBeInTheDocument();
  });

  it('refetches when the day is changed', async () => {
    const user = userEvent.setup();
    render(<DailyBills policy={POLICY} />);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    await user.clear(screen.getByLabelText('Day'));
    await user.type(screen.getByLabelText('Day'), '2026-10-01');

    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({
        from: '2026-10-01',
        to: '2026-10-01',
        limit: 200,
      }),
    );
    expect(dailySales).toHaveBeenLastCalledWith({ from: '2026-10-01', to: '2026-10-01' });
  });

  it('discards a response that arrives after the day has already changed', async () => {
    // The first request is slow and resolves with yesterday's single row *after* the
    // second request has already returned today's. Without the cancellation guard the
    // stale response would win and the screen would show the wrong day's bills.
    const user = userEvent.setup();
    let resolveFirst: ((value: unknown) => void) | undefined;
    list
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveFirst = r;
        }),
      )
      .mockResolvedValue({ items: ROWS });

    render(<DailyBills policy={POLICY} />);
    await user.clear(screen.getByLabelText('Day'));
    await user.type(screen.getByLabelText('Day'), '2026-10-01');
    await screen.findByText('Ramesh Motors');

    resolveFirst?.({
      items: [{ ...ROWS[0], id: 'stale', customer_name: 'STALE ROW' }],
    });
    await waitFor(() => expect(screen.queryByText('STALE ROW')).not.toBeInTheDocument());
    expect(screen.getByText('Ramesh Motors')).toBeInTheDocument();
  });

  it('explains a refused request in words, not a status code', async () => {
    dailySales.mockRejectedValue(apiError('PERMISSION_DENIED'));
    render(<DailyBills policy={POLICY} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You do not have permission to do this.');
    expect(alert).not.toHaveTextContent('403');
  });

  it('offers a retry when the failure is not one the server named', async () => {
    list.mockRejectedValue(new Error('network down'));
    render(<DailyBills policy={POLICY} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Retry');
  });

  it('stops saying it is loading after a failure', async () => {
    list.mockRejectedValue(new Error('network down'));
    render(<DailyBills policy={POLICY} />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('clears a previous error once a later request succeeds', async () => {
    const user = userEvent.setup();
    list
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ items: ROWS });
    render(<DailyBills policy={POLICY} />);
    await screen.findByRole('alert');

    await user.clear(screen.getByLabelText('Day'));
    await user.type(screen.getByLabelText('Day'), '2026-10-02');

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('reprints by asking the server for a duplicate payload, creating nothing', async () => {
    const user = userEvent.setup();
    render(<DailyBills policy={POLICY} />);
    await screen.findByText('Ramesh Motors');

    await user.click(firstReprintButton());

    await waitFor(() => expect(printPayload).toHaveBeenCalledWith('inv-1', true));
    // Nothing that could create a sale, a number or a movement was called.
    expect(list).toHaveBeenCalledTimes(1);
    expect(dailySales).toHaveBeenCalledTimes(1);
  });

  it('clears the print payload once the dialog closes, so it cannot reopen', async () => {
    // The payload is cleared on `afterprint` (`onAfterPrint`). Without that, a later
    // parent re-render would mount the same payload again and the operator would get a
    // second print dialog for a bill they already printed.
    const user = userEvent.setup();
    render(<DailyBills policy={POLICY} />);
    await screen.findByText('Ramesh Motors');

    await user.click(firstReprintButton());
    await waitFor(() => expect(printPayload).toHaveBeenCalledWith('inv-1', true));
    // PrintRoot opens the dialog a frame later; let that happen, then close it.
    await waitFor(() => expect(printSpy).toHaveBeenCalled());

    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });

    // Logged best-effort, after the dialog — never before, and never blocking it.
    await waitFor(() => expect(recordPrintEvent).toHaveBeenCalledWith('inv-1', true));
    // And pressing Reprint again asks the server again rather than reusing stale state.
    await user.click(firstReprintButton());
    await waitFor(() => expect(printPayload).toHaveBeenCalledTimes(2));
  });

  it('gives every column a header and the table a caption', async () => {
    render(<DailyBills policy={POLICY} />);
    await screen.findByText('Ramesh Motors');
    for (const header of [
      'Time',
      'Customer',
      'Counter',
      'Type',
      'Total',
      'Outstanding',
      'Status',
    ]) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
    expect(screen.getByText(/Bills issued on/)).toBeInTheDocument();
  });

  it('passes axe', async () => {
    const { container } = render(<DailyBills policy={POLICY} />);
    await screen.findByText('Ramesh Motors');
    const results = await axe.run(container, {
      // Contrast cannot be computed in jsdom — there is no layout and no canvas, so
      // axe reports an error rather than a result. It is checked for real in a browser
      // by `tests/e2e/accessibility.spec.ts`.
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});

// --- Credit Bills -------------------------------------------------------------

const CREDIT_CUSTOMERS = [
  {
    customer: { id: 'c1', name: 'Ramesh Motors', primary_phone: '9876543210' },
    outstanding: '2000',
    invoice_count: 5,
    open_invoice_count: 2,
    days_overdue: 12,
    ageing: { '0_30': '1000', '31_60': '1000' },
  },
  {
    customer: { id: 'c2', name: 'Suresh Transport', primary_phone: null },
    outstanding: '500',
    invoice_count: 1,
    open_invoice_count: 1,
    days_overdue: null,
    ageing: { '0_30': '500' },
  },
];

describe('Credit Bills', () => {
  beforeEach(() => {
    customers.mockResolvedValue({
      items: CREDIT_CUSTOMERS,
      summary: { customer_count: 2, outstanding: '2500' },
    });
  });

  it('says it is loading before the first response', () => {
    customers.mockReturnValue(new Promise(() => {}));
    render(<CreditBills />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });

  it('excludes settled customers by default', async () => {
    render(<CreditBills />);
    await waitFor(() => expect(customers).toHaveBeenCalled());
    expect(customers).toHaveBeenCalledWith({ include_settled: false, limit: 200 });
  });

  it('can include customers at zero balance, so history is never hidden for good', async () => {
    const user = userEvent.setup();
    render(<CreditBills />);
    await screen.findByText('Ramesh Motors');

    await user.click(screen.getByLabelText(/Include customers at zero balance/));

    await waitFor(() =>
      expect(customers).toHaveBeenLastCalledWith({ include_settled: true, limit: 200 }),
    );
  });

  it('renders the server-computed totals rather than summing the rows', async () => {
    render(<CreditBills />);
    await screen.findByText('Ramesh Motors');
    expect(screen.getByText('Customers owing').nextElementSibling).toHaveTextContent('2');
    expect(screen.getByText('Total outstanding').nextElementSibling).toHaveTextContent(
      '2500',
    );
  });

  it('falls back to the row count when the server sends no customer_count', async () => {
    customers.mockResolvedValue({
      items: CREDIT_CUSTOMERS,
      summary: { outstanding: '2500' },
    });
    render(<CreditBills />);
    await screen.findByText('Ramesh Motors');
    expect(screen.getByText('Customers owing').nextElementSibling).toHaveTextContent('2');
  });

  it('omits the totals panel when the server sends no summary', async () => {
    customers.mockResolvedValue({ items: CREDIT_CUSTOMERS, summary: null });
    render(<CreditBills />);
    await screen.findByText('Ramesh Motors');
    expect(screen.queryByText('Total outstanding')).not.toBeInTheDocument();
  });

  it('shows a phone number when there is one and nothing when there is not', async () => {
    render(<CreditBills />);
    await screen.findByText('Ramesh Motors');
    expect(screen.getByText('9876543210')).toBeInTheDocument();
    const settled = screen.getByText('Suresh Transport').closest('button');
    expect(within(settled!).queryByText(/^\d{10}$/)).not.toBeInTheDocument();
  });

  it('flags an overdue customer and leaves the others unflagged', async () => {
    render(<CreditBills />);
    await screen.findByText('Ramesh Motors');
    expect(screen.getByText('12 days overdue')).toBeInTheDocument();
    expect(screen.getAllByText(/days overdue/)).toHaveLength(1);
  });

  it('shows open-of-total counts', async () => {
    render(<CreditBills />);
    expect(await screen.findByText('2 open of 5')).toBeInTheDocument();
  });

  it('expands a customer to their credit bills, keyed on the customer id', async () => {
    const user = userEvent.setup();
    render(<CreditBills />);
    await screen.findByText('Ramesh Motors');

    await user.click(screen.getByRole('button', { name: /Ramesh Motors/ }));

    await waitFor(() =>
      expect(list).toHaveBeenCalledWith({
        customer_id: 'c1',
        is_credit: true,
        limit: 200,
      }),
    );
    expect(screen.getByRole('button', { name: /Ramesh Motors/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('collapses again on a second press without refetching', async () => {
    const user = userEvent.setup();
    render(<CreditBills />);
    await screen.findByText('Ramesh Motors');
    const toggle = screen.getByRole('button', { name: /Ramesh Motors/ });

    await user.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
    await user.click(toggle);

    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('shows the server-computed ageing buckets, readably', async () => {
    const user = userEvent.setup();
    render(<CreditBills />);
    await screen.findByText('Ramesh Motors');

    await user.click(screen.getByRole('button', { name: /Ramesh Motors/ }));

    // `0_30` is shown as `0–30`; the client never buckets the dates itself.
    expect(await screen.findByText(/0–30/)).toBeInTheDocument();
    expect(screen.getByText(/31–60/)).toBeInTheDocument();
  });

  it('lists the expanded customer bills with a due date or an em dash', async () => {
    const user = userEvent.setup();
    render(<CreditBills />);
    await screen.findByText('Ramesh Motors');

    await user.click(screen.getByRole('button', { name: /Ramesh Motors/ }));

    expect(await screen.findByText('2026-11-15')).toBeInTheDocument();
    expect(screen.getByText('3000')).toBeInTheDocument();
  });

  it('explains a refusal in words', async () => {
    customers.mockRejectedValue(apiError('PERMISSION_DENIED'));
    render(<CreditBills />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You do not have permission to do this.',
    );
  });

  it('offers a retry for an unnamed failure', async () => {
    customers.mockRejectedValue(new Error('offline'));
    render(<CreditBills />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Retry');
  });

  it('renders an empty list without an error', async () => {
    customers.mockResolvedValue({ items: [], summary: null });
    render(<CreditBills />);
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('passes axe', async () => {
    const { container } = render(<CreditBills />);
    await screen.findByText('Ramesh Motors');
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});

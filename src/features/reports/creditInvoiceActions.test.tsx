/**
 * The credit-invoice features the owner asked for on 2026-11-07.
 *
 * * **F6** — opening a credit bill shows the *whole bill*, not a summary.
 * * **F13** — a payment against one named invoice.
 * * **F14** — the per-invoice actions, including the payment history.
 *
 * The load-bearing assertions are again the negative ones:
 *
 * * the viewer must render the bill's **saved** figures, never recompute them from
 *   today's catalogue;
 * * the per-invoice payment must allocate `invoice_specific`, **not** `oldest_first` —
 *   confusing the two would silently pay the wrong bill;
 * * the payment history must read the **ledger**, so money collected through the
 *   Customers screen still shows up here.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Invoice } from '@/api/types';
import {
  FullBillView,
  InvoicePaymentHistory,
  ReceiveInvoicePayment,
} from './CreditInvoiceDetail';

const mocks = vi.hoisted(() => ({
  recordPayment: vi.fn(),
  payments: vi.fn(),
  printPayload: vi.fn(),
}));

vi.mock('@/api/endpoints', () => ({
  credit: { recordPayment: mocks.recordPayment, payments: mocks.payments },
  invoices: { printPayload: mocks.printPayload },
}));

/** A credit bill, in the exact shape `GET /invoices/{id}` returns. */
const INVOICE: Invoice = {
  id: 'inv-1',
  internal_reference: 'C1/2026/0007',
  sequence_number: 7,
  document_kind: 'estimate',
  status: 'issued',
  issued_at: '2026-10-30T10:15:00Z',
  is_credit: true,
  due_date: '2026-11-15',
  customer: {
    id: 'cust-1',
    name_snapshot: 'Ramesh Motors',
    business_name_snapshot: 'Ramesh Transports',
    vehicle_number_snapshot: 'KA01AB1234',
    mechanic_name_snapshot: 'Suresh',
    phone_snapshot: '9876500011',
  },
  notes: 'Collected by driver.',
  version: 1,
  items: [
    {
      id: 'item-1',
      product_id: 'prod-1',
      line_no: 1,
      product_name_snapshot: 'Brake Shoe Set Ace',
      sku_snapshot: 'BR-4002-E',
      unit_code_snapshot: 'SET',
      quantity: '2.000',
      unit_price: '870.0000',
      discount_amount: '0.00',
      tax_rate_snapshot: '0.00',
      tax_amount: '0.00',
      line_total: '1740.00',
      returned_quantity: '0.000',
    },
  ],
  subtotal: '1740.00',
  discount_total: '0.00',
  tax_total: '0.00',
  rounding_adjustment: '0.00',
  total: '1740.00',
  amount_paid: '740.00',
  outstanding: '1000.00',
  payment_status: 'partially_paid',
  oversell_override: false,
  oversell_reason: null,
  money_policy_version: 1,
  cancelled_at: null,
  cancellation_reason: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recordPayment.mockResolvedValue({ payment_id: 'pay-1', allocations: [] });
  mocks.payments.mockResolvedValue({ items: [] });
});

// --- F6: the full bill --------------------------------------------------------

describe('the full bill viewer', () => {
  it('shows the header fields, not just a total', () => {
    // The owner's complaint: opening a credit bill gave date, total, paid, outstanding
    // and due date — a summary, not the bill.
    render(<FullBillView invoice={INVOICE} />);

    expect(screen.getByText('Ramesh Motors')).toBeInTheDocument();
    expect(screen.getByText('Ramesh Transports')).toBeInTheDocument();
    expect(screen.getByText('Suresh')).toBeInTheDocument();
    expect(screen.getByText('KA01AB1234')).toBeInTheDocument();
    expect(screen.getByText('9876500011')).toBeInTheDocument();
    expect(screen.getByText('C1/2026/0007')).toBeInTheDocument();
  });

  it('numbers the lines with the bill’s own serial numbers', () => {
    render(<FullBillView invoice={INVOICE} />);
    const row = screen.getByText('Brake Shoe Set Ace').closest('tr');
    // `line_no` from the bill, so the serials match the paper rather than the render
    // order of this list.
    expect(row).toHaveTextContent('1');
  });

  it('renders the saved prices and totals verbatim', () => {
    render(<FullBillView invoice={INVOICE} />);

    // `formatForScreen` groups nothing and shows paise only when a value has them, so
    // `870.0000` is `870` and `1740.00` is `1740`. Asserted in that exact form rather
    // than a prettified one, because the point is that the bill's own figures are
    // passed through untouched.
    expect(screen.getByText('870')).toBeInTheDocument();
    // Twice: the line total and the grand total are both 1740 on a single-line bill.
    expect(screen.getAllByText('1740').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps ESTIMATE on the bill (OD-24)', () => {
    render(<FullBillView invoice={INVOICE} />);
    expect(screen.getByText('ESTIMATE')).toBeInTheDocument();
  });

  it('shows the credit block: credit amount, paid, outstanding and status', () => {
    render(<FullBillView invoice={INVOICE} />);

    expect(screen.getByText('Credit amount')).toBeInTheDocument();
    expect(screen.getByText('740')).toBeInTheDocument();
    expect(screen.getByText('1000')).toBeInTheDocument();
    // Server-derived, displayed as given (ADR-022).
    expect(screen.getByText('partially_paid')).toBeInTheDocument();
  });

  it('shows the bill’s note', () => {
    render(<FullBillView invoice={INVOICE} />);
    expect(screen.getByText(/Collected by driver/)).toBeInTheDocument();
  });

  it('omits a zero discount and a zero tax row rather than showing a misleading zero', () => {
    render(<FullBillView invoice={INVOICE} />);
    // A zero tax row would be actively wrong while tax is estimate-only (ADR-020).
    expect(screen.queryByText('Tax')).not.toBeInTheDocument();
    expect(screen.queryByText('Discount')).not.toBeInTheDocument();
  });

  it('shows a discount row when there is one', () => {
    render(<FullBillView invoice={{ ...INVOICE, discount_total: '40.00' }} />);
    expect(screen.getByText('Discount')).toBeInTheDocument();
  });

  it('says a cancelled bill is cancelled, with the reason', () => {
    render(
      <FullBillView
        invoice={{
          ...INVOICE,
          status: 'cancelled',
          cancellation_reason: 'Wrong part supplied',
        }}
      />,
    );
    expect(screen.getByText(/Wrong part supplied/)).toBeInTheDocument();
  });
});

// --- F13: a payment against this bill ----------------------------------------

describe('receiving a payment on one invoice', () => {
  function renderForm(outstanding = '1000.00') {
    const onRecorded = vi.fn();
    render(
      <ReceiveInvoicePayment
        invoiceId="inv-1"
        customerId="cust-1"
        outstanding={outstanding}
        onRecorded={onRecorded}
      />,
    );
    return { onRecorded };
  }

  it('allocates to the named invoice, not oldest-first', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Record the payment' }));

    await waitFor(() => expect(mocks.recordPayment).toHaveBeenCalledTimes(1));
    const [body] = mocks.recordPayment.mock.calls[0] ?? [];
    expect(body.allocation).toEqual({
      strategy: 'invoice_specific',
      allocations: [{ invoice_id: 'inv-1', amount: '1000.00' }],
    });
    // Confusing this with the Customers screen's workflow would pay the wrong bill.
    expect(body.allocation.strategy).not.toBe('oldest_first');
  });

  it('prefills the amount with what is still outstanding', () => {
    renderForm('1000.00');
    expect(screen.getByLabelText('Amount received')).toHaveValue('1000');
  });

  it('supports a partial payment', async () => {
    const user = userEvent.setup();
    renderForm();

    const amount = screen.getByLabelText('Amount received');
    await user.clear(amount);
    await user.type(amount, '400');
    await user.click(screen.getByRole('button', { name: 'Record the payment' }));

    await waitFor(() => expect(mocks.recordPayment).toHaveBeenCalled());
    const [body] = mocks.recordPayment.mock.calls[0] ?? [];
    expect(body.amount).toBe('400.00');
  });

  it('sends an idempotency key, so a double press records one payment', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Record the payment' }));
    await waitFor(() => expect(mocks.recordPayment).toHaveBeenCalled());

    const key = mocks.recordPayment.mock.calls[0]?.[1];
    expect(key).toBeTruthy();
  });

  it('uses a NEW key for a second, genuine payment', async () => {
    const user = userEvent.setup();
    renderForm();
    const button = screen.getByRole('button', { name: 'Record the payment' });

    await user.click(button);
    await waitFor(() => expect(mocks.recordPayment).toHaveBeenCalledTimes(1));
    await user.click(button);
    await waitFor(() => expect(mocks.recordPayment).toHaveBeenCalledTimes(2));

    // Otherwise the second payment would replay the first and silently vanish.
    expect(mocks.recordPayment.mock.calls[0]?.[1]).not.toBe(
      mocks.recordPayment.mock.calls[1]?.[1],
    );
  });

  it('refuses an amount above the outstanding, before sending', async () => {
    const user = userEvent.setup();
    renderForm('1000.00');

    const amount = screen.getByLabelText('Amount received');
    await user.clear(amount);
    await user.type(amount, '1500');
    await user.click(screen.getByRole('button', { name: 'Record the payment' }));

    expect(
      await screen.findByText(/more than the 1000 still outstanding/),
    ).toBeInTheDocument();
    expect(mocks.recordPayment).not.toHaveBeenCalled();
  });

  it('refuses zero', async () => {
    const user = userEvent.setup();
    renderForm();

    const amount = screen.getByLabelText('Amount received');
    await user.clear(amount);
    await user.type(amount, '0');
    await user.click(screen.getByRole('button', { name: 'Record the payment' }));

    expect(await screen.findByText(/greater than zero/)).toBeInTheDocument();
    expect(mocks.recordPayment).not.toHaveBeenCalled();
  });

  it('offers no form at all on a settled bill', () => {
    renderForm('0.00');
    expect(
      screen.queryByRole('button', { name: 'Record the payment' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/settled in full/)).toBeInTheDocument();
  });

  it('says plainly that this is not the oldest-first workflow', () => {
    renderForm();
    // The two payment paths must not be confusable at the counter.
    expect(screen.getByText(/this bill only/)).toBeInTheDocument();
    expect(screen.getByText(/oldest unpaid bills instead/)).toBeInTheDocument();
  });

  it('tells the caller to refresh, so the row and folder totals update', async () => {
    const user = userEvent.setup();
    const { onRecorded } = renderForm();

    await user.click(screen.getByRole('button', { name: 'Record the payment' }));

    await waitFor(() => expect(onRecorded).toHaveBeenCalled());
  });
});

// --- F14: the payment history -------------------------------------------------

describe('the payment history for one invoice', () => {
  it('reads the ledger for this invoice id', async () => {
    render(<InvoicePaymentHistory invoiceId="inv-1" reloadToken={0} />);
    await waitFor(() =>
      expect(mocks.payments).toHaveBeenCalledWith({ invoice_id: 'inv-1' }),
    );
  });

  it('lists the payments', async () => {
    mocks.payments.mockResolvedValue({
      items: [
        {
          id: 'pay-1',
          kind: 'payment',
          amount: '740.00',
          method: 'upi',
          received_at: '2026-11-01T09:00:00Z',
          reference: 'UPI-9912',
          invoice_id: 'inv-1',
          allocated: '740.00',
        },
      ],
    });
    render(<InvoicePaymentHistory invoiceId="inv-1" reloadToken={0} />);

    expect(await screen.findByText('740')).toBeInTheDocument();
    expect(screen.getByText('upi')).toBeInTheDocument();
    expect(screen.getByText('UPI-9912')).toBeInTheDocument();
  });

  it('says so when there are none, rather than looking broken', async () => {
    render(<InvoicePaymentHistory invoiceId="inv-1" reloadToken={0} />);
    expect(await screen.findByText(/No payments have been recorded/)).toBeInTheDocument();
  });

  it('surfaces a failed fetch instead of showing an empty history', async () => {
    // An empty list and a failed request look identical on screen, and one of them
    // means "no money has been received" — which would be alarming and wrong.
    mocks.payments.mockRejectedValue(new Error('offline'));
    render(<InvoicePaymentHistory invoiceId="inv-1" reloadToken={0} />);

    expect(
      await screen.findByText((text) => /again|retry/i.test(text)),
    ).toBeInTheDocument();
  });

  it('refetches when the reload token changes', async () => {
    const { rerender } = render(
      <InvoicePaymentHistory invoiceId="inv-1" reloadToken={0} />,
    );
    await waitFor(() => expect(mocks.payments).toHaveBeenCalledTimes(1));

    rerender(<InvoicePaymentHistory invoiceId="inv-1" reloadToken={1} />);

    await waitFor(() => expect(mocks.payments).toHaveBeenCalledTimes(2));
  });
});

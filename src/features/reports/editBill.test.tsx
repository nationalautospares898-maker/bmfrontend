/**
 * The in-place bill editor (F7–F10; owner Decision A, 2026-11-07).
 *
 * The assertions that matter are the ones about what the screen *sends* and what it
 * *refuses to flatten*:
 *
 * * the request carries the **version the editor read**, because that is the whole
 *   optimistic-concurrency mechanism;
 * * one idempotency key per attempt, reused on retry and regenerated after success;
 * * the server's three refusals reach the operator in the server's own words —
 *   `EDIT_BELOW_PAID_TOTAL` tells them to use a return, and "something went wrong"
 *   would leave them with nothing to do.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type ErrorCode } from '@/api/errors';
import type { Invoice, InvoiceSummary } from '@/api/types';
import { EditBill, RevisionHistory } from './EditBill';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  amend: vi.fn(),
  revisions: vi.fn(),
  search: vi.fn(),
}));

vi.mock('@/api/endpoints', () => ({
  invoices: { get: mocks.get, amend: mocks.amend, revisions: mocks.revisions },
  catalog: { search: mocks.search },
}));

const SUMMARY: InvoiceSummary = {
  id: 'inv-1',
  internal_reference: 'NAS/2026-27/00007',
  issued_at: '2026-11-01T10:00:00Z',
  status: 'issued',
  is_credit: false,
  due_date: null,
  customer_id: null,
  customer_name: 'Walk-in',
  counter: 'C1',
  total: '200.00',
  amount_paid: '200.00',
  outstanding: '0.00',
  payment_status: 'paid',
};

const INVOICE: Invoice = {
  id: 'inv-1',
  internal_reference: 'NAS/2026-27/00007',
  sequence_number: 7,
  document_kind: 'estimate',
  status: 'issued',
  issued_at: '2026-11-01T10:00:00Z',
  is_credit: false,
  due_date: null,
  customer: {
    id: null,
    name_snapshot: 'Walk-in',
    business_name_snapshot: null,
    vehicle_number_snapshot: 'KA01AB1234',
    mechanic_name_snapshot: 'Ramesh',
    phone_snapshot: null,
  },
  notes: 'Left at the counter',
  version: 3,
  items: [
    {
      id: 'item-1',
      product_id: 'prod-1',
      line_no: 1,
      product_name_snapshot: 'Axel Packing',
      sku_snapshot: 'AX-1',
      unit_code_snapshot: 'NOS',
      quantity: '2.000',
      unit_price: '100.0000',
      discount_amount: '0.00',
      tax_rate_snapshot: '0.00',
      tax_amount: '0.00',
      line_total: '200.00',
      returned_quantity: '0.000',
    },
  ],
  subtotal: '200.00',
  discount_total: '0.00',
  tax_total: '0.00',
  rounding_adjustment: '0.00',
  total: '200.00',
  amount_paid: '200.00',
  outstanding: '0.00',
  payment_status: 'paid',
  oversell_override: false,
  oversell_reason: null,
  money_policy_version: 1,
  cancelled_at: null,
  cancellation_reason: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(INVOICE);
  mocks.amend.mockResolvedValue({
    invoice_id: 'inv-1',
    revision_number: 1,
    version: 4,
    total: '300.00',
    amount_paid: '200.00',
    outstanding: '100.00',
    payment_status: 'partially_paid',
  });
  mocks.revisions.mockResolvedValue({ items: [] });
  mocks.search.mockResolvedValue({ items: [], page: {} });
});

function renderEditor() {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<EditBill summary={SUMMARY} onClose={onClose} onSaved={onSaved} />);
  return { onSaved, onClose };
}

// --- F7: straight in ----------------------------------------------------------

describe('opening the editor', () => {
  it('opens into the editor with no confirmation to dismiss first', async () => {
    renderEditor();
    // F7. The old dialog opened on a warning that Edit Bill would cancel the bill; it
    // would now be untrue as well as in the way.
    expect(await screen.findByLabelText('Mechanic Name')).toBeInTheDocument();
    expect(screen.queryByText(/will be cancelled/i)).not.toBeInTheDocument();
  });

  it('shows the bill’s own reference in the title, unchanged', async () => {
    renderEditor();
    expect(
      await screen.findByText(/NAS\/2026-27\/00007/, {}, { timeout: 3000 }),
    ).toBeInTheDocument();
  });

  it('says what the edit keeps, rather than warning about what it loses', async () => {
    renderEditor();
    expect(await screen.findByText(/same bill reference/i)).toBeInTheDocument();
    expect(screen.getByText(/keeps every payment already recorded/i)).toBeInTheDocument();
  });
});

// --- F8: prefill --------------------------------------------------------------

describe('prefilling from the saved bill', () => {
  it('fills the header fields from the invoice', async () => {
    renderEditor();
    expect(await screen.findByLabelText('Mechanic Name')).toHaveValue('Ramesh');
    expect(screen.getByLabelText('Vehicle Number')).toHaveValue('KA01AB1234');
    expect(screen.getByLabelText('Notes')).toHaveValue('Left at the counter');
  });

  it('fills each line with its own saved quantity and price', async () => {
    renderEditor();
    expect(await screen.findByLabelText('Quantity for Axel Packing')).toHaveValue(
      '2.000',
    );
    expect(screen.getByLabelText('Price for Axel Packing')).toHaveValue('100.0000');
  });

  it('shows the item under its snapshot name, not the catalogue’s', async () => {
    renderEditor();
    // FR-SALE-012: a product renamed since must not change what the bill says.
    expect(await screen.findByText('Axel Packing')).toBeInTheDocument();
  });

  it('shows what has already been paid', async () => {
    renderEditor();
    expect(await screen.findByText('Already paid')).toBeInTheDocument();
    expect(screen.getByText(/cannot be lower than that/i)).toBeInTheDocument();
  });
});

// --- F9: saving in place ------------------------------------------------------

describe('saving', () => {
  async function fillReasonAndSave(user: ReturnType<typeof userEvent.setup>) {
    await user.type(
      screen.getByLabelText(/Why is this bill being changed/),
      'Customer took one more',
    );
    await user.click(screen.getByRole('button', { name: 'Save the changes' }));
  }

  it('sends the version the editor read', async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByLabelText('Mechanic Name');

    await fillReasonAndSave(user);

    await waitFor(() => expect(mocks.amend).toHaveBeenCalled());
    const [invoiceId, body] = mocks.amend.mock.calls[0] ?? [];
    expect(invoiceId).toBe('inv-1');
    // 3, from the invoice — not a guess, and not 1.
    expect(body.expected_version).toBe(3);
  });

  it('sends the edited lines and the reason', async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByLabelText('Mechanic Name');

    const quantity = screen.getByLabelText('Quantity for Axel Packing');
    await user.clear(quantity);
    await user.type(quantity, '3');
    await fillReasonAndSave(user);

    await waitFor(() => expect(mocks.amend).toHaveBeenCalled());
    const [, body] = mocks.amend.mock.calls[0] ?? [];
    expect(body.lines).toEqual([
      { product_id: 'prod-1', quantity: '3', unit_price: '100.0000' },
    ]);
    expect(body.reason).toBe('Customer took one more');
  });

  it('sends an idempotency key', async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByLabelText('Mechanic Name');

    await fillReasonAndSave(user);

    await waitFor(() => expect(mocks.amend).toHaveBeenCalled());
    expect(mocks.amend.mock.calls[0]?.[2]).toMatch(/[0-9a-f-]{36}/);
  });

  it('reuses the key when a failed save is retried', async () => {
    // A fresh key per click would let a retry write a second revision and a second set
    // of stock movements — and stock movements can never be deleted.
    mocks.amend.mockRejectedValueOnce(new Error('network'));
    const user = userEvent.setup();
    renderEditor();
    await screen.findByLabelText('Mechanic Name');

    await fillReasonAndSave(user);
    await waitFor(() => expect(mocks.amend).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Save the changes' }));
    await waitFor(() => expect(mocks.amend).toHaveBeenCalledTimes(2));

    expect(mocks.amend.mock.calls[1]?.[2]).toBe(mocks.amend.mock.calls[0]?.[2]);
  });

  it('tells the caller to refresh, so the list and totals update', async () => {
    const user = userEvent.setup();
    const { onSaved } = renderEditor();
    await screen.findByLabelText('Mechanic Name');

    await fillReasonAndSave(user);

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(await screen.findByText(/keeps its original reference/i)).toBeInTheDocument();
  });

  it('refuses to save without a reason, before sending anything', async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByLabelText('Mechanic Name');

    await user.click(screen.getByRole('button', { name: 'Save the changes' }));

    expect(
      await screen.findByText(/Say why this bill is being changed/),
    ).toBeInTheDocument();
    expect(mocks.amend).not.toHaveBeenCalled();
  });

  it('refuses an empty bill and points at the cancel action instead', async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByLabelText('Mechanic Name');

    await user.click(screen.getByLabelText('Remove Axel Packing from this bill'));
    await user.type(
      screen.getByLabelText(/Why is this bill being changed/),
      'Everything came back',
    );
    await user.click(screen.getByRole('button', { name: 'Save the changes' }));

    expect(await screen.findByText(/use the cancel action instead/i)).toBeInTheDocument();
    expect(mocks.amend).not.toHaveBeenCalled();
  });

  it('refuses a zero quantity before sending', async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByLabelText('Mechanic Name');

    const quantity = screen.getByLabelText('Quantity for Axel Packing');
    await user.clear(quantity);
    await user.type(quantity, '0');
    await fillReasonAndSave(user);

    expect(
      await screen.findByText(/quantity greater than zero for Axel Packing/),
    ).toBeInTheDocument();
    expect(mocks.amend).not.toHaveBeenCalled();
  });
});

// --- the server's refusals ----------------------------------------------------

describe('the server’s refusals reach the operator intact', () => {
  async function saveExpecting(code: ErrorCode) {
    mocks.amend.mockRejectedValue(
      // `(status, body)`, where the body is the server's envelope. The screen reads
      // `code` and looks the wording up in `describeError`, so the message here is
      // deliberately blank: this test is about the client's own words for the code.
      new ApiError(409, {
        error: { code, message: '', details: {}, request_id: 'r', retryable: false },
      }),
    );
    const user = userEvent.setup();
    renderEditor();
    await screen.findByLabelText('Mechanic Name');
    await user.type(
      screen.getByLabelText(/Why is this bill being changed/),
      'Customer took one more',
    );
    await user.click(screen.getByRole('button', { name: 'Save the changes' }));
  }

  it('explains the paid-total rule and names the way out', async () => {
    // The owner's explicit rule. "Something went wrong" would leave the operator with
    // no idea that a return or a credit note is what they need.
    //
    // Scoped to the alert: the editor *also* warns about this rule up front, next to
    // "Already paid", so the words appear twice on a paid bill — which is intended, and
    // is why a bare text query is ambiguous here.
    await saveExpecting('EDIT_BELOW_PAID_TOTAL');
    const alerts = await screen.findAllByRole('alert');
    expect(
      alerts.some((alert) => /return|credit note/i.test(alert.textContent ?? '')),
    ).toBe(true);
  });

  it('explains a concurrent edit', async () => {
    await saveExpecting('INVOICE_VERSION_CONFLICT');
    expect(
      await screen.findByText((text) => /someone else|reload/i.test(text)),
    ).toBeInTheDocument();
  });

  it('explains a stock shortfall', async () => {
    await saveExpecting('INSUFFICIENT_STOCK');
    expect(await screen.findByText((text) => /stock/i.test(text))).toBeInTheDocument();
  });
});

// --- the revision history -----------------------------------------------------

describe('the revision history', () => {
  it('reads the history for this invoice', async () => {
    render(<RevisionHistory invoiceId="inv-1" reloadToken={0} />);
    await waitFor(() => expect(mocks.revisions).toHaveBeenCalledWith('inv-1'));
  });

  it('says so when the bill has never been edited', async () => {
    render(<RevisionHistory invoiceId="inv-1" reloadToken={0} />);
    expect(await screen.findByText(/has not been edited/)).toBeInTheDocument();
  });

  it('shows each previous version with its reason, editor and figures', async () => {
    mocks.revisions.mockResolvedValue({
      items: [
        {
          revision_number: 1,
          reason: 'Customer took one more',
          created_at: '2026-11-02T09:00:00Z',
          edited_by: 'E2E Owner',
          total: '200.00',
          amount_paid: '200.00',
          payment_status: 'paid',
          status: 'issued',
          customer_name: 'Walk-in',
          mechanic_name: 'Ramesh',
          vehicle_number: 'KA01AB1234',
          notes: null,
          items: [
            {
              line_no: 1,
              product_name: 'Axel Packing',
              sku: 'AX-1',
              unit_code: 'NOS',
              quantity: '2.000',
              unit_price: '100.0000',
              line_total: '200.00',
            },
          ],
        },
      ],
    });
    render(<RevisionHistory invoiceId="inv-1" reloadToken={0} />);

    expect(await screen.findByText('Version 1')).toBeInTheDocument();
    expect(screen.getByText('Customer took one more')).toBeInTheDocument();
    expect(screen.getByText(/E2E Owner/)).toBeInTheDocument();
    expect(screen.getByText(/Axel Packing/)).toBeInTheDocument();
  });

  it('says the records cannot be changed', async () => {
    render(<RevisionHistory invoiceId="inv-1" reloadToken={0} />);
    // True at the database level: `invoice_revisions` is SELECT, INSERT only.
    expect(await screen.findByText(/cannot be changed or removed/i)).toBeInTheDocument();
  });
});

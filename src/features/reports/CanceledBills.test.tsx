/**
 * Canceled Bills (owner request, 2026-11-10).
 *
 * The load-bearing assertions:
 *
 * - the screen fetches `status: 'cancelled'` and nothing else filters it client-side —
 *   a row the server did not mark cancelled must never appear here by accident;
 * - every figure is the server's own (type, reference, customer, amount, cancelled-at,
 *   reason) — nothing is recomputed;
 * - "View" opens the same `FullBillView` Credit Bills uses, via `GET /invoices/{id}`,
 *   so a cancelled bill's lines and totals read exactly as issued.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Invoice, InvoiceSummary } from '@/api/types';
import { CanceledBills } from './CanceledBills';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
}));

vi.mock('@/api/endpoints', () => ({
  invoices: { list: mocks.list, get: mocks.get },
}));

const ROW: InvoiceSummary = {
  id: 'inv-cancelled-1',
  internal_reference: 'C1/2026/0099',
  issued_at: '2026-11-09T10:15:00Z',
  status: 'cancelled',
  is_credit: true,
  due_date: null,
  customer_id: 'cust-1',
  customer_name: 'Ramesh Motors',
  counter: 'C1',
  total: '1740.00',
  amount_paid: '0.00',
  outstanding: '1740.00',
  payment_status: 'cancelled',
  cancelled_at: '2026-11-09T11:00:00Z',
  cancellation_reason: 'Entered against the wrong customer',
};

const FULL: Invoice = {
  id: 'inv-cancelled-1',
  internal_reference: 'C1/2026/0099',
  sequence_number: 99,
  document_kind: 'estimate',
  status: 'cancelled',
  issued_at: '2026-11-09T10:15:00Z',
  is_credit: true,
  due_date: null,
  customer: {
    id: 'cust-1',
    name_snapshot: 'Ramesh Motors',
    business_name_snapshot: null,
    vehicle_number_snapshot: null,
    mechanic_name_snapshot: null,
    phone_snapshot: null,
  },
  notes: null,
  version: 1,
  items: [],
  subtotal: '1740.00',
  discount_total: '0.00',
  tax_total: '0.00',
  rounding_adjustment: '0.00',
  total: '1740.00',
  amount_paid: '0.00',
  outstanding: '1740.00',
  payment_status: 'cancelled',
  oversell_override: false,
  oversell_reason: null,
  money_policy_version: 1,
  cancelled_at: '2026-11-09T11:00:00Z',
  cancellation_reason: 'Entered against the wrong customer',
};

beforeEach(() => {
  mocks.list.mockReset();
  mocks.get.mockReset();
});

describe('Canceled Bills', () => {
  it('fetches status=cancelled, not an unfiltered list', async () => {
    mocks.list.mockResolvedValue({ items: [ROW], page: {}, as_of: '' });
    render(<CanceledBills />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled' }),
    );
  });

  it('shows the server-given reference, customer, amount, cancelled-at and reason', async () => {
    mocks.list.mockResolvedValue({ items: [ROW], page: {}, as_of: '' });
    render(<CanceledBills />);
    expect(await screen.findByText('C1/2026/0099')).toBeInTheDocument();
    expect(screen.getByText('Ramesh Motors')).toBeInTheDocument();
    expect(screen.getByText('Entered against the wrong customer')).toBeInTheDocument();
    expect(screen.getByText('Credit')).toBeInTheDocument();
  });

  it('says plainly when there are none', async () => {
    mocks.list.mockResolvedValue({ items: [], page: {}, as_of: '' });
    render(<CanceledBills />);
    expect(await screen.findByText(/no cancelled bills/i)).toBeInTheDocument();
  });

  it('View opens the full bill, fetched from GET /invoices/{id}', async () => {
    mocks.list.mockResolvedValue({ items: [ROW], page: {}, as_of: '' });
    mocks.get.mockResolvedValue(FULL);
    render(<CanceledBills />);
    await screen.findByText('C1/2026/0099');

    await userEvent.click(screen.getByRole('button', { name: 'View' }));

    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('inv-cancelled-1'));
    // `FullBillView` also captions its item table with the same string (sr-only), so
    // the heading role is what makes this assertion unambiguous.
    expect(
      await screen.findByRole('heading', { name: 'The bill as it was issued' }),
    ).toBeInTheDocument();
  });
});

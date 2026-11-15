/**
 * NAS-NEW-02: Credit Bills' "Edit Bill" through the real billing grid.
 *
 * Load-bearing assertions:
 *
 * - the real grid renders (not `EditBill`'s plain table) — proven structurally by the
 *   spreadsheet's own "S.No" column and the mechanic field's `combobox` role, which
 *   `EditBill`'s plain text input does not have;
 * - every field is prefilled from the saved invoice, from its snapshots, never from
 *   today's catalogue;
 * - the customer cannot be changed — read-only, even though `AmendHeaderIn` would
 *   technically accept a new `customer_name` (see this component's own module doc);
 * - saving sends `expected_version`, a reason, the edited lines and only the header
 *   fields that are genuinely editable — never `customer_name`;
 * - the three server refusals `EditBill` already handles are handled identically here.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type ErrorCode } from '@/api/errors';
import type { Invoice } from '@/api/types';
import { EditCreditBillGrid } from './EditCreditBillGrid';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  amend: vi.fn(),
  search: vi.fn(),
  mechanicSearch: vi.fn(),
  mechanicEnsure: vi.fn(),
}));

vi.mock('@/api/endpoints', () => ({
  invoices: { get: mocks.get, amend: mocks.amend },
  catalog: { search: mocks.search },
  mechanics: { search: mocks.mechanicSearch, ensure: mocks.mechanicEnsure },
}));

function refused(code: ErrorCode): ApiError {
  return new ApiError(409, {
    error: { code, message: '', details: {}, request_id: 'r', retryable: false },
  });
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    internal_reference: 'REF-001',
    sequence_number: 1,
    document_kind: 'invoice',
    status: 'issued',
    issued_at: '2026-11-10T10:00:00Z',
    is_credit: true,
    due_date: null,
    customer: {
      id: 'cust-1',
      name_snapshot: 'Ramesh Motors',
      business_name_snapshot: null,
      vehicle_number_snapshot: 'KA 01 AB 1234',
      mechanic_name_snapshot: 'Suresh',
      phone_snapshot: '9876543210',
    },
    notes: 'Handle with care',
    version: 3,
    items: [
      {
        id: 'item-1',
        product_id: 'prod-1',
        line_no: 1,
        product_name_snapshot: 'Brake Shoe Set (as sold)',
        sku_snapshot: 'TT-407-BS',
        unit_code_snapshot: 'SET',
        quantity: '2.000',
        unit_price: '1250.0000',
        discount_amount: '0.00',
      },
    ],
    subtotal: '2500.00',
    discount_total: '0.00',
    tax_total: '0.00',
    rounding_adjustment: '0.00',
    total: '2500.00',
    amount_paid: '0.00',
    outstanding: '2500.00',
    ...overrides,
  } as Invoice;
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.amend.mockReset();
  mocks.search.mockReset().mockResolvedValue({ items: [], page: {} });
  mocks.mechanicSearch.mockReset().mockResolvedValue({ items: [], page: {} });
  mocks.mechanicEnsure.mockReset();
});

function renderEditor(
  overrides: Partial<React.ComponentProps<typeof EditCreditBillGrid>> = {},
) {
  return render(
    <EditCreditBillGrid
      invoiceId="inv-1"
      online
      canOverridePrice
      canOverrideOversell
      canCreateProduct={false}
      onClose={vi.fn()}
      onSaved={vi.fn()}
      {...overrides}
    />,
  );
}

const REASON_LABEL = 'Why is this bill being changed?';
const SAVE_LABEL = 'Save the changes';

describe('EditCreditBillGrid', () => {
  it('opens the real billing grid, not a plain table — proven by its own column and the mechanic combobox', async () => {
    mocks.get.mockResolvedValue(invoice());
    renderEditor();
    await screen.findByText('Brake Shoe Set (as sold)');

    expect(screen.getByText('S.No')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Mechanic Name' })).toBeInTheDocument();
  });

  it('prefills every field from the saved invoice, not from the catalogue', async () => {
    mocks.get.mockResolvedValue(invoice());
    renderEditor();

    expect(await screen.findByDisplayValue('Ramesh Motors')).toBeInTheDocument();
    expect(screen.getByDisplayValue('KA 01 AB 1234')).toBeInTheDocument();
    expect(screen.getByDisplayValue('9876543210')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Handle with care')).toBeInTheDocument();
    expect(screen.getByText('Brake Shoe Set (as sold)')).toBeInTheDocument();
    expect(screen.getByText('TT-407-BS')).toBeInTheDocument();
  });

  it('the customer field cannot be edited', async () => {
    mocks.get.mockResolvedValue(invoice());
    renderEditor();

    const field = await screen.findByDisplayValue('Ramesh Motors');
    expect(field).toHaveAttribute('readonly');
    expect(field).toBeDisabled();
  });

  it('saving sends the version, the reason, the lines and only the editable header fields', async () => {
    mocks.get.mockResolvedValue(invoice());
    mocks.amend.mockResolvedValue({
      invoice_id: 'inv-1',
      revision_number: 2,
      version: 4,
      total: '2500.00',
      amount_paid: '0.00',
      outstanding: '2500.00',
      payment_status: 'unpaid',
    });
    const onSaved = vi.fn();
    const onClose = vi.fn();
    renderEditor({ onSaved, onClose });
    await screen.findByText('Brake Shoe Set (as sold)');

    await userEvent.type(
      screen.getByLabelText(REASON_LABEL),
      'Owner corrected the quantity after a phone call',
    );
    await userEvent.click(screen.getByRole('button', { name: SAVE_LABEL }));

    await waitFor(() => expect(mocks.amend).toHaveBeenCalled());
    const [invoiceId, body] = mocks.amend.mock.calls[0] as [string, Record<string, unknown>];
    expect(invoiceId).toBe('inv-1');
    expect(body.expected_version).toBe(3);
    expect(body.reason).toBe('Owner corrected the quantity after a phone call');
    expect(body.lines).toEqual([
      { product_id: 'prod-1', quantity: '2.000', unit_price: '1250.0000' },
    ]);
    expect(body.header).toEqual({
      mechanic_name: 'Suresh',
      vehicle_number: 'KA 01 AB 1234',
      phone: '9876543210',
      notes: 'Handle with care',
    });
    expect(body).not.toHaveProperty('customer_name');

    expect(onSaved).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('saves with no reason at all (owner correction, 2026-11-14) — nothing is invented', async () => {
    mocks.get.mockResolvedValue(invoice());
    mocks.amend.mockResolvedValue({
      invoice_id: 'inv-1',
      revision_number: 2,
      version: 4,
      total: '2500.00',
      amount_paid: '0.00',
      outstanding: '2500.00',
      payment_status: 'unpaid',
    });
    const onSaved = vi.fn();
    const onClose = vi.fn();
    renderEditor({ onSaved, onClose });
    await screen.findByText('Brake Shoe Set (as sold)');

    await userEvent.click(screen.getByRole('button', { name: SAVE_LABEL }));

    await waitFor(() => expect(mocks.amend).toHaveBeenCalled());
    const [, body] = mocks.amend.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.reason).toBe('');
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('refuses a reason that is too short to mean anything, before sending it', async () => {
    mocks.get.mockResolvedValue(invoice());
    renderEditor();
    await screen.findByText('Brake Shoe Set (as sold)');

    await userEvent.type(screen.getByLabelText(REASON_LABEL), 'hi');
    await userEvent.click(screen.getByRole('button', { name: SAVE_LABEL }));

    expect(mocks.amend).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('explains the paid-total rule and names the way out', async () => {
    mocks.get.mockResolvedValue(invoice());
    mocks.amend.mockRejectedValue(refused('EDIT_BELOW_PAID_TOTAL'));
    renderEditor();
    await screen.findByText('Brake Shoe Set (as sold)');
    await userEvent.type(
      screen.getByLabelText(REASON_LABEL),
      'Correcting a typo in the quantity',
    );
    await userEvent.click(screen.getByRole('button', { name: SAVE_LABEL }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/return|credit note/i);
  });

  it('explains a concurrent edit', async () => {
    mocks.get.mockResolvedValue(invoice());
    mocks.amend.mockRejectedValue(refused('INVOICE_VERSION_CONFLICT'));
    renderEditor();
    await screen.findByText('Brake Shoe Set (as sold)');
    await userEvent.type(
      screen.getByLabelText(REASON_LABEL),
      'Correcting a typo in the quantity',
    );
    await userEvent.click(screen.getByRole('button', { name: SAVE_LABEL }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/reload|redo|again/i);
  });

  it('offers the oversell override after a stock refusal, same as new-bill finalisation', async () => {
    mocks.get.mockResolvedValue(invoice());
    mocks.amend.mockRejectedValue(refused('INSUFFICIENT_STOCK'));
    renderEditor();
    await screen.findByText('Brake Shoe Set (as sold)');
    await userEvent.type(
      screen.getByLabelText(REASON_LABEL),
      'Increasing the quantity per the owner',
    );
    await userEvent.click(screen.getByRole('button', { name: SAVE_LABEL }));
    await screen.findByRole('alert');

    expect(
      screen.getByRole('checkbox', {
        name: 'I approve this sale against insufficient recorded stock',
      }),
    ).toBeInTheDocument();
  });

  it('never calls amend for a bill that failed to load', async () => {
    mocks.get.mockRejectedValue(refused('NOT_FOUND'));
    renderEditor();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(mocks.amend).not.toHaveBeenCalled();
  });
});

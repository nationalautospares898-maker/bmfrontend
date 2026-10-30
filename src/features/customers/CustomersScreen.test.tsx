/**
 * The Customers screen, rendered.
 *
 * The rule under test: **a customer's balance is derived, never typed** (ADR-022,
 * FR-CREDIT-003). There is no editable outstanding field, no "mark as paid" control,
 * and the screen says so in words — because a shopkeeper who cannot find the field needs
 * to know it is absent on purpose rather than missing.
 *
 * Also checked:
 *
 * - a suspected duplicate **warns and does not block** (FR-CUST-004), since two
 *   relatives genuinely do share a phone;
 * - a new customer gets a **client-generated id**, so a retry is an upsert rather than a
 *   second customer (FR-CUST-003);
 * - `credit_terms_days` is parsed as a whole number, and an empty field is `null` rather
 *   than zero — "due immediately" is not the right default for a blank box.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CustomersScreen } from './CustomersScreen';

const creditCustomers = vi.fn();
const payments = vi.fn();
const upsert = vi.fn();
const search = vi.fn();

vi.mock('@/api/endpoints', () => ({
  credit: {
    customers: (...a: unknown[]) => creditCustomers(...a) as unknown,
    payments: (...a: unknown[]) => payments(...a) as unknown,
  },
  customers: {
    upsert: (...a: unknown[]) => upsert(...a) as unknown,
    search: (...a: unknown[]) => search(...a) as unknown,
  },
}));

const ROW = {
  customer: { id: 'c1', name: 'Rakesh Motors', primary_phone: '9876500011' },
  outstanding: '7400.00',
  total_invoiced: '21000.00',
  total_paid: '13600.00',
  invoice_count: 6,
  open_invoice_count: 2,
  oldest_due_date: '2026-09-15',
  days_overdue: 45,
  ageing: { '0_30': '1000.00', '31_60': '6400.00' },
};

beforeEach(() => {
  for (const fn of [creditCustomers, payments, upsert, search]) fn.mockReset();
  creditCustomers.mockResolvedValue({ items: [ROW] });
  payments.mockResolvedValue({ items: [] });
  upsert.mockResolvedValue({ id: 'c1' });
  search.mockResolvedValue({ items: [] });
});

describe('ADR-022 — the balance is derived, never typed', () => {
  it('says so, where someone would otherwise look for the field', async () => {
    render(<CustomersScreen canEdit />);
    expect(await screen.findByText(/It cannot be typed in\./)).toBeInTheDocument();
  });

  it('offers no editable outstanding field', async () => {
    const user = userEvent.setup();
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    // Everything editable is identity. Nothing financial is.
    expect(screen.queryByLabelText(/Owed/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Outstanding/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Balance/i)).not.toBeInTheDocument();
  });

  it('offers no way to mark a customer as paid', async () => {
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');
    expect(screen.queryByRole('button', { name: /mark.*paid/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/paid/i)).not.toBeInTheDocument();
  });

  it('renders the server’s figures rather than summing anything', async () => {
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');
    // 7400 from the response, not 21000 − 13600 computed here (FR-RPT-030).
    // `formatForScreen` emits no thousands separator — a grouped figure would have to
    // pick a convention, and the server is the authority on presentation (OD-23).
    expect(screen.getByText('7400')).toBeInTheDocument();
  });
});

describe('the list', () => {
  it('shows who owes what, with the oldest unpaid date', async () => {
    render(<CustomersScreen canEdit />);
    expect(await screen.findByText('Rakesh Motors')).toBeInTheDocument();
    expect(screen.getByText('9876500011')).toBeInTheDocument();
    expect(screen.getByText('2026-09-15')).toBeInTheDocument();
  });

  it('asks the server to include settled customers when requested', async () => {
    const user = userEvent.setup();
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');
    await user.click(screen.getByRole('button', { name: /Include customers who owe/ }));

    await waitFor(() =>
      expect(creditCustomers).toHaveBeenLastCalledWith({ include_settled: true }),
    );
  });

  it('distinguishes "nobody owes anything" from "nothing matched"', async () => {
    creditCustomers.mockResolvedValue({ items: [] });
    render(<CustomersScreen canEdit />);
    expect(await screen.findByText('No customer owes anything.')).toBeInTheDocument();
  });

  it('hides the edit control without the permission', async () => {
    render(<CustomersScreen canEdit={false} />);
    await screen.findByText('Rakesh Motors');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add a customer' }),
    ).not.toBeInTheDocument();
  });
});

describe('FR-CUST-004 — a suspected duplicate warns, and never blocks', () => {
  it('warns when the phone already belongs to someone', async () => {
    search.mockResolvedValue({
      items: [{ id: 'other', name: 'Rakesh Kumar', phone: '9876500011' }],
    });
    const user = userEvent.setup();
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');
    await user.click(screen.getByRole('button', { name: 'Add a customer' }));
    await user.type(screen.getByLabelText('Name'), 'Rakesh Motors Two');
    await user.type(screen.getByLabelText('Phone'), '9876500011');

    expect(
      await screen.findByText('A customer with this phone number already exists.'),
    ).toBeInTheDocument();
    // Still saveable: two relatives genuinely share a phone, and the server surfaces
    // candidates rather than merging.
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('does not look up a half-typed phone number', async () => {
    const user = userEvent.setup();
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');
    await user.click(screen.getByRole('button', { name: 'Add a customer' }));
    await user.type(screen.getByLabelText('Phone'), '98765');

    expect(search).not.toHaveBeenCalled();
  });
});

describe('creating and editing', () => {
  it('requires a name', async () => {
    const user = userEvent.setup();
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');
    await user.click(screen.getByRole('button', { name: 'Add a customer' }));

    expect(screen.getByText('A customer needs a name.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('uses a client-generated id for a new customer', async () => {
    const user = userEvent.setup();
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');
    await user.click(screen.getByRole('button', { name: 'Add a customer' }));
    await user.type(screen.getByLabelText('Name'), 'New Garage');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(upsert).toHaveBeenCalled());
    const [id] = upsert.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    // Not the existing customer's id: this is a create.
    expect(id).not.toBe('c1');
  });

  it('keeps the existing id when editing, so it is an update', async () => {
    const user = userEvent.setup();
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(upsert).toHaveBeenCalled());
    const [id] = upsert.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('c1');
  });

  it('sends null terms for an empty field, never zero days', async () => {
    const user = userEvent.setup();
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');
    await user.click(screen.getByRole('button', { name: 'Add a customer' }));
    await user.type(screen.getByLabelText('Name'), 'New Garage');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(upsert).toHaveBeenCalled());
    const [, body] = upsert.mock.calls[0] as [string, Record<string, unknown>];
    // `Number('')` would be 0 — "payment due immediately" on every customer saved
    // without filling the box in.
    expect(body.credit_terms_days).toBeNull();
  });

  it('sends a whole number of days when the field is filled', async () => {
    const user = userEvent.setup();
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');
    await user.click(screen.getByRole('button', { name: 'Add a customer' }));
    await user.type(screen.getByLabelText('Name'), 'New Garage');
    await user.type(screen.getByLabelText('Payment terms (days)'), '30');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(upsert).toHaveBeenCalled());
    const [, body] = upsert.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.credit_terms_days).toBe(30);
  });
});

describe('the detail view', () => {
  it('shows payments received, including a reversal as its own row', async () => {
    payments.mockResolvedValue({
      items: [
        {
          id: 'pay1',
          amount: '2000.00',
          allocated: '2000.00',
          method: 'cash',
          reference: null,
          received_at: '2026-10-20T10:00:00Z',
          kind: 'payment',
          invoice_id: 'i1',
        },
        {
          id: 'pay2',
          amount: '-2000.00',
          allocated: null,
          method: 'cash',
          reference: null,
          received_at: '2026-10-21T10:00:00Z',
          // The original is never edited (FR-PAY-005), so both rows show.
          kind: 'reversal',
          invoice_id: 'i1',
        },
      ],
    });
    const user = userEvent.setup();
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');
    await user.click(screen.getByRole('button', { name: 'Open' }));

    expect(await screen.findByText(/reversal/)).toBeInTheDocument();
    expect(screen.getByText('2000')).toBeInTheDocument();
  });

  it('says so when there are no payments', async () => {
    const user = userEvent.setup();
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');
    await user.click(screen.getByRole('button', { name: 'Open' }));

    expect(
      await screen.findByText('No payments recorded for this customer.'),
    ).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('has no axe violations', async () => {
    const { container } = render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');
    const results = await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    });
    expect(results.violations).toEqual([]);
  });
});

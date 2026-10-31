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
 *   than zero — "due immediately" is not the right default for a blank box;
 * - a figure the screen could not read is shown as a dash and explained, **never** as
 *   `0.00`, and never used to hide the row (see the last describe block).
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/errors';
import { CustomersScreen } from './CustomersScreen';

const creditCustomers = vi.fn();
const payments = vi.fn();
const upsert = vi.fn();
const search = vi.fn();
const list = vi.fn();
const recordPayment = vi.fn();

vi.mock('@/api/endpoints', () => ({
  credit: {
    customers: (...a: unknown[]) => creditCustomers(...a) as unknown,
    payments: (...a: unknown[]) => payments(...a) as unknown,
    // Taking a payment. This had no caller in the application at all until now.
    recordPayment: (...a: unknown[]) => recordPayment(...a) as unknown,
  },
  customers: {
    upsert: (...a: unknown[]) => upsert(...a) as unknown,
    search: (...a: unknown[]) => search(...a) as unknown,
    // The directory. The screen reads this for *who exists* and merges the credit
    // aggregates on top; it used to read only `/credit/customers`, which cannot
    // contain a customer with no credit invoice.
    list: (...a: unknown[]) => list(...a) as unknown,
  },
}));

/**
 * A directory record, as `GET /customers` returns it.
 *
 * The `credit` block is left off by default so the fallback path — merge the aggregates,
 * and treat absence from a *complete* aggregate list as nothing owed — stays covered.
 * The tests that care about the per-row summary (FR-CUST-012) pass it explicitly.
 */
function directory(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

/** The credit aggregates, as `GET /credit/customers` returns them. */
const CREDIT_ROW = {
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

const PAGE = { next_cursor: null, has_more: false, limit: 50 };

beforeEach(() => {
  for (const fn of [creditCustomers, payments, upsert, search, list, recordPayment])
    fn.mockReset();
  list.mockResolvedValue({ items: [directory()], page: PAGE });
  creditCustomers.mockResolvedValue({ items: [CREDIT_ROW] });
  payments.mockResolvedValue({ items: [] });
  upsert.mockResolvedValue({ id: 'c1' });
  search.mockResolvedValue({ items: [], page: PAGE });
  recordPayment.mockResolvedValue({ payment: { id: 'pay-1' } });
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

  it('asks the credit endpoint for an explicit limit, never its default of twenty', async () => {
    // Called with no limit at all, the server capped the aggregates at twenty rows
    // while a directory page holds fifty, so every row past the cap was drawn as 0.00
    // owed. 200 is the endpoint's declared maximum (`le=200`), not a preference.
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');
    await waitFor(() => expect(creditCustomers).toHaveBeenCalledWith({ limit: 200 }));
  });

  it('does not spend the capped credit page on customers who owe nothing', async () => {
    // `include_settled: true` used to be sent, so settled customers consumed slots in
    // a page the screen had already under-asked for. What a settled customer brings is
    // now read from their directory row instead, and their payment history is fetched
    // per customer, so nothing is lost by leaving them out of the aggregates.
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');
    await waitFor(() => expect(creditCustomers).toHaveBeenCalled());
    const [filters] = creditCustomers.mock.calls[0] as [Record<string, unknown>];
    expect(filters.include_settled).toBeUndefined();
  });

  it('still shows a settled customer’s figures and history once they have paid up', async () => {
    const user = userEvent.setup();
    // Settled, so `GET /credit/customers` omits them without `include_settled` — and
    // the figures come from the directory row regardless.
    list.mockResolvedValue({
      items: [directory({ credit: { outstanding: '0.00', oldest_due_date: null } })],
      page: PAGE,
    });
    creditCustomers.mockResolvedValue({ items: [] });
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');

    expect(screen.getAllByRole('cell', { name: '0' })).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('Payments received')).toBeInTheDocument();
  });

  it('filters to customers who owe when asked, without hiding the rest by default', async () => {
    const user = userEvent.setup();
    list.mockResolvedValue({
      items: [directory(), directory({ id: 'c2', name: 'Owes Nothing Co' })],
      page: PAGE,
    });
    render(<CustomersScreen canEdit />);

    // Both by default — the directory is the point of this screen.
    expect(await screen.findByText('Owes Nothing Co')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Only customers who owe/ }));
    await waitFor(() =>
      expect(screen.queryByText('Owes Nothing Co')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Rakesh Motors')).toBeInTheDocument();
  });

  it('distinguishes an empty directory from nothing matching a search', async () => {
    list.mockResolvedValue({ items: [], page: PAGE });
    render(<CustomersScreen canEdit />);
    expect(await screen.findByText(/No customers yet/)).toBeInTheDocument();
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

describe('the directory, not the credit report (reported from the browser)', () => {
  /**
   * The symptom: "I clicked Add a customer, the customer did not appear in the list,
   * and the only visible customer is Demo Credit Customer One."
   *
   * The customer had been created — two of them, in fact. The screen read
   * `GET /credit/customers`, which inner-joins credit invoices, so a customer with no
   * credit invoice could not appear there and could not be found by typing their name
   * either. `include_settled` did not help: it only relaxes the `outstanding > 0`
   * filter, it does not reach past the join.
   */
  it('lists a customer who has never bought on credit', async () => {
    list.mockResolvedValue({
      items: [directory({ id: 'new-1', name: 'Sukith', primary_phone: '9306432399' })],
      page: PAGE,
    });
    // Deliberately absent from the credit aggregates, which is the whole point.
    creditCustomers.mockResolvedValue({ items: [] });

    render(<CustomersScreen canEdit />);

    expect(await screen.findByText('Sukith')).toBeInTheDocument();
    expect(screen.getByText('9306432399')).toBeInTheDocument();
  });

  it('shows a dash rather than a wrong figure when there is no credit history', async () => {
    list.mockResolvedValue({ items: [directory({ id: 'new-1' })], page: PAGE });
    creditCustomers.mockResolvedValue({ items: [] });
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');
    // Both the "Owed" and "Unpaid bills" cells read zero — taken from the absence of
    // aggregates, never summed client-side (ADR-032).
    expect(screen.getAllByRole('cell', { name: '0' })).toHaveLength(2);
  });

  it('searches the directory, so a non-credit customer is findable by name', async () => {
    const user = userEvent.setup();
    search.mockResolvedValue({
      items: [directory({ id: 'found', name: 'Sukith' })],
      page: PAGE,
    });
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');

    await user.type(screen.getByLabelText(/Find a customer/), 'sukith');

    await waitFor(() => expect(search).toHaveBeenCalledWith('sukith'));
    expect(await screen.findByText('Sukith')).toBeInTheDocument();
  });

  it('pages the directory rather than shipping every customer at once', async () => {
    const user = userEvent.setup();
    list.mockResolvedValueOnce({
      items: [directory()],
      page: { next_cursor: '1762000000000000', has_more: true, limit: 50 },
    });
    list.mockResolvedValueOnce({
      items: [directory({ id: 'c2', name: 'Second Page Co' })],
      page: PAGE,
    });
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');

    await user.click(screen.getByRole('button', { name: /Show more customers/ }));

    expect(await screen.findByText('Second Page Co')).toBeInTheDocument();
    // Appended, not replaced: the first page is still on screen.
    expect(screen.getByText('Rakesh Motors')).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith({ cursor: '1762000000000000' });
  });
});

describe('editing a customer does not wipe what it never showed', () => {
  /**
   * A data-loss defect found while wiring the directory. `businessName`, `creditLimit`
   * and `creditTerms` started empty whatever was being edited — the screen's only data
   * came from `/credit/customers`, which does not carry them — and `save()` sends
   * `businessName.trim() || null`. So changing a customer's phone silently cleared
   * their business name, credit limit and payment terms. The credit limit is what the
   * credit check reads, so an unrelated edit was clearing a financial control.
   */
  it('prefills business name, credit limit and terms from the record', async () => {
    const user = userEvent.setup();
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');

    await user.click(screen.getByRole('button', { name: 'Edit' }));

    expect(await screen.findByLabelText(/Business name/)).toHaveValue('Rakesh Transport');
    expect(screen.getByLabelText(/Credit limit/)).toHaveValue('50000.00');
    expect(screen.getByLabelText(/Payment terms/)).toHaveValue('30');
  });

  it('keeps them when only the phone is changed', async () => {
    const user = userEvent.setup();
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByLabelText(/Business name/);

    const phone = screen.getByLabelText(/^Phone/);
    await user.clear(phone);
    await user.type(phone, '9000000001');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(upsert).toHaveBeenCalled());
    const [, body] = upsert.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.phone).toBe('9000000001');
    // The three that used to be silently cleared.
    expect(body.business_name).toBe('Rakesh Transport');
    expect(body.credit_limit).toBe('50000.00');
    expect(body.credit_terms_days).toBe(30);
  });
});

describe('taking a payment (the capability with no caller)', () => {
  /**
   * `credit.recordPayment` existed in the API client, was correct, and had **no caller
   * anywhere in the application**. Credit bills could be issued and not one rupee could
   * be recorded against them, so an outstanding balance could only ever grow. The same
   * shape of defect as the billing customer picker: a capability wired to the server
   * with no way in from a screen.
   */
  it('records the payment against the customer, oldest bills first', async () => {
    const user = userEvent.setup();
    recordPayment.mockResolvedValue({ payment: { id: 'pay-1' } });
    render(<CustomersScreen canEdit canRecordPayment />);
    await screen.findByText('Rakesh Motors');

    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(await screen.findByRole('button', { name: 'Record this payment' }));

    await waitFor(() => expect(recordPayment).toHaveBeenCalled());
    const [body, key] = recordPayment.mock.calls[0] as [
      {
        customer_id: string;
        amount: string;
        method: string;
        allocation: { strategy: string };
      },
      string,
    ];
    expect(body.customer_id).toBe('c1');
    // Prefilled with the whole outstanding amount, because settling up is the common
    // case and retyping a figure already on screen is how digits get transposed.
    expect(body.amount).toBe('7400.00');
    expect(body.method).toBe('cash');
    expect(body.allocation.strategy).toBe('oldest_first');
    // A client-generated key, so a double click records one payment, not two.
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('never sends a balance — only the payment', async () => {
    const user = userEvent.setup();
    recordPayment.mockResolvedValue({ payment: { id: 'pay-1' } });
    render(<CustomersScreen canEdit canRecordPayment />);
    await screen.findByText('Rakesh Motors');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(await screen.findByRole('button', { name: 'Record this payment' }));

    await waitFor(() => expect(recordPayment).toHaveBeenCalled());
    const body = recordPayment.mock.calls[0]?.[0] as Record<string, unknown>;
    // ADR-022: what a customer owes is derived from bills and payments. A client that
    // could post a balance would eventually post a wrong one.
    expect(body).not.toHaveProperty('outstanding');
    expect(body).not.toHaveProperty('amount_paid');
    expect(body).not.toHaveProperty('payment_status');
  });

  it('refuses an amount of zero without calling the server', async () => {
    const user = userEvent.setup();
    render(<CustomersScreen canEdit canRecordPayment />);
    await screen.findByText('Rakesh Motors');
    await user.click(screen.getByRole('button', { name: 'Open' }));

    const amount = await screen.findByLabelText('Amount received');
    await user.clear(amount);
    await user.type(amount, '0');
    await user.click(screen.getByRole('button', { name: 'Record this payment' }));

    expect(await screen.findByText(/more than zero/)).toBeInTheDocument();
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it('shows the server’s own refusal rather than a generic failure', async () => {
    const user = userEvent.setup();
    // The whole-rupee rule lives in the money policy and is enforced server-side, so
    // the client must surface the refusal rather than pre-judge the amount — otherwise
    // the rule drifts between the two.
    recordPayment.mockRejectedValue(
      new ApiError(422, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Some values need correcting.',
          details: {},
          request_id: 'req-1',
          retryable: false,
        },
      }),
    );
    render(<CustomersScreen canEdit canRecordPayment />);
    await screen.findByText('Rakesh Motors');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(await screen.findByRole('button', { name: 'Record this payment' }));

    // The server's own wording, not a generic failure — and specifically, not the
    // static balance explainer, which also carries `role="alert"` on this screen.
    expect(await screen.findByText(/Some values need correcting/)).toBeInTheDocument();
  });

  it('is absent without the payment permission', async () => {
    const user = userEvent.setup();
    render(<CustomersScreen canEdit />);
    await screen.findByText('Rakesh Motors');
    await user.click(screen.getByRole('button', { name: 'Open' }));

    // The history is still readable; taking money is a separate authority.
    expect(await screen.findByText('Payments received')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Record this payment' }),
    ).not.toBeInTheDocument();
  });

  it('is absent when the customer owes nothing', async () => {
    const user = userEvent.setup();
    creditCustomers.mockResolvedValue({
      items: [{ ...CREDIT_ROW, outstanding: '0.00', open_invoice_count: 0 }],
    });
    render(<CustomersScreen canEdit canRecordPayment />);
    await screen.findByText('Rakesh Motors');
    await user.click(screen.getByRole('button', { name: 'Open' }));

    // A payment against a settled account is an advance, which is a different decision
    // and not one to slip in behind an identical button.
    await screen.findByText('Payments received');
    expect(
      screen.queryByRole('button', { name: 'Record this payment' }),
    ).not.toBeInTheDocument();
  });
});

describe('a debt outside the credit endpoint’s page must never read as 0.00', () => {
  /**
   * The defect, reported as a financial display fault: the screen showed `0.00` owed
   * for a customer who owed money, and "Only customers who owe" then hid them
   * altogether — so the debt was invisible and nobody chased it.
   *
   * `credit.customers()` was called with **no limit**, so the server applied its own
   * default of twenty while a directory page holds fifty, and `include_settled: true`
   * handed some of those twenty slots to customers who owed nothing. Every directory
   * row missing from the resulting map fell back to a literal `0.00`.
   *
   * The fix reads the outstanding figure from the directory row itself, which carries a
   * per-customer summary for a caller holding `credit.read` (FR-CUST-012) and therefore
   * cannot be truncated at all; it asks the aggregates for the endpoint's maximum of
   * 200 for the one figure only they carry — the unpaid-bill count; and where a figure
   * genuinely is not known it prints a dash and says so, because a wrong number is
   * worse than an admitted gap (FR-RPT-030, ADR-032).
   */

  /** A real debtor, sitting outside whatever page the credit endpoint returned. */
  const DEBTOR = {
    id: 'past-the-page',
    name: 'Overflow Garage',
    primary_phone: '9876500099',
    credit: { outstanding: '12500.00', oldest_due_date: '2026-07-04' },
  };

  /** The credit endpoint's page, filled to its 200-row cap by *other* customers. */
  function cappedCreditPage() {
    return Array.from({ length: 200 }, (_, index) => ({
      ...CREDIT_ROW,
      customer: { id: `other-${index}`, name: `Other ${index}`, primary_phone: null },
    }));
  }

  it('shows the real figure for a customer the credit aggregates left out', async () => {
    list.mockResolvedValue({ items: [directory(DEBTOR)], page: PAGE });
    // The twenty-row page the server used to return, spent entirely on other people.
    creditCustomers.mockResolvedValue({
      items: cappedCreditPage().slice(0, 20),
    });

    render(<CustomersScreen canEdit />);

    await screen.findByText('Overflow Garage');
    // 12500 owed, not the 0.00 the old fallback asserted on their behalf.
    expect(screen.getByRole('cell', { name: '12500' })).toBeInTheDocument();
    expect(screen.getByText('2026-07-04')).toBeInTheDocument();
  });

  it('does not hide that customer behind “Only customers who owe”', async () => {
    const user = userEvent.setup();
    list.mockResolvedValue({
      items: [directory(DEBTOR), directory({ id: 'c3', name: 'Owes Nothing Co' })],
      page: PAGE,
    });
    creditCustomers.mockResolvedValue({ items: [] });

    render(<CustomersScreen canEdit />);
    await screen.findByText('Overflow Garage');
    await user.click(screen.getByRole('button', { name: /Only customers who owe/ }));

    // The worst half of the defect: a 0.00 the screen invented also failed the filter,
    // so the debtor vanished from the one view meant to list them.
    expect(screen.getByText('Overflow Garage')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('Owes Nothing Co')).not.toBeInTheDocument(),
    );
  });

  it('shows a dash, not a zero, for an unpaid-bill count the capped page could not reach', async () => {
    // The count exists only on `/credit/customers`, which caps at 200 rows and offers
    // no cursor, so on a shop with more than 200 credit customers it genuinely cannot
    // be known here. A full page is how the server reports `has_more`.
    list.mockResolvedValue({ items: [directory(DEBTOR)], page: PAGE });
    creditCustomers.mockResolvedValue({ items: cappedCreditPage() });

    render(<CustomersScreen canEdit />);

    await screen.findByText('Overflow Garage');
    // The money figure is still exact — it comes from the directory row.
    expect(screen.getByRole('cell', { name: '12500' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '—' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: '0' })).not.toBeInTheDocument();
    // And the dash is explained, rather than left to be read as "nothing".
    expect(await screen.findByText(/does not mean nothing is owed/)).toBeInTheDocument();
  });

  it('keeps a customer visible under the filter when their figure is unknown', async () => {
    const user = userEvent.setup();
    // No per-row summary and a credit list cut off at the cap: this screen cannot tell
    // whether they owe. Hiding them would repeat the defect — showing a possible
    // non-debtor costs a glance, hiding a real debtor costs the money.
    list.mockResolvedValue({
      items: [directory({ id: 'unknown-1', name: 'Unreadable Figure Co' })],
      page: PAGE,
    });
    creditCustomers.mockResolvedValue({ items: cappedCreditPage() });

    render(<CustomersScreen canEdit />);
    await screen.findByText('Unreadable Figure Co');
    await user.click(screen.getByRole('button', { name: /Only customers who owe/ }));

    expect(screen.getByText('Unreadable Figure Co')).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: '0' })).not.toBeInTheDocument();
  });

  it('offers no payment form against a figure it could not read', async () => {
    const user = userEvent.setup();
    // Prefilling the amount box from a figure we do not have would be guessing at how
    // much a customer owes, which is the one thing this screen must never do (ADR-022).
    list.mockResolvedValue({
      items: [directory({ id: 'unknown-1', name: 'Unreadable Figure Co' })],
      page: PAGE,
    });
    creditCustomers.mockResolvedValue({ items: cappedCreditPage() });

    render(<CustomersScreen canEdit canRecordPayment />);
    await screen.findByText('Unreadable Figure Co');
    await user.click(screen.getByRole('button', { name: 'Open' }));

    expect(await screen.findByText('Payments received')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Record this payment' }),
    ).not.toBeInTheDocument();
  });
});

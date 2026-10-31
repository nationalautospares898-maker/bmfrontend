/**
 * The billing screen, rendered.
 *
 * The assertions are the owner-decided rules that are easy to break by editing a
 * component:
 *
 * - **exactly four primary actions, and no fifth** (OD-14);
 * - both finalisation buttons are **disabled offline** — credit for the same reason as
 *   cash, since `Credit Bill` finalises (ADR-033);
 * - the on-screen total is **labelled a preview**, every time (ADR-032);
 * - a conflict renders as an **inline panel**, not a toast;
 * - the screen passes **axe** with no violations, because a cashier using a keyboard or
 *   a screen reader has to be able to bill.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db/schema';
import type { MoneyPolicy } from '@/lib/money';
import { useBillingStore } from './draftStore';
import { BillingCounter } from './BillingCounter';

const POLICY: MoneyPolicy = {
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

const COUNTER = '0192f000-0000-7000-8000-00000000c001';

// The search box and finalisation are stubbed: this suite is about the screen's rules,
// and the network paths have their own suites.
// Hoisted so the tests below can reference the mocks directly. Reaching them as
// `vi.mocked(module).method` instead trips `unbound-method`, and binding them per test
// is noise — this is the pattern the other screen suites use.
const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  finalize: vi.fn(),
  // Finalisation pushes the draft first, so this has to be here for the screen to work
  // at all — which is the point of `pushes the draft to the server before finalising`.
  draftUpsert: vi.fn(),
  customerSearch: vi.fn(),
  customerUpsert: vi.fn(),
}));

vi.mock('@/api/endpoints', () => ({
  catalog: { search: mocks.search },
  invoices: { get: vi.fn(), recordPrintEvent: vi.fn() },
  sales: { finalize: mocks.finalize },
  sync: { catalogDelta: vi.fn() },
  drafts: { upsert: mocks.draftUpsert },
  customers: { search: mocks.customerSearch, upsert: mocks.customerUpsert },
}));

beforeEach(async () => {
  mocks.search.mockResolvedValue({ items: [], page: {} });
  mocks.draftUpsert.mockResolvedValue({ version: 1 });
  mocks.customerSearch.mockResolvedValue({ items: [], page: {} });
  mocks.customerUpsert.mockResolvedValue({
    customer: { id: 'c1' },
    created: true,
    warnings: [],
  });
  await db.open();
  await db.drafts.clear();
  await db.outbox.clear();
  await db.pending_finalizations.clear();
  useBillingStore.setState({
    counterId: null,
    maxOpenDrafts: 1,
    drafts: [],
    activeDraftId: null,
    limitMessage: null,
    ready: false,
  });
  await useBillingStore.getState().initialise(COUNTER, 4);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('exactly four primary actions, and no fifth (OD-14)', () => {
  it('renders the four owner-decided labels', () => {
    render(<BillingCounter policy={POLICY} online canBill />);
    for (const label of ['Print Bill', 'Credit Bill', 'Save a Draft', 'Clear Draft']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it('renders no fifth finalisation-like action', () => {
    render(<BillingCounter policy={POLICY} online canBill />);
    const labels = screen
      .getAllByRole('button')
      .map((button) => button.textContent ?? '');
    // The rejected designs: a "Hold", a "Park", a "Quote", a credit-details step.
    for (const forbidden of [/\bhold\b/i, /\bpark\b/i, /\bquote\b/i, /credit details/i]) {
      expect(labels.some((label) => forbidden.test(label))).toBe(false);
    }
  });

  it('shows the keyboard shortcut next to each action, never instead of it', () => {
    render(<BillingCounter policy={POLICY} online canBill />);
    const printBill = screen.getByRole('button', { name: /Print Bill/ });
    // Words first, shortcut as an addition. A shortcut-only affordance is invisible to
    // someone who has never been shown it.
    expect(printBill.textContent).toContain('Print Bill');
    expect(printBill.textContent).toContain('Ctrl+Enter');
  });
});

describe('offline (FR-OFFLINE-002, ADR-033)', () => {
  it('disables both finalisation buttons', () => {
    render(<BillingCounter policy={POLICY} online={false} canBill />);
    expect(screen.getByRole('button', { name: /Print Bill/ })).toBeDisabled();
    // Credit is refused for the same reason as cash: since ADR-033 it finalises a
    // sale, and "credit" is about who owes money, not about whether the sale happened.
    expect(screen.getByRole('button', { name: /Credit Bill/ })).toBeDisabled();
  });

  it('leaves Save a Draft and Clear Draft available', () => {
    render(<BillingCounter policy={POLICY} online={false} canBill />);
    // The bill is already safe on disk, so saving it offline is a success rather than
    // an error.
    expect(screen.getByRole('button', { name: /Save a Draft/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Clear Draft/ })).toBeEnabled();
  });

  it('says what is happening and that nothing is lost', () => {
    render(<BillingCounter policy={POLICY} online={false} canBill />);
    expect(screen.getByText(/Working offline/)).toBeInTheDocument();
    expect(screen.getByText(/nothing is lost/)).toBeInTheDocument();
  });
});

describe('permissions', () => {
  it('explains rather than silently failing when the user cannot bill', () => {
    render(<BillingCounter policy={POLICY} online canBill={false} />);
    expect(screen.getByRole('button', { name: /Print Bill/ })).toBeDisabled();
    expect(screen.getByText(/Ask a supervisor/)).toBeInTheDocument();
  });
});

describe('the total is always a preview (ADR-032)', () => {
  it('labels it as confirmed on completion', () => {
    render(<BillingCounter policy={POLICY} online canBill />);
    expect(screen.getByText(/preview — confirmed on completion/)).toBeInTheDocument();
  });
});

describe('the empty state tells the cashier what to do', () => {
  it('prompts for a part rather than showing a bare table', () => {
    render(<BillingCounter policy={POLICY} online canBill />);
    expect(screen.getByText(/Type a part name or code above/)).toBeInTheDocument();
  });

  it('disables finalisation with no lines', () => {
    render(<BillingCounter policy={POLICY} online canBill />);
    // `EMPTY_SALE` should never reach the server from this client; if it does, that is
    // a client bug worth logging.
    expect(screen.getByRole('button', { name: /Print Bill/ })).toBeDisabled();
  });
});

describe('Clear Draft asks first', () => {
  it('opens a confirmation naming how many items will go', async () => {
    const user = userEvent.setup();
    render(<BillingCounter policy={POLICY} online canBill />);

    await user.click(screen.getByRole('button', { name: /Clear Draft/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    // And it says the one thing a cashier needs to know: this does not touch a
    // completed bill.
    expect(dialog.textContent).toMatch(/does not affect any completed bill/);
  });

  it('keeps the bill when the user backs out', async () => {
    const user = userEvent.setup();
    render(<BillingCounter policy={POLICY} online canBill />);
    await user.click(screen.getByRole('button', { name: /Clear Draft/ }));
    await user.click(screen.getByRole('button', { name: /Keep this bill/ }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(await db.drafts.count()).toBe(1);
  });
});

describe('credit requires a saved customer (FR-CREDIT-009)', () => {
  it('refuses before sending and says why', async () => {
    const user = userEvent.setup();
    render(<BillingCounter policy={POLICY} online canBill />);

    const draftId = useBillingStore.getState().activeDraftId;
    expect(draftId).toBeTruthy();
    await useBillingStore.getState().addLine(draftId!, {
      product_id: 'p1',
      product_name: 'Brake Shoe Set',
      sku: 'TT-407-BS',
      unit_code: 'SET',
      quantity: '1.000',
      unit_price: '1250.0000',
      catalog_price_at_add: '1250.0000',
      price_source: 'catalog',
      discount_percent: '0.000',
      known_stock: '10.000',
      stock_as_of: '2026-10-30T10:00:00Z',
    });

    await user.click(screen.getByRole('button', { name: /Credit Bill/ }));

    // An inline panel, not a toast: a toast can be missed while looking at a customer,
    // and this blocks the sale.
    const panel = await screen.findByRole('alert');
    expect(panel.textContent).toMatch(/needs a saved customer/);
  });
});

describe('the tab strip', () => {
  it('offers a new bill and marks the current one', () => {
    render(<BillingCounter policy={POLICY} online canBill />);
    expect(screen.getByRole('button', { name: 'New bill' })).toBeInTheDocument();
    // `aria-current` rather than colour alone, so the active tab is announced.
    const current = screen
      .getAllByRole('button')
      .find((button) => button.getAttribute('aria-current') === 'true');
    expect(current).toBeDefined();
  });

  it('refuses a new bill at the limit and says nothing will be closed', async () => {
    const user = userEvent.setup();
    useBillingStore.setState({ maxOpenDrafts: 1 });
    render(<BillingCounter policy={POLICY} online canBill />);

    await user.click(screen.getByRole('button', { name: 'New bill' }));

    const panel = await screen.findByRole('alert');
    // The wording matters as much as the refusal: a cashier who loses a half-typed
    // bill to make room will not trust the system again.
    expect(panel.textContent).toMatch(/Nothing will be closed for you/);
    expect(await db.drafts.count()).toBe(1);
  });
});

describe('accessibility', () => {
  it('has no axe violations', async () => {
    const { container } = render(<BillingCounter policy={POLICY} online canBill />);

    const results = await axe.run(container, {
      // The rules that actually matter at a counter: labels, names, contrast-independent
      // structure, and keyboard reachability.
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    });

    const violations = results.violations.map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.length,
    }));
    expect(violations).toEqual([]);
  }, 30_000);

  it('labels every input, because a placeholder is not a label', () => {
    render(<BillingCounter policy={POLICY} online canBill />);
    for (const input of screen.getAllByRole('textbox')) {
      const labelled =
        input.getAttribute('aria-label') ??
        input.getAttribute('aria-labelledby') ??
        (input.id ? document.querySelector(`label[for="${input.id}"]`) : null);
      expect(labelled, input.outerHTML).toBeTruthy();
    }
  });
});

describe('a bill the server has never seen (the NOT_FOUND defect)', () => {
  /**
   * The defect, as reported from a real browser: type a bill, press `Print Bill`, and
   * get "This bill is not confirmed" with three failed attempts and `NOT_FOUND`.
   *
   * The server resolves `draft_id` against its own `draft_bills` row and raises
   * `NotFound("That bill does not exist.")` when it has never seen it
   * (`bmbackend/src/bm/domain/sales/service.py`). Nothing pushed a draft except the
   * `Save a Draft` button — `saveDraftToServer` had exactly one caller, that button —
   * so the ordinary way to use this screen failed every single time, deterministically.
   * Verified against the real database afterwards: no invoice, no idempotency row and
   * no stock movement had been created, so the sale was never committed.
   */
  it('pushes the draft to the server before finalising', async () => {
    const user = userEvent.setup();
    const { draftUpsert: upsert, finalize } = mocks;
    upsert.mockResolvedValue({ version: 4 });
    finalize.mockRejectedValue(new Error('stop after the push'));

    render(<BillingCounter policy={POLICY} online canBill />);
    const draftId = useBillingStore.getState().activeDraftId;
    await useBillingStore.getState().addLine(draftId!, {
      product_id: 'p1',
      product_name: 'Brake Shoe Set Ace',
      sku: 'BR-4002-E',
      unit_code: 'NOS',
      quantity: '1.000',
      unit_price: '880.0000',
      catalog_price_at_add: '870.0000',
      price_source: 'manual_override',
      discount_percent: '0.000',
      known_stock: '12.000',
      stock_as_of: '2026-10-31T13:26:04Z',
    });

    await user.click(screen.getByRole('button', { name: /Print Bill/ }));

    // The draft reached the server, and it reached it with this draft's own id.
    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
    expect(upsert.mock.calls[0]?.[0]).toBe(draftId);
    // Waited out, not abandoned: the click's promise chain continues after the
    // assertion, and a `finalize` call landing after `afterEach` cleared the mocks
    // shows up as the *next* test's first call. Which is exactly how this leaked once.
    await waitFor(() => expect(finalize).toHaveBeenCalled());
  });

  it('sends the version the server just confirmed, not a stale one', async () => {
    // The push is not enough on its own: `draft_version` has to match what the server
    // now holds, or the optimistic-concurrency check turns the NOT_FOUND into a 409.
    const user = userEvent.setup();
    const { finalize } = mocks;
    mocks.draftUpsert.mockResolvedValue({ version: 7 });
    finalize.mockRejectedValue(new Error('stop after the push'));

    render(<BillingCounter policy={POLICY} online canBill />);
    const draftId = useBillingStore.getState().activeDraftId;
    await useBillingStore.getState().addLine(draftId!, {
      product_id: 'p1',
      product_name: 'Brake Shoe Set Ace',
      sku: 'BR-4002-E',
      unit_code: 'NOS',
      quantity: '1.000',
      unit_price: '880.0000',
      catalog_price_at_add: '870.0000',
      price_source: 'manual_override',
      discount_percent: '0.000',
      known_stock: '12.000',
      stock_as_of: '2026-10-31T13:26:04Z',
    });

    await user.click(screen.getByRole('button', { name: /Print Bill/ }));

    await waitFor(() => expect(finalize).toHaveBeenCalled());
    const body = finalize.mock.calls[0]?.[0] as { draft_version?: number | null };
    expect(body.draft_version).toBe(7);
  });

  it('records the confirmed version locally, so the next edit sends the right If-Match', async () => {
    mocks.draftUpsert.mockResolvedValue({ version: 9 });

    const draftId = useBillingStore.getState().activeDraftId;
    expect(useBillingStore.getState().drafts[0]?.version).toBeNull();

    await useBillingStore.getState().ensureOnServer(draftId!);

    expect(useBillingStore.getState().drafts[0]?.version).toBe(9);
    expect((await db.drafts.get(draftId!))?.version).toBe(9);
  });
});

describe('the customer picker (FR-CREDIT-009)', () => {
  /**
   * `draft.header.customer_id` was only ever **read** — at five places including the
   * credit guard — and never written anywhere in the application. So
   * `saleType === 'credit' && !customer_id` was always true and the `Credit Bill`
   * button could not succeed for anyone. A cashier typing a name, vehicle and phone got
   * "A credit bill needs a saved customer, not just a typed name" with no way to
   * satisfy it.
   */
  const SAVED = {
    id: 'cust-1',
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
  };

  async function addLine(): Promise<void> {
    const draftId = useBillingStore.getState().activeDraftId;
    await useBillingStore.getState().addLine(draftId!, {
      product_id: 'p1',
      product_name: 'Brake Shoe Set Ace',
      sku: 'BR-4002-E',
      unit_code: 'NOS',
      quantity: '1.000',
      unit_price: '880.0000',
      catalog_price_at_add: '870.0000',
      price_source: 'manual_override',
      discount_percent: '0.000',
      known_stock: '12.000',
      stock_as_of: '2026-10-31T13:26:04Z',
    });
  }

  it('attaches the saved customer id to the draft when one is chosen', async () => {
    const user = userEvent.setup();
    mocks.customerSearch.mockResolvedValue({ items: [SAVED], page: {} });
    render(<BillingCounter policy={POLICY} online canBill />);

    await user.type(screen.getByLabelText(/Find a saved customer/), 'rakesh');
    await user.click(await screen.findByRole('button', { name: /Rakesh Motors/ }));

    const draftId = useBillingStore.getState().activeDraftId;
    await waitFor(() => {
      const draft = useBillingStore.getState().drafts.find((d) => d.id === draftId);
      // The id is the association. This is the line that never used to run.
      expect(draft?.header.customer_id).toBe('cust-1');
    });
  });

  it('fills the bill snapshot from the chosen customer', async () => {
    const user = userEvent.setup();
    mocks.customerSearch.mockResolvedValue({ items: [SAVED], page: {} });
    render(<BillingCounter policy={POLICY} online canBill />);

    await user.type(screen.getByLabelText(/Find a saved customer/), 'rakesh');
    await user.click(await screen.findByRole('button', { name: /Rakesh Motors/ }));

    await waitFor(() => {
      const draft = useBillingStore.getState().drafts[0];
      expect(draft?.header.customer_name).toBe('Rakesh Motors');
      expect(draft?.header.phone).toBe('9876500011');
      expect(draft?.header.vehicle_number).toBe('KA01AB1234');
    });
    // And it says who the bill is for, rather than leaving the cashier to infer it.
    expect(await screen.findByText(/Billing to:/)).toBeInTheDocument();
  });

  it('lets the customer be changed again, keeping the typed snapshot', async () => {
    const user = userEvent.setup();
    mocks.customerSearch.mockResolvedValue({ items: [SAVED], page: {} });
    render(<BillingCounter policy={POLICY} online canBill />);
    await user.type(screen.getByLabelText(/Find a saved customer/), 'rakesh');
    await user.click(await screen.findByRole('button', { name: /Rakesh Motors/ }));
    await screen.findByText(/Billing to:/);

    await user.click(screen.getByRole('button', { name: 'Change' }));

    await waitFor(() => {
      const draft = useBillingStore.getState().drafts[0];
      // Association cleared...
      expect(draft?.header.customer_id).toBeNull();
      // ...but the goods were still sold to whoever is standing there.
      expect(draft?.header.customer_name).toBe('Rakesh Motors');
    });
  });

  it('creates a customer when none matches, and attaches the persisted id', async () => {
    const user = userEvent.setup();
    mocks.customerSearch.mockResolvedValue({ items: [], page: {} });
    mocks.customerUpsert.mockResolvedValue({
      // The server's id, which the client must read back rather than assume.
      customer: { ...SAVED, id: 'server-assigned', name: 'Sukith' },
      created: true,
      warnings: [],
    });
    render(<BillingCounter policy={POLICY} online canBill />);

    await user.type(screen.getByLabelText(/Find a saved customer/), 'Sukith');
    await user.click(
      await screen.findByRole('button', { name: /Save as a new customer/ }),
    );

    await waitFor(() => expect(mocks.customerUpsert).toHaveBeenCalled());
    // Client-generated id in the path, so a double click is an upsert not a duplicate.
    const [sentId, body] = mocks.customerUpsert.mock.calls[0] as [
      string,
      { name: string },
    ];
    expect(sentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.name).toBe('Sukith');

    await waitFor(() => {
      expect(useBillingStore.getState().drafts[0]?.header.customer_id).toBe(
        'server-assigned',
      );
    });
  });

  it('surfaces a suspected duplicate without blocking or merging (FR-CUST-004)', async () => {
    const user = userEvent.setup();
    mocks.customerSearch.mockResolvedValue({ items: [], page: {} });
    mocks.customerUpsert.mockResolvedValue({
      customer: { ...SAVED, id: 'server-assigned', name: 'Sukith' },
      created: true,
      warnings: [
        { code: 'CUSTOMER_DUPLICATE_SUSPECTED', message: 'Sukith may already exist.' },
      ],
    });
    render(<BillingCounter policy={POLICY} online canBill />);

    await user.type(screen.getByLabelText(/Find a saved customer/), 'Sukith');
    await user.click(
      await screen.findByRole('button', { name: /Save as a new customer/ }),
    );

    // Warned, and the customer is still attached — nothing was merged or refused.
    expect(await screen.findByText(/may already exist/)).toBeInTheDocument();
    await waitFor(() =>
      expect(useBillingStore.getState().drafts[0]?.header.customer_id).toBe(
        'server-assigned',
      ),
    );
  });

  it('lets a credit bill through once a customer is attached', async () => {
    const user = userEvent.setup();
    mocks.customerSearch.mockResolvedValue({ items: [SAVED], page: {} });
    mocks.draftUpsert.mockResolvedValue({ version: 1 });
    mocks.finalize.mockRejectedValue(new Error('stop after the request'));
    render(<BillingCounter policy={POLICY} online canBill />);
    await addLine();

    await user.type(screen.getByLabelText(/Find a saved customer/), 'rakesh');
    await user.click(await screen.findByRole('button', { name: /Rakesh Motors/ }));
    await screen.findByText(/Billing to:/);

    await user.click(screen.getByRole('button', { name: /Credit Bill/ }));

    // It reached the server instead of being refused on the client, and it carried the
    // customer as `existing` with the saved id.
    await waitFor(() => expect(mocks.finalize).toHaveBeenCalled());
    const body = mocks.finalize.mock.calls[0]?.[0] as {
      customer?: { mode: string; customer_id?: string };
    };
    expect(body.customer?.mode).toBe('existing');
    expect(body.customer?.customer_id).toBe('cust-1');
  });

  it('offers "save as a new customer" even when something matched (two people share a name)', async () => {
    // The action used to appear only on an empty result set. So a near-match blocked it
    // outright: a shop that already has a "Rakesh Motors" could not add a second,
    // different one from the billing screen — the matches showed, none was the right
    // person, and the only way forward was abandoning the bill. Two customers may
    // genuinely share a name, and the cashier can see which person is standing there.
    const user = userEvent.setup();
    mocks.customerSearch.mockResolvedValue({ items: [SAVED], page: {} });
    render(<BillingCounter policy={POLICY} online canBill />);

    await user.type(screen.getByLabelText(/Find a saved customer/), 'rakesh');

    // The match is offered...
    expect(
      await screen.findByRole('button', { name: /Rakesh Motors/ }),
    ).toBeInTheDocument();
    // ...and so is creating a new one.
    expect(
      await screen.findByRole('button', { name: /Save as a new customer/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Not the right person/)).toBeInTheDocument();
  });

  it('still refuses a credit bill with only a typed name', async () => {
    // The guard stays. The picker gives it something to be satisfied by; it does not
    // weaken it.
    const user = userEvent.setup();
    render(<BillingCounter policy={POLICY} online canBill />);
    await addLine();

    await user.click(screen.getByRole('button', { name: /Credit Bill/ }));

    expect(await screen.findByText(/needs a saved customer/)).toBeInTheDocument();
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it('needs no customer for a cash bill', async () => {
    const user = userEvent.setup();
    mocks.draftUpsert.mockResolvedValue({ version: 1 });
    mocks.finalize.mockRejectedValue(new Error('stop after the request'));
    render(<BillingCounter policy={POLICY} online canBill />);
    await addLine();

    await user.click(screen.getByRole('button', { name: /Print Bill/ }));

    await waitFor(() => expect(mocks.finalize).toHaveBeenCalled());
    const body = mocks.finalize.mock.calls[0]?.[0] as { customer?: { mode: string } };
    expect(body.customer?.mode).toBe('none');
  });
});

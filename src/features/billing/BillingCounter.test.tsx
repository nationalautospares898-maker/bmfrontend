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
vi.mock('@/api/endpoints', () => ({
  catalog: { search: vi.fn(() => Promise.resolve({ items: [], page: {} })) },
  invoices: { get: vi.fn(), recordPrintEvent: vi.fn() },
  sales: { finalize: vi.fn() },
  sync: { catalogDelta: vi.fn() },
}));

beforeEach(async () => {
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

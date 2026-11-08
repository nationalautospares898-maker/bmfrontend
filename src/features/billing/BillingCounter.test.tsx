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

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/errors';
import { db } from '@/db/schema';
import type { MoneyPolicy } from '@/lib/money';
import { BILLING } from '@/lib/strings';
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
  mechanicSearch: vi.fn(),
  mechanicEnsure: vi.fn(),
}));

vi.mock('@/api/endpoints', () => ({
  catalog: { search: mocks.search },
  invoices: { get: vi.fn(), recordPrintEvent: vi.fn() },
  sales: { finalize: mocks.finalize },
  sync: { catalogDelta: vi.fn() },
  drafts: { upsert: mocks.draftUpsert },
  customers: { search: mocks.customerSearch, upsert: mocks.customerUpsert },
  mechanics: { search: mocks.mechanicSearch, ensure: mocks.mechanicEnsure },
}));

beforeEach(async () => {
  mocks.search.mockResolvedValue({ items: [], page: {} });
  mocks.draftUpsert.mockResolvedValue({ version: 1 });
  mocks.customerSearch.mockResolvedValue({ items: [], page: {} });
  mocks.mechanicSearch.mockResolvedValue({ items: [], page: {} });
  mocks.mechanicEnsure.mockResolvedValue({
    id: 'm1',
    name: 'Ramesh',
    phone: null,
    is_active: true,
    use_count: 1,
    last_used_at: null,
    created: true,
  });
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

/** A catalogue hit, in the shape `GET /products/search` actually returns. */
const PRODUCT = {
  id: 'p1',
  name: 'AXEL PACKING',
  sku: 'AX-100',
  barcode: null,
  unit: { code: 'NOS', name: 'Numbers', allows_fraction: false, decimal_places: 0 },
  default_selling_price: '30.0000',
  stock: { branch_quantity: '200.000', as_of: '2026-11-02T04:00:00Z' },
  is_active: true,
};

const SECOND_PRODUCT = { ...PRODUCT, id: 'p2', name: '11L LE MAX', sku: 'LE-11' };

/**
 * Type into row 1's Item cell and pick the first match.
 *
 * This is the whole keyboard-only path the redesign had to preserve: the search box
 * became a cell, so adding an item is "type in the cell, press Enter" rather than "type
 * in the box above, press Enter" (FR-BILL-001).
 */
async function addFirstProduct(
  user: ReturnType<typeof userEvent.setup>,
  row = 1,
  text = 'axel',
  column = 0,
): Promise<void> {
  // Scoped to one column: three bills are on screen at once and each of them has a row
  // 1. `column` is which of them to type into, left to right.
  await user.type(bill(column).getByLabelText(`Item, row ${row}`), text);
  // Selected with `Enter`, not a click, because that is the path a cashier actually
  // uses and the one the owner asked to keep working: type, Enter, type the quantity,
  // Enter. Clicking is also available and has its own assertion.
  await screen.findByRole('listbox');
  await user.keyboard('{Enter}');
  /**
   * Wait for the line to actually be **on** the bill before returning.
   *
   * `Enter` starts `addLine`, which writes to Dexie and only then republishes the
   * store. Returning on the keystroke left every caller racing that write, and the
   * race had a silent loser: until the line lands, `canFinalize` is false, `Print
   * Bill` is disabled, and `user.click` on a disabled button does nothing at all. The
   * test then waited for a panel that no request had been made for.
   *
   * It failed roughly one run in four under a full-suite load and nowhere near a
   * single-file run, which is what made it look like slowness — the first two attempts
   * at it raised the timeout, which could not have helped, because nothing was ever
   * in flight to wait for. The same race is reachable on the original single-bill
   * screen; the three-bill workspace only made it more likely by adding a render.
   */
  await waitFor(() => {
    const state = useBillingStore.getState();
    const draft = state.drafts.find((candidate) => candidate.id === state.activeDraftId);
    expect(draft?.lines.length ?? 0).toBeGreaterThan(0);
  });
}

/**
 * Queries scoped to one bill column.
 *
 * The workspace now shows up to three bills at once and the tab strip carries the
 * customer's name, so a bare `screen.getByText('Rakesh Motors')` legitimately matches
 * two things: the tab and the bill it names. That is the feature working, not a defect
 * — a cashier with fifteen bills open finds the third one by the name on its tab.
 *
 * Each column is a `<section aria-label="Bill 1: ...">`, which is an ARIA `region`, so
 * scoping is the same tool the tab strip already uses (`within(getByRole('navigation'))`)
 * pointed the other way.
 */
function bill(index = 0) {
  const columns = screen.getAllByRole('region');
  return within(columns[index]!);
}

/**
 * Start a new bill and wait for its column to exist.
 *
 * `Start a new bill` writes to Dexie before the store publishes, so the click resolves
 * a tick before the new column is mounted. Typing into "the second bill" in that gap
 * found no second bill — which is why this waits for the column rather than for the
 * click. It was invisible while the screen showed one bill at a time, because the new
 * draft simply replaced what was already rendered.
 */
async function newBill(
  user: ReturnType<typeof userEvent.setup>,
  expected: number,
): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Start a new bill' }));
  await waitFor(() => expect(screen.getAllByRole('region')).toHaveLength(expected));
}

describe('exactly four primary actions, and no fifth (OD-14)', () => {
  it('renders the four owner-decided labels', () => {
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    for (const label of ['Print Bill', 'Credit Bill', 'Save a Draft', 'Clear Draft']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it('renders no fifth finalisation-like action', () => {
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    const labels = screen
      .getAllByRole('button')
      .map((button) => button.textContent ?? '');
    // The rejected designs: a "Hold", a "Park", a "Quote", a credit-details step.
    for (const forbidden of [/\bhold\b/i, /\bpark\b/i, /\bquote\b/i, /credit details/i]) {
      expect(labels.some((label) => forbidden.test(label))).toBe(false);
    }
  });

  it('shows the keyboard shortcut next to each action, never instead of it', () => {
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    const printBill = screen.getByRole('button', { name: /Print Bill/ });
    // Words first, shortcut as an addition. A shortcut-only affordance is invisible to
    // someone who has never been shown it.
    expect(printBill.textContent).toContain('Print Bill');
    expect(printBill.textContent).toContain('Ctrl+Enter');
  });
});

describe('offline (FR-OFFLINE-002, ADR-033)', () => {
  it('disables both finalisation buttons', () => {
    render(<BillingCounter policy={POLICY} online={false} canBill canOverridePrice />);
    expect(screen.getByRole('button', { name: /Print Bill/ })).toBeDisabled();
    // Credit is refused for the same reason as cash: since ADR-033 it finalises a
    // sale, and "credit" is about who owes money, not about whether the sale happened.
    expect(screen.getByRole('button', { name: /Credit Bill/ })).toBeDisabled();
  });

  it('leaves Save a Draft and Clear Draft available', () => {
    render(<BillingCounter policy={POLICY} online={false} canBill canOverridePrice />);
    // The bill is already safe on disk, so saving it offline is a success rather than
    // an error.
    expect(screen.getByRole('button', { name: /Save a Draft/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Clear Draft/ })).toBeEnabled();
  });

  it('says what is happening and that nothing is lost', () => {
    render(<BillingCounter policy={POLICY} online={false} canBill canOverridePrice />);
    expect(screen.getByText(/Working offline/)).toBeInTheDocument();
    expect(screen.getByText(/nothing is lost/)).toBeInTheDocument();
  });
});

describe('permissions', () => {
  it('explains rather than silently failing when the user cannot bill', () => {
    render(<BillingCounter policy={POLICY} online canBill={false} canOverridePrice />);
    expect(screen.getByRole('button', { name: /Print Bill/ })).toBeDisabled();
    expect(screen.getByText(/Ask a supervisor/)).toBeInTheDocument();
  });

  it('shows the price but does not let it be edited without the permission', async () => {
    // Read-only, never hidden: the cashier still has to be able to see what the bill
    // says. The server re-checks the override regardless (§5 rule 12).
    mocks.search.mockResolvedValue({ items: [PRODUCT], page: {} });
    const user = userEvent.setup();
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice={false} />);
    await addFirstProduct(user);

    // Awaited: adding a line writes to Dexie before the store publishes, so the cell
    // does not exist on the tick the key was pressed.
    expect(await screen.findByLabelText('Price, row 1')).toBeDisabled();
    // The quantity is still editable — only the price is permissioned.
    expect(screen.getByLabelText('Quantity, row 1')).toBeEnabled();
  });

  it('offers audited oversell only after a stock refusal and sends the reason on retry', async () => {
    const user = userEvent.setup();
    mocks.search.mockResolvedValue({ items: [PRODUCT], page: {} });
    mocks.finalize.mockRejectedValueOnce(
      new ApiError(409, {
        error: {
          code: 'INSUFFICIENT_STOCK',
          message: 'There is not enough stock.',
          details: {
            shortfalls: [
              {
                product_id: 'p1',
                product_name: 'AXEL PACKING',
                requested: '1',
                available: '0',
              },
            ],
          },
          request_id: 'test-request',
          retryable: false,
        },
      }),
    );
    mocks.finalize.mockRejectedValueOnce(new Error('stop after the retry request'));
    render(
      <BillingCounter
        policy={POLICY}
        online
        canBill
        canOverridePrice
        canOverrideOversell
      />,
    );
    await addFirstProduct(user);

    expect(
      screen.queryByRole('checkbox', { name: BILLING.oversellApprovalLabel }),
    ).toBeNull();
    await user.click(screen.getByRole('button', { name: /Print Bill/ }));

    const approval = await screen.findByRole(
      'checkbox',
      { name: BILLING.oversellApprovalLabel },
      // Pressing `Print Bill` pushes the draft to the server, finalises and reloads the
      // store before this panel can render — four awaits, not one render.
      { timeout: 4000 },
    );
    await user.click(approval);
    const reason = screen.getByLabelText(BILLING.oversellReasonLabel);
    await user.type(reason, 'Verified physically and approved by manager');
    await user.click(screen.getByRole('button', { name: /Print Bill/ }));

    await waitFor(() => expect(mocks.finalize).toHaveBeenCalledTimes(2));
    const body = mocks.finalize.mock.calls[1]?.[0] as {
      oversell_override?: { reason?: string };
    };
    expect(body.oversell_override?.reason).toBe(
      'Verified physically and approved by manager',
    );
  });

  it('does not offer the oversell approval to a user without that permission', async () => {
    const user = userEvent.setup();
    mocks.search.mockResolvedValue({ items: [PRODUCT], page: {} });
    mocks.finalize.mockRejectedValueOnce(
      new ApiError(409, {
        error: {
          code: 'INSUFFICIENT_STOCK',
          message: 'There is not enough stock.',
          details: { shortfalls: [] },
          request_id: 'test-request',
          retryable: false,
        },
      }),
    );
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    await addFirstProduct(user);
    await user.click(screen.getByRole('button', { name: /Print Bill/ }));

    // The default one-second patience is not enough under a full-suite run: pressing
    // `Print Bill` writes the draft to Dexie, pushes it to the server, finalises, and
    // reloads the store before the panel can render — and those are four awaits, not
    // one render. The sibling suites below already use the same 4s for the same reason.
    await screen.findByText(/There is not enough stock/, {}, { timeout: 4000 });
    expect(
      screen.queryByRole('checkbox', { name: BILLING.oversellApprovalLabel }),
    ).toBeNull();
  });
});

describe('the total is always a preview (ADR-032)', () => {
  it('labels it as confirmed on completion', () => {
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    expect(screen.getByText(/preview — confirmed on completion/)).toBeInTheDocument();
  });
});

describe('the empty state tells the cashier what to do', () => {
  it('prompts for a part rather than showing a bare table', () => {
    // FR-BILL-011 survives the redesign. Fifteen blank numbered rows are exactly the
    // "empty table with no guidance" the requirement was written against, so the hint is
    // rendered under the grid instead of inside it.
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    expect(
      screen.getByText(/Type a part name or code in the Item column/),
    ).toBeInTheDocument();
  });

  it('disables finalisation with no lines', () => {
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    // `EMPTY_SALE` should never reach the server from this client; if it does, that is
    // a client bug worth logging.
    expect(screen.getByRole('button', { name: /Print Bill/ })).toBeDisabled();
  });
});

describe('Clear Draft asks first', () => {
  it('opens a confirmation naming how many items will go', async () => {
    const user = userEvent.setup();
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);

    await user.click(screen.getByRole('button', { name: /Clear Draft/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    // And it says the one thing a cashier needs to know: this does not touch a
    // completed bill.
    expect(dialog.textContent).toMatch(/does not affect any completed bill/);
  });

  it('keeps the bill when the user backs out', async () => {
    const user = userEvent.setup();
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
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
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);

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
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    expect(screen.getByRole('button', { name: 'Start a new bill' })).toBeInTheDocument();
    // `aria-current` rather than colour alone, so the active tab is announced.
    const current = screen
      .getAllByRole('button')
      .find((button) => button.getAttribute('aria-current') === 'true');
    expect(current).toBeDefined();
  });

  it('refuses a new bill at the limit and says nothing will be closed', async () => {
    const user = userEvent.setup();
    useBillingStore.setState({ maxOpenDrafts: 1 });
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);

    await user.click(screen.getByRole('button', { name: 'Start a new bill' }));

    const panel = await screen.findByRole('alert');
    // The wording matters as much as the refusal: a cashier who loses a half-typed
    // bill to make room will not trust the system again.
    expect(panel.textContent).toMatch(/Nothing will be closed for you/);
    expect(await db.drafts.count()).toBe(1);
  });
});

describe('the Excel-style invoice grid', () => {
  it('shows fifteen numbered rows before anything is on the bill', () => {
    // The owner's own sheet has its rows numbered whether or not they are used, and
    // seeing three rows for a three-line bill was the specific complaint.
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    const grid = within(screen.getByRole('table', { name: /Bill items/i }));
    for (const row of [1, 15]) {
      expect(grid.getByLabelText(`Item, row ${row}`)).toBeInTheDocument();
    }
    // Fifteen, not sixteen, while the bill is empty: the spare row appears once rows
    // start filling.
    expect(grid.queryByLabelText('Item, row 16')).not.toBeInTheDocument();
  });

  it('uses the owner’s column headers', () => {
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    const grid = within(screen.getByRole('table', { name: /Bill items/i }));
    for (const header of ['S.No', 'Item', 'Qty', 'Price', 'Total']) {
      expect(grid.getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
  });

  it('keeps a spare row below the last item, so row 16 exists once 15 are filled', async () => {
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    const draftId = useBillingStore.getState().activeDraftId!;
    for (let line = 0; line < 15; line += 1) {
      await useBillingStore.getState().addLine(draftId, {
        product_id: `p${line}`,
        product_name: `PART ${line}`,
        sku: null,
        unit_code: 'NOS',
        quantity: '1.000',
        unit_price: '10.0000',
        catalog_price_at_add: '10.0000',
        price_source: 'catalog',
        discount_percent: '0.000',
        known_stock: null,
        stock_as_of: null,
      });
    }
    // Row 16 is already there when the cashier leaves row 15 — they never have to ask
    // for one.
    expect(await screen.findByLabelText('Item, row 16')).toBeInTheDocument();
  });

  it('adds a product from the Item cell and fills its price', async () => {
    mocks.search.mockResolvedValue({ items: [PRODUCT], page: {} });
    const user = userEvent.setup();
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);

    await addFirstProduct(user);

    await waitFor(() => {
      expect(screen.getByLabelText('Quantity, row 1')).toHaveValue('1');
    });
    // The catalogue price, taken from the hit rather than typed.
    expect(screen.getByLabelText('Price, row 1')).toHaveValue('30');
  });

  it('keeps a space a space while a product name is being typed', async () => {
    // `AXEL PACKING` has one in the middle. A grid that swallowed `Space` to select a
    // cell would make half the catalogue untypeable, so this is asserted rather than
    // assumed.
    mocks.search.mockResolvedValue({ items: [PRODUCT], page: {} });
    const user = userEvent.setup();
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);

    const cell = screen.getByLabelText('Item, row 1');
    await user.type(cell, 'axel packing');
    expect(cell).toHaveValue('axel packing');
  });

  it('shows a prominent GRAND TOTAL', () => {
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    expect(screen.getByText('GRAND TOTAL')).toBeInTheDocument();
  });

  it('renders the bill header fields inline, mechanic included (FR-BILL-010)', () => {
    // Inline on the bill, never behind a dialog, and never part of a credit-details
    // form — that design was removed by OD-21/ADR-033 and must not come back.
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    expect(screen.getByLabelText(/Customer Name/)).toBeInTheDocument();
    expect(screen.getByLabelText('Mechanic Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Vehicle Number')).toBeInTheDocument();
    expect(screen.getByText('ESTIMATE')).toBeInTheDocument();
  });

  it('draws no shop heading of its own — the shell owns the one name', () => {
    // The workspace used to draw the configured name above its columns, and the shell
    // draws it at the top left: two `NATIONAL AUTO SPARES` on one screen, which the
    // owner reported on sight. The rule that heading exists for — **configured, never
    // invented** (OD-4, FR-PRINT-016) — did not move, only the heading did; `AppShell`
    // reads it from `/sync/bootstrap` and this screen reads nothing.
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    // And nothing stands in for a business field the owner has not supplied.
    expect(screen.queryByText(/Address line/i)).not.toBeInTheDocument();
  });
});

/**
 * The three-bill workspace (owner request, 2026-11-08).
 *
 * The owner described the rolling window by example rather than by rule, so these are
 * their examples: open three and see `1 2 3`; start a fourth and see `2 3 4`; choose a
 * bill from the tabs and it opens on the left with the next two beside it.
 *
 * Asserted through each column's accessible name, which carries both the position and
 * whoever the bill is for — the same thing a cashier reads off the tab.
 */
describe('three bills at a time, rolling (owner request, 2026-11-08)', () => {
  /** The positions of the bills currently on screen, left to right. */
  function columns(): number[] {
    return screen.getAllByRole('region').map((panel) => {
      const match = /^Bill (\d+):/.exec(panel.getAttribute('aria-label') ?? '');
      return Number(match?.[1]);
    });
  }

  /**
   * Open `count` bills.
   *
   * Waits on the **store**, not on the number of columns: past the third bill the
   * column count stops changing — that is the whole point of the window — so waiting
   * for it would return before the new draft existed and the next click would race it.
   */
  async function open(user: ReturnType<typeof userEvent.setup>, count: number) {
    useBillingStore.setState({ maxOpenDrafts: 8 });
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    for (let n = 2; n <= count; n += 1) {
      await user.click(screen.getByRole('button', { name: 'Start a new bill' }));
      await waitFor(() => expect(useBillingStore.getState().drafts).toHaveLength(n));
    }
    await waitFor(() =>
      expect(screen.getAllByRole('region')).toHaveLength(Math.min(count, 3)),
    );
  }

  it('shows the first three as 1 · 2 · 3', async () => {
    const user = userEvent.setup();
    await open(user, 3);
    expect(columns()).toEqual([1, 2, 3]);
  });

  it('rolls to 2 · 3 · 4 when a fourth is started, keeping the new one on the right', async () => {
    // The two beside it are the bills the cashier was already working on. Pushing those
    // off-screen to make room for the new one would lose their place.
    const user = userEvent.setup();
    await open(user, 4);
    expect(columns()).toEqual([2, 3, 4]);
  });

  it('keeps rolling: a fifth shows 3 · 4 · 5', async () => {
    const user = userEvent.setup();
    await open(user, 5);
    expect(columns()).toEqual([3, 4, 5]);
  });

  it('opens a bill chosen from the tabs on the LEFT, with the next two beside it', async () => {
    const user = userEvent.setup();
    await open(user, 5); // showing 3 · 4 · 5
    const tabs = within(screen.getByRole('navigation', { name: 'Open bills' }));

    await user.click(tabs.getAllByRole('button', { name: /^New bill/ })[1]!); // bill 2

    await waitFor(() => expect(columns()).toEqual([2, 3, 4]));
  });

  it('stops at the end of the list rather than scrolling past it', async () => {
    // Bill 5 of 5 cannot have two more to its right. The window stops, and the chosen
    // bill is simply the last column instead of the first — visible either way, which
    // is the promise the tab strip makes.
    const user = userEvent.setup();
    await open(user, 5);
    const tabs = within(screen.getByRole('navigation', { name: 'Open bills' }));
    await user.click(tabs.getAllByRole('button', { name: /^New bill/ })[0]!); // bill 1
    await waitFor(() => expect(columns()).toEqual([1, 2, 3]));

    await user.click(tabs.getAllByRole('button', { name: /^New bill/ })[4]!); // bill 5

    await waitFor(() => expect(columns()).toEqual([3, 4, 5]));
  });

  it('shows one bill full width rather than two empty columns', () => {
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    expect(screen.getAllByRole('region')).toHaveLength(1);
  });

  it('gives every bill its own four actions', async () => {
    const user = userEvent.setup();
    await open(user, 3);
    // Three columns, three sets. Each acts on its own bill — which is the whole point
    // of the split, and is why they are not a single set above the columns.
    expect(screen.getAllByRole('button', { name: /Print Bill/ })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: /Credit Bill/ })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: /Save a Draft/ })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: /Clear Draft/ })).toHaveLength(3);
  });

  it('puts the advance where the shop name used to be, once per bill', async () => {
    const user = userEvent.setup();
    await open(user, 3);
    expect(screen.getAllByLabelText(/Advance Received/)).toHaveLength(3);
    // And the shop's heading is drawn once, above the columns — not three times.
    expect(bill(0).queryByRole('heading')).not.toBeInTheDocument();
  });

  it('names each tab by its position and whoever the bill is for', async () => {
    // "like while I create I will keep the customer name with bill number on the area".
    const user = userEvent.setup();
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);

    await user.type(bill(0).getByLabelText(/Customer Name/), 'Anas');
    // Persisted on blur, which is also when the cashier moves on from the field.
    await user.tab();

    const tabs = within(screen.getByRole('navigation', { name: 'Open bills' }));
    await waitFor(() => {
      expect(tabs.getByRole('button', { name: 'Anas' })).toBeInTheDocument();
    });
    // The number is beside it, as decoration rather than part of the name: two tabs
    // differing only by a digit read badly, and the name is what anyone says out loud.
    expect(tabs.getByText('1')).toBeInTheDocument();
  });
});

/**
 * What a bill keeps while it is off screen (reported 2026-11-08).
 *
 * Only three bills are rendered at a time, so the other twelve are **unmounted** — and
 * anything held as component state inside a column went with it. The cashier's report
 * was "I update a bill, make a few more, come back and it has reset".
 *
 * Nothing was ever lost from the bill itself: every field persists to Dexie on blur and
 * `drafts` still held it. What was lost was what the screen *showed* and the screen's
 * own working state, which is worse than it sounds — a cashier who sees an empty
 * Customer Name believes the bill is empty and types it again.
 */
describe('a bill keeps what is on it while it is off screen', () => {
  async function fiveBills(user: ReturnType<typeof userEvent.setup>) {
    useBillingStore.setState({ maxOpenDrafts: 8 });
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    for (let n = 2; n <= 5; n += 1) {
      await user.click(screen.getByRole('button', { name: 'Start a new bill' }));
      await waitFor(() => expect(useBillingStore.getState().drafts).toHaveLength(n));
    }
  }

  function tab(position: number) {
    const tabs = within(screen.getByRole('navigation', { name: 'Open bills' }));
    return tabs.getAllByRole('button', { name: /^(New bill|Anas|Rakesh)/ })[
      position - 1
    ]!;
  }

  it('shows the customer name again after the bill scrolls out and back', async () => {
    const user = userEvent.setup();
    await fiveBills(user); // showing 3 · 4 · 5; bills 1 and 2 are unmounted

    // Go to bill 1, type a customer, and move on so it is committed.
    await user.click(tab(1));
    await waitFor(() => expect(screen.getAllByRole('region')).toHaveLength(3));
    await user.type(bill(0).getByLabelText(/Customer Name/), 'Anas');
    await user.tab();
    await waitFor(() =>
      expect(useBillingStore.getState().drafts[0]?.header.customer_name).toBe('Anas'),
    );

    // Scroll it off screen, then come back to it.
    await user.click(tab(3));
    await waitFor(() => expect(screen.getAllByRole('region')).toHaveLength(3));
    await user.click(tab(1));

    await waitFor(() =>
      expect(bill(0).getByLabelText(/Customer Name/)).toHaveValue('Anas'),
    );
  });

  it('keeps the vehicle and the mechanic too', async () => {
    const user = userEvent.setup();
    await fiveBills(user);
    await user.click(tab(1));
    await waitFor(() => expect(screen.getAllByRole('region')).toHaveLength(3));

    await user.type(bill(0).getByLabelText('Vehicle Number'), 'KA01AB1234');
    await user.type(bill(0).getByLabelText('Mechanic Name'), 'Ramesh');
    await user.tab();
    await waitFor(() =>
      expect(useBillingStore.getState().drafts[0]?.header.vehicle_number).toBe(
        'KA01AB1234',
      ),
    );

    await user.click(tab(4));
    await waitFor(() => expect(screen.getAllByRole('region')).toHaveLength(3));
    await user.click(tab(1));

    await waitFor(() =>
      expect(bill(0).getByLabelText('Vehicle Number')).toHaveValue('KA01AB1234'),
    );
    expect(bill(0).getByLabelText('Mechanic Name')).toHaveValue('Ramesh');
  });

  it('keeps the advance typed on a bill that scrolls away', async () => {
    // An advance is not part of the draft — it is taken at finalisation — so it lives
    // on the screen. It still belongs to **one** bill, and it has to be there when the
    // cashier comes back to press Credit Bill.
    const user = userEvent.setup();
    await fiveBills(user);
    await user.click(tab(1));
    await waitFor(() => expect(screen.getAllByRole('region')).toHaveLength(3));

    await user.type(bill(0).getByLabelText(/Advance Received/), '500');

    await user.click(tab(3));
    await waitFor(() => expect(screen.getAllByRole('region')).toHaveLength(3));
    await user.click(tab(1));

    await waitFor(() =>
      expect(bill(0).getByLabelText(/Advance Received/)).toHaveValue('500'),
    );
  });

  it('never carries one bill’s advance onto another', async () => {
    // The other half of the same rule, and the one that would cost money: an advance
    // belongs to the bill it was taken on and to no other.
    const user = userEvent.setup();
    await fiveBills(user);
    await user.click(tab(1));
    await waitFor(() => expect(screen.getAllByRole('region')).toHaveLength(3));

    await user.type(bill(0).getByLabelText(/Advance Received/), '500');

    expect(bill(1).getByLabelText(/Advance Received/)).toHaveValue('');
    expect(bill(2).getByLabelText(/Advance Received/)).toHaveValue('');
  });
});

describe('bill tabs behave like browser tabs', () => {
  it('names a new tab "New bill" until its first product names it', async () => {
    mocks.search.mockResolvedValue({ items: [PRODUCT], page: {} });
    const user = userEvent.setup();
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);

    const tabs = within(screen.getByRole('navigation', { name: 'Open bills' }));
    expect(tabs.getByRole('button', { name: 'New bill' })).toBeInTheDocument();

    await addFirstProduct(user);

    // Renamed to the product, which is what the owner asked for.
    await waitFor(() => {
      expect(tabs.getByRole('button', { name: 'AXEL PACKING' })).toBeInTheDocument();
    });
  });

  it('gives two bills starting with the same product distinguishable names', async () => {
    // A shop sells four of the same clutch plate in a morning. Two tabs reading
    // `AXEL PACKING` would be a coin flip for the cashier deciding which to finalise, so
    // the second is suffixed — display only, nothing about the bill changes.
    mocks.search.mockResolvedValue({ items: [PRODUCT], page: {} });
    const user = userEvent.setup();
    useBillingStore.setState({ maxOpenDrafts: 4 });
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);

    await addFirstProduct(user);
    await newBill(user, 2);
    // The second bill opens as the second column, so that is where the next part goes.
    await addFirstProduct(user, 1, 'axel', 1);

    const tabs = within(screen.getByRole('navigation', { name: 'Open bills' }));
    await waitFor(() => {
      expect(tabs.getByRole('button', { name: 'AXEL PACKING (2)' })).toBeInTheDocument();
    });
  });

  it('keeps each tab’s items independent', async () => {
    // One mock returning **both** products, and each is picked by name.
    //
    // `mockResolvedValueOnce` was wrong here and intermittently so: the cell debounces
    // ~120 ms and `user.type` sends a keystroke at a time, so the number of searches per
    // word is a timing detail. Which product the "once" applied to therefore varied, and
    // the test failed on whichever run coalesced differently. Picking by name asserts the
    // thing that matters — these two tabs hold two different bills — without depending on
    // how many times the box was queried.
    mocks.search.mockResolvedValue({ items: [PRODUCT, SECOND_PRODUCT], page: {} });
    const user = userEvent.setup();
    useBillingStore.setState({ maxOpenDrafts: 4 });
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);

    async function pick(name: string, column = 0): Promise<void> {
      await user.type(bill(column).getByLabelText('Item, row 1'), 'a');
      await screen.findByRole('listbox');
      await user.click(bill(column).getByRole('button', { name: new RegExp(name) }));
    }

    await pick('AXEL PACKING');
    const first = useBillingStore.getState().activeDraftId;
    await waitFor(() => {
      expect(
        useBillingStore.getState().drafts.find((d) => d.id === first)?.lines,
      ).toHaveLength(1);
    });

    await newBill(user, 2);
    await pick('11L LE MAX', 1);
    const second = useBillingStore.getState().activeDraftId;
    await waitFor(() => {
      expect(
        useBillingStore.getState().drafts.find((d) => d.id === second)?.lines,
      ).toHaveLength(1);
    });

    expect(first).not.toBe(second);
    const drafts = useBillingStore.getState().drafts;
    // Different products: switching tabs must not mix one bill's items into another.
    expect(drafts.find((d) => d.id === first)?.lines[0]?.product_id).toBe('p1');
    expect(drafts.find((d) => d.id === second)?.lines[0]?.product_id).toBe('p2');
  });

  it('closes an empty tab straight away', async () => {
    const user = userEvent.setup();
    useBillingStore.setState({ maxOpenDrafts: 4 });
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    await user.click(screen.getByRole('button', { name: 'Start a new bill' }));
    await waitFor(() => expect(useBillingStore.getState().drafts).toHaveLength(2));

    const tabs = within(screen.getByRole('navigation', { name: 'Open bills' }));
    await user.click(tabs.getAllByRole('button', { name: /^Close / })[1]!);

    await waitFor(() => expect(useBillingStore.getState().drafts).toHaveLength(1));
  });

  it('warns before closing a tab that has items, and offers to save it', async () => {
    // §5 rule 18: no draft is ever auto-closed or silently discarded. A cashier who
    // loses a half-typed bill to a stray click stops trusting the system.
    mocks.search.mockResolvedValue({ items: [PRODUCT], page: {} });
    const user = userEvent.setup();
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    await addFirstProduct(user);

    const tabs = within(screen.getByRole('navigation', { name: 'Open bills' }));
    await user.click(tabs.getAllByRole('button', { name: /^Close / })[0]!);

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/Save it as a draft/);
    // Still there — nothing was discarded by opening the warning.
    expect(useBillingStore.getState().drafts).toHaveLength(1);
  });
});

describe('accessibility', () => {
  it('has no axe violations', async () => {
    const { container } = render(
      <BillingCounter policy={POLICY} online canBill canOverridePrice />,
    );

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
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
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

    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
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

    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
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
  /**
   * How long to wait for a result that is behind the customer search's debounce.
   *
   * `CustomerPicker` waits 250 ms after the last keystroke before it searches, so an
   * assertion on a match needs that, plus the mocked promise, plus a React render.
   * Testing Library's default `findBy` patience is 1000 ms, which leaves roughly 700 ms
   * of headroom — enough when this file runs alone, and **not** enough when twenty test
   * files share the machine. These three tests failed only in a full run, which is the
   * signature of a timing race rather than a defect, and they passed in isolation every
   * time.
   *
   * This widens the window; it weakens nothing. The match must still appear, still be a
   * button, and still carry the customer's name — a test that waits longer for the
   * right answer is not a test that accepts a wrong one. Raising the floor is also
   * preferable to shortening the debounce, which exists so that typing a name does not
   * fire a request per keystroke at the counter.
   */
  const AFTER_DEBOUNCE = { timeout: 4000 };

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

  it('does not pull the caret out of the customer name the cashier is typing', async () => {
    /**
     * A real defect, found by this suite failing in a different place on each run.
     *
     * `FR-BILL-001` focuses row 1's Item cell when the screen is ready, on a
     * `requestAnimationFrame`, and `store.ready` flips only after the open bills have
     * been read out of Dexie. A cashier who clicked `Customer Name` and started typing
     * inside that window had the caret dragged into the grid mid-word — so the
     * customer's name was typed into the **product search** and the customer field was
     * left empty. The diagnostic that caught it showed exactly that: `rakesh` sitting in
     * the item cell.
     *
     * The automatic focus now yields to a field in use. The deliberate hand-off after
     * adding a product does not, and `moves to the next row after a product is picked`
     * is the test that holds that line.
     */
    const user = userEvent.setup();

    /**
     * The frame is **held**, not awaited.
     *
     * The race is "the frame lands while the cashier is mid-word", and a window that is
     * ~16 ms wide in jsdom cannot be hit by waiting: typing six characters takes longer
     * than that, so the steal had already happened and been harmless before the
     * assertion looked. Capturing the callbacks and running them at the chosen moment
     * reproduces the ordering exactly — and was verified to fail when the guard is
     * removed, which the earlier timing-based version of this test did not.
     */
    const frames: FrameRequestCallback[] = [];
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      });

    try {
      render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);

      const field = screen.getByLabelText(/Customer Name/);
      field.focus();
      await user.type(field, 'Sukith');

      // Now the frame arrives. This is the instant focus used to be taken away.
      // Wrapped in `act` because running the callbacks can set state.
      act(() => {
        for (const frame of frames.splice(0)) frame(performance.now());
      });

      expect(document.activeElement).toBe(field);
      expect((field as HTMLInputElement).value).toBe('Sukith');
      // And the name went nowhere near the catalogue search.
      expect(screen.getByLabelText('Item, row 1')).toHaveValue('');
    } finally {
      raf.mockRestore();
    }
  });

  it('attaches the saved customer id to the draft when one is chosen', async () => {
    const user = userEvent.setup();
    mocks.customerSearch.mockResolvedValue({ items: [SAVED], page: {} });
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);

    await user.type(screen.getByLabelText(/Customer Name/), 'rakesh');
    await user.click(
      await screen.findByRole('button', { name: /Rakesh Motors/ }, AFTER_DEBOUNCE),
    );

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
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);

    await user.type(screen.getByLabelText(/Customer Name/), 'rakesh');
    await user.click(
      await screen.findByRole('button', { name: /Rakesh Motors/ }, AFTER_DEBOUNCE),
    );

    await waitFor(() => {
      const draft = useBillingStore.getState().drafts[0];
      expect(draft?.header.customer_name).toBe('Rakesh Motors');
      expect(draft?.header.phone).toBe('9876500011');
      expect(draft?.header.vehicle_number).toBe('KA01AB1234');
    });
    // And it says who the bill is for, rather than leaving the cashier to infer it.
    // In the spreadsheet header that is the name shown under the `Customer Name` label,
    // where the search box was.
    expect(await bill().findByText('Rakesh Motors')).toBeInTheDocument();
  });

  it('lets the customer be changed again, keeping the typed snapshot', async () => {
    const user = userEvent.setup();
    mocks.customerSearch.mockResolvedValue({ items: [SAVED], page: {} });
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    await user.type(screen.getByLabelText(/Customer Name/), 'rakesh');
    await user.click(
      await screen.findByRole('button', { name: /Rakesh Motors/ }, AFTER_DEBOUNCE),
    );
    await bill().findByText('Rakesh Motors');

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
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);

    await user.type(screen.getByLabelText(/Customer Name/), 'Sukith');
    await user.click(
      await screen.findByRole(
        'button',
        { name: /Save as a new customer/ },
        AFTER_DEBOUNCE,
      ),
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
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);

    await user.type(screen.getByLabelText(/Customer Name/), 'Sukith');
    await user.click(
      await screen.findByRole(
        'button',
        { name: /Save as a new customer/ },
        AFTER_DEBOUNCE,
      ),
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
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    await addLine();

    await user.type(screen.getByLabelText(/Customer Name/), 'rakesh');
    await user.click(
      await screen.findByRole('button', { name: /Rakesh Motors/ }, AFTER_DEBOUNCE),
    );
    await bill().findByText('Rakesh Motors');

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

  it('the packing tick actually sticks, through the real draft store', async () => {
    /**
     * A **real-wiring** test, not a mocked one.
     *
     * `counterAdditions.test.tsx` asserts that `BillGrid` calls `onChangeLine` — which
     * it does, and which told us nothing about whether the tick survives the round trip
     * through the Zustand store and Dexie. A real browser found that it did not: the
     * controlled checkbox snapped straight back to unchecked. This suite drives the real
     * store, so it is the right place to pin it.
     */
    const user = userEvent.setup();
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    await addLine();

    const tick = await screen.findByRole('checkbox', { name: /has been brought/ });
    expect(tick).not.toBeChecked();

    await user.click(tick);

    await waitFor(() => expect(tick).toBeChecked());
    // And it is on the persisted draft, not only in the DOM.
    await waitFor(() =>
      expect(useBillingStore.getState().drafts[0]?.lines[0]?.collected).toBe(true),
    );
  });

  // --- the optional advance on a credit bill (owner request, 2026-11-07) -------

  /**
   * An advance is a **real payment against the new invoice**, taken in the same
   * transaction as the sale. The assertions that matter are that it does not become a
   * discount, and that leaving it blank changes nothing about the existing request.
   */
  async function creditWithCustomer(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<void> {
    mocks.customerSearch.mockResolvedValue({ items: [SAVED], page: {} });
    mocks.draftUpsert.mockResolvedValue({ version: 1 });
    mocks.finalize.mockRejectedValue(new Error('stop after the request'));
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    await addLine();
    await user.type(screen.getByLabelText(/Customer Name/), 'rakesh');
    await user.click(
      await screen.findByRole('button', { name: /Rakesh Motors/ }, AFTER_DEBOUNCE),
    );
    await bill().findByText('Rakesh Motors');
  }

  it('sends no payment at all when no advance is entered', async () => {
    // Zero advance must behave exactly like the credit bill always did.
    const user = userEvent.setup();
    await creditWithCustomer(user);

    await user.click(screen.getByRole('button', { name: /Credit Bill/ }));

    await waitFor(() => expect(mocks.finalize).toHaveBeenCalled());
    const body = mocks.finalize.mock.calls[0]?.[0] as { payment?: unknown };
    expect(body.payment ?? null).toBeNull();
  });

  it('sends the advance as a payment, and leaves the bill total alone', async () => {
    const user = userEvent.setup();
    await creditWithCustomer(user);

    await user.type(screen.getByLabelText(/Advance Received/), '40');
    await user.click(screen.getByRole('button', { name: /Credit Bill/ }));

    await waitFor(() => expect(mocks.finalize).toHaveBeenCalled());
    const body = mocks.finalize.mock.calls[0]?.[0] as {
      payment?: { method: string; amount: string };
      lines?: { quantity: string; unit_price: string }[];
      invoice_discount?: unknown;
    };
    expect(body.payment).toEqual({ method: 'cash', amount: '40.00' });
    // Emphatically **not** a discount: the lines are untouched and no invoice discount
    // is sent, so the server's total is unchanged and the advance only moves
    // `amount_paid`.
    expect(body.invoice_discount ?? null).toBeNull();
    // The catalogue price the line was added at, unchanged by the advance.
    expect(body.lines?.[0]?.unit_price).toBe('880.0000');
  });

  it('treats a zero or blank advance as no advance', async () => {
    const user = userEvent.setup();
    await creditWithCustomer(user);

    await user.type(screen.getByLabelText(/Advance Received/), '0');
    await user.click(screen.getByRole('button', { name: /Credit Bill/ }));

    await waitFor(() => expect(mocks.finalize).toHaveBeenCalled());
    const body = mocks.finalize.mock.calls[0]?.[0] as { payment?: unknown };
    // `{amount: "0"}` would be refused by the server ("must be greater than zero"), so
    // the key is omitted entirely rather than sent as a zero.
    expect(body.payment ?? null).toBeNull();
  });

  it('carries the chosen advance method', async () => {
    const user = userEvent.setup();
    await creditWithCustomer(user);

    await user.type(screen.getByLabelText(/Advance Received/), '40');
    await user.selectOptions(screen.getByLabelText('Paid by'), 'upi');
    await user.click(screen.getByRole('button', { name: /Credit Bill/ }));

    await waitFor(() => expect(mocks.finalize).toHaveBeenCalled());
    const body = mocks.finalize.mock.calls[0]?.[0] as { payment?: { method: string } };
    expect(body.payment?.method).toBe('upi');
  });

  it('spells out the arithmetic so the advance is not read as a discount', async () => {
    const user = userEvent.setup();
    await creditWithCustomer(user);

    await user.type(screen.getByLabelText(/Advance Received/), '40');

    expect(await screen.findByText(/The bill total stays/)).toBeInTheDocument();
  });

  it('does not offer a payment method until there is an advance', async () => {
    const user = userEvent.setup();
    await creditWithCustomer(user);

    expect(screen.queryByLabelText('Paid by')).not.toBeInTheDocument();
  });

  it('leaves an over-the-total advance for the server to refuse', async () => {
    // Clamping it client-side would hide a typo. The server owns the rule and says
    // "That is more than the bill total".
    const user = userEvent.setup();
    await creditWithCustomer(user);

    await user.type(screen.getByLabelText(/Advance Received/), '99999');
    await user.click(screen.getByRole('button', { name: /Credit Bill/ }));

    await waitFor(() => expect(mocks.finalize).toHaveBeenCalled());
    const body = mocks.finalize.mock.calls[0]?.[0] as { payment?: { amount: string } };
    expect(body.payment?.amount).toBe('99999.00');
  });

  it('offers "save as a new customer" even when something matched (two people share a name)', async () => {
    // The action used to appear only on an empty result set. So a near-match blocked it
    // outright: a shop that already has a "Rakesh Motors" could not add a second,
    // different one from the billing screen — the matches showed, none was the right
    // person, and the only way forward was abandoning the bill. Two customers may
    // genuinely share a name, and the cashier can see which person is standing there.
    const user = userEvent.setup();
    mocks.customerSearch.mockResolvedValue({ items: [SAVED], page: {} });
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);

    await user.type(screen.getByLabelText(/Customer Name/), 'rakesh');

    // The match is offered...
    expect(
      await screen.findByRole('button', { name: /Rakesh Motors/ }, AFTER_DEBOUNCE),
    ).toBeInTheDocument();
    // ...and so is creating a new one.
    expect(
      await screen.findByRole(
        'button',
        { name: /Save as a new customer/ },
        AFTER_DEBOUNCE,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Not the right person/)).toBeInTheDocument();
  });

  it('still refuses a credit bill with only a typed name', async () => {
    // The guard stays. The picker gives it something to be satisfied by; it does not
    // weaken it.
    const user = userEvent.setup();
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    await addLine();

    await user.click(screen.getByRole('button', { name: /Credit Bill/ }));

    expect(await screen.findByText(/needs a saved customer/)).toBeInTheDocument();
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it('needs no customer for a cash bill', async () => {
    const user = userEvent.setup();
    mocks.draftUpsert.mockResolvedValue({ version: 1 });
    mocks.finalize.mockRejectedValue(new Error('stop after the request'));
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    await addLine();

    await user.click(screen.getByRole('button', { name: /Print Bill/ }));

    await waitFor(() => expect(mocks.finalize).toHaveBeenCalled());
    const body = mocks.finalize.mock.calls[0]?.[0] as { customer?: { mode: string } };
    expect(body.customer?.mode).toBe('none');
  });
});

/**
 * The keyboard remediation of 2 November 2026.
 *
 * The cashier's report was precise: choose a customer, press Tab or Enter, and focus does
 * not reach Mechanic Name — the touchpad becomes compulsory. Two separate defects sat
 * behind it, and each has a test here that fails without its fix:
 *
 * 1. **The customer list could not be driven by the keyboard at all.** Its options were
 *    `<button onMouseDown=...>`, and a keyboard press fires `click`, never `mousedown`.
 *    So `Enter` on a focused suggestion genuinely did nothing, and there was no arrow
 *    navigation to reach one in the first place.
 * 2. **Focus was destroyed by the selection itself.** Choosing a customer replaces the
 *    search box with the chosen name and a `Change` button. The focused node is unmounted
 *    by that render, and a browser whose focused element disappears moves focus to
 *    `<body>` — so the next `Tab` restarted from the top of the document.
 */
describe('keyboard: the customer box (the reported defect)', () => {
  /**
   * Local fixtures rather than the ones inside `the customer picker` describe above.
   *
   * Those are scoped to that block, and widening their scope would mean editing a
   * passing suite to suit a new one — a change with no upside and a real chance of
   * disturbing coverage that already works. Duplicating two small constants is the
   * cheaper trade.
   */
  const WAIT = { timeout: 4000 };
  const BASE = {
    business_name: null,
    primary_phone: '9876500011',
    phones: ['9876500011'],
    vehicles: [],
    address_lines: [],
    default_mechanic_name: null,
    credit_terms_days: 30,
    credit_limit: '50000.00',
    is_active: true,
  };

  const MATCHES = [
    { ...BASE, id: 'c-1', name: 'Rakesh Motors' },
    { ...BASE, id: 'c-2', name: 'Rakesh Transport' },
    { ...BASE, id: 'c-3', name: 'Rakesh Auto' },
  ];

  async function openList(user: ReturnType<typeof userEvent.setup>) {
    mocks.customerSearch.mockResolvedValue({ items: MATCHES, page: {} });
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);
    const field = screen.getByLabelText(/Customer Name/);
    await user.click(field);
    await user.keyboard('rakesh');
    await screen.findByRole('listbox', {}, WAIT);

    // Wait until the search for the **whole** term has landed.
    //
    // The box debounces ~250 ms and resets the highlight to 0 on every result set. Under
    // full-suite load the six keystrokes take longer than that, so a search for an early
    // prefix (`rak`) opens the list, a test moves the highlight, and *then* the search
    // for `rakesh` lands and resets it — after which `Enter` or `Tab` picks the wrong
    // match. It failed about one run in four, always on the match's name, while the
    // behaviour was correct every time.
    //
    // Timers are cancelled on each keystroke, so once a search for the full term has
    // been issued no later one can arrive. Waiting for that makes the highlight stable.
    await waitFor(
      () => expect(mocks.customerSearch).toHaveBeenLastCalledWith('rakesh'),
      WAIT,
    );
    return field;
  }

  it('walks the matches with the arrow keys', async () => {
    const user = userEvent.setup();
    await openList(user);

    const options = () => screen.getAllByRole('option');
    // The first match is highlighted to begin with, so Enter always has a target.
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowDown}');
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}');
    expect(options()[2]).toHaveAttribute('aria-selected', 'true');
    // It stops at the end rather than wrapping, like the product cell.
    await user.keyboard('{ArrowDown}');
    expect(options()[2]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowUp}');
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('attaches the highlighted customer when Enter is pressed', async () => {
    // The headline. Before the fix this did nothing whatsoever.
    const user = userEvent.setup();
    await openList(user);

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(useBillingStore.getState().drafts[0]?.header.customer_id).toBe('c-2'),
    );
    expect(bill().getByText('Rakesh Transport')).toBeInTheDocument();
  });

  it('moves focus to Mechanic Name once a customer is chosen', async () => {
    /**
     * The other half of the report. The search box is unmounted by the selection, so
     * without a deliberate hand-off focus lands on `<body>` and the next Tab starts from
     * the top of the page.
     */
    const user = userEvent.setup();
    await openList(user);

    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText(/Mechanic Name/)),
    );
  });

  it('moves to Mechanic Name on Enter even when no list is open', async () => {
    // A walk-in with no saved record: the cashier types a name and carries on. Enter
    // must not sit there doing nothing, and must not reach a finalisation.
    const user = userEvent.setup();
    mocks.customerSearch.mockResolvedValue({ items: [], page: {} });
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);

    const field = screen.getByLabelText(/Customer Name/);
    await user.click(field);
    await user.keyboard('A walk-in{Enter}');

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText(/Mechanic Name/)),
    );
    expect(mocks.finalize).not.toHaveBeenCalled();
    // And the typed name was kept — moving focus fires the blur that persists it.
    await waitFor(() =>
      expect(useBillingStore.getState().drafts[0]?.header.customer_name).toBe(
        'A walk-in',
      ),
    );
  });

  it('closes the list on Escape and keeps what was typed', async () => {
    const user = userEvent.setup();
    const field = await openList(user);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    // Mid-word is the normal case; a key that discarded the typing would be worse than
    // one that did nothing.
    expect(field).toHaveValue('rakesh');
    expect(document.activeElement).toBe(field);
  });

  it('does not make the matches tab stops', async () => {
    /**
     * With ten matches open, `Tab` used to walk through ten buttons before reaching
     * Mechanic Name — and each one did nothing when pressed. Focus belongs in the box;
     * the arrows walk the list.
     *
     * `Tab` now **picks** the highlighted match as well (the owner asked for Enter, Tab
     * and mouse), so the list is gone by the time focus settles. That is a stronger
     * version of the original guarantee rather than a weaker one: there is no option
     * left to focus at all. The assertion below therefore checks that nothing in the
     * document is one of those option buttons, which holds whether the list closed or
     * merely stayed unfocused.
     */
    const user = userEvent.setup();
    const field = await openList(user);
    expect(document.activeElement).toBe(field);

    await user.tab();

    for (const option of screen.queryAllByRole('option')) {
      expect(option.querySelector('button')).not.toBe(document.activeElement);
    }
    // Focus left the search box rather than landing on the list container, which is the
    // Chromium scrollable-container trap the `tabIndex={-1}` above exists to avoid.
    expect(document.activeElement).not.toBe(screen.queryByRole('listbox'));
  });

  it('picks the highlighted match on Tab, and moves on', async () => {
    // The owner asked for Enter, Tab and the mouse to all select a suggestion.
    const user = userEvent.setup();
    await openList(user);

    await user.keyboard('{ArrowDown}');
    // Waited for rather than assumed. Pressing Tab immediately after ArrowDown raced a
    // re-render under full-suite load and picked whichever match the highlight happened
    // to be on, which made this test fail about one run in five while the behaviour was
    // correct every time.
    await waitFor(() =>
      expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true'),
    );

    await user.tab();

    // Waited for the **committed** state, not for the name to appear.
    //
    // Attaching a customer replaces the search box with a name plus a `Change` button,
    // and that swap is the only reliable signal that `attach` actually ran. Querying for
    // the name alone also matches it while it is still only text in the search input, so
    // under full-suite load this timed out at 4s against a component that was mid-swap.
    expect(
      await screen.findByRole('button', { name: BILLING.changeCustomer }, WAIT),
    ).toBeInTheDocument();

    // `MATCHES[1]` was highlighted, so it is the one that got attached.
    expect(bill().getByText(MATCHES[1]!.name)).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('does not overwrite the picked customer\u2019s name with the typed text', async () => {
    /**
     * The defect behind a one-in-four "flake" on the Tab test.
     *
     * `Tab` picks the suggestion **and** moves focus, which fires the search box's
     * `blur` \u2014 and `blur` persists the typed text as the bill's customer name. So the
     * bill ended up with the right `customer_id` and the wrong name: `rakesh` instead of
     * `Rakesh Transport`. `Enter` never showed it (it calls `preventDefault`, so no blur)
     * and the mouse never showed it (`onMouseDown` is cancelled).
     *
     * Asserted on the **store**, not the DOM, because the store is what a credit bill
     * and the printed snapshot are built from.
     */
    const user = userEvent.setup();
    await openList(user);

    await user.keyboard('{ArrowDown}');
    await waitFor(() =>
      expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true'),
    );
    await user.tab();

    await waitFor(() =>
      expect(useBillingStore.getState().drafts[0]?.header.customer_id).toBe('c-2'),
    );
    // The customer's own name, not the fragment that was typed to find them.
    expect(useBillingStore.getState().drafts[0]?.header.customer_name).toBe(
      'Rakesh Transport',
    );
  });

  it('lets the keyboard reach and press "save as a new customer"', async () => {
    // Also `onMouseDown`-only before, so a keyboard user could focus it and press Enter
    // to no effect.
    const user = userEvent.setup();
    mocks.customerSearch.mockResolvedValue({ items: [], page: {} });
    mocks.customerUpsert.mockResolvedValue({
      customer: { ...BASE, id: 'created-1', name: 'Sukith' },
      created: true,
      warnings: [],
    });
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);

    await user.click(screen.getByLabelText(/Customer Name/));
    await user.keyboard('Sukith');
    const save = await screen.findByRole(
      'button',
      { name: /Save as a new customer/ },
      WAIT,
    );

    save.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(mocks.customerUpsert).toHaveBeenCalled());
    await waitFor(() =>
      expect(useBillingStore.getState().drafts[0]?.header.customer_id).toBe('created-1'),
    );
  });

  it('returns focus to the search box when the customer is changed', async () => {
    // The same unmount trap in the other direction: pressing `Change` removes the button
    // that was focused.
    const user = userEvent.setup();
    await openList(user);
    await user.keyboard('{Enter}');
    await bill().findByText('Rakesh Motors');

    const change = screen.getByRole('button', { name: /Change/ });
    change.focus();
    await user.keyboard('{Enter}');

    // Wait for the search box to come back before asserting where focus is. The box
    // returns only once the draft store has committed through Dexie, which under a
    // parallel test run is slower than the assertion's default patience — waiting for
    // the precondition separately tests the behaviour instead of the test runner.
    const search = await screen.findByLabelText(/Customer Name/, {}, WAIT);
    await waitFor(() => expect(document.activeElement).toBe(search), WAIT);
  });

  it('declares the combobox contract so the matches are announced', async () => {
    const user = userEvent.setup();
    const field = await openList(user);

    expect(field).toHaveAttribute('role', 'combobox');
    expect(field).toHaveAttribute('aria-expanded', 'true');
    expect(field).toHaveAttribute('aria-autocomplete', 'list');
    // Reports the highlighted option while focus stays in the box, which is what lets
    // the options stay out of the tab order.
    const active = field.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    expect(document.getElementById(active!)).toHaveAttribute('aria-selected', 'true');
  });
});

describe('keyboard: the bill header carries on to the grid', () => {
  it('Enter moves Mechanic Name to Vehicle Number, and Vehicle Number to the first item', async () => {
    // The header is the one place `Enter` did nothing, which made it the odd one out on
    // a screen where Enter means "next" everywhere else.
    const user = userEvent.setup();
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);

    const mechanic = screen.getByLabelText(/Mechanic Name/);
    mechanic.focus();
    await user.keyboard('Ravi{Enter}');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText(/Vehicle Number/)),
    );

    await user.keyboard('KA01AB1234{Enter}');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('Item, row 1')),
    );
  });

  it('leaves the arrow keys to the text they are editing', async () => {
    // Moving the caret is what the arrows are for in a field holding a registration
    // number. A header that stole them would be a worse bug than the one being fixed.
    const user = userEvent.setup();
    render(<BillingCounter policy={POLICY} online canBill canOverridePrice />);

    const vehicle = screen.getByLabelText<HTMLInputElement>(/Vehicle Number/);
    vehicle.focus();
    await user.keyboard('KA01');
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    await user.keyboard('X');

    // Caret ends after `KA01`, two lefts put it between `KA` and `01`, so the `X` lands
    // there. The point is that the arrows moved the caret rather than being swallowed.
    expect(vehicle).toHaveValue('KAX01');
    expect(document.activeElement).toBe(vehicle);
  });
});

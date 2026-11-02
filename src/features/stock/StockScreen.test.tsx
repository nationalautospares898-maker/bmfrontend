/**
 * The Stock screen, rendered.
 *
 * The assertions are the rules that are easy to break by editing a component, and each
 * one would be invisible until it caused harm:
 *
 * - **there is no way to set a quantity** (FR-INV-002). A "set to" field would let
 *   someone type over a discrepancy, and the discrepancy is the thing worth keeping;
 * - an adjustment **requires a reason** and the sign comes from the chosen reason, so
 *   the two cannot disagree;
 * - a missing reorder level is **not** rendered as zero;
 * - "running low" is words, not only a colour (NFR-FE-UX-007);
 * - the screen passes **axe**, because the owner may be using it on a cheap monitor
 *   with a keyboard.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StockScreen } from './StockScreen';

const balances = vi.fn();
const movements = vi.fn();
const adjust = vi.fn();
const saveStockEntries = vi.fn();
const resolveStockEntry = vi.fn();
const movementReport = vi.fn();

vi.mock('@/api/endpoints', () => ({
  inventory: {
    balances: (...args: unknown[]) => balances(...args) as unknown,
    movements: (...args: unknown[]) => movements(...args) as unknown,
    adjust: (...args: unknown[]) => adjust(...args) as unknown,
    saveStockEntries: (...args: unknown[]) => saveStockEntries(...args) as unknown,
    resolveStockEntry: (...args: unknown[]) => resolveStockEntry(...args) as unknown,
    movementReport: (...args: unknown[]) => movementReport(...args) as unknown,
  },
}));

/**
 * Wait for the list to load, then query **inside the table**.
 *
 * An item below its minimum now appears twice on this screen on purpose: once in the
 * Low Stock section at the top, which the owner asked for, and once in the table with a
 * `Running low` badge. So a bare `getByText('Tie Rod End Bolero')` is genuinely
 * ambiguous, and a test asserting "the stock *list* shows this item" should be looking in
 * the list rather than anywhere on the page.
 */
async function stockList(): Promise<HTMLElement> {
  return screen.findByRole('table', { name: /Stock on hand/i });
}

/** Wait until the rows have arrived, without caring where the name appears. */
async function loaded(name = 'Tie Rod End Bolero'): Promise<void> {
  await screen.findAllByText(name);
}

const ROWS = [
  {
    product_id: 'p1',
    name: 'Tie Rod End Bolero',
    quantity: '4.000',
    reorder_level: '10.000',
  },
  {
    product_id: 'p2',
    name: 'Oil Filter Scorpio',
    quantity: '42.000',
    // No reorder level set. Not the same as a level of zero.
    reorder_level: null,
  },
];

beforeEach(() => {
  balances.mockReset();
  movements.mockReset();
  adjust.mockReset();
  balances.mockResolvedValue({ items: ROWS, as_of: '2026-10-30T10:00:00Z' });
  movements.mockResolvedValue({ items: [], as_of: '2026-10-30T10:00:00Z' });
  adjust.mockResolvedValue({ movement_id: 'm1' });
  movementReport.mockReset();
  movementReport.mockResolvedValue({
    on_date: TODAY,
    kind: 'added',
    items: [],
    products: 0,
    total_quantity: '0',
    movements: 0,
    invoices: 0,
    truncated: false,
    as_of: '2026-11-02T10:00:00Z',
  });
});

/** A fixed business date — the screen takes it from the server, never a clock. */
const TODAY = '2026-11-02';

describe('the stock list', () => {
  it('shows each item with its quantity', async () => {
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    const list = within(await stockList());
    expect(list.getByText('Tie Rod End Bolero')).toBeInTheDocument();
    expect(list.getByText('4')).toBeInTheDocument();
  });

  it('marks a low item in words, not only in colour', async () => {
    // 4 on hand against a reorder level of 10.
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    const list = within(await stockList());
    expect(list.getByText('Running low')).toBeInTheDocument();
  });

  it('does not call an item low when it has no reorder level', async () => {
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    await loaded('Oil Filter Scorpio');
    // Exactly one badge — the first row's. A missing level must not be read as zero and
    // then compared against.
    const list = within(await stockList());
    expect(list.getAllByText('Running low')).toHaveLength(1);
  });

  it('shows "Not set" rather than 0 for a missing reorder level', async () => {
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    const list = within(await stockList());
    expect(list.getByText('Not set')).toBeInTheDocument();
  });

  it('asks the server for only low stock when the filter is pressed', async () => {
    const user = userEvent.setup();
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    await loaded();
    await user.click(screen.getByRole('button', { name: /Only what is running low/ }));
    await waitFor(() =>
      expect(balances).toHaveBeenLastCalledWith({ low_stock_only: true }),
    );
  });

  it('filters with the same normalisation as the counter search', async () => {
    // `tierod` must find `Tie Rod End` — a cashier should not have to learn that this
    // box behaves differently from the one they use all day.
    const user = userEvent.setup();
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    await loaded();
    await user.type(screen.getByLabelText('Find an item'), 'tierod');
    const list = within(await stockList());
    expect(list.queryByText('Oil Filter Scorpio')).not.toBeInTheDocument();
    expect(list.getByText('Tie Rod End Bolero')).toBeInTheDocument();
  });

  it('says which kind of empty it is', async () => {
    balances.mockResolvedValue({ items: [], as_of: '2026-10-30T10:00:00Z' });
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    expect(await screen.findByText(/No stock has been recorded yet/)).toBeInTheDocument();
  });
});

describe('FR-INV-002 — the ledger is the only writer', () => {
  it('offers no way to set a quantity', async () => {
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    await loaded();
    // The affordance is "Adjust", never "Set". A field that set a quantity directly
    // would bypass the movement ledger entirely.
    expect(screen.queryByLabelText(/^Set /i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Set\b/i })).not.toBeInTheDocument();
  });

  it('hides the adjust control without the permission', async () => {
    render(<StockScreen canAdjust={false} canAddStock={false} businessDate={TODAY} />);
    await loaded();
    expect(screen.queryByRole('button', { name: 'Adjust' })).not.toBeInTheDocument();
  });

  it('asks for a difference, not a new total', async () => {
    const user = userEvent.setup();
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    await loaded();
    await user.click(screen.getAllByRole('button', { name: 'Adjust' })[0]!);
    expect(screen.getByText('The difference, not the new total.')).toBeInTheDocument();
  });

  it('refuses an adjustment with no reason', async () => {
    const user = userEvent.setup();
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    await loaded();
    await user.click(screen.getAllByRole('button', { name: 'Adjust' })[0]!);
    await user.type(screen.getByLabelText('How many?'), '2');

    expect(
      screen.getByText('Say why. This is kept as a permanent record.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record the correction' })).toBeDisabled();
    expect(adjust).not.toHaveBeenCalled();
  });

  it('refuses an adjustment that would take stock below zero', async () => {
    const user = userEvent.setup();
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    await loaded();
    await user.click(screen.getAllByRole('button', { name: 'Adjust' })[0]!);
    // 4 on hand, decreasing by 9.
    await user.type(screen.getByLabelText('How many?'), '9');
    await user.type(screen.getByLabelText('Why?'), 'Counted the shelf');

    expect(screen.getByText(/below zero/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record the correction' })).toBeDisabled();
  });

  it('shows the resulting balance before committing', async () => {
    const user = userEvent.setup();
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    await loaded();
    await user.click(screen.getAllByRole('button', { name: 'Adjust' })[0]!);
    await user.type(screen.getByLabelText('How many?'), '1');
    await user.type(screen.getByLabelText('Why?'), 'One was broken');

    // 4 − 1. Shown because "decrease by 3" and "set to 3" are easy to confuse.
    //
    // A regex, because the label and the figure are deliberately separate elements —
    // the number is in a `<strong>` so it reads as the answer, which means no single
    // element holds the whole sentence.
    expect(screen.getByText(/In stock after this/)).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('sends a negative delta for a decrease, taking the sign from the reason', async () => {
    const user = userEvent.setup();
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    await loaded();
    await user.click(screen.getAllByRole('button', { name: 'Adjust' })[0]!);
    await user.type(screen.getByLabelText('How many?'), '2');
    await user.type(screen.getByLabelText('Why?'), 'Two missing from the box');
    await user.click(screen.getByRole('button', { name: 'Record the correction' }));

    await waitFor(() => expect(adjust).toHaveBeenCalled());
    const [body] = adjust.mock.calls[0] as [Record<string, string>, string];
    expect(body.quantity_delta).toBe('-2');
    expect(body.reason_code).toBe('adjustment_decrease');
    expect(body.reason_text).toBe('Two missing from the box');
  });

  it('sends a positive delta when the reason is an increase', async () => {
    const user = userEvent.setup();
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    await loaded();
    await user.click(screen.getAllByRole('button', { name: 'Adjust' })[0]!);
    await user.click(screen.getByLabelText('There is more than the system says'));
    await user.type(screen.getByLabelText('How many?'), '5');
    await user.type(screen.getByLabelText('Why?'), 'Found a box behind the counter');
    await user.click(screen.getByRole('button', { name: 'Record the correction' }));

    await waitFor(() => expect(adjust).toHaveBeenCalled());
    const [body] = adjust.mock.calls[0] as [Record<string, string>, string];
    expect(body.quantity_delta).toBe('5');
    expect(body.reason_code).toBe('adjustment_increase');
  });

  it('sends an idempotency key, so a retried adjustment cannot apply twice', async () => {
    const user = userEvent.setup();
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    await loaded();
    await user.click(screen.getAllByRole('button', { name: 'Adjust' })[0]!);
    await user.type(screen.getByLabelText('How many?'), '1');
    await user.type(screen.getByLabelText('Why?'), 'Broken in transit');
    await user.click(screen.getByRole('button', { name: 'Record the correction' }));

    await waitFor(() => expect(adjust).toHaveBeenCalled());
    const [, key] = adjust.mock.calls[0] as [unknown, string];
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('movement history', () => {
  it('shows the sign of each change, because the sign is the information', async () => {
    movements.mockResolvedValue({
      items: [
        {
          id: 'm1',
          product_id: 'p1',
          quantity_delta: '-2.000',
          balance_after: '4.000',
          reason: 'sale',
          source_type: 'invoice',
          source_id: 'i1',
          oversell_override: false,
          override_reason: null,
          created_at: '2026-10-30T09:00:00Z',
        },
        {
          id: 'm2',
          product_id: 'p1',
          quantity_delta: '6.000',
          balance_after: '6.000',
          reason: 'purchase_receipt',
          source_type: 'purchase',
          source_id: 'pu1',
          oversell_override: false,
          override_reason: null,
          created_at: '2026-10-29T09:00:00Z',
        },
      ],
      as_of: '2026-10-30T10:00:00Z',
    });
    const user = userEvent.setup();
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    await loaded();
    await user.click(screen.getAllByRole('button', { name: 'History' })[0]!);

    expect(await screen.findByText('-2')).toBeInTheDocument();
    // `+` is explicit: a bare `6` reads as a quantity, not as a change.
    expect(screen.getByText('+6')).toBeInTheDocument();
  });

  it('translates the reason into words a shopkeeper uses', async () => {
    movements.mockResolvedValue({
      items: [
        {
          id: 'm1',
          product_id: 'p1',
          quantity_delta: '-2.000',
          balance_after: '4.000',
          reason: 'purchase_receipt',
          source_type: 'purchase',
          source_id: 'pu1',
          oversell_override: false,
          override_reason: null,
          created_at: '2026-10-30T09:00:00Z',
        },
      ],
      as_of: '2026-10-30T10:00:00Z',
    });
    const user = userEvent.setup();
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    await loaded();
    await user.click(screen.getAllByRole('button', { name: 'History' })[0]!);

    // Not `purchase_receipt`. The data model's vocabulary is not the counter's.
    expect(await screen.findByText('Received from supplier')).toBeInTheDocument();
  });

  it('says so when nothing has moved', async () => {
    const user = userEvent.setup();
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    await loaded();
    await user.click(screen.getAllByRole('button', { name: 'History' })[0]!);
    expect(await screen.findByText(/Nothing has moved/)).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('has no axe violations', async () => {
    const { container } = render(
      <StockScreen canAdjust canAddStock businessDate={TODAY} />,
    );
    await loaded();
    const results = await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    });
    expect(results.violations).toEqual([]);
  });
});

/**
 * The report is an **addition** to this screen, so these check both halves: that it can
 * be opened and asks the server for the right day, and that opening it disturbs nothing
 * the screen already offered.
 */
describe('the stock movement report, alongside what was already here', () => {
  it('opens from the Stock page and asks for the business date', async () => {
    const user = userEvent.setup();
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Stock Movement Report' }));

    await waitFor(() => expect(movementReport).toHaveBeenCalled());
    expect(movementReport.mock.calls[0]?.[0]).toMatchObject({
      on_date: TODAY,
      kind: 'added',
    });
    expect(
      await screen.findByRole('region', { name: /Stock movement on one day/i }),
    ).toBeInTheDocument();
  });

  it('leaves every existing control exactly where it was', async () => {
    const user = userEvent.setup();
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Stock Movement Report' }));
    await screen.findByRole('region', { name: /Stock movement on one day/i });

    // Add Items, the filter, the low-stock toggle, Refresh and the stock table are all
    // still there, and so is the per-product History the report does not replace.
    expect(screen.getByRole('button', { name: 'Add Items' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Find an item/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Only what is running low/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(await stockList()).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'History' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Adjust' }).length).toBeGreaterThan(0);
  });

  it('closes again, leaving the screen as it was', async () => {
    const user = userEvent.setup();
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    await loaded();

    await user.click(screen.getByRole('button', { name: 'Stock Movement Report' }));
    await screen.findByRole('region', { name: /Stock movement on one day/i });
    await user.click(screen.getByRole('button', { name: 'Close report' }));

    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: /Stock movement on one day/i }),
      ).not.toBeInTheDocument(),
    );
    expect(await stockList()).toBeInTheDocument();
  });

  it('does not open by itself — the stock list is what the screen shows first', async () => {
    render(<StockScreen canAdjust canAddStock businessDate={TODAY} />);
    await loaded();
    expect(movementReport).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('region', { name: /Stock movement on one day/i }),
    ).not.toBeInTheDocument();
  });
});

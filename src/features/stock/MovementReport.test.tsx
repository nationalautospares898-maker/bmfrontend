/**
 * The day's stock movement report, rendered.
 *
 * This is a reporting screen, so the assertions are about **not misleading the owner**:
 *
 * - the figures on screen are the ones the server sent, in the right columns;
 * - the day it asks for is the **business** date, never the browser's;
 * - a slow answer to an old question cannot overwrite a newer one;
 * - an empty day says so, rather than showing a blank table that looks like a failure;
 * - a failure says so, rather than showing an empty table that looks like a quiet day.
 *
 * The last two are the pair that matters most: "nothing happened" and "we could not find
 * out" look identical if you render both as an empty table, and they lead the owner to
 * opposite conclusions.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/errors';
import { MovementReport } from './MovementReport';

const movementReport = vi.fn();

vi.mock('@/api/endpoints', () => ({
  inventory: {
    movementReport: (...args: unknown[]) => movementReport(...args) as unknown,
  },
}));

const TODAY = '2026-11-02';

/** One purchase receipt: four on the shelf, six delivered, ten after. */
const ADDED = {
  on_date: TODAY,
  kind: 'added',
  items: [
    {
      movement_id: 'm-1',
      product_id: 'p-1',
      product_name: 'Tie Rod End Bolero',
      sku: 'TT-1001-A',
      quantity: '6.000',
      stock_before: '4.000',
      stock_after: '10.000',
      reason: 'purchase_receipt',
      reference: 'ASD/2026/881',
      is_credit: null,
      invoice_cancelled: null,
      created_at: '2026-11-02T09:15:00Z',
    },
  ],
  products: 1,
  total_quantity: '6.000',
  movements: 1,
  invoices: 0,
  truncated: false,
  as_of: '2026-11-02T10:00:00Z',
};

/** Two deductions, one cash and one credit, from two different bills. */
const SOLD = {
  on_date: TODAY,
  kind: 'sold',
  items: [
    {
      movement_id: 'm-2',
      product_id: 'p-1',
      product_name: 'Tie Rod End Bolero',
      sku: 'TT-1001-A',
      quantity: '2.000',
      stock_before: '10.000',
      stock_after: '8.000',
      reason: 'sale',
      reference: 'NAS/2026-27/00007',
      is_credit: false,
      invoice_cancelled: false,
      created_at: '2026-11-02T11:00:00Z',
    },
    {
      movement_id: 'm-3',
      product_id: 'p-2',
      product_name: 'Oil Filter Scorpio',
      sku: 'OF-2001-B',
      quantity: '1.000',
      stock_before: '42.000',
      stock_after: '41.000',
      reason: 'sale',
      reference: 'NAS/2026-27/00008',
      is_credit: true,
      invoice_cancelled: false,
      created_at: '2026-11-02T11:30:00Z',
    },
  ],
  products: 2,
  total_quantity: '3.000',
  movements: 2,
  invoices: 2,
  truncated: false,
  as_of: '2026-11-02T12:00:00Z',
};

const EMPTY = {
  on_date: '2019-01-01',
  kind: 'added',
  items: [],
  products: 0,
  total_quantity: '0',
  movements: 0,
  invoices: 0,
  truncated: false,
  as_of: '2026-11-02T10:00:00Z',
};

beforeEach(() => {
  movementReport.mockReset();
  movementReport.mockResolvedValue(ADDED);
});

function open(): void {
  render(<MovementReport businessDate={TODAY} onClose={() => {}} />);
}

/** The report's own table, so a match cannot come from the summary above it. */
async function table(): Promise<HTMLElement> {
  return screen.findByRole('table');
}

describe('opening the report', () => {
  it('asks for the business date it was given, not for the browser today', async () => {
    // FE-E-3. A counter PC set to UTC would make `new Date()` yesterday for the first
    // five and a half hours of every `Asia/Kolkata` day.
    open();
    await waitFor(() => expect(movementReport).toHaveBeenCalled());
    expect(movementReport.mock.calls[0]?.[0]).toMatchObject({
      on_date: TODAY,
      kind: 'added',
    });
    expect(screen.getByLabelText('Start date')).toHaveValue(TODAY);
  });

  it('starts on Stock Added, with that choice shown as pressed', async () => {
    open();
    await table();
    expect(screen.getByRole('button', { name: 'Stock Added' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Stock Sold' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});

describe('stock added', () => {
  it('shows the quantity, the stock before and the stock after, in that order', async () => {
    open();
    const row = within(await table()).getByRole('row', { name: /Tie Rod End Bolero/ });
    const cells = within(row)
      .getAllByRole('cell')
      .map((cell) => cell.textContent?.trim());

    // code, quantity added, before, after, movement type, reference, time
    expect(cells[0]).toBe('TT-1001-A');
    expect(cells[1]).toBe('6');
    expect(cells[2]).toBe('4');
    expect(cells[3]).toBe('10');
    // The owner's word for the movement, not the database's.
    expect(cells[4]).toBe('Purchase');
    expect(cells[5]).toContain('ASD/2026/881');
  });

  it('shows the summary the owner reads first', async () => {
    open();
    await table();
    const products = screen.getByText('Products affected').parentElement;
    expect(products).toHaveTextContent('1');
    const quantity = screen.getByText('Total quantity added').parentElement;
    expect(quantity).toHaveTextContent('6');
    const movements = screen.getByText('Stock movements').parentElement;
    expect(movements).toHaveTextContent('1');
    // An invoice count on a stock-in report would be meaningless.
    expect(screen.queryByText('Invoices')).not.toBeInTheDocument();
  });
});

describe('stock sold', () => {
  it('loads the sold report when the tab is pressed', async () => {
    const user = userEvent.setup();
    open();
    await table();
    movementReport.mockResolvedValue(SOLD);

    await user.click(screen.getByRole('button', { name: 'Stock Sold' }));

    await waitFor(() =>
      expect(movementReport).toHaveBeenLastCalledWith(
        expect.objectContaining({ on_date: TODAY, kind: 'sold' }),
        expect.anything(),
      ),
    );
    expect(await screen.findByText('NAS/2026-27/00007')).toBeInTheDocument();
  });

  it('names each sale cash or credit, and counts the bills behind the deductions', async () => {
    const user = userEvent.setup();
    open();
    await table();
    movementReport.mockResolvedValue(SOLD);
    await user.click(screen.getByRole('button', { name: 'Stock Sold' }));
    await screen.findByText('NAS/2026-27/00007');

    const cash = within(await table()).getByRole('row', { name: /Tie Rod End Bolero/ });
    expect(within(cash).getByText('Cash')).toBeInTheDocument();
    const credit = within(await table()).getByRole('row', { name: /Oil Filter Scorpio/ });
    expect(within(credit).getByText('Credit')).toBeInTheDocument();

    // Two bills, two products, three units — each counted as itself.
    expect(screen.getByText('Invoices').parentElement).toHaveTextContent('2');
    expect(screen.getByText('Products affected').parentElement).toHaveTextContent('2');
    expect(screen.getByText('Total quantity sold').parentElement).toHaveTextContent('3');
  });

  it('shows the stock before and after each deduction', async () => {
    const user = userEvent.setup();
    open();
    await table();
    movementReport.mockResolvedValue(SOLD);
    await user.click(screen.getByRole('button', { name: 'Stock Sold' }));
    await screen.findByText('NAS/2026-27/00007');

    const row = within(await table()).getByRole('row', { name: /Tie Rod End Bolero/ });
    const cells = within(row)
      .getAllByRole('cell')
      .map((cell) => cell.textContent?.trim());
    // code, quantity sold, before, after, invoice, sale type, time
    expect(cells[1]).toBe('2');
    expect(cells[2]).toBe('10');
    expect(cells[3]).toBe('8');
  });

  it('marks a deduction whose bill was cancelled afterwards', async () => {
    // The deduction stands on the day it happened; its reversal is in Stock Added on the
    // day of the cancellation. Saying so beats leaving the owner to wonder.
    const user = userEvent.setup();
    open();
    await table();
    movementReport.mockResolvedValue({
      ...SOLD,
      items: [{ ...SOLD.items[0], invoice_cancelled: true }],
      products: 1,
      movements: 1,
      invoices: 1,
      total_quantity: '2.000',
    });
    await user.click(screen.getByRole('button', { name: 'Stock Sold' }));

    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
  });
});

describe('changing the day', () => {
  it('reloads for the new date', async () => {
    const user = userEvent.setup();
    open();
    await table();

    await user.clear(screen.getByLabelText('Start date'));
    await user.type(screen.getByLabelText('Start date'), '2026-10-30');

    await waitFor(() =>
      expect(movementReport).toHaveBeenLastCalledWith(
        expect.objectContaining({ on_date: '2026-10-30' }),
        expect.anything(),
      ),
    );
  });

  it('does not let a slow answer to an old date overwrite a newer one', async () => {
    /**
     * The classic report bug: pick a date, pick another before the first replies, and the
     * first reply lands last — the wrong day's figures under the right day's heading.
     */
    const user = userEvent.setup();
    let resolveFirst: ((value: unknown) => void) | undefined;
    movementReport.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    open();

    // A second question, answered immediately.
    movementReport.mockResolvedValue({
      ...ADDED,
      on_date: '2026-10-30',
      items: [{ ...ADDED.items[0], movement_id: 'm-new', reference: 'NEWER/DOC' }],
    });
    await user.clear(screen.getByLabelText('Start date'));
    await user.type(screen.getByLabelText('Start date'), '2026-10-30');
    expect(await screen.findByText('NEWER/DOC')).toBeInTheDocument();

    // Now the first, stale answer arrives.
    resolveFirst?.(ADDED);

    await waitFor(() => expect(screen.getByText('NEWER/DOC')).toBeInTheDocument());
    expect(screen.queryByText('ASD/2026/881')).not.toBeInTheDocument();
  });
});

describe('the states that are easy to confuse', () => {
  it('says a day was quiet rather than showing an empty table', async () => {
    movementReport.mockResolvedValue(EMPTY);
    open();
    expect(
      await screen.findByText(/No stock was added in this period/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('uses the right wording for an empty sold report', async () => {
    const user = userEvent.setup();
    open();
    await table();
    movementReport.mockResolvedValue({ ...EMPTY, kind: 'sold' });
    await user.click(screen.getByRole('button', { name: 'Stock Sold' }));
    expect(await screen.findByText(/Nothing was sold in this period/)).toBeInTheDocument();
  });

  it('reports a failure as a failure, never as a quiet day', async () => {
    // The pair that matters: "nothing happened" and "we could not find out" lead to
    // opposite conclusions, so they must never look the same.
    movementReport.mockRejectedValue(
      new ApiError(500, {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Something went wrong.',
          details: {},
          request_id: 'req-1',
          retryable: false,
        },
      }),
    );
    open();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/No stock was added/)).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows a loading indicator while it waits', async () => {
    movementReport.mockImplementation(() => new Promise(() => {}));
    open();
    expect(await screen.findByRole('status')).toBeInTheDocument();
  });

  it('says plainly when a day had more movements than it can show', async () => {
    movementReport.mockResolvedValue({ ...ADDED, truncated: true });
    open();
    expect(
      await screen.findByText(/more movements than can be shown/),
    ).toBeInTheDocument();
  });
});

describe('the date range (owner request: start date + end date)', () => {
  it('sends end_date equal to the start date by default', async () => {
    open();
    await waitFor(() => expect(movementReport).toHaveBeenCalled());
    expect(movementReport.mock.calls[0]?.[0]).toMatchObject({
      on_date: TODAY,
      end_date: TODAY,
    });
    expect(screen.getByLabelText('End date')).toHaveValue(TODAY);
  });

  it('widening the end date reloads with both dates', async () => {
    const user = userEvent.setup();
    open();
    await table();

    await user.clear(screen.getByLabelText('End date'));
    await user.type(screen.getByLabelText('End date'), '2026-11-05');

    await waitFor(() =>
      expect(movementReport).toHaveBeenLastCalledWith(
        expect.objectContaining({ on_date: TODAY, end_date: '2026-11-05' }),
        expect.anything(),
      ),
    );
  });

  it('moving the start date past the end date carries the end date along, rather than sending an invalid range', async () => {
    const user = userEvent.setup();
    open();
    await table();

    await user.clear(screen.getByLabelText('Start date'));
    await user.type(screen.getByLabelText('Start date'), '2026-11-20');

    await waitFor(() =>
      expect(movementReport).toHaveBeenLastCalledWith(
        expect.objectContaining({ on_date: '2026-11-20', end_date: '2026-11-20' }),
        expect.anything(),
      ),
    );
  });
});

describe('kind=adjusted (a bucket this report did not have before)', () => {
  const ADJUSTED = {
    on_date: TODAY,
    end_date: TODAY,
    kind: 'adjusted',
    items: [
      {
        movement_id: 'm-4',
        product_id: 'p-1',
        product_name: 'Tie Rod End Bolero',
        sku: 'TT-1001-A',
        quantity: '2.000',
        stock_before: '10.000',
        stock_after: '8.000',
        reason: 'adjustment_decrease',
        source_type: 'stock_count',
        reference: null,
        is_credit: null,
        invoice_cancelled: null,
        created_at: '2026-11-02T13:00:00Z',
      },
    ],
    products: 1,
    total_quantity: '2.000',
    movements: 1,
    invoices: 0,
    truncated: false,
    as_of: '2026-11-02T14:00:00Z',
  };

  it('loads the adjusted report when that tab is pressed, and shows the movement type and source', async () => {
    const user = userEvent.setup();
    open();
    await table();
    movementReport.mockResolvedValue(ADJUSTED);

    await user.click(screen.getByRole('button', { name: 'Adjustments' }));

    await waitFor(() =>
      expect(movementReport).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'adjusted' }),
        expect.anything(),
      ),
    );
    const row = within(await table()).getByRole('row', { name: /Tie Rod End Bolero/ });
    expect(within(row).getByText('Correction (less)')).toBeInTheDocument();
    expect(within(row).getByText('Stock Count')).toBeInTheDocument();
    // Not a sale report: no Sale Type / Invoices figure.
    expect(screen.queryByText('Sale Type')).not.toBeInTheDocument();
    expect(screen.queryByText('Invoices')).not.toBeInTheDocument();
  });

  it('says plainly when nothing was adjusted in the period', async () => {
    const user = userEvent.setup();
    open();
    await table();
    movementReport.mockResolvedValue({ ...ADJUSTED, items: [], movements: 0, products: 0 });

    await user.click(screen.getByRole('button', { name: 'Adjustments' }));

    expect(await screen.findByText(/No adjustments in this period/)).toBeInTheDocument();
  });
});

describe('refresh and close', () => {
  it('reloads the same day when Refresh is pressed', async () => {
    const user = userEvent.setup();
    open();
    await table();
    const before = movementReport.mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'Refresh report' }));

    await waitFor(() => expect(movementReport.mock.calls.length).toBeGreaterThan(before));
    expect(movementReport.mock.calls.at(-1)?.[0]).toMatchObject({
      on_date: TODAY,
      kind: 'added',
    });
  });

  it('closes when asked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<MovementReport businessDate={TODAY} onClose={onClose} />);
    await table();

    await user.click(screen.getByRole('button', { name: 'Close report' }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('keyboard and accessibility', () => {
  it('reaches the date, both tabs, refresh and close with Tab alone', async () => {
    const user = userEvent.setup();
    open();
    await table();

    const order = [
      'Start date',
      'End date',
      'Stock Added',
      'Stock Sold',
      'Adjustments',
      'Refresh report',
      'Close report',
    ];
    const seen: string[] = [];
    screen.getByLabelText('Start date').focus();
    for (let step = 0; step < order.length; step += 1) {
      const active = document.activeElement as HTMLElement | null;
      seen.push(active?.getAttribute('aria-label') ?? active?.textContent?.trim() ?? '');
      await user.tab();
    }

    // The two date fields have real labels rather than an aria-label; the rest are buttons.
    expect(seen[0]).toBe('');
    expect(seen[1]).toBe('');
    expect(seen.slice(2)).toEqual(order.slice(2));
  });

  it('switches tabs with the keyboard', async () => {
    const user = userEvent.setup();
    open();
    await table();
    movementReport.mockResolvedValue(SOLD);

    screen.getByRole('button', { name: 'Stock Sold' }).focus();
    await user.keyboard('{Enter}');

    expect(await screen.findByText('NAS/2026-27/00007')).toBeInTheDocument();
  });

  it('passes axe', async () => {
    open();
    await table();
    const results = await axe.run(document.body, {
      rules: { region: { enabled: false } },
    });
    const serious = results.violations.filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? ''),
    );
    expect(serious.map((violation) => violation.id)).toEqual([]);
  });
});

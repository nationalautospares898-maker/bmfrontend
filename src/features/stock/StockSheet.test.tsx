/**
 * The owner's four-column stock sheet, rendered.
 *
 * The assertion this file exists for is
 * `tells the user a quantity will be ADDED to the stock already on the shelf`. Reading
 * `Stock Qty` as a new total instead of an arrival destroys real inventory — 20 on the
 * shelf plus a typed 200 must be 220 — and the mistake leaves the balance table and the
 * ledger agreeing with each other, so nothing downstream would reveal it. The wording and
 * the live `20 + 200 = 220` preview are the two things stopping a user making that
 * reading, so both are tested.
 *
 * The rest covers the layout the owner asked for (four columns side by side, not a
 * stacked form), the keyboard, and the refusals that are cheaper to hear about before
 * pressing Save than after.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StockSheet } from './StockSheet';

const saveStockEntries = vi.fn();
const resolveStockEntry = vi.fn();

vi.mock('@/api/endpoints', () => ({
  inventory: {
    saveStockEntries: (...args: unknown[]) => saveStockEntries(...args) as unknown,
    resolveStockEntry: (...args: unknown[]) => resolveStockEntry(...args) as unknown,
  },
}));

beforeEach(() => {
  saveStockEntries.mockReset();
  resolveStockEntry.mockReset();
  resolveStockEntry.mockResolvedValue({ kind: 'new', candidates: [] });
  saveStockEntries.mockResolvedValue({
    items: [
      {
        item: 'Axel Packing',
        product_id: 'p1',
        created: true,
        quantity_added: '200.000',
        quantity_before: '0',
        quantity_after: '200.000',
        movement_id: 'm1',
        reason: 'opening',
      },
    ],
    as_of: '2026-11-02T04:00:00Z',
  });
});

function noop(): void {
  /* the sheet's callbacks are asserted separately where they matter */
}

async function fillRow(
  user: ReturnType<typeof userEvent.setup>,
  row: number,
  values: { item: string; price: string; min: string; qty: string },
): Promise<void> {
  await user.type(screen.getByLabelText(`Item, row ${row}`), values.item);
  await user.type(screen.getByLabelText(`Price, row ${row}`), values.price);
  await user.type(screen.getByLabelText(`Min Qty, row ${row}`), values.min);
  await user.type(screen.getByLabelText(`Stock Qty, row ${row}`), values.qty);
}

describe('the sheet layout the owner asked for', () => {
  it('puts Item, Price, Min Qty and Stock Qty side by side in one row', () => {
    // Four columns, not a two-up form: the owner wants the data-entry experience of an
    // Excel row, and a vertical form was the specific thing rejected.
    render(<StockSheet onClose={noop} onSaved={noop} />);
    const grid = within(screen.getByRole('table', { name: /Add stock/i }));
    const headers = grid
      .getAllByRole('columnheader')
      .map((header) => header.textContent?.trim());
    expect(headers).toEqual(
      expect.arrayContaining(['Item', 'Price', 'Min Qty', 'Stock Qty']),
    );
    // All four cells of row 1 exist together, which is what "side by side" means here.
    for (const label of ['Item', 'Price', 'Min Qty', 'Stock Qty']) {
      expect(grid.getByLabelText(`${label}, row 1`)).toBeInTheDocument();
    }
  });

  it('opens with several blank rows, so it reads as a sheet', () => {
    render(<StockSheet onClose={noop} onSaved={noop} />);
    expect(screen.getByLabelText('Item, row 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Item, row 8')).toBeInTheDocument();
  });

  it('says that Stock Qty is an arrival, before anything is typed', () => {
    render(<StockSheet onClose={noop} onSaved={noop} />);
    expect(
      screen.getByText(/added to what is already on the shelf, never used to replace it/),
    ).toBeInTheDocument();
  });

  it('can grow a row at a time', async () => {
    const user = userEvent.setup();
    render(<StockSheet onClose={noop} onSaved={noop} />);
    await user.click(screen.getByRole('button', { name: 'Add another row' }));
    expect(screen.getByLabelText('Item, row 9')).toBeInTheDocument();
  });
});

describe('new item versus existing item', () => {
  it('says a name it has not seen before will add a new item', async () => {
    const user = userEvent.setup();
    render(<StockSheet onClose={noop} onSaved={noop} />);

    await user.type(screen.getByLabelText('Item, row 1'), 'Axel Packing');

    expect(await screen.findByText('New item')).toBeInTheDocument();
  });

  it('tells the user a quantity will be ADDED to the stock already on the shelf', async () => {
    // The whole point of this file. `20 + 200 = 220`, spelled out before saving, so
    // nobody can read `Stock Qty` as a replacement figure.
    resolveStockEntry.mockResolvedValue({
      kind: 'existing',
      product_id: 'p1',
      product_name: 'Axel Packing',
      current_quantity: '20.000',
      current_price: '30.0000',
      current_min_qty: '50.000',
      candidates: [],
    });
    const user = userEvent.setup();
    render(<StockSheet onClose={noop} onSaved={noop} />);

    await user.type(screen.getByLabelText('Item, row 1'), 'Axel Packing');
    await waitFor(() => expect(resolveStockEntry).toHaveBeenCalled());
    await user.type(screen.getByLabelText('Stock Qty, row 1'), '200');

    expect(await screen.findByText(/In stock 20 \+ 200 = 220/)).toBeInTheDocument();
  });

  it('fills the price and minimum from the existing item, without overwriting typing', async () => {
    resolveStockEntry.mockResolvedValue({
      kind: 'existing',
      product_id: 'p1',
      product_name: 'Axel Packing',
      current_quantity: '20.000',
      current_price: '30.0000',
      current_min_qty: '50.000',
      candidates: [],
    });
    const user = userEvent.setup();
    render(<StockSheet onClose={noop} onSaved={noop} />);

    await user.type(screen.getByLabelText('Item, row 1'), 'Axel Packing');

    // Pre-filled, so topping up a part does not mean retyping figures that have not
    // changed.
    await waitFor(() => {
      expect(screen.getByLabelText('Price, row 1')).toHaveValue('30.0000');
      expect(screen.getByLabelText('Min Qty, row 1')).toHaveValue('50.000');
    });
  });

  it('refuses to save an ambiguous name and says where to resolve it', async () => {
    // Two products share the normalised name. Choosing one would merge the stock of two
    // different parts, so the sheet refuses rather than guesses — as the server does.
    resolveStockEntry.mockResolvedValue({
      kind: 'ambiguous',
      candidates: [
        { product_id: 'p1', name: 'Oil Seal' },
        { product_id: 'p2', name: 'OIL SEAL' },
      ],
    });
    const user = userEvent.setup();
    render(<StockSheet onClose={noop} onSaved={noop} />);

    await fillRow(user, 1, { item: 'Oil Seal', price: '120', min: '5', qty: '10' });
    await screen.findAllByText(/More than one item has this name/);
    await user.click(screen.getByRole('button', { name: 'Save these items' }));

    expect(saveStockEntries).not.toHaveBeenCalled();
  });

  it('refuses a withdrawn item rather than silently reviving it', async () => {
    resolveStockEntry.mockResolvedValue({
      kind: 'inactive',
      product_id: 'p1',
      product_name: 'Discontinued Clip',
      candidates: [],
    });
    const user = userEvent.setup();
    render(<StockSheet onClose={noop} onSaved={noop} />);

    await fillRow(user, 1, {
      item: 'Discontinued Clip',
      price: '40',
      min: '2',
      qty: '6',
    });
    await screen.findAllByText(/no longer stocked/);
    await user.click(screen.getByRole('button', { name: 'Save these items' }));

    expect(saveStockEntries).not.toHaveBeenCalled();
  });
});

describe('saving', () => {
  it('sends the filled rows as decimal strings and ignores the blank ones', async () => {
    const user = userEvent.setup();
    render(<StockSheet onClose={noop} onSaved={noop} />);

    await fillRow(user, 1, { item: 'Axel Packing', price: '30', min: '50', qty: '200' });
    await user.click(screen.getByRole('button', { name: 'Save these items' }));

    await waitFor(() => expect(saveStockEntries).toHaveBeenCalled());
    const [body] = saveStockEntries.mock.calls[0] as [{ entries: unknown[] }];
    // Seven blank rows were on screen and none of them was sent.
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toEqual({
      item: 'Axel Packing',
      // Strings end to end, never JavaScript numbers (ADR-013).
      price: '30.0000',
      min_qty: '50.000',
      stock_qty: '200.000',
    });
  });

  it('reuses one idempotency key, so a double-tapped Save books one delivery', async () => {
    // The server claims the key. Minting a fresh one per attempt would defeat it, and
    // because `stock_movements` can never be deleted a second booking could not be
    // tidied away afterwards.
    saveStockEntries.mockRejectedValueOnce(new Error('network'));
    const user = userEvent.setup();
    render(<StockSheet onClose={noop} onSaved={noop} />);

    await fillRow(user, 1, { item: 'Axel Packing', price: '30', min: '50', qty: '200' });
    await user.click(screen.getByRole('button', { name: 'Save these items' }));
    await waitFor(() => expect(saveStockEntries).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Save these items' }));
    await waitFor(() => expect(saveStockEntries).toHaveBeenCalledTimes(2));

    const first = saveStockEntries.mock.calls[0]?.[1];
    const second = saveStockEntries.mock.calls[1]?.[1];
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);
  });

  it('never writes "undefined" into Price when the server omits the current one', async () => {
    /**
     * The defect behind three load-dependent flakes in this file.
     *
     * `current_price` and `current_min_qty` are **optional** in the contract, so the
     * server omits them for a `kind: 'new'` row — there is no existing product to quote
     * a price from. The prefill tested `!== null`, which is true for `undefined`, so it
     * wrote the string `"undefined"` into the box. Typing a price afterwards produced
     * `undefined30`, the local price check refused the save, and `onSaved` was never
     * called.
     *
     * Reproduced here deterministically by letting the debounced resolve land **before**
     * the price is typed, which is what full-suite load did by accident.
     */
    const user = userEvent.setup();
    render(<StockSheet onClose={noop} onSaved={noop} />);

    await user.type(screen.getByLabelText('Item, row 1'), 'Axel Packing');
    // Let the resolve settle with its prefill, as a slow network would.
    await waitFor(() => expect(resolveStockEntry).toHaveBeenCalled());

    const price = screen.getByLabelText('Price, row 1');
    await waitFor(() => expect(price).not.toHaveValue('undefined'));
    expect(price).toHaveValue('');

    const minQty = screen.getByLabelText('Min Qty, row 1');
    expect(minQty).not.toHaveValue('undefined');
  });

  it('still prefills Price when the server does supply one', async () => {
    // The fix must not throw the prefill away — only stop it inventing a value.
    resolveStockEntry.mockResolvedValue({
      kind: 'existing',
      candidates: [],
      current_price: '42.0000',
      current_min_qty: '7.000',
    });
    const user = userEvent.setup();
    render(<StockSheet onClose={noop} onSaved={noop} />);

    await user.type(screen.getByLabelText('Item, row 1'), 'Axel Packing');

    await waitFor(() =>
      expect(screen.getByLabelText('Price, row 1')).toHaveValue('42.0000'),
    );
    expect(screen.getByLabelText('Min Qty, row 1')).toHaveValue('7.000');
  });

  it('reports what was saved, separating new items from top-ups', async () => {
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(<StockSheet onClose={noop} onSaved={onSaved} />);

    await fillRow(user, 1, { item: 'Axel Packing', price: '30', min: '50', qty: '200' });
    await user.click(screen.getByRole('button', { name: 'Save these items' }));

    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith('Saved 1 item. 1 new, 0 topped up.'),
    );
  });
});

describe('refusals heard before Save, not after', () => {
  it('refuses an empty sheet', async () => {
    const user = userEvent.setup();
    render(<StockSheet onClose={noop} onSaved={noop} />);
    await user.click(screen.getByRole('button', { name: 'Save these items' }));
    expect(await screen.findByText(/Fill in at least one row/)).toBeInTheDocument();
    expect(saveStockEntries).not.toHaveBeenCalled();
  });

  it('refuses a row with no quantity', async () => {
    const user = userEvent.setup();
    render(<StockSheet onClose={noop} onSaved={noop} />);
    await user.type(screen.getByLabelText('Item, row 1'), 'Axel Packing');
    await user.type(screen.getByLabelText('Price, row 1'), '30');
    await user.click(screen.getByRole('button', { name: 'Save these items' }));
    expect(await screen.findByText(/needs a Stock Qty above zero/)).toBeInTheDocument();
    expect(saveStockEntries).not.toHaveBeenCalled();
  });

  it('refuses a quantity of zero — an arrival of none is not an arrival', async () => {
    const user = userEvent.setup();
    render(<StockSheet onClose={noop} onSaved={noop} />);
    await fillRow(user, 1, { item: 'Axel Packing', price: '30', min: '50', qty: '0' });
    await user.click(screen.getByRole('button', { name: 'Save these items' }));
    expect(await screen.findByText(/needs a Stock Qty above zero/)).toBeInTheDocument();
    expect(saveStockEntries).not.toHaveBeenCalled();
  });

  it('refuses the same item twice in one sheet', async () => {
    // Which quantity the user meant is genuinely unknown, and guessing either way gets
    // the shelf wrong.
    const user = userEvent.setup();
    render(<StockSheet onClose={noop} onSaved={noop} />);
    await fillRow(user, 1, { item: 'Axel Packing', price: '30', min: '50', qty: '20' });
    await fillRow(user, 2, { item: 'axel  packing', price: '30', min: '50', qty: '200' });
    await user.click(screen.getByRole('button', { name: 'Save these items' }));
    expect(
      await screen.findByText(/Put the whole quantity on one row/),
    ).toBeInTheDocument();
    expect(saveStockEntries).not.toHaveBeenCalled();
  });
});

describe('the keyboard', () => {
  it('keeps a space a space, so a part name can be typed', async () => {
    // `Axel Packing` has one in the middle. A sheet that swallowed `Space` to select a
    // cell would make half the catalogue untypeable.
    const user = userEvent.setup();
    render(<StockSheet onClose={noop} onSaved={noop} />);
    const cell = screen.getByLabelText('Item, row 1');
    await user.type(cell, 'Axel Packing');
    expect(cell).toHaveValue('Axel Packing');
  });

  it('moves down a row on Enter, and grows the sheet from the last one', async () => {
    const user = userEvent.setup();
    render(<StockSheet onClose={noop} onSaved={noop} />);

    await user.click(screen.getByLabelText('Item, row 8'));
    await user.keyboard('{Enter}');

    // Row 9 did not exist a moment ago. A long delivery never runs out of rows.
    expect(await screen.findByLabelText('Item, row 9')).toBeInTheDocument();
  });

  it('says which keys move the cursor', () => {
    render(<StockSheet onClose={noop} onSaved={noop} />);
    expect(screen.getByText(/arrow keys move between cells/)).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('has no axe violations', async () => {
    const { container } = render(<StockSheet onClose={noop} onSaved={noop} />);
    const results = await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    });
    expect(
      results.violations.map((violation) => ({
        id: violation.id,
        nodes: violation.nodes.length,
      })),
    ).toEqual([]);
  }, 30_000);
});

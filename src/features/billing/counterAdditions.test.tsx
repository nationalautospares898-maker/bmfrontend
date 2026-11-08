/**
 * The three billing-counter additions the owner asked for on 2026-11-07.
 *
 * * **Add New Item to Stock** from the Item cell, when the catalogue has nothing.
 * * **Mechanic Name** suggestions, saved and reused.
 * * The **packing tick** per bill row.
 *
 * The assertions that matter most here are the *negative* ones, because each feature has
 * a way of being wrong that looks right on screen:
 *
 * * creating a product must **not** move stock, and must **not** be offered when the
 *   search merely has not answered yet (that is how duplicates get made);
 * * the packing tick must **not** reach the server, the printed bill or the total;
 * * a failure to save a mechanic must **not** lose what was typed on the bill.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db/schema';
import type { LocalDraft, LocalDraftLine } from '@/db/schema';
import { toUpsertPayload } from './draftStore';
import { BillGrid } from './BillGrid';
import { ItemCell } from './ItemCell';
import { MechanicPicker } from './MechanicPicker';

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  create: vi.fn(),
  mechanicSearch: vi.fn(),
  mechanicEnsure: vi.fn(),
}));

vi.mock('@/api/endpoints', () => ({
  catalog: { search: mocks.search, create: mocks.create },
  mechanics: { search: mocks.mechanicSearch, ensure: mocks.mechanicEnsure },
}));

const CREATED_PRODUCT = {
  id: 'p-new',
  name: 'BRAKE SHOE XL',
  sku: null,
  unit: { code: 'NOS', name: 'Numbers', allows_fraction: false, decimal_places: 0 },
  default_selling_price: '450',
  is_active: true,
  stock: null,
};

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.search.mockResolvedValue({ items: [], page: {} });
  mocks.create.mockResolvedValue(CREATED_PRODUCT);
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
  await db.open();
  await db.drafts.clear();
  await db.outbox.clear();
});

function renderCell(overrides: Partial<React.ComponentProps<typeof ItemCell>> = {}) {
  const onPick = vi.fn();
  render(
    <ItemCell
      row={0}
      billId="draft-1"
      line={undefined}
      online
      readOnly={false}
      canCreateProduct
      onPick={onPick}
      onFocusCell={vi.fn()}
      onMove={vi.fn()}
      {...overrides}
    />,
  );
  return { onPick };
}

// --- F1: adding a missing item from the bill ----------------------------------

describe('Add New Item to Stock', () => {
  it('is offered once a search has come back with nothing', async () => {
    const user = userEvent.setup();
    renderCell();

    await user.type(screen.getByLabelText(/Item, row 1/), 'BRAKE SHOE XL');

    expect(
      await screen.findByRole('button', { name: 'Add New Item to Stock' }),
    ).toBeInTheDocument();
  });

  it('is NOT offered before the search has answered', () => {
    // The whole point of tracking "a search completed empty" separately from
    // "there are no hits": offering it while results are in flight is how a cashier
    // creates a duplicate of a part that was about to appear.
    renderCell();
    expect(
      screen.queryByRole('button', { name: 'Add New Item to Stock' }),
    ).not.toBeInTheDocument();
  });

  it('is NOT offered to a user without catalog.write', async () => {
    const user = userEvent.setup();
    renderCell({ canCreateProduct: false });

    await user.type(screen.getByLabelText(/Item, row 1/), 'BRAKE SHOE XL');

    await waitFor(() => expect(mocks.search).toHaveBeenCalled());
    expect(
      screen.queryByRole('button', { name: 'Add New Item to Stock' }),
    ).not.toBeInTheDocument();
  });

  it('is NOT offered when the results came from the offline cache', async () => {
    const user = userEvent.setup();
    // "Not in the copy saved on this computer" is not evidence the catalogue lacks it.
    renderCell({ online: false });

    await user.type(screen.getByLabelText(/Item, row 1/), 'BRAKE SHOE XL');

    expect(
      screen.queryByRole('button', { name: 'Add New Item to Stock' }),
    ).not.toBeInTheDocument();
  });

  it('creates the product with the typed price and a minimum quantity of 10', async () => {
    const user = userEvent.setup();
    renderCell();

    await user.type(screen.getByLabelText(/Item, row 1/), 'BRAKE SHOE XL');
    await user.click(
      await screen.findByRole('button', { name: 'Add New Item to Stock' }),
    );

    await user.type(screen.getByLabelText('Selling price'), '450');
    // The owner's stated default, pre-filled rather than asked for.
    expect(screen.getByLabelText('Minimum quantity')).toHaveValue('10');

    await user.click(screen.getByRole('button', { name: 'Create and add to the bill' }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    const body = mocks.create.mock.calls[0]?.[0];
    expect(body).toMatchObject({
      name: 'BRAKE SHOE XL',
      default_selling_price: '450',
      reorder_level: '10',
      unit_code: 'NOS',
    });
    // A client-generated id is what makes the create idempotent on retry.
    expect(body.id).toBeTruthy();
  });

  it('puts the new product straight onto the current row', async () => {
    const user = userEvent.setup();
    const { onPick } = renderCell();

    await user.type(screen.getByLabelText(/Item, row 1/), 'BRAKE SHOE XL');
    await user.click(
      await screen.findByRole('button', { name: 'Add New Item to Stock' }),
    );
    await user.type(screen.getByLabelText('Selling price'), '450');
    await user.click(screen.getByRole('button', { name: 'Create and add to the bill' }));

    // No "now search for it again" step — the bill continues.
    await waitFor(() =>
      expect(onPick).toHaveBeenCalledWith(
        expect.objectContaining({ productId: 'p-new', name: 'BRAKE SHOE XL' }),
      ),
    );
  });

  it('reuses one id across retries, so a failure then a success makes one product', async () => {
    const user = userEvent.setup();
    mocks.create.mockRejectedValueOnce(new Error('network'));
    renderCell();

    await user.type(screen.getByLabelText(/Item, row 1/), 'BRAKE SHOE XL');
    await user.click(
      await screen.findByRole('button', { name: 'Add New Item to Stock' }),
    );
    await user.type(screen.getByLabelText('Selling price'), '450');

    const save = screen.getByRole('button', { name: 'Create and add to the bill' });
    await user.click(save);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    await user.click(save);
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));

    const first = mocks.create.mock.calls[0]?.[0]?.id;
    const second = mocks.create.mock.calls[1]?.[0]?.id;
    expect(first).toBe(second);
  });

  it('refuses a price that is not a number, before sending anything', async () => {
    const user = userEvent.setup();
    renderCell();

    await user.type(screen.getByLabelText(/Item, row 1/), 'BRAKE SHOE XL');
    await user.click(
      await screen.findByRole('button', { name: 'Add New Item to Stock' }),
    );
    await user.type(screen.getByLabelText('Selling price'), 'abc');
    await user.click(screen.getByRole('button', { name: 'Create and add to the bill' }));

    expect(await screen.findByText('Enter a selling price.')).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('says plainly that no stock is being added', async () => {
    const user = userEvent.setup();
    renderCell();

    await user.type(screen.getByLabelText(/Item, row 1/), 'BRAKE SHOE XL');
    await user.click(
      await screen.findByRole('button', { name: 'Add New Item to Stock' }),
    );

    // A created product with zero stock will prompt an oversell override, and a cashier
    // who was not told will read that as a bug.
    expect(screen.getByText(/it records no stock/i)).toBeInTheDocument();
    expect(
      screen.getByText(/can choose an audited oversell override/i),
    ).toBeInTheDocument();
  });
});

// --- F2: the mechanic picker --------------------------------------------------

describe('Mechanic Name suggestions', () => {
  function renderPicker(value = '') {
    const onChange = vi.fn();
    const onDone = vi.fn();
    render(
      <MechanicPicker
        value={value}
        onChange={onChange}
        onDone={onDone}
        resetKey="draft-1"
      />,
    );
    return { onChange, onDone };
  }

  it('asks for the recently-used list as soon as the field is focused', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByLabelText('Mechanic Name'));

    // An empty query is a real request — it is what returns the recent names.
    await waitFor(() => expect(mocks.mechanicSearch).toHaveBeenCalled());
    expect(mocks.mechanicSearch.mock.calls[0]?.[0]).toBeUndefined();
  });

  it('offers a matching saved mechanic and picks it with Enter', async () => {
    mocks.mechanicSearch.mockResolvedValue({
      items: [
        {
          id: 'm1',
          name: 'Ramesh',
          phone: null,
          is_active: true,
          use_count: 3,
          last_used_at: null,
        },
      ],
      page: {},
    });
    const user = userEvent.setup();
    const { onChange } = renderPicker();

    await user.type(screen.getByLabelText('Mechanic Name'), 'ram');
    await screen.findByRole('option', { name: /Ramesh/ });
    await user.keyboard('{Enter}');

    expect(onChange).toHaveBeenCalledWith('Ramesh');
  });

  it('saves a newly typed name so the next bill can suggest it', async () => {
    const user = userEvent.setup();
    renderPicker();

    const input = screen.getByLabelText('Mechanic Name');
    await user.type(input, 'Ramesh');
    await user.tab();

    await waitFor(() => expect(mocks.mechanicEnsure).toHaveBeenCalledWith('Ramesh'));
  });

  it('does not re-save the same name on every blur', async () => {
    const user = userEvent.setup();
    renderPicker();

    const input = screen.getByLabelText('Mechanic Name');
    await user.type(input, 'Ramesh');
    await user.tab();
    await waitFor(() => expect(mocks.mechanicEnsure).toHaveBeenCalledTimes(1));

    await user.click(input);
    await user.tab();

    expect(mocks.mechanicEnsure).toHaveBeenCalledTimes(1);
  });

  it('keeps the typed name on the bill when saving the suggestion fails', async () => {
    mocks.mechanicEnsure.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    const { onChange } = renderPicker();

    await user.type(screen.getByLabelText('Mechanic Name'), 'Ramesh');
    await user.tab();

    // The draft was updated first and unconditionally. Losing the convenience of a
    // suggestion must never cost the name on the bill in front of the customer.
    expect(onChange).toHaveBeenCalledWith('Ramesh');
    expect(
      await screen.findByText(/could not be saved for next time/i),
    ).toBeInTheDocument();
  });

  it('leaves Space as an ordinary character so two-word names are typeable', async () => {
    mocks.mechanicSearch.mockResolvedValue({
      items: [
        {
          id: 'm1',
          name: 'Ramesh',
          phone: null,
          is_active: true,
          use_count: 1,
          last_used_at: null,
        },
      ],
      page: {},
    });
    const user = userEvent.setup();
    renderPicker();

    const input = screen.getByLabelText('Mechanic Name');
    await user.type(input, 'Ramesh Kumar');

    // If Space selected from the list, this would read "Ramesh".
    expect(input).toHaveValue('Ramesh Kumar');
  });
});

// --- F4: the packing tick -----------------------------------------------------

const LINE: LocalDraftLine = {
  id: 'l1',
  line_no: 1,
  product_id: 'p1',
  product_name: 'AXEL PACKING',
  sku: 'AX-1',
  unit_code: 'NOS',
  quantity: '2',
  unit_price: '100',
  catalog_price_at_add: '100',
  price_source: 'catalog',
  discount_percent: '0',
  known_stock: '5',
  stock_as_of: new Date().toISOString(),
};

describe('the packing tick', () => {
  function renderGrid(line: LocalDraftLine = LINE) {
    const onChangeLine = vi.fn();
    render(
      <BillGrid
        billId="draft-1"
        lines={[line]}
        readOnly={false}
        online
        canOverridePrice
        canCreateProduct
        onAddProduct={vi.fn()}
        onChangeLine={onChangeLine}
        onRemoveLine={vi.fn()}
      />,
    );
    return { onChangeLine };
  }

  it('offers a tick per bill row', () => {
    renderGrid();
    expect(
      screen.getByRole('checkbox', { name: /AXEL PACKING has been brought/i }),
    ).toBeInTheDocument();
  });

  it('records the tick against the line', async () => {
    const user = userEvent.setup();
    const { onChangeLine } = renderGrid();

    await user.click(screen.getByRole('checkbox', { name: /AXEL PACKING/i }));

    expect(onChangeLine).toHaveBeenCalledWith('l1', { collected: true });
  });

  it('does not change the line total', async () => {
    const user = userEvent.setup();
    renderGrid();
    const row = screen.getByRole('checkbox', { name: /AXEL PACKING/i }).closest('tr');

    const before = within(row as HTMLElement).getByText('200');
    await user.click(screen.getByRole('checkbox', { name: /AXEL PACKING/i }));

    expect(before).toBeInTheDocument();
  });

  it('is NOT sent to the server with the draft', () => {
    // `toUpsertPayload` enumerates its fields, and this is the test that fails if
    // somebody "simplifies" it into a spread.
    const draft: LocalDraft = {
      id: 'd1',
      counter_id: 'c1',
      label: 'New bill',
      version: null,
      status: 'editing',
      header: {
        customer_id: null,
        customer_name: '',
        customer_business_name: '',
        vehicle_number: '',
        mechanic_name: 'Ramesh',
        phone: '',
        notes: '',
        is_credit_intent: false,
      },
      lines: [{ ...LINE, collected: true }],
      dirty: true,
      last_synced_at: null,
      conflict: null,
      invoice_id: null,
      updated_at: new Date().toISOString(),
    };

    const payload = toUpsertPayload(draft);

    const [item] = payload.items ?? [];
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty('collected');
    expect(JSON.stringify(payload)).not.toContain('collected');
  });

  it('reads back as unticked for a draft written before the field existed', () => {
    // No Dexie version bump was needed precisely because `undefined` is falsy.
    const { collected, ...withoutField } = { ...LINE, collected: true };
    void collected;
    renderGrid(withoutField);

    expect(screen.getByRole('checkbox', { name: /AXEL PACKING/i })).not.toBeChecked();
  });
});

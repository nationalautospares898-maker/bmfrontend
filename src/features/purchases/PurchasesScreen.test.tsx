/**
 * The Purchases screen, rendered.
 *
 * One rule dominates: **entering a supplier's bill and receiving the goods are separate
 * acts** (FR-PUR-003). A screen that merged them would turn every delivery note into
 * stock nobody has counted, so the tests check the separation is visible — in the status
 * text, in the button wording, and in what the confirmation says before it acts.
 *
 * The second rule is about honesty on a replay: confirming is idempotent server-side,
 * and `movements: 0` means "already received". Reporting that as a fresh receipt would
 * tell the shopkeeper goods arrived twice.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PurchasesScreen } from './PurchasesScreen';

const list = vi.fn();
const confirm = vi.fn();
const create = vi.fn();
const suppliers = vi.fn();
const upsertSupplier = vi.fn();
const search = vi.fn();

vi.mock('@/api/endpoints', () => ({
  purchases: {
    list: (...a: unknown[]) => list(...a) as unknown,
    confirm: (...a: unknown[]) => confirm(...a) as unknown,
    create: (...a: unknown[]) => create(...a) as unknown,
    suppliers: (...a: unknown[]) => suppliers(...a) as unknown,
    upsertSupplier: (...a: unknown[]) => upsertSupplier(...a) as unknown,
  },
  catalog: { search: (...a: unknown[]) => search(...a) as unknown },
}));

const DRAFT = {
  id: 'pu1',
  supplier_id: 's1',
  supplier_name: 'Sri Balaji Auto Parts',
  supplier_document_number: 'SB/2026/118',
  document_date: '2026-10-28',
  status: 'draft',
  subtotal: '12000.00',
  total: '12000.00',
  line_count: 3,
};

beforeEach(() => {
  for (const fn of [list, confirm, create, suppliers, upsertSupplier, search]) {
    fn.mockReset();
  }
  list.mockResolvedValue({ items: [DRAFT] });
  suppliers.mockResolvedValue({ items: [{ id: 's1', name: 'Sri Balaji', phone: null }] });
  confirm.mockResolvedValue({ movements: 3 });
  create.mockResolvedValue({ id: 'pu2' });
  upsertSupplier.mockResolvedValue({ id: 's2' });
  search.mockResolvedValue({
    items: [
      {
        id: 'p1',
        name: 'Tie Rod End Bolero',
        sku: 'TT-407-BS',
        cost_price: '300.0000',
        default_selling_price: '420.0000',
        stock: null,
      },
    ],
    page: {},
  });
});

describe('FR-PUR-003 — entering a bill is not receiving the goods', () => {
  it('states the separation before anything is done', async () => {
    render(<PurchasesScreen canReceive />);
    expect(
      await screen.findByText(/Stock only changes when you press/),
    ).toBeInTheDocument();
  });

  it('says a saved bill has not been received, in words', async () => {
    render(<PurchasesScreen canReceive />);
    // Not `draft`.
    expect(await screen.findByText('Entered, not received')).toBeInTheDocument();
  });

  it('labels the action "Receive into stock", not "Confirm"', async () => {
    render(<PurchasesScreen canReceive />);
    expect(
      await screen.findByRole('button', { name: 'Receive into stock' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
  });

  it('says what receiving will change before it changes it', async () => {
    const user = userEvent.setup();
    render(<PurchasesScreen canReceive />);
    await user.click(await screen.findByRole('button', { name: 'Receive into stock' }));
    expect(
      await screen.findByText(/adds the quantities on this bill to your stock/),
    ).toBeInTheDocument();
  });

  it('offers no receive control without the permission', async () => {
    render(<PurchasesScreen canReceive={false} />);
    await screen.findByText('Sri Balaji Auto Parts');
    expect(
      screen.queryByRole('button', { name: 'Receive into stock' }),
    ).not.toBeInTheDocument();
  });

  it('tells the user a saved bill has not moved stock yet', async () => {
    const user = userEvent.setup();
    render(<PurchasesScreen canReceive />);
    await screen.findByText('Sri Balaji Auto Parts');
    await user.click(screen.getByRole('button', { name: 'Record a supplier bill' }));

    // Build one valid line.
    await user.selectOptions(screen.getByLabelText('Supplier'), 's1');
    await user.type(screen.getByLabelText(/Add an item 1/), 'tie rod');
    await user.click(await screen.findByRole('button', { name: /Tie Rod End Bolero/ }));
    await user.type(screen.getByLabelText('Quantity'), '6');
    await user.click(screen.getByRole('button', { name: 'Save the bill' }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(await screen.findByText(/Stock has not changed/)).toBeInTheDocument();
  });
});

describe('receiving is idempotent, and said so honestly', () => {
  it('reports "already received" when the server moved nothing', async () => {
    confirm.mockResolvedValue({ movements: 0 });
    const user = userEvent.setup();
    render(<PurchasesScreen canReceive />);
    await user.click(await screen.findByRole('button', { name: 'Receive into stock' }));
    await user.click(
      screen.getAllByRole('button', { name: 'Receive into stock' }).at(-1)!,
    );

    expect(
      await screen.findByText(/already received. Nothing was added a second time/),
    ).toBeInTheDocument();
  });

  it('sends an idempotency key so a retried receive cannot double the stock', async () => {
    const user = userEvent.setup();
    render(<PurchasesScreen canReceive />);
    await user.click(await screen.findByRole('button', { name: 'Receive into stock' }));
    await user.click(
      screen.getAllByRole('button', { name: 'Receive into stock' }).at(-1)!,
    );

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    const [, key] = confirm.mock.calls[0] as [string, string];
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('entering a bill', () => {
  it('names the first unmet requirement rather than silently disabling save', async () => {
    const user = userEvent.setup();
    render(<PurchasesScreen canReceive />);
    await screen.findByText('Sri Balaji Auto Parts');
    await user.click(screen.getByRole('button', { name: 'Record a supplier bill' }));

    expect(
      await screen.findByText('Choose which supplier this bill is from.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save the bill' })).toBeDisabled();
  });

  it('asks for a quantity above zero', async () => {
    const user = userEvent.setup();
    render(<PurchasesScreen canReceive />);
    await screen.findByText('Sri Balaji Auto Parts');
    await user.click(screen.getByRole('button', { name: 'Record a supplier bill' }));
    await user.selectOptions(screen.getByLabelText('Supplier'), 's1');
    await user.type(screen.getByLabelText(/Add an item 1/), 'tie rod');
    await user.click(await screen.findByRole('button', { name: /Tie Rod End Bolero/ }));
    await user.type(screen.getByLabelText('Quantity'), '0');

    expect(
      await screen.findByText('Every line needs a quantity above zero.'),
    ).toBeInTheDocument();
  });

  it('pre-fills the cost from the catalogue, visibly and editably', async () => {
    const user = userEvent.setup();
    render(<PurchasesScreen canReceive />);
    await screen.findByText('Sri Balaji Auto Parts');
    await user.click(screen.getByRole('button', { name: 'Record a supplier bill' }));
    await user.type(screen.getByLabelText(/Add an item 1/), 'tie rod');
    await user.click(await screen.findByRole('button', { name: /Tie Rod End Bolero/ }));

    // The most-likely-right number, shown rather than hidden.
    expect(screen.getByLabelText('Cost each')).toHaveValue('300.0000');
  });

  it('shows a running total as a preview', async () => {
    const user = userEvent.setup();
    render(<PurchasesScreen canReceive />);
    await screen.findByText('Sri Balaji Auto Parts');
    await user.click(screen.getByRole('button', { name: 'Record a supplier bill' }));
    await user.type(screen.getByLabelText(/Add an item 1/), 'tie rod');
    await user.click(await screen.findByRole('button', { name: /Tie Rod End Bolero/ }));
    await user.type(screen.getByLabelText('Quantity'), '2');

    expect(screen.getByText(/Total so far/)).toBeInTheDocument();
  });

  it('creates a supplier with a client-generated id, so a retry is an upsert', async () => {
    const user = userEvent.setup();
    render(<PurchasesScreen canReceive />);
    await screen.findByText('Sri Balaji Auto Parts');
    await user.click(screen.getByRole('button', { name: 'Record a supplier bill' }));
    await user.click(screen.getByRole('button', { name: 'Add a supplier' }));
    await user.type(screen.getByLabelText('Supplier name'), 'New Spares Co');
    await user.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!);

    await waitFor(() => expect(upsertSupplier).toHaveBeenCalled());
    const [id, body] = upsertSupplier.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.name).toBe('New Spares Co');
  });
});

describe('the list', () => {
  it('says so when there are no bills', async () => {
    list.mockResolvedValue({ items: [] });
    render(<PurchasesScreen canReceive />);
    expect(
      await screen.findByText('No supplier bills recorded yet.'),
    ).toBeInTheDocument();
  });

  it('shows the supplier’s own bill number, so the two can be reconciled', async () => {
    render(<PurchasesScreen canReceive />);
    expect(await screen.findByText('SB/2026/118')).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('has no axe violations', async () => {
    const { container } = render(<PurchasesScreen canReceive />);
    await screen.findByText('Sri Balaji Auto Parts');
    const results = await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    });
    expect(results.violations).toEqual([]);
  });
});

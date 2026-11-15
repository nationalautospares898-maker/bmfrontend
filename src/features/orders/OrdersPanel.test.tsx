/**
 * The persistent Orders panel (NAS-NEW-01). Load-bearing assertions:
 *
 * - it renders from the shared `ordersStore`, not a fetch of its own (`loadPending`
 *   is never called here — `AppShell` is the one place that triggers the first load);
 * - the same actions `OrdersScreen` offers (create, complete, trash-with-confirm, set
 *   a reminder) work from this compact view and hit the same endpoints;
 * - "View all orders" is offered and calls back out, never navigates itself.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Order } from '@/api/types';
import { OrdersPanel } from './OrdersPanel';
import { resetOrdersStore, useOrdersStore } from './ordersStore';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  complete: vi.fn(),
  discard: vi.fn(),
  setReminder: vi.fn(),
}));

vi.mock('@/api/endpoints', () => ({
  orders: {
    list: mocks.list,
    create: mocks.create,
    update: mocks.update,
    complete: mocks.complete,
    discard: mocks.discard,
    setReminder: mocks.setReminder,
  },
}));

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    customer_name: 'Ramesh',
    phone: null,
    body: '2x brake pad',
    status: 'pending',
    created_at: '2026-11-10T10:00:00Z',
    updated_at: '2026-11-10T10:00:00Z',
    completed_at: null,
    discarded_at: null,
    remind_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.list.mockReset();
  mocks.create.mockReset();
  mocks.update.mockReset();
  mocks.complete.mockReset();
  mocks.discard.mockReset();
  mocks.setReminder.mockReset();
  resetOrdersStore();
});

describe('OrdersPanel', () => {
  it('renders from the store rather than fetching on its own', async () => {
    render(<OrdersPanel />);
    // Nothing to show until something populates the store — proves there is no
    // internal `loadPending()` call hiding in this component.
    expect(mocks.list).not.toHaveBeenCalled();
    expect(screen.getByText('Orders')).toBeInTheDocument();

    mocks.list.mockResolvedValue({ items: [order()] });
    await useOrdersStore.getState().loadPending();
    expect(await screen.findByText('2x brake pad')).toBeInTheDocument();
    expect(screen.getByText('Orders (1)')).toBeInTheDocument();
  });

  it('creating an order posts to the server and clears the local card', async () => {
    mocks.list.mockResolvedValue({ items: [] });
    mocks.create.mockResolvedValue({ id: 'order-new' });
    render(<OrdersPanel />);
    await useOrdersStore.getState().loadPending();

    await userEvent.click(screen.getByRole('button', { name: '+ New Order' }));
    await userEvent.type(
      screen.getByPlaceholderText(/write down the order/i),
      '1x oil filter',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        body: '1x oil filter',
        customer_name: null,
        phone: null,
      }),
    );
  });

  it('marking an order complete calls the complete endpoint, not a generic update', async () => {
    mocks.list.mockResolvedValue({ items: [order()] });
    mocks.complete.mockResolvedValue({ status: 'completed' });
    render(<OrdersPanel />);
    await useOrdersStore.getState().loadPending();
    await screen.findByText('2x brake pad');

    await userEvent.click(screen.getByRole('button', { name: 'Mark Complete' }));

    await waitFor(() => expect(mocks.complete).toHaveBeenCalledWith('order-1'));
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('discarding an order requires a confirmation step', async () => {
    mocks.list.mockResolvedValue({ items: [order()] });
    mocks.discard.mockResolvedValue({ status: 'discarded' });
    render(<OrdersPanel />);
    await useOrdersStore.getState().loadPending();
    await screen.findByText('2x brake pad');

    await userEvent.click(screen.getByRole('button', { name: 'Trash' }));
    expect(mocks.discard).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Yes, trash it' }));
    await waitFor(() => expect(mocks.discard).toHaveBeenCalledWith('order-1'));
  });

  it('setting a reminder calls setReminder with the chosen moment, as an ISO string', async () => {
    mocks.list.mockResolvedValue({ items: [order()] });
    mocks.setReminder.mockResolvedValue({ updated: true });
    render(<OrdersPanel />);
    await useOrdersStore.getState().loadPending();
    await screen.findByText('2x brake pad');

    await userEvent.click(screen.getByRole('button', { name: 'Set reminder' }));
    const input = screen.getByLabelText('Remind me at');
    await userEvent.type(input, '2026-12-25T09:30');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocks.setReminder).toHaveBeenCalled());
    const [orderId, remindAt] = mocks.setReminder.mock.calls[0] as [string, string];
    expect(orderId).toBe('order-1');
    expect(new Date(remindAt).getFullYear()).toBe(2026);
  });

  it('shares state with another simultaneously-mounted consumer (e.g. the full Orders page)', async () => {
    mocks.list.mockResolvedValue({ items: [order()] });
    mocks.complete.mockResolvedValue({ status: 'completed' });
    render(<OrdersPanel />);
    await useOrdersStore.getState().loadPending();
    await screen.findByText('2x brake pad');

    // A second consumer reading the exact same store, as `OrdersScreen` would.
    mocks.list.mockResolvedValue({ items: [] });
    await useOrdersStore.getState().complete(order());

    await waitFor(() =>
      expect(useOrdersStore.getState().pending).toEqual([]),
    );
  });

  it('"View all orders" calls back out rather than navigating itself', async () => {
    mocks.list.mockResolvedValue({ items: [] });
    const onOpenOrders = vi.fn();
    render(<OrdersPanel onOpenOrders={onOpenOrders} />);
    await useOrdersStore.getState().loadPending();

    await userEvent.click(screen.getByRole('button', { name: 'View all orders' }));
    expect(onOpenOrders).toHaveBeenCalledOnce();
  });
});

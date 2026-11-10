/**
 * Chitti orders (Feature B). Load-bearing assertions:
 *
 * - a new card needs only its note to be savable — the Save button stays disabled on
 *   an empty body, matching the server's own refusal;
 * - saving posts to `POST /orders` and the card disappears from local drafts once
 *   the server has it;
 * - completing/discarding call their own endpoints, never a generic update.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Order } from '@/api/types';
import { OrdersScreen } from './OrdersScreen';

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
});

describe('OrdersScreen', () => {
  it('a blank draft cannot be saved', async () => {
    mocks.list.mockResolvedValue({ items: [] });
    render(<OrdersScreen />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: '+ New Order' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saving a draft posts to the server and clears the local card', async () => {
    mocks.list.mockResolvedValue({ items: [] });
    mocks.create.mockResolvedValue({ id: 'order-new' });
    render(<OrdersScreen />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: '+ New Order' }));
    await userEvent.type(
      screen.getByPlaceholderText(/write down the order/i),
      '2x brake pad, Ramesh',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        body: '2x brake pad, Ramesh',
        customer_name: null,
        phone: null,
      }),
    );
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('marking an order complete calls the complete endpoint, not a generic update', async () => {
    mocks.list.mockResolvedValue({ items: [order()] });
    mocks.complete.mockResolvedValue({ status: 'completed' });
    render(<OrdersScreen />);
    await screen.findByText('2x brake pad');

    await userEvent.click(screen.getByRole('button', { name: 'Mark Complete' }));

    await waitFor(() => expect(mocks.complete).toHaveBeenCalledWith('order-1'));
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('discarding an order requires a confirmation step', async () => {
    mocks.list.mockResolvedValue({ items: [order()] });
    mocks.discard.mockResolvedValue({ status: 'discarded' });
    render(<OrdersScreen />);
    await screen.findByText('2x brake pad');

    await userEvent.click(screen.getByRole('button', { name: 'Trash' }));
    expect(mocks.discard).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Yes, trash it' }));
    await waitFor(() => expect(mocks.discard).toHaveBeenCalledWith('order-1'));
  });

  it('says plainly when there are no pending orders', async () => {
    mocks.list.mockResolvedValue({ items: [] });
    render(<OrdersScreen />);
    expect(await screen.findByText(/no pending orders/i)).toBeInTheDocument();
  });

  describe('the per-order reminder (owner request, 2026-11-11)', () => {
    it('shows "No reminder set" by default', async () => {
      mocks.list.mockResolvedValue({ items: [order()] });
      render(<OrdersScreen />);
      expect(await screen.findByText('No reminder set')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Set reminder' })).toBeInTheDocument();
    });

    it('setting a reminder calls setReminder with the chosen moment, as an ISO string', async () => {
      mocks.list.mockResolvedValue({ items: [order()] });
      mocks.setReminder.mockResolvedValue({ updated: true });
      render(<OrdersScreen />);
      await screen.findByText('2x brake pad');

      await userEvent.click(screen.getByRole('button', { name: 'Set reminder' }));
      const input = screen.getByLabelText('Remind me at');
      await userEvent.type(input, '2026-12-25T09:30');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(mocks.setReminder).toHaveBeenCalled());
      const [orderId, remindAt] = mocks.setReminder.mock.calls[0] as [string, string];
      expect(orderId).toBe('order-1');
      // Round-trips through a real Date rather than a hand-built string, so whatever
      // the browser's own local offset is, the server still receives a valid ISO
      // instant pointing at the wall-clock moment the owner actually picked.
      expect(new Date(remindAt).getFullYear()).toBe(2026);
      expect(Number.isNaN(new Date(remindAt).getTime())).toBe(false);
    });

    it('shows a set reminder with a Change/Clear pair, and Clear sends null', async () => {
      const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
      mocks.list.mockResolvedValue({ items: [order({ remind_at: farFuture })] });
      mocks.setReminder.mockResolvedValue({ updated: true });
      render(<OrdersScreen />);
      await screen.findByText('2x brake pad');

      expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Clear' }));

      await waitFor(() => expect(mocks.setReminder).toHaveBeenCalledWith('order-1', null));
    });

    it('marks a past reminder as overdue', async () => {
      const past = new Date(Date.now() - 1000 * 60 * 60).toISOString();
      mocks.list.mockResolvedValue({ items: [order({ remind_at: past })] });
      render(<OrdersScreen />);
      await screen.findByText('2x brake pad');

      expect(screen.getByText(/^Overdue reminder:/)).toBeInTheDocument();
    });
  });

  describe('highlighting the order a notification pointed at', () => {
    it('visibly marks the highlighted order and not the others', async () => {
      mocks.list.mockResolvedValue({
        items: [order({ id: 'order-1' }), order({ id: 'order-2', body: '1x oil filter' })],
      });
      render(<OrdersScreen highlightOrderId="order-2" />);
      await screen.findByText('1x oil filter');

      const highlighted = screen.getByText('1x oil filter').closest('div.rounded');
      const other = screen.getByText('2x brake pad').closest('div.rounded');
      expect(highlighted?.className).toContain('ring-2');
      expect(other?.className).not.toContain('ring-2');
    });

    it('calls onHighlightSeen after the highlight has had time to be noticed', async () => {
      vi.useFakeTimers();
      mocks.list.mockResolvedValue({ items: [order()] });
      const onHighlightSeen = vi.fn();
      render(<OrdersScreen highlightOrderId="order-1" onHighlightSeen={onHighlightSeen} />);
      await vi.waitFor(() => expect(mocks.list).toHaveBeenCalled());

      await vi.advanceTimersByTimeAsync(4000);
      expect(onHighlightSeen).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });
  });
});

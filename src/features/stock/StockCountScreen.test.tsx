/**
 * Physical stock count (Feature A.6). Load-bearing assertions:
 *
 * - an uncounted item shows "Not counted", never a computed zero discrepancy;
 * - Finalize is disabled until at least one item has been counted;
 * - cancelling calls the cancel endpoint, never finalize.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StockCountReview, StockCountSession } from '@/api/types';
import { StockCountScreen } from './StockCountScreen';

const mocks = vi.hoisted(() => ({
  listStockCounts: vi.fn(),
  startStockCount: vi.fn(),
  reviewStockCount: vi.fn(),
  recordStockCountItem: vi.fn(),
  finalizeStockCount: vi.fn(),
  cancelStockCount: vi.fn(),
}));

vi.mock('@/api/endpoints', () => ({
  inventory: {
    listStockCounts: mocks.listStockCounts,
    startStockCount: mocks.startStockCount,
    reviewStockCount: mocks.reviewStockCount,
    recordStockCountItem: mocks.recordStockCountItem,
    finalizeStockCount: mocks.finalizeStockCount,
    cancelStockCount: mocks.cancelStockCount,
  },
}));

const SESSION: StockCountSession = {
  id: 'session-1',
  status: 'open',
  notes: null,
  created_at: '2026-11-10T10:00:00Z',
  applied_at: null,
};

const REVIEW: StockCountReview = {
  session: SESSION,
  items: [
    {
      product_id: 'prod-1',
      name: 'Brake Shoe Set',
      sku: 'BR-1',
      system_quantity: '12.000',
      counted_quantity: null,
      discrepancy: null,
    },
  ],
};

const REVIEW_TWO_ITEMS: StockCountReview = {
  session: SESSION,
  items: [
    ...REVIEW.items,
    {
      product_id: 'prod-2',
      name: 'Diesel Filter',
      sku: 'TT-407-BS',
      system_quantity: '5.000',
      counted_quantity: '5.000',
      discrepancy: '0.000',
    },
  ],
};

beforeEach(() => {
  mocks.listStockCounts.mockReset();
  mocks.startStockCount.mockReset();
  mocks.reviewStockCount.mockReset();
  mocks.recordStockCountItem.mockReset();
  mocks.finalizeStockCount.mockReset();
  mocks.cancelStockCount.mockReset();
});

describe('StockCountScreen', () => {
  it('an uncounted item shows "Not counted", not a zero discrepancy', async () => {
    mocks.listStockCounts.mockResolvedValue({ items: [] });
    mocks.startStockCount.mockResolvedValue(SESSION);
    mocks.reviewStockCount.mockResolvedValue(REVIEW);

    render(<StockCountScreen open onClose={vi.fn()} onFinalized={vi.fn()} />);
    expect(await screen.findByText('Not counted')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('resumes an already-open session rather than starting a second one', async () => {
    mocks.listStockCounts.mockResolvedValue({ items: [SESSION] });
    mocks.reviewStockCount.mockResolvedValue(REVIEW);

    render(<StockCountScreen open onClose={vi.fn()} onFinalized={vi.fn()} />);
    await screen.findByText('Brake Shoe Set');
    expect(mocks.startStockCount).not.toHaveBeenCalled();
  });

  it('Finalize is disabled until something has been counted', async () => {
    mocks.listStockCounts.mockResolvedValue({ items: [] });
    mocks.startStockCount.mockResolvedValue(SESSION);
    mocks.reviewStockCount.mockResolvedValue(REVIEW);

    render(<StockCountScreen open onClose={vi.fn()} onFinalized={vi.fn()} />);
    await screen.findByText('Brake Shoe Set');
    expect(screen.getByRole('button', { name: 'Finalize' })).toBeDisabled();
  });

  it('cancelling calls the cancel endpoint, never finalize', async () => {
    mocks.listStockCounts.mockResolvedValue({ items: [] });
    mocks.startStockCount.mockResolvedValue(SESSION);
    mocks.reviewStockCount.mockResolvedValue(REVIEW);
    mocks.recordStockCountItem.mockResolvedValue(undefined);
    mocks.cancelStockCount.mockResolvedValue({ status: 'cancelled' });

    render(<StockCountScreen open onClose={vi.fn()} onFinalized={vi.fn()} />);
    await screen.findByText('Brake Shoe Set');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel Count' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }));

    await waitFor(() => expect(mocks.cancelStockCount).toHaveBeenCalledWith('session-1'));
    expect(mocks.finalizeStockCount).not.toHaveBeenCalled();
  });

  it('recording a count enables Finalize and shows the discrepancy', async () => {
    mocks.listStockCounts.mockResolvedValue({ items: [] });
    mocks.startStockCount.mockResolvedValue(SESSION);
    mocks.reviewStockCount
      .mockResolvedValueOnce(REVIEW)
      .mockResolvedValueOnce({
        session: SESSION,
        items: [{ ...REVIEW.items[0], counted_quantity: '10.000', discrepancy: '-2.000' }],
      });
    mocks.recordStockCountItem.mockResolvedValue(undefined);

    render(<StockCountScreen open onClose={vi.fn()} onFinalized={vi.fn()} />);
    await screen.findByText('Brake Shoe Set');

    const input = screen.getByLabelText('Counted quantity for Brake Shoe Set');
    await userEvent.clear(input);
    await userEvent.type(input, '10');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mocks.recordStockCountItem).toHaveBeenCalledWith('session-1', 'prod-1', '10'),
    );
    expect(await screen.findByText('-2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finalize' })).not.toBeDisabled();
  });

  describe('search', () => {
    beforeEach(() => {
      mocks.listStockCounts.mockResolvedValue({ items: [] });
      mocks.startStockCount.mockResolvedValue(SESSION);
      mocks.reviewStockCount.mockResolvedValue(REVIEW_TWO_ITEMS);
    });

    it('finds an item by exact name', async () => {
      render(<StockCountScreen open onClose={vi.fn()} onFinalized={vi.fn()} />);
      await screen.findByText('Brake Shoe Set');

      await userEvent.type(screen.getByLabelText('Find an item'), 'Diesel Filter');

      expect(screen.queryByText('Brake Shoe Set')).not.toBeInTheDocument();
      expect(screen.getByText('Diesel Filter')).toBeInTheDocument();
    });

    it('finds an item by partial, case-insensitive name', async () => {
      render(<StockCountScreen open onClose={vi.fn()} onFinalized={vi.fn()} />);
      await screen.findByText('Brake Shoe Set');

      await userEvent.type(screen.getByLabelText('Find an item'), 'brake');

      expect(screen.getByText('Brake Shoe Set')).toBeInTheDocument();
      expect(screen.queryByText('Diesel Filter')).not.toBeInTheDocument();
    });

    it('matches by SKU regardless of separators', async () => {
      render(<StockCountScreen open onClose={vi.fn()} onFinalized={vi.fn()} />);
      await screen.findByText('Brake Shoe Set');

      await userEvent.type(screen.getByLabelText('Find an item'), 'tt407');

      expect(screen.getByText('Diesel Filter')).toBeInTheDocument();
      expect(screen.queryByText('Brake Shoe Set')).not.toBeInTheDocument();
    });

    it('shows a clear empty state when nothing matches', async () => {
      render(<StockCountScreen open onClose={vi.fn()} onFinalized={vi.fn()} />);
      await screen.findByText('Brake Shoe Set');

      await userEvent.type(screen.getByLabelText('Find an item'), 'no such part');

      expect(await screen.findByText('No items match that search.')).toBeInTheDocument();
      expect(screen.queryByText('Brake Shoe Set')).not.toBeInTheDocument();
    });

    it('clearing the search shows the full list again', async () => {
      render(<StockCountScreen open onClose={vi.fn()} onFinalized={vi.fn()} />);
      await screen.findByText('Brake Shoe Set');

      const search = screen.getByLabelText('Find an item');
      await userEvent.type(search, 'Diesel');
      expect(screen.queryByText('Brake Shoe Set')).not.toBeInTheDocument();

      await userEvent.clear(search);
      expect(screen.getByText('Brake Shoe Set')).toBeInTheDocument();
      expect(screen.getByText('Diesel Filter')).toBeInTheDocument();
    });

    it('searching does not change the counted/discrepancy totals used for Finalize', async () => {
      render(<StockCountScreen open onClose={vi.fn()} onFinalized={vi.fn()} />);
      await screen.findByText('Brake Shoe Set');

      // Only "Diesel Filter" (already counted) is visible, but the progress text and
      // Finalize's enabled state must still reflect the full, unfiltered item set —
      // searching must never let an already-counted item escape the finalize count.
      await userEvent.type(screen.getByLabelText('Find an item'), 'Diesel');

      expect(screen.getByText('1 of 2 counted')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Finalize' })).not.toBeDisabled();
    });
  });
});

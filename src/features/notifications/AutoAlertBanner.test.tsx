/**
 * NAS-NEW-04: the automatic, non-toast on-screen alert banner.
 *
 * Load-bearing assertions: it renders from `items` alone (no fetch of its own),
 * "Hide" only removes an item from *this* banner and persists that across a
 * re-mount (simulating a refresh), and nothing it does ever calls a
 * dismiss/acknowledge endpoint — that stays the bell's job.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Notification } from '@/api/types';
import { getHiddenAlertIds, setHiddenAlertIds } from '@/db/meta';
import { AutoAlertBanner } from './AutoAlertBanner';

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'n-1',
    kind: 'low_stock',
    severity: 'warning',
    title: 'Brake Shoe Set is running low',
    body: '2 left, below the minimum of 10.',
    created_at: '2026-11-10T10:00:00Z',
    status: 'active',
    entity_type: 'product',
    entity_id: 'prod-1',
    read_at: null,
    ...overrides,
  };
}

beforeEach(async () => {
  // The default `db` singleton (IndexedDB, via `fake-indexeddb` — this component has
  // no way to inject a per-test instance, unlike `db/meta.ts`'s own functions), reset
  // so one test's hidden ids cannot explain another's pass.
  await setHiddenAlertIds([]);
});

describe('AutoAlertBanner', () => {
  it('renders nothing before the first poll resolves', () => {
    const { container } = render(<AutoAlertBanner items={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing once there are no active notifications', () => {
    const { container } = render(<AutoAlertBanner items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an active notification automatically, with no click required', () => {
    render(<AutoAlertBanner items={[notification()]} />);
    expect(screen.getByText('Brake Shoe Set is running low')).toBeInTheDocument();
  });

  it('"Go to" navigates and never calls a dismiss/acknowledge endpoint', async () => {
    const onNavigate = vi.fn();
    render(<AutoAlertBanner items={[notification()]} onNavigate={onNavigate} />);
    await userEvent.click(screen.getByRole('button', { name: 'Go to' }));
    expect(onNavigate).toHaveBeenCalledWith('stock', 'prod-1');
  });

  it('"Hide" removes it from the banner and survives a re-mount (a refresh)', async () => {
    const { unmount } = render(<AutoAlertBanner items={[notification()]} />);
    await userEvent.click(screen.getByRole('button', { name: /Hide/ }));
    expect(screen.queryByText('Brake Shoe Set is running low')).not.toBeInTheDocument();
    // The hide is a fire-and-forget IndexedDB write; wait for it to land before the
    // remount reads it back, the same race a real page reload would not have.
    await waitFor(async () => expect(await getHiddenAlertIds()).toEqual(['n-1']));
    unmount();

    render(<AutoAlertBanner items={[notification()]} />);
    await waitFor(() =>
      expect(screen.queryByText('Brake Shoe Set is running low')).not.toBeInTheDocument(),
    );
  });

  it('a hidden id is forgotten once the notification is no longer active, so a fresh recurrence shows again', async () => {
    // Hidden before this banner ever mounts, equivalent to a hide from an earlier session.
    await setHiddenAlertIds(['n-1']);
    const { rerender } = render(<AutoAlertBanner items={[notification()]} />);
    await waitFor(() =>
      expect(screen.queryByText('Brake Shoe Set is running low')).not.toBeInTheDocument(),
    );

    // The id is no longer in `items`, so pruning drops it from the hidden set...
    rerender(<AutoAlertBanner items={[]} />);
    await waitFor(async () => expect(await getHiddenAlertIds()).toEqual([]));

    // ...and the same id, now a fresh occurrence, is shown again rather than suppressed forever.
    rerender(<AutoAlertBanner items={[notification()]} />);
    expect(screen.getByText('Brake Shoe Set is running low')).toBeInTheDocument();
  });

  it('caps visible alerts and leaves the rest for the bell', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      notification({ id: `n-${i}`, title: `Alert ${i}` }),
    );
    render(<AutoAlertBanner items={many} />);
    expect(screen.getAllByRole('group')).toHaveLength(1);
    expect(screen.getByText('Alert 0')).toBeInTheDocument();
    expect(screen.getByText('Alert 1')).toBeInTheDocument();
    expect(screen.getByText('Alert 2')).toBeInTheDocument();
    expect(screen.queryByText('Alert 3')).not.toBeInTheDocument();
  });
});

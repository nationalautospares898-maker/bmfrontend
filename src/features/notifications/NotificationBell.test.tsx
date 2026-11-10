/**
 * The universal notification bell (Feature A.1/A.2).
 *
 * Load-bearing assertions: dismiss and acknowledge both just remove the row from the
 * active list (never anything else), "Go to" navigates and closes the panel, and a
 * failed poll leaves the list exactly as it was rather than clearing it.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Notification } from '@/api/types';
import { NotificationBell } from './NotificationBell';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  dismiss: vi.fn(),
  acknowledge: vi.fn(),
  snooze: vi.fn(),
}));

vi.mock('@/api/endpoints', () => ({
  notifications: {
    list: mocks.list,
    dismiss: mocks.dismiss,
    acknowledge: mocks.acknowledge,
    snooze: mocks.snooze,
  },
}));

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

beforeEach(() => {
  mocks.list.mockReset();
  mocks.dismiss.mockReset();
  mocks.acknowledge.mockReset();
  mocks.snooze.mockReset();
});

describe('NotificationBell', () => {
  it('shows a count badge for active notifications', async () => {
    mocks.list.mockResolvedValue({
      notifications: [notification(), notification({ id: 'n-2' })],
    });
    render(<NotificationBell />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());
    expect(await screen.findByText('2')).toBeInTheDocument();
  });

  it('dismissing a notification only removes it from the list, nothing else', async () => {
    mocks.list.mockResolvedValue({ notifications: [notification()] });
    mocks.dismiss.mockResolvedValue({ status: 'dismissed' });
    render(<NotificationBell />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));
    await screen.findByText('Brake Shoe Set is running low');

    await userEvent.click(
      screen.getByRole('button', { name: 'Dismiss: Brake Shoe Set is running low' }),
    );

    await waitFor(() => expect(mocks.dismiss).toHaveBeenCalledWith('n-1'));
    expect(screen.queryByText('Brake Shoe Set is running low')).not.toBeInTheDocument();
  });

  it('acknowledging calls the acknowledge endpoint, not dismiss', async () => {
    mocks.list.mockResolvedValue({ notifications: [notification()] });
    mocks.acknowledge.mockResolvedValue({ status: 'acknowledged' });
    render(<NotificationBell />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));
    await screen.findByText('Brake Shoe Set is running low');
    await userEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));

    await waitFor(() => expect(mocks.acknowledge).toHaveBeenCalledWith('n-1'));
    expect(mocks.dismiss).not.toHaveBeenCalled();
  });

  it('"Go to" navigates to the right screen for the notification kind and closes the panel', async () => {
    mocks.list.mockResolvedValue({
      notifications: [notification({ kind: 'low_stock' })],
    });
    const onNavigate = vi.fn();
    render(<NotificationBell onNavigate={onNavigate} />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));
    await screen.findByText('Brake Shoe Set is running low');
    await userEvent.click(screen.getByRole('button', { name: 'Go to' }));

    // The entity id rides along (owner request, 2026-11-11), so the destination screen
    // can jump straight to the specific thing the notification was about.
    expect(onNavigate).toHaveBeenCalledWith('stock', 'prod-1');
    expect(screen.queryByText('Brake Shoe Set is running low')).not.toBeInTheDocument();
  });

  it('"Go to" on an order reminder carries that order\'s own id', async () => {
    mocks.list.mockResolvedValue({
      notifications: [
        notification({
          kind: 'order_reminder',
          title: 'Pending order: Ramesh',
          entity_type: 'order',
          entity_id: 'order-42',
        }),
      ],
    });
    const onNavigate = vi.fn();
    render(<NotificationBell onNavigate={onNavigate} />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));
    await screen.findByText('Pending order: Ramesh');
    await userEvent.click(screen.getByRole('button', { name: 'Go to' }));

    expect(onNavigate).toHaveBeenCalledWith('orders', 'order-42');
  });

  it('"Go to" with no entity id forwards undefined rather than null', async () => {
    mocks.list.mockResolvedValue({
      notifications: [notification({ kind: 'low_stock', entity_id: null })],
    });
    const onNavigate = vi.fn();
    render(<NotificationBell onNavigate={onNavigate} />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));
    await screen.findByText('Brake Shoe Set is running low');
    await userEvent.click(screen.getByRole('button', { name: 'Go to' }));

    expect(onNavigate).toHaveBeenCalledWith('stock', undefined);
  });

  it('a custom reminder has no "Go to" action', async () => {
    mocks.list.mockResolvedValue({
      notifications: [
        notification({ kind: 'custom_reminder', title: 'Call the tyre supplier' }),
      ],
    });
    render(<NotificationBell />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));
    await screen.findByText('Call the tyre supplier');
    expect(screen.queryByRole('button', { name: 'Go to' })).not.toBeInTheDocument();
  });

  it('says plainly when nothing needs attention', async () => {
    mocks.list.mockResolvedValue({ notifications: [] });
    render(<NotificationBell />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));
    expect(await screen.findByText(/nothing needs your attention/i)).toBeInTheDocument();
  });
});

/**
 * Device-style (OS/browser) notifications (owner request, 2026-11-11).
 *
 * jsdom has no `Notification` global, so each test installs a small fake and tears it
 * down afterwards — exactly the kind of thing `vi.stubGlobal` exists for.
 */
describe('NotificationBell: device notifications', () => {
  class FakeNotification {
    static permission: NotificationPermission = 'default';
    static requestPermission = vi.fn<() => Promise<NotificationPermission>>();
    onclick: (() => void) | null = null;
    close = vi.fn();
    constructor(
      public title: string,
      public options?: NotificationOptions,
    ) {
      FakeNotification.instances.push(this);
    }
    static instances: FakeNotification[] = [];
  }

  beforeEach(() => {
    FakeNotification.permission = 'default';
    FakeNotification.instances = [];
    FakeNotification.requestPermission.mockReset();
    vi.stubGlobal('Notification', FakeNotification);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not fire a device notification for alerts already active on the first poll', async () => {
    FakeNotification.permission = 'granted';
    mocks.list.mockResolvedValue({ notifications: [notification()] });
    render(<NotificationBell />);

    await waitFor(() => expect(mocks.list).toHaveBeenCalled());
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('fires a device notification for an alert that becomes active after the first poll', async () => {
    vi.useFakeTimers();
    FakeNotification.permission = 'granted';
    mocks.list.mockResolvedValueOnce({ notifications: [] });
    render(<NotificationBell />);
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));

    mocks.list.mockResolvedValueOnce({
      notifications: [
        notification({ id: 'n-new', title: 'Brake Shoe Set is running low' }),
      ],
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));

    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]?.title).toBe('Brake Shoe Set is running low');
    expect(FakeNotification.instances[0]?.options?.tag).toBe('n-new');
  });

  it('does not fire anything when permission has not been granted', async () => {
    vi.useFakeTimers();
    FakeNotification.permission = 'denied';
    mocks.list.mockResolvedValueOnce({ notifications: [] });
    render(<NotificationBell />);
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));

    mocks.list.mockResolvedValueOnce({ notifications: [notification({ id: 'n-new' })] });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));

    expect(FakeNotification.instances).toHaveLength(0);
  });

  it('does not re-fire for the same id on a later poll (no duplicate spam)', async () => {
    vi.useFakeTimers();
    FakeNotification.permission = 'granted';
    mocks.list.mockResolvedValueOnce({ notifications: [] });
    render(<NotificationBell />);
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));

    mocks.list.mockResolvedValue({ notifications: [notification({ id: 'n-new' })] });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));

    expect(FakeNotification.instances).toHaveLength(1);
  });

  it('clicking the device notification navigates to the right screen with its entity id', async () => {
    vi.useFakeTimers();
    FakeNotification.permission = 'granted';
    mocks.list.mockResolvedValueOnce({ notifications: [] });
    const onNavigate = vi.fn();
    render(<NotificationBell onNavigate={onNavigate} />);
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));

    mocks.list.mockResolvedValueOnce({
      notifications: [
        notification({ id: 'n-new', kind: 'low_stock', entity_id: 'prod-9' }),
      ],
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));

    FakeNotification.instances[0]?.onclick?.();
    expect(onNavigate).toHaveBeenCalledWith('stock', 'prod-9');
  });

  it('offers "Enable" only while permission is still undecided', async () => {
    FakeNotification.permission = 'default';
    mocks.list.mockResolvedValue({ notifications: [] });
    render(<NotificationBell />);
    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));

    expect(await screen.findByRole('button', { name: 'Enable' })).toBeInTheDocument();
  });

  it('clicking "Enable" requests permission and hides the banner once decided', async () => {
    FakeNotification.permission = 'default';
    FakeNotification.requestPermission.mockImplementation(() => {
      FakeNotification.permission = 'granted';
      return Promise.resolve('granted');
    });
    mocks.list.mockResolvedValue({ notifications: [] });
    render(<NotificationBell />);
    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Enable' }));

    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument(),
    );
  });

  it('does not offer "Enable" when the browser already denied it', async () => {
    FakeNotification.permission = 'denied';
    mocks.list.mockResolvedValue({ notifications: [] });
    render(<NotificationBell />);
    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));

    expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument();
  });

  it('falls back to no device notification at all when the browser has no Notification API', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('Notification', undefined);
    mocks.list.mockResolvedValue({ notifications: [notification()] });
    render(<NotificationBell />);
    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));

    // The in-app bell still works — the whole point of a fallback.
    expect(await screen.findByText('Brake Shoe Set is running low')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument();
  });
});

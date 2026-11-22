/**
 * The redesigned notification panel.
 *
 * What is worth testing about a visual change is the part that is **not** visual: the
 * popover behaviour (Escape, outside click, focus return), the severity grouping, and
 * that the severity still reaches the user as a word rather than only as a colour —
 * that last one is a hard rule (§10), not a preference.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { Notification } from '@/api/types';
import { NotificationPanel, type NotificationScreen } from './NotificationPanel';

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'n-1',
    kind: 'low_stock',
    severity: 'warning',
    title: 'Brake Shoe Set is running low',
    body: '2 left, below the minimum of 10.',
    created_at: new Date().toISOString(),
    status: 'active',
    entity_type: 'product',
    entity_id: 'prod-1',
    read_at: null,
    ...overrides,
  };
}

function screenFor(kind: string): NotificationScreen | null {
  return kind === 'low_stock' ? 'stock' : null;
}

interface Overrides {
  items?: Notification[] | null;
  error?: string | null;
  busyId?: string | null;
  onClose?: () => void;
  onNavigate?: (screen: NotificationScreen, entityId?: string) => void;
  onAcknowledge?: (id: string) => void;
  onSnooze?: (id: string) => void;
  onDismiss?: (id: string) => void;
  onManageReminders?: () => void;
}

function renderPanel(overrides: Overrides = {}) {
  const bell = document.createElement('button');
  bell.textContent = 'bell';
  document.body.appendChild(bell);
  const returnFocusTo = createRef<HTMLElement>();
  returnFocusTo.current = bell;

  const handlers = {
    onClose: overrides.onClose ?? vi.fn(),
    onNavigate: overrides.onNavigate ?? vi.fn(),
    onAcknowledge: overrides.onAcknowledge ?? vi.fn(),
    onSnooze: overrides.onSnooze ?? vi.fn(),
    onDismiss: overrides.onDismiss ?? vi.fn(),
  };

  const view = render(
    <NotificationPanel
      open
      items={overrides.items === undefined ? [notification()] : overrides.items}
      error={overrides.error ?? null}
      busyId={overrides.busyId ?? null}
      returnFocusTo={returnFocusTo}
      screenFor={screenFor}
      onManageReminders={overrides.onManageReminders}
      {...handlers}
    />,
  );

  return { ...view, bell, ...handlers };
}

describe('NotificationPanel: popover behaviour', () => {
  it('is a labelled, non-modal dialog — the work behind it is still available', () => {
    renderPanel();
    const panel = screen.getByRole('dialog');

    expect(panel).toHaveAccessibleName('Notifications');
    // Not `true`: the billing screen behind this is genuinely still usable, and
    // claiming otherwise would make a screen reader hide it.
    expect(panel).toHaveAttribute('aria-modal', 'false');
  });

  it('moves focus into the panel when it opens', () => {
    renderPanel();
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('Escape closes it and returns focus to the bell', async () => {
    const onClose = vi.fn();
    const { bell } = renderPanel({ onClose });

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
    expect(bell).toHaveFocus();
  });

  it('a click outside closes it', async () => {
    const onClose = vi.fn();
    renderPanel({ onClose });

    await userEvent.click(document.body);

    expect(onClose).toHaveBeenCalled();
  });

  it('a click inside does not close it', async () => {
    const onClose = vi.fn();
    renderPanel({ onClose });

    await userEvent.click(screen.getByText('Brake Shoe Set is running low'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('a click on the bell itself does not close it — the bell toggles', async () => {
    // Otherwise one press would close here and reopen there, or vice versa.
    const onClose = vi.fn();
    const { bell } = renderPanel({ onClose });

    await userEvent.click(bell);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('the Close button closes it', async () => {
    const onClose = vi.fn();
    renderPanel({ onClose });

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalled();
  });

  it('renders nothing at all when closed', () => {
    const returnFocusTo = createRef<HTMLElement>();
    render(
      <NotificationPanel
        open={false}
        items={[notification()]}
        error={null}
        busyId={null}
        returnFocusTo={returnFocusTo}
        screenFor={screenFor}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        onAcknowledge={vi.fn()}
        onSnooze={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('NotificationPanel: presentation', () => {
  it('states the severity in words, never by colour alone', () => {
    renderPanel({
      items: [
        notification({ id: 'c', severity: 'critical', title: 'Out of stock' }),
        notification({ id: 'w', severity: 'warning', title: 'Running low' }),
        notification({ id: 'i', severity: 'info', title: 'New order' }),
      ],
    });

    // Each card's own chip, which is what a card read in isolation has to carry.
    expect(screen.getByText('Urgent')).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('For information')).toBeInTheDocument();
    // And the section headings, which carry the count rather than repeating the word.
    expect(screen.getByRole('heading', { name: 'Urgent · 1' })).toBeInTheDocument();
  });

  it('groups by severity, urgent first', () => {
    renderPanel({
      items: [
        notification({ id: 'i', severity: 'info', title: 'New order' }),
        notification({ id: 'c', severity: 'critical', title: 'Out of stock' }),
      ],
    });

    const sections = screen.getAllByRole('region');
    // `aria-label` on each `<section>` names the group it holds.
    expect(sections[0]).toHaveAccessibleName('Urgent');
    expect(
      within(sections[0] as HTMLElement).getByText('Out of stock'),
    ).toBeInTheDocument();
    expect(sections[1]).toHaveAccessibleName('For information');
  });

  it('omits a group heading when nothing is in it', () => {
    renderPanel({ items: [notification({ severity: 'warning' })] });

    expect(
      screen.getByRole('heading', { name: 'Needs attention · 1' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Urgent/ })).not.toBeInTheDocument();
  });

  it('shows a relative timestamp on each card', () => {
    renderPanel({
      items: [notification({ created_at: new Date(Date.now() - 125_000).toISOString() })],
    });

    expect(screen.getByText('2 minutes ago')).toBeInTheDocument();
  });

  it('shows a helpful empty state rather than a blank panel', () => {
    renderPanel({ items: [] });

    expect(
      screen.getByText('Nothing needs your attention right now.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Low stock, pending bills and saved orders will show up here.'),
    ).toBeInTheDocument();
  });

  it('shows a loading state before the first payload', () => {
    renderPanel({ items: null });

    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });

  it('surfaces an action error as an alert', () => {
    renderPanel({ error: 'Could not update that notification. Try again.' });

    expect(screen.getByRole('alert')).toHaveTextContent('Could not update');
  });

  it('summarises the count in the header', () => {
    renderPanel({ items: [notification({ id: 'a' }), notification({ id: 'b' })] });
    expect(screen.getByText('2 notifications')).toBeInTheDocument();
  });

  it('an unrecognised severity is shown as information rather than dropped', () => {
    // A notification the owner cannot see is worse than one in the wrong group.
    renderPanel({ items: [notification({ severity: 'catastrophic' })] });

    expect(screen.getByText('Brake Shoe Set is running low')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'For information · 1' }),
    ).toBeInTheDocument();
  });
});

describe('NotificationPanel: actions', () => {
  it('"Go to" navigates with the entity id and closes the panel', async () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    renderPanel({ onNavigate, onClose });

    await userEvent.click(screen.getByRole('button', { name: 'Go to' }));

    expect(onNavigate).toHaveBeenCalledWith('stock', 'prod-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('a notification whose kind has no destination offers no "Go to"', () => {
    renderPanel({ items: [notification({ kind: 'custom_reminder' })] });
    expect(screen.queryByRole('button', { name: 'Go to' })).not.toBeInTheDocument();
  });

  it('acknowledge, snooze and dismiss each call their own handler', async () => {
    const onAcknowledge = vi.fn();
    const onSnooze = vi.fn();
    const onDismiss = vi.fn();
    renderPanel({ onAcknowledge, onSnooze, onDismiss });

    await userEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await userEvent.click(screen.getByRole('button', { name: 'Snooze 1 hour' }));
    await userEvent.click(
      screen.getByRole('button', { name: 'Dismiss: Brake Shoe Set is running low' }),
    );

    expect(onAcknowledge).toHaveBeenCalledWith('n-1');
    expect(onSnooze).toHaveBeenCalledWith('n-1');
    expect(onDismiss).toHaveBeenCalledWith('n-1');
  });

  it('"Manage reminders" is offered only when the caller provides it', async () => {
    const onManageReminders = vi.fn();
    const { unmount } = renderPanel({ onManageReminders });
    await userEvent.click(screen.getByRole('button', { name: 'Manage reminders' }));
    expect(onManageReminders).toHaveBeenCalled();
    unmount();

    renderPanel();
    expect(
      screen.queryByRole('button', { name: 'Manage reminders' }),
    ).not.toBeInTheDocument();
  });
});

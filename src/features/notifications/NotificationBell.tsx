/**
 * The universal notification bell (Feature A.1/A.2).
 *
 * Lives in `AppShell`'s header, so it is reachable from every screen rather than one
 * page's own corner — the owner's complaint about the previous design was exactly that
 * low-stock alerts lived only on the Stock screen.
 *
 * ## The lifecycle, and why dismiss and acknowledge are both offered
 *
 * `POST /notifications/{id}:dismiss` and `:acknowledge` do the same thing to this row
 * — both just stop it being active — and are offered as two differently-labelled
 * buttons anyway, because the **word** is the point: dismissing a low-stock notice
 * must never be mistaken for having restocked it, and acknowledging a bill reminder
 * must never be mistaken for the bill being paid. The server enforces the same
 * distinction (`domain/notifications/service.py` — only application code that
 * performed the actual fix may `resolve`), this screen just uses whichever word the
 * owner would use for what they are about to do.
 *
 * ## How notifications get here
 *
 * Not on a 30-second timer any more (owner request, 2026-11-22). `notificationsPoller`
 * fetches when the person does something that could have made the list stale — signing
 * in, returning to the tab, reconnecting, **opening this panel** — and otherwise sleeps
 * for exactly as long as the server says the next scheduled notification is away. This
 * component does not decide when a request happens; it subscribes, renders, and asks for
 * one refresh when the panel is opened.
 *
 * ## What this component owns and what it delegates
 *
 * It owns the bell, the badge, the notification state and the lifecycle actions.
 * `NotificationPanel` owns the panel's appearance, grouping and popover behaviour. The
 * split keeps the state logic testable without a DOM full of presentation, and keeps the
 * presentation replaceable without touching the single-flight contract underneath it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { notifications as notificationsApi } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import type { Notification } from '@/api/types';
import { Panel } from '@/components/primitives';
import * as deviceNotifications from '@/lib/deviceNotifications';
import { NOTIFICATIONS } from '@/lib/strings';
import { NotificationPanel, type NotificationScreen } from './NotificationPanel';
import { refreshNotifications, subscribeToNotifications } from './notificationsPoller';

/** Which screen a notification's own "Go to" action should open, if any. */
function screenFor(kind: string): NotificationScreen | null {
  switch (kind) {
    case 'low_stock':
    case 'stock_reminder':
      return 'stock';
    case 'overdue_credit':
    case 'bill_reminder':
      return 'credit-bills';
    case 'order_reminder':
      return 'orders';
    default:
      return null;
  }
}

export interface NotificationBellProps {
  /**
   * Opens the named screen and closes the panel — wired to `AppShell`'s `setScreen`.
   *
   * `entityId` (owner request, 2026-11-11) carries the specific thing the notification
   * was about — e.g. the order id behind an `order_reminder` — so the destination
   * screen can highlight that one row rather than only opening onto the general list.
   * `undefined` when a notification's kind has no single entity to jump to.
   */
  onNavigate?: (screen: NotificationScreen, entityId?: string) => void;
  /** Opens the reminder-management dialog (Feature A.5), if the caller offers one. */
  onManageReminders?: () => void;
  /**
   * Mirrors this bell's own `items` up to whoever renders it (NAS-NEW-04), so an
   * always-on-screen alert banner can show the same active notifications without a
   * second fetch of its own — this bell already has the one feed the whole app needs,
   * and the banner is just another view of the same data, including this component's
   * own optimistic removals on dismiss/acknowledge/snooze. Called with the same value
   * every time `items` changes, nothing else.
   */
  onItemsChanged?: (items: Notification[] | null) => void;
}

export function NotificationBell({
  onNavigate,
  onManageReminders,
  onItemsChanged,
}: NotificationBellProps) {
  const [items, setItems] = useState<Notification[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [devicePermission, setDevicePermission] =
    useState<deviceNotifications.DevicePermission>(
      deviceNotifications.currentPermission(),
    );

  /** The bell button, so the panel can anchor to it and return focus to it. */
  const bellRef = useRef<HTMLButtonElement | null>(null);

  /**
   * Which active ids have already been shown as a **device** notification this
   * session, so a fetch that re-reads the same still-open alert never shows it
   * twice. A ref, not state: it must survive every update without itself triggering a
   * re-render, and it is read and written only inside `receive()`.
   */
  const deviceShown = useRef<Set<string>>(new Set());
  /**
   * False until the first payload arrives. That payload is the business's
   * **already-existing** state, not a new event — logging in to five pre-existing
   * low-stock alerts must not detonate five OS popups at once. Only an id that
   * appears in a **later** payload, having not been in an earlier one, is an event this
   * session actually witnessed happen.
   */
  const hasLoadedOnce = useRef(false);

  /**
   * `AppShell` passes `onNavigate` as a fresh inline function on every one of its own
   * renders (it is not memoised, and must not need to be just to satisfy this
   * component), so nothing this component schedules may depend on its identity. The
   * original defect was exactly that: the fetch's `useEffect` depended on a callback
   * rebuilt from `onNavigate`, so every parent re-render tore the subscription down and
   * fired an immediate, unscheduled request — and since every fetch fed its result back
   * to `AppShell` via `onItemsChanged`, every fetch caused the re-render that triggered
   * the next one. A ref breaks that cycle: the latest callback is readable without
   * anything needing to change identity when it does.
   */
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  /**
   * Handle one payload. Stable identity (no dependencies) so the subscription effect
   * below runs exactly once per mount, whatever the parent re-renders.
   */
  const receive = useCallback((incoming: Notification[]) => {
    setItems(incoming);
    setError(null);

    if (hasLoadedOnce.current) {
      for (const n of incoming) {
        if (deviceShown.current.has(n.id)) continue;
        if (deviceNotifications.currentPermission() === 'granted') {
          const target = screenFor(n.kind);
          deviceNotifications.show(n.id, n.title, {
            ...(n.body ? { body: n.body } : {}),
            ...(target
              ? {
                  onClick: () =>
                    onNavigateRef.current?.(target, n.entity_id ?? undefined),
                }
              : {}),
          });
        }
      }
    }
    for (const n of incoming) deviceShown.current.add(n.id);
    hasLoadedOnce.current = true;
  }, []);

  useEffect(() => subscribeToNotifications(receive), [receive]);

  useEffect(() => {
    onItemsChanged?.(items);
  }, [items, onItemsChanged]);

  async function enableDeviceAlerts(): Promise<void> {
    setDevicePermission(await deviceNotifications.requestPermission());
  }

  /**
   * Opening the panel is an explicit "show me", so it asks for a refresh — one of the
   * interaction triggers that replaced the unconditional timer. The poller's floor means
   * opening and closing it repeatedly cannot turn into a stream of requests.
   */
  function togglePanel(): void {
    setOpen((wasOpen) => {
      if (!wasOpen) void refreshNotifications();
      return !wasOpen;
    });
  }

  async function act(
    action: (id: string) => Promise<{ status: string }>,
    notificationId: string,
  ): Promise<void> {
    setBusyId(notificationId);
    setError(null);
    try {
      await action(notificationId);
      setItems((prev) => (prev ? prev.filter((n) => n.id !== notificationId) : prev));
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? describeError(caught.code).message
          : NOTIFICATIONS.actionFailed,
      );
    } finally {
      setBusyId(null);
    }
  }

  const count = items?.length ?? 0;
  const hasCritical = Boolean(items?.some((n) => n.severity === 'critical'));

  return (
    // `relative` so the panel can anchor to the bell rather than to the viewport.
    <div className="relative">
      <button
        ref={bellRef}
        type="button"
        aria-label={NOTIFICATIONS.bellLabel(count)}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={togglePanel}
        // A 40px target (§10), square, with the badge overhanging the corner rather
        // than crowding the glyph.
        className={`relative inline-flex h-10 w-10 items-center justify-center rounded-lg border text-lg transition-colors duration-150 ${
          open
            ? 'border-nas-navy bg-slate-100'
            : 'border-slate-300 bg-white hover:bg-slate-50'
        }`}
      >
        <span aria-hidden>{NOTIFICATIONS.bellIcon}</span>
        {count > 0 ? (
          <span
            aria-hidden
            // `ring-white` lifts the badge off the bell's own border so the digits stay
            // legible at a glance. Red only for a genuinely urgent item; the navy
            // carries an ordinary count, so red keeps meaning something.
            className={`nas-notification-badge absolute -right-1.5 -top-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[0.6875rem] font-bold leading-none text-white ring-2 ring-white ${
              hasCritical ? 'bg-red-600' : 'bg-nas-navy'
            }`}
          >
            {count > 99 ? NOTIFICATIONS.badgeOverflow : count}
          </span>
        ) : null}
      </button>

      <NotificationPanel
        open={open}
        items={items}
        error={error}
        busyId={busyId}
        returnFocusTo={bellRef}
        onClose={() => setOpen(false)}
        onNavigate={(screen, entityId) => onNavigate?.(screen, entityId)}
        onAcknowledge={(id) => void act((n) => notificationsApi.acknowledge(n), id)}
        onSnooze={(id) => void act((n) => notificationsApi.snooze(n, 60), id)}
        onDismiss={(id) => void act((n) => notificationsApi.dismiss(n), id)}
        onManageReminders={onManageReminders}
        screenFor={screenFor}
        devicePrompt={
          devicePermission === 'default' ? (
            <div className="p-3">
              <Panel tone="info">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{NOTIFICATIONS.enableDevice}</span>
                  <button
                    type="button"
                    onClick={() => void enableDeviceAlerts()}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50"
                  >
                    {NOTIFICATIONS.enableDeviceAction}
                  </button>
                </div>
              </Panel>
            </div>
          ) : null
        }
      />
    </div>
  );
}

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
 * ## Why this polls instead of pushing
 *
 * No websocket, no SSE — this is a single-counter shop application, and a 30-second
 * poll is indistinguishable from "live" at that scale while adding no server process
 * to operate. Polling also means a notification raised by the worker between polls
 * survives a refresh exactly like any other server state, which a client-only timer
 * would not (the owner's explicit requirement for Feature A.5's reminders, which
 * surface through this same bell).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { notifications as notificationsApi } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import type { Notification } from '@/api/types';
import { Busy, Button, Dialog, Panel } from '@/components/primitives';
import * as deviceNotifications from '@/lib/deviceNotifications';
import { NOTIFICATIONS } from '@/lib/strings';

const POLL_INTERVAL_MS = 30_000;

/** Which screen a notification's own "Go to" action should open, if any. */
function screenFor(kind: string): 'stock' | 'credit-bills' | 'orders' | null {
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

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'bg-red-100 text-red-900',
  warning: 'bg-amber-100 text-amber-900',
  info: 'bg-slate-100 text-slate-700',
};

export interface NotificationBellProps {
  /**
   * Opens the named screen and closes the panel — wired to `AppShell`'s `setScreen`.
   *
   * `entityId` (owner request, 2026-11-11) carries the specific thing the notification
   * was about — e.g. the order id behind an `order_reminder` — so the destination
   * screen can highlight that one row rather than only opening onto the general list.
   * `undefined` when a notification's kind has no single entity to jump to.
   */
  onNavigate?: (screen: 'stock' | 'credit-bills' | 'orders', entityId?: string) => void;
  /** Opens the reminder-management dialog (Feature A.5), if the caller offers one. */
  onManageReminders?: () => void;
}

export function NotificationBell({
  onNavigate,
  onManageReminders,
}: NotificationBellProps) {
  const [items, setItems] = useState<Notification[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [devicePermission, setDevicePermission] =
    useState<deviceNotifications.DevicePermission>(
      deviceNotifications.currentPermission(),
    );

  /**
   * Which active ids have already been shown as a **device** notification this
   * session, so a poll that re-fetches the same still-open alert never shows it
   * twice. A ref, not state: it must survive every poll without itself triggering a
   * re-render, and it is read and written only inside `load()`.
   */
  const deviceShown = useRef<Set<string>>(new Set());
  /**
   * False until the first poll resolves. The first poll's results are each business's
   * **already-existing** state, not a new event — logging in to five pre-existing
   * low-stock alerts must not detonate five OS popups at once. Only an id that
   * appears in a **later** poll, having not been in an earlier one, is an event this
   * session actually witnessed happen.
   */
  const hasLoadedOnce = useRef(false);

  const load = useCallback(async () => {
    try {
      const response = await notificationsApi.list();
      setItems(response.notifications);
      setError(null);

      if (hasLoadedOnce.current) {
        for (const n of response.notifications) {
          if (deviceShown.current.has(n.id)) continue;
          if (deviceNotifications.currentPermission() === 'granted') {
            const target = screenFor(n.kind);
            deviceNotifications.show(n.id, n.title, {
              ...(n.body ? { body: n.body } : {}),
              ...(target
                ? { onClick: () => onNavigate?.(target, n.entity_id ?? undefined) }
                : {}),
            });
          }
        }
      }
      for (const n of response.notifications) deviceShown.current.add(n.id);
      hasLoadedOnce.current = true;
    } catch {
      // A failed poll must not spam the owner with an error every 30 seconds — it
      // just tries again next tick, and keeps whatever list was last shown.
    }
  }, [onNavigate]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  async function enableDeviceAlerts(): Promise<void> {
    setDevicePermission(await deviceNotifications.requestPermission());
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

  return (
    <>
      <Button
        variant="secondary"
        aria-label={NOTIFICATIONS.bellLabel(count)}
        onClick={() => setOpen(true)}
        className="relative"
      >
        {NOTIFICATIONS.bellIcon}
        {count > 0 ? (
          <span
            className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-xs font-semibold text-white"
            aria-hidden
          >
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
      </Button>

      <Dialog
        open={open}
        title={NOTIFICATIONS.panelTitle}
        onDismiss={() => setOpen(false)}
        actions={
          <>
            {onManageReminders ? (
              <Button variant="quiet" onClick={onManageReminders}>
                {NOTIFICATIONS.manageReminders}
              </Button>
            ) : null}
            <Button onClick={() => setOpen(false)}>{NOTIFICATIONS.close}</Button>
          </>
        }
      >
        {error ? <Panel tone="danger">{error}</Panel> : null}
        {devicePermission === 'default' ? (
          <Panel tone="info">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{NOTIFICATIONS.enableDevice}</span>
              <Button variant="secondary" onClick={() => void enableDeviceAlerts()}>
                {NOTIFICATIONS.enableDeviceAction}
              </Button>
            </div>
          </Panel>
        ) : null}
        {items === null ? (
          <Busy label={NOTIFICATIONS.loading} />
        ) : items.length === 0 ? (
          <Panel tone="info">{NOTIFICATIONS.empty}</Panel>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((n) => {
              const target = screenFor(n.kind);
              return (
                <li
                  key={n.id}
                  className="flex flex-col gap-1 rounded border border-slate-200 p-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <span
                        className={`mr-2 rounded px-1 text-xs font-medium ${SEVERITY_BADGE[n.severity] ?? SEVERITY_BADGE.info}`}
                      >
                        {n.severity}
                      </span>
                      <span className="font-medium">{n.title}</span>
                      {n.body ? <p className="text-sm text-slate-600">{n.body}</p> : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {target ? (
                      <Button
                        variant="quiet"
                        disabled={busyId === n.id}
                        onClick={() => {
                          onNavigate?.(target, n.entity_id ?? undefined);
                          setOpen(false);
                        }}
                      >
                        {NOTIFICATIONS.goTo}
                      </Button>
                    ) : null}
                    <Button
                      variant="quiet"
                      busy={busyId === n.id}
                      onClick={() =>
                        void act((id) => notificationsApi.acknowledge(id), n.id)
                      }
                    >
                      {NOTIFICATIONS.acknowledge}
                    </Button>
                    <Button
                      variant="quiet"
                      disabled={busyId === n.id}
                      onClick={() =>
                        void act((id) => notificationsApi.snooze(id, 60), n.id)
                      }
                    >
                      {NOTIFICATIONS.snooze}
                    </Button>
                    <Button
                      variant="quiet"
                      busy={busyId === n.id}
                      onClick={() => void act((id) => notificationsApi.dismiss(id), n.id)}
                      aria-label={NOTIFICATIONS.dismissLabel(n.title)}
                    >
                      {NOTIFICATIONS.dismiss}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Dialog>
    </>
  );
}

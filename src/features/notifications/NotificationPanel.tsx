/**
 * The notification panel: a right-anchored dropdown, grouped by severity.
 *
 * ## Why this is not the shared `Dialog`
 *
 * It used to be. A centred modal with a dimmed backdrop is the right shape for "answer
 * this question before continuing", which is what `components/primitives.tsx`'s `Dialog`
 * is built for and why every other caller uses it — and it is the wrong shape for
 * glancing at a list. It covered the billing grid, and the cashier had to dismiss a
 * modal to get back to the bill they were in the middle of.
 *
 * So this is a popover: anchored under the bell, non-modal, the work behind it still
 * visible and still there when the panel closes. That is the pattern every application
 * the owner compared this to uses, and the reason is the same in all of them.
 *
 * It is a **local** component rather than a new shared primitive, deliberately. The
 * notification redesign is scoped to notifications; adding a `Popover` to
 * `primitives.tsx` would put a new shared abstraction in front of every other screen's
 * future, on the strength of one caller.
 *
 * ## Accessibility, since this is hand-rolled rather than inherited
 *
 * * `role="dialog"` + `aria-modal="false"` + `aria-labelledby` — a labelled, non-modal
 *   region, which is what a popover is. Not `aria-modal="true"`: the content behind it
 *   is genuinely still available, and claiming otherwise would make a screen reader hide
 *   the billing screen the cashier can plainly still use.
 * * **Escape closes it**, from anywhere inside.
 * * **A click outside closes it** — but `mousedown`, not `click`, so pressing a button
 *   behind the panel does not land on whatever moved under the cursor after the panel
 *   collapsed.
 * * **Focus moves into the panel on open and returns to the bell on close.** The bell is
 *   where the user was; dropping focus on `<body>` would mean the next `Tab` restarts
 *   from the top of the page.
 * * No focus *trap*. Tabbing out of a non-modal popover is legitimate, and the panel
 *   closes when focus leaves it, so the keyboard never ends up typing into a bill with
 *   a panel still open over it.
 *
 * ## Grouping
 *
 * Urgent / Needs attention / For information, in that order, each heading rendered only
 * when it has cards. The server already sorts by severity then recency
 * (`domain/notifications/service.active_for`), so this adds headings to an order that is
 * already correct rather than re-sorting it — and headings are what make a list of
 * fifteen scannable instead of a wall.
 */

import { useCallback, useEffect, useId, useRef } from 'react';

import type { Notification } from '@/api/types';
import { Busy, Button } from '@/components/primitives';
import { NOTIFICATIONS } from '@/lib/strings';
import { relativeTime } from './notificationTime';

export type NotificationScreen = 'stock' | 'credit-bills' | 'orders';

interface SeverityTone {
  /** The coloured rail down the card's left edge — the quick read. */
  rail: string;
  /** The chip behind the severity *word* — the accessible read. */
  chip: string;
  /** A shape, so the chip is distinguishable without colour at all. */
  icon: string;
  group: string;
}

/**
 * The order groups appear in. Matches the server's own severity ranking
 * (`domain/notifications/service.active_for`), so the headings follow the list's
 * existing order rather than re-sorting it.
 */
const GROUP_ORDER = ['critical', 'warning', 'info'] as const;
type SeverityKey = (typeof GROUP_ORDER)[number];

const SEVERITY: Record<SeverityKey, SeverityTone> = {
  critical: {
    rail: 'bg-red-600',
    chip: 'bg-red-50 text-red-900 ring-1 ring-red-200',
    icon: '●',
    group: NOTIFICATIONS.groupUrgent,
  },
  warning: {
    rail: 'bg-amber-500',
    chip: 'bg-amber-50 text-amber-900 ring-1 ring-amber-200',
    icon: '▲',
    group: NOTIFICATIONS.groupAttention,
  },
  info: {
    rail: 'bg-slate-400',
    chip: 'bg-slate-100 text-slate-700 ring-1 ring-slate-200',
    icon: '■',
    group: NOTIFICATIONS.groupInfo,
  },
};

/**
 * `severity` arrives as a plain string from the API. An unrecognised value — a severity
 * the backend adds before this screen knows about it — is shown as information rather
 * than crashing or vanishing: a notification the owner cannot see is worse than one
 * shown in the wrong group.
 */
function severityKey(severity: string): SeverityKey {
  return severity === 'critical' || severity === 'warning' || severity === 'info'
    ? severity
    : 'info';
}

function severityOf(severity: string): SeverityTone {
  return SEVERITY[severityKey(severity)];
}

export interface NotificationPanelProps {
  open: boolean;
  items: Notification[] | null;
  error: string | null;
  /** Which card is mid-action, so only that card's buttons show busy. */
  busyId: string | null;
  /** The element focus returns to when the panel closes — the bell. */
  returnFocusTo: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onNavigate: (screen: NotificationScreen, entityId?: string) => void;
  onAcknowledge: (id: string) => void;
  onSnooze: (id: string) => void;
  onDismiss: (id: string) => void;
  onManageReminders?: (() => void) | undefined;
  /** The "turn on device alerts" prompt, rendered by the bell and slotted in here. */
  devicePrompt?: React.ReactNode;
  screenFor: (kind: string) => NotificationScreen | null;
}

export function NotificationPanel({
  open,
  items,
  error,
  busyId,
  returnFocusTo,
  onClose,
  onNavigate,
  onAcknowledge,
  onSnooze,
  onDismiss,
  onManageReminders,
  devicePrompt,
  screenFor,
}: NotificationPanelProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => {
    // Return focus before the panel unmounts, or the browser drops it on `<body>`.
    if (returnFocusTo.current?.isConnected) returnFocusTo.current.focus();
    onClose();
  }, [onClose, returnFocusTo]);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panel.current?.contains(target)) return;
      // The bell itself is excluded: its own click handler toggles the panel, and
      // closing here as well would reopen-then-close on a single press.
      if (returnFocusTo.current?.contains(target)) return;
      close();
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open, close, returnFocusTo]);

  if (!open) return null;

  const count = items?.length ?? 0;

  return (
    <div
      ref={panel}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      // Anchored to the bell's wrapper. `max-h` + an inner scroll region so a long list
      // scrolls inside the panel rather than growing past the bottom of the window;
      // `w-[min(…)]` so it never overflows a narrow viewport.
      className="nas-notification-panel absolute right-0 top-full z-50 mt-2 flex w-[min(26rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl"
    >
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div>
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            {NOTIFICATIONS.panelTitle}
          </h2>
          {count > 0 ? (
            <p className="text-[0.8125rem] text-slate-500">
              {NOTIFICATIONS.countSummary(count)}
            </p>
          ) : null}
        </div>
        <Button variant="quiet" onClick={close}>
          {NOTIFICATIONS.close}
        </Button>
      </header>

      <div className="max-h-[min(28rem,60vh)] overflow-y-auto overscroll-contain">
        {error ? (
          <p
            role="alert"
            className="m-3 rounded-lg border-l-4 border-red-600 bg-red-50 p-3 text-sm text-red-900"
          >
            {error}
          </p>
        ) : null}

        {devicePrompt}

        {items === null ? (
          <div className="px-4 py-8 text-center">
            <Busy label={NOTIFICATIONS.loading} />
          </div>
        ) : items.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p aria-hidden className="text-2xl">
              {NOTIFICATIONS.bellIcon}
            </p>
            <p className="mt-2 text-sm font-medium text-slate-700">
              {NOTIFICATIONS.empty}
            </p>
            <p className="mt-1 text-[0.8125rem] text-slate-500">
              {NOTIFICATIONS.emptySubtitle}
            </p>
          </div>
        ) : (
          GROUP_ORDER.map((severity) => {
            const group = items.filter((n) => severityKey(n.severity) === severity);
            if (group.length === 0) return null;
            return (
              <section key={severity} aria-label={SEVERITY[severity].group}>
                <h3 className="sticky top-0 z-10 bg-slate-50/95 px-4 py-1.5 text-[0.75rem] font-semibold uppercase tracking-wide text-slate-500 backdrop-blur">
                  {NOTIFICATIONS.groupHeading(SEVERITY[severity].group, group.length)}
                </h3>
                <ul className="flex flex-col">
                  {group.map((n) => (
                    <NotificationCard
                      key={n.id}
                      notification={n}
                      busy={busyId === n.id}
                      target={screenFor(n.kind)}
                      onNavigate={(screen, entityId) => {
                        onNavigate(screen, entityId);
                        close();
                      }}
                      onAcknowledge={onAcknowledge}
                      onSnooze={onSnooze}
                      onDismiss={onDismiss}
                    />
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>

      {onManageReminders ? (
        <footer className="border-t border-slate-200 bg-slate-50 px-4 py-2">
          <Button variant="quiet" onClick={onManageReminders}>
            {NOTIFICATIONS.manageReminders}
          </Button>
        </footer>
      ) : null}
    </div>
  );
}

interface NotificationCardProps {
  notification: Notification;
  busy: boolean;
  target: NotificationScreen | null;
  onNavigate: (screen: NotificationScreen, entityId?: string) => void;
  onAcknowledge: (id: string) => void;
  onSnooze: (id: string) => void;
  onDismiss: (id: string) => void;
}

/**
 * One notification.
 *
 * The severity rail down the left edge is the quick read; the chip next to the title
 * carries the same information **in words**, because status is never colour alone (§10)
 * and a cashier with colour-blindness has to get the urgency from the same glance.
 */
function NotificationCard({
  notification: n,
  busy,
  target,
  onNavigate,
  onAcknowledge,
  onSnooze,
  onDismiss,
}: NotificationCardProps) {
  const tone = severityOf(n.severity);
  const when = relativeTime(n.created_at);

  return (
    <li className="nas-notification-card relative border-b border-slate-100 pl-4 pr-3 py-3 last:border-b-0 hover:bg-slate-50/80">
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${tone.rail}`} />

      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.75rem] font-medium ${tone.chip}`}
        >
          <span aria-hidden className="text-[0.625rem]">
            {tone.icon}
          </span>
          {NOTIFICATIONS.severityLabel(n.severity)}
        </span>
        {when ? (
          <time dateTime={n.created_at} className="text-[0.75rem] text-slate-500">
            {when}
          </time>
        ) : null}
      </div>

      <p className="mt-1.5 text-sm font-semibold text-slate-900">{n.title}</p>
      {n.body ? <p className="mt-0.5 text-sm text-slate-600">{n.body}</p> : null}

      <div className="mt-2 flex flex-wrap gap-1">
        {target ? (
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => onNavigate(target, n.entity_id ?? undefined)}
          >
            {NOTIFICATIONS.goTo}
          </Button>
        ) : null}
        <Button variant="quiet" busy={busy} onClick={() => onAcknowledge(n.id)}>
          {NOTIFICATIONS.acknowledge}
        </Button>
        <Button variant="quiet" disabled={busy} onClick={() => onSnooze(n.id)}>
          {NOTIFICATIONS.snooze}
        </Button>
        <Button
          variant="quiet"
          busy={busy}
          onClick={() => onDismiss(n.id)}
          aria-label={NOTIFICATIONS.dismissLabel(n.title)}
        >
          {NOTIFICATIONS.dismiss}
        </Button>
      </div>
    </li>
  );
}

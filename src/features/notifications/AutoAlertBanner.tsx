/**
 * Automatic on-screen alerts (NAS-NEW-04) — the owner should not have to click the
 * bell to see that something needs attention.
 *
 * ## Why this is a banner, not a toast
 *
 * `components/primitives.tsx`'s own `Panel` doc is explicit about this application's
 * stance: "a toast can be missed while someone is looking at a customer" (PRD §6.1).
 * A toast times out on its own regardless of whether anyone saw it; this does not —
 * it stays up for as long as the thing it is about stays active, and only goes away
 * when either the owner hides it (locally, see below) or the underlying condition is
 * actually resolved server-side. That is the same distinction the rest of this
 * application already draws between a toast and an inline `Panel`, applied here.
 *
 * ## One feed, not a second poll
 *
 * This renders `items` as given — it does not fetch anything itself. `AppShell`
 * passes it the exact same list `NotificationBell` already polls every 30 seconds
 * (`NotificationBell`'s `onItemsChanged`), so the app makes one `GET /notifications`
 * call, not two, no matter how many places show the result (cross-cutting
 * requirement: avoid notification polling overload).
 *
 * ## "Hide" is local and never touches the server
 *
 * Dismissing or acknowledging a notification is a business action with its own
 * meaning (`domain/notifications/service.py`'s module doc: dismissing a low-stock
 * alert must never read as "restocked") and stays exclusively the bell's job, where
 * the owner is choosing those specific words. "Hide" here only removes an item from
 * *this banner*, remembered in IndexedDB via `db/meta.ts` — **not** `localStorage` or
 * `sessionStorage`, which `tests/structural/rules.test.ts` (rule 3 of §4) forbids
 * everywhere in this codebase, access token or not — so a hidden alert does not
 * reappear the moment the next 30-second poll runs. It is still sitting in the bell,
 * untouched, exactly as a dismiss never would be if it weren't a dismiss. Hidden ids
 * are pruned to whatever is still in `items` on every update, so this never grows
 * unbounded and a resolved notification's id does not linger forever.
 */

import { useEffect, useState } from 'react';

import type { Notification } from '@/api/types';
import { Button, Panel } from '@/components/primitives';
import { getHiddenAlertIds, setHiddenAlertIds } from '@/db/meta';

/** Only the most urgent few, on screen at once — the rest are one bell click away. */
const MAX_VISIBLE = 3;

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'bg-red-100 text-red-900',
  warning: 'bg-amber-100 text-amber-900',
  info: 'bg-slate-100 text-slate-700',
};

/** Which screen a notification's own "Go to" action should open, if any. Mirrors
 *  `NotificationBell`'s own mapping — kept as a second small copy rather than a
 *  shared import so this component stays a pure function of its `items` prop with no
 *  dependency on the bell module, which is what keeps the two independently testable. */
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

export interface AutoAlertBannerProps {
  /** The bell's own list, or `null` before its first poll resolves. */
  items: Notification[] | null;
  onNavigate?: (screen: 'stock' | 'credit-bills' | 'orders', entityId?: string) => void;
}

export function AutoAlertBanner({ items, onNavigate }: AutoAlertBannerProps) {
  // Empty until the IndexedDB read resolves (a microtask, not a network round trip) —
  // an alert the owner hid moments before a remount can flash back on for that one
  // frame, which is a smaller cost than blocking the whole banner on a local read.
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    void getHiddenAlertIds().then((ids) => setHiddenIds(new Set(ids)));
  }, []);

  // Prune hidden ids that no longer correspond to an active notification — a
  // resolved/dismissed/expired item's id has nothing left to suppress.
  useEffect(() => {
    if (!items) return;
    const liveIds = new Set(items.map((n) => n.id));
    setHiddenIds((current) => {
      const pruned = new Set([...current].filter((id) => liveIds.has(id)));
      if (pruned.size === current.size) return current;
      void setHiddenAlertIds([...pruned]);
      return pruned;
    });
  }, [items]);

  if (!items) return null;
  const visible = items.filter((n) => !hiddenIds.has(n.id)).slice(0, MAX_VISIBLE);
  if (visible.length === 0) return null;

  function hide(id: string): void {
    setHiddenIds((current) => {
      const next = new Set(current).add(id);
      void setHiddenAlertIds([...next]);
      return next;
    });
  }

  return (
    // `role="group"`, not `region`: every `BillPanel` column is a `<section
    // aria-label="Bill N: …">`, which already carries the implicit `region` role
    // (HTML-AAM) — a second `region` here collided with `page.getByRole('region')`
    // selectors the E2E suite already uses to address "the first/second/third bill",
    // silently grabbing this banner instead whenever an alert happened to be showing.
    // A `group` is accurate for a transient cluster of alerts and does not compete for
    // the same landmark.
    //
    // `max-h-28 overflow-y-auto`: a real shop can genuinely have several products low
    // at once (a slow restock week is not rare), and `MAX_VISIBLE` alone does not bound
    // *height* — three full-padding alerts stacked were tall enough to push the whole
    // billing grid's header and every row below the fold on a 768px-tall screen, which
    // is exactly the "must not obstruct critical billing interactions" failure this
    // banner was built not to cause. Capping the height and scrolling internally means
    // the grid's own position never moves no matter how many alerts are active.
    <div
      className="flex max-h-28 flex-col gap-1 overflow-y-auto"
      aria-label="Alerts"
      role="group"
    >
      {visible.map((n) => {
        const target = screenFor(n.kind);
        return (
          <Panel key={n.id} tone={n.severity === 'critical' ? 'danger' : 'warning'}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <span
                  className={`mr-2 rounded px-1 text-xs font-medium ${SEVERITY_BADGE[n.severity] ?? SEVERITY_BADGE.info}`}
                >
                  {n.severity}
                </span>
                <span className="font-medium">{n.title}</span>
                {n.body ? <p className="text-sm text-slate-600">{n.body}</p> : null}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {target ? (
                  <Button
                    variant="quiet"
                    onClick={() => onNavigate?.(target, n.entity_id ?? undefined)}
                  >
                    Go to
                  </Button>
                ) : null}
                <Button
                  variant="quiet"
                  aria-label={`Hide: ${n.title}`}
                  onClick={() => hide(n.id)}
                >
                  Hide
                </Button>
              </div>
            </div>
          </Panel>
        );
      })}
    </div>
  );
}

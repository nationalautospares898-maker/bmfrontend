/**
 * The persistent Orders panel (NAS-NEW-01).
 *
 * Mounted once in `AppShell`'s right sidebar, directly below "Saving and syncing" —
 * never inside the screen-conditional part of the shell, so it is on screen exactly
 * as long as the sidebar itself is, regardless of which section is open. It reads
 * from `ordersStore` (not its own fetch), the same store `OrdersScreen` reads from —
 * completing an order here is instantly reflected if the full Orders page happens to
 * be open too, and vice versa, because there is exactly one copy of the list.
 *
 * ## Deliberately not a copy of `OrdersScreen`
 *
 * The brief's own warning — "do not blindly copy the entire Orders page into the
 * sidebar" — is why this is a narrower, denser view rather than `OrdersScreen` reused
 * verbatim: `OrdersScreen`'s cards assume a two-column grid and a 224px-wide
 * `datetime-local` field on their own, neither of which fits a ~280px sidebar column.
 * Only **pending** orders show here (what needs attention); completed orders, the
 * bulkier free-form editing of an existing order's body, and the Pending/Completed
 * toggle stay on the full page, reached via "View all orders".
 */

import { useState } from 'react';

import type { Order } from '@/api/types';
import { Busy, Button, Field, Panel } from '@/components/primitives';
import { COMMON, ORDERS } from '@/lib/strings';
import { type DraftCard, useOrdersStore } from './ordersStore';

/** `datetime-local`'s own format: no timezone, interpreted (and emitted) as local time. */
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface OrdersPanelProps {
  /** Switches the shell to the full Orders screen — the escape hatch for anything
   *  this compact view does not have room for (completed orders, longer editing). */
  onOpenOrders?: () => void;
}

export function OrdersPanel({ onOpenOrders }: OrdersPanelProps) {
  const pending = useOrdersStore((s) => s.pending);
  const drafts = useOrdersStore((s) => s.drafts);
  const error = useOrdersStore((s) => s.error);
  const busyId = useOrdersStore((s) => s.busyId);
  const addDraft = useOrdersStore((s) => s.addDraft);
  const updateDraft = useOrdersStore((s) => s.updateDraft);
  const discardDraft = useOrdersStore((s) => s.discardDraft);
  const saveDraft = useOrdersStore((s) => s.saveDraft);
  const complete = useOrdersStore((s) => s.complete);
  const discard = useOrdersStore((s) => s.discard);
  const setReminder = useOrdersStore((s) => s.setReminder);

  // No fetch effect here on purpose: `OrdersPanel` is mounted for the life of the
  // whole app, so whichever component (this one, or `OrdersScreen`) asks for
  // `pending` first warms it for both — see `ordersStore`'s own doc. A `useEffect`
  // here that always called `loadPending()` on mount would be harmless on its own
  // but duplicates the one `OrdersScreen` already triggers whenever both happen to
  // mount close together; callers that need a guaranteed first load use `AppShell`'s
  // own bootstrap instead (see `AppShell.tsx`'s orders-panel wiring).
  const count = pending?.length ?? 0;

  return (
    // `<aside>`, not `<section>`: a `<section>` carrying an accessible name gets the
    // implicit `region` role (HTML-AAM) — the exact same collision `AutoAlertBanner`
    // hit with `page.getByRole('region')` locators the E2E suite already uses to
    // address "the first/second bill" by position. `<aside>`'s implicit
    // `complementary` role is also the more accurate one for a persistent sidebar
    // panel: this is supporting content alongside the billing workspace, not a
    // principal region of the page in its own right.
    <aside
      aria-label={ORDERS.title}
      className="flex min-h-0 flex-col gap-2 border-t border-slate-300 pt-2"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-[#232852]">
          {count > 0 ? `${ORDERS.title} (${count})` : ORDERS.title}
        </h2>
        <Button variant="quiet" aria-label={ORDERS.newOrder} onClick={addDraft}>
          +
        </Button>
      </div>

      {error ? (
        <Panel tone="danger">
          <span className="text-xs">{error}</span>
        </Panel>
      ) : null}

      <div
        className="flex min-h-0 flex-col gap-2 overflow-y-auto"
        style={{ maxHeight: '40vh' }}
      >
        {drafts.map((draft) => (
          <CompactDraftCard
            key={draft.localId}
            draft={draft}
            busy={busyId === draft.localId}
            onChange={(patch) => updateDraft(draft.localId, patch)}
            onSave={() => void saveDraft(draft)}
            onDiscard={() => discardDraft(draft.localId)}
          />
        ))}

        {pending === null ? (
          <Busy label={COMMON.loading} />
        ) : pending.length === 0 && drafts.length === 0 ? (
          <p className="text-xs text-slate-500">{ORDERS.emptyPending}</p>
        ) : (
          pending.map((order) => (
            <CompactOrderRow
              key={order.id}
              order={order}
              busy={busyId === order.id}
              onComplete={() => void complete(order)}
              onDiscard={() => void discard(order)}
              onSetReminder={(iso) => void setReminder(order, iso)}
            />
          ))
        )}
      </div>

      {onOpenOrders ? (
        // Not "Open …" or anything containing a "/": this panel is persistent on
        // every screen now (NAS-NEW-01), including Credit Bills, where
        // `owner-additions-2026-11-07.spec.ts` already addresses a bill's own
        // reference button with a loose `/\/|Open/` match — this button sitting
        // anywhere in the DOM with either word in its name became `.first()`'s match
        // instead of the real bill link, silently opening Orders rather than the
        // bill. The fix belongs here, not in that test: existing selectors should
        // not have to anticipate what a new persistent element's wording happens to be.
        <Button variant="quiet" onClick={onOpenOrders} className="self-start text-xs">
          View all orders
        </Button>
      ) : null}
    </aside>
  );
}

function CompactDraftCard({
  draft,
  busy,
  onChange,
  onSave,
  onDiscard,
}: {
  draft: DraftCard;
  busy: boolean;
  onChange: (patch: Partial<DraftCard>) => void;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="flex flex-col gap-1 rounded border border-slate-300 bg-white p-2">
      <textarea
        autoFocus
        value={draft.body}
        onChange={(e) => onChange({ body: e.target.value })}
        placeholder={ORDERS.bodyPlaceholder}
        rows={3}
        className="w-full resize-y rounded border border-slate-300 p-1 text-sm"
      />
      <Field
        label={ORDERS.customerName}
        value={draft.customerName}
        onChange={(e) => onChange({ customerName: e.target.value })}
      />
      <div className="flex gap-2">
        <Button
          variant="primary"
          busy={busy}
          disabled={!draft.body.trim()}
          onClick={onSave}
        >
          {ORDERS.save}
        </Button>
        <Button variant="quiet" onClick={onDiscard}>
          {ORDERS.trash}
        </Button>
      </div>
    </div>
  );
}

function CompactOrderRow({
  order,
  busy,
  onComplete,
  onDiscard,
  onSetReminder,
}: {
  order: Order;
  busy: boolean;
  onComplete: () => void;
  onDiscard: () => void;
  onSetReminder: (remindAt: string | null) => void;
}) {
  const [confirmingTrash, setConfirmingTrash] = useState(false);
  const [editingReminder, setEditingReminder] = useState(false);
  const [reminderValue, setReminderValue] = useState(() =>
    order.remind_at ? toLocalInputValue(order.remind_at) : '',
  );
  const overdue = order.remind_at != null && new Date(order.remind_at) <= new Date();

  return (
    <div className="flex flex-col gap-1 rounded border border-slate-300 bg-white p-2 text-sm">
      <div className="flex items-baseline justify-between gap-2 text-xs text-slate-500">
        <span className="truncate">
          {order.customer_name
            ? order.customer_name
            : new Date(order.created_at).toLocaleDateString()}
        </span>
        {order.remind_at ? (
          <span className={overdue ? 'font-medium text-red-700' : 'text-amber-700'}>
            {overdue ? '⏰ overdue' : '⏰ set'}
          </span>
        ) : null}
      </div>
      <p className="line-clamp-3 whitespace-pre-wrap text-sm">{order.body}</p>

      {editingReminder ? (
        <div className="flex flex-col gap-1">
          <Field
            label={ORDERS.reminderLabel}
            type="datetime-local"
            value={reminderValue}
            onChange={(e) => setReminderValue(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              variant="primary"
              busy={busy}
              disabled={reminderValue === ''}
              onClick={() => {
                onSetReminder(new Date(reminderValue).toISOString());
                setEditingReminder(false);
              }}
            >
              {ORDERS.reminderSaveAction}
            </Button>
            <Button variant="quiet" onClick={() => setEditingReminder(false)}>
              {ORDERS.reminderCancelAction}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1">
          <Button variant="secondary" busy={busy} onClick={onComplete}>
            {ORDERS.markComplete}
          </Button>
          <Button
            variant="quiet"
            busy={busy}
            onClick={() => {
              setReminderValue(order.remind_at ? toLocalInputValue(order.remind_at) : '');
              setEditingReminder(true);
            }}
          >
            {order.remind_at ? ORDERS.reminderChangeAction : ORDERS.reminderSetAction}
          </Button>
          {confirmingTrash ? (
            <>
              <Button variant="danger" busy={busy} onClick={onDiscard}>
                {ORDERS.trashConfirm}
              </Button>
              <Button variant="quiet" onClick={() => setConfirmingTrash(false)}>
                {COMMON.cancel}
              </Button>
            </>
          ) : (
            <Button variant="quiet" onClick={() => setConfirmingTrash(true)}>
              {ORDERS.trash}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

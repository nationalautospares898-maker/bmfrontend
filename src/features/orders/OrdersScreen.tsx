/**
 * Chitti orders (Feature B).
 *
 * A phoned-in order the owner writes down now and turns into a bill later. Two
 * columns of order cards, each a blank writing area first and a structured field
 * second — `body` is the only required thing, matching the owner's explicit request
 * not to force structured fields before saving.
 *
 * An order here never becomes an invoice by itself (`domain/orders/service.py`'s
 * module docstring): converting one is left to the Billing screen reading an order's
 * own fields, which is future work this screen does not block.
 */

import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';

import { orders as ordersApi } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import type { Order } from '@/api/types';
import { Busy, Button, Field, Panel } from '@/components/primitives';
import { COMMON, ORDERS } from '@/lib/strings';
import { uuidv7 } from '@/lib/ids';

/** A card still being written, with no server id yet. */
interface DraftCard {
  localId: string;
  body: string;
  customerName: string;
  phone: string;
}

function isDraft(card: DraftCard | Order): card is DraftCard {
  return 'localId' in card;
}

export interface OrdersScreenProps {
  /**
   * The order a notification's "Go to" pointed at (owner request, 2026-11-11). That
   * order's card scrolls into view and is visibly highlighted — "quickly identify
   * which order needs attention" — until `onHighlightSeen` is called.
   */
  highlightOrderId?: string | null;
  onHighlightSeen?: () => void;
}

export function OrdersScreen({ highlightOrderId, onHighlightSeen }: OrdersScreenProps = {}) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [drafts, setDrafts] = useState<DraftCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);

  const load = useCallback(async (status: 'pending' | 'completed' | 'discarded') => {
    setOrders(null);
    setError(null);
    try {
      const response = await ordersApi.list({ status });
      setOrders(response.items);
    } catch (caught) {
      setOrders([]);
      setError(caught instanceof ApiError ? describeError(caught.code).message : COMMON.retry);
    }
  }, []);

  useEffect(() => {
    void load(showCompleted ? 'completed' : 'pending');
  }, [load, showCompleted]);

  function addDraft(): void {
    setDrafts((prev) => [
      { localId: uuidv7(), body: '', customerName: '', phone: '' },
      ...prev,
    ]);
  }

  function updateDraft(localId: string, patch: Partial<DraftCard>): void {
    setDrafts((prev) => prev.map((d) => (d.localId === localId ? { ...d, ...patch } : d)));
  }

  function discardDraft(localId: string): void {
    setDrafts((prev) => prev.filter((d) => d.localId !== localId));
  }

  async function saveDraft(draft: DraftCard): Promise<void> {
    if (!draft.body.trim()) return;
    setBusyId(draft.localId);
    setError(null);
    try {
      await ordersApi.create({
        body: draft.body,
        customer_name: draft.customerName || null,
        phone: draft.phone || null,
      });
      discardDraft(draft.localId);
      await load('pending');
    } catch (caught) {
      setError(caught instanceof ApiError ? describeError(caught.code).message : COMMON.retry);
    } finally {
      setBusyId(null);
    }
  }

  async function saveEdit(order: Order, body: string): Promise<void> {
    setBusyId(order.id);
    try {
      await ordersApi.update(order.id, { body });
      await load('pending');
    } catch (caught) {
      setError(caught instanceof ApiError ? describeError(caught.code).message : COMMON.retry);
    } finally {
      setBusyId(null);
    }
  }

  async function complete(order: Order): Promise<void> {
    setBusyId(order.id);
    try {
      await ordersApi.complete(order.id);
      await load(showCompleted ? 'completed' : 'pending');
    } finally {
      setBusyId(null);
    }
  }

  async function discard(order: Order): Promise<void> {
    setBusyId(order.id);
    try {
      await ordersApi.discard(order.id);
      await load(showCompleted ? 'completed' : 'pending');
    } finally {
      setBusyId(null);
    }
  }

  async function setReminder(order: Order, remindAt: string | null): Promise<void> {
    setBusyId(order.id);
    setError(null);
    try {
      await ordersApi.setReminder(order.id, remindAt);
      await load(showCompleted ? 'completed' : 'pending');
    } catch (caught) {
      setError(caught instanceof ApiError ? describeError(caught.code).message : COMMON.retry);
    } finally {
      setBusyId(null);
    }
  }

  // The highlight is a few seconds' pulse, not a permanent mark — long enough to find
  // the card the notification meant, short enough that it reads as "here it is", not
  // as a new, separate state of the order itself.
  useEffect(() => {
    if (!highlightOrderId) return;
    const timer = window.setTimeout(() => onHighlightSeen?.(), 4000);
    return () => window.clearTimeout(timer);
  }, [highlightOrderId, onHighlightSeen]);

  const cards: Array<DraftCard | Order> = [...drafts, ...(orders ?? [])];

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-[#232852]">{ORDERS.title}</h1>
        <div className="flex gap-2">
          <Button
            variant={showCompleted ? 'secondary' : 'primary'}
            onClick={() => setShowCompleted(false)}
          >
            {ORDERS.pending}
          </Button>
          <Button
            variant={showCompleted ? 'primary' : 'secondary'}
            onClick={() => setShowCompleted(true)}
          >
            {ORDERS.completed}
          </Button>
          {!showCompleted ? (
            <Button variant="primary" onClick={addDraft}>
              {ORDERS.newOrder}
            </Button>
          ) : null}
        </div>
      </header>

      {error ? <Panel tone="danger">{error}</Panel> : null}

      {orders === null ? (
        <Busy label={COMMON.loading} />
      ) : cards.length === 0 ? (
        <Panel tone="info">{showCompleted ? ORDERS.emptyCompleted : ORDERS.emptyPending}</Panel>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {cards.map((card) =>
            isDraft(card) ? (
              <DraftOrderCard
                key={card.localId}
                draft={card}
                busy={busyId === card.localId}
                onChange={(patch) => updateDraft(card.localId, patch)}
                onSave={() => void saveDraft(card)}
                onDiscard={() => discardDraft(card.localId)}
              />
            ) : (
              <SavedOrderCard
                key={card.id}
                order={card}
                busy={busyId === card.id}
                readOnly={showCompleted}
                highlighted={highlightOrderId === card.id}
                onSave={(body) => void saveEdit(card, body)}
                onComplete={() => void complete(card)}
                onDiscard={() => void discard(card)}
                onSetReminder={(iso) => void setReminder(card, iso)}
              />
            ),
          )}
        </div>
      )}
    </section>
  );
}

const CardShell = forwardRef<
  HTMLDivElement,
  { children: React.ReactNode; highlighted?: boolean }
>(function CardShell({ children, highlighted }, ref) {
  return (
    <div
      ref={ref}
      className={
        'flex flex-col gap-2 rounded border bg-white p-3 shadow-sm transition-shadow ' +
        (highlighted
          ? 'border-nas-navy ring-2 ring-nas-navy ring-offset-2'
          : 'border-slate-300')
      }
    >
      {children}
    </div>
  );
});

function DraftOrderCard({
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
    <CardShell>
      <textarea
        autoFocus
        value={draft.body}
        onChange={(e) => onChange({ body: e.target.value })}
        placeholder={ORDERS.bodyPlaceholder}
        rows={6}
        className="min-h-32 w-full resize-y rounded border border-slate-300 p-2 text-base"
      />
      <div className="grid grid-cols-2 gap-2">
        <Field
          label={ORDERS.customerName}
          value={draft.customerName}
          onChange={(e) => onChange({ customerName: e.target.value })}
        />
        <Field
          label={ORDERS.phone}
          value={draft.phone}
          onChange={(e) => onChange({ phone: e.target.value })}
        />
      </div>
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
    </CardShell>
  );
}

function SavedOrderCard({
  order,
  busy,
  readOnly,
  highlighted = false,
  onSave,
  onComplete,
  onDiscard,
  onSetReminder,
}: {
  order: Order;
  busy: boolean;
  readOnly: boolean;
  highlighted?: boolean;
  onSave: (body: string) => void;
  onComplete: () => void;
  onDiscard: () => void;
  onSetReminder: (remindAt: string | null) => void;
}) {
  const [body, setBody] = useState(order.body);
  const [confirmingTrash, setConfirmingTrash] = useState(false);
  const dirty = body !== order.body;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Guarded rather than assumed: every real browser has `scrollIntoView`, but the
    // test environment's DOM does not implement it, and a missing method must not
    // crash the component that is otherwise working exactly as intended.
    if (highlighted) ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, [highlighted]);

  return (
    <CardShell ref={ref} highlighted={highlighted}>
      <div className="flex items-baseline justify-between text-xs text-slate-500">
        <span>{new Date(order.created_at).toLocaleString()}</span>
        {order.customer_name ? <span className="font-medium">{order.customer_name}</span> : null}
      </div>
      <textarea
        value={body}
        readOnly={readOnly}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        className="min-h-32 w-full resize-y rounded border border-slate-300 p-2 text-base"
      />
      {order.phone ? <p className="text-xs text-slate-500">{order.phone}</p> : null}
      {!readOnly ? <ReminderControl order={order} busy={busy} onSet={onSetReminder} /> : null}
      {!readOnly ? (
        <div className="flex flex-wrap gap-2">
          {dirty ? (
            <Button variant="primary" busy={busy} onClick={() => onSave(body)}>
              {ORDERS.save}
            </Button>
          ) : null}
          <Button variant="secondary" busy={busy} onClick={onComplete}>
            {ORDERS.markComplete}
          </Button>
          {confirmingTrash ? (
            <>
              <span className="text-sm text-slate-600">{ORDERS.confirmTrash}</span>
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
      ) : null}
    </CardShell>
  );
}

/** `datetime-local`'s own format: no timezone, interpreted (and emitted) as local time. */
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The owner's one-time reminder for one order (owner request, 2026-11-11), on top of
 * the flat ten-minute nudge every pending order already gets. Shows what is set (with
 * an overdue flag, since "fires ahead of the flat cadence" from the backend is easy to
 * read as "immediately" without a visible cue), and lets it be set, changed or cleared.
 */
function ReminderControl({
  order,
  busy,
  onSet,
}: {
  order: Order;
  busy: boolean;
  onSet: (remindAt: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(() =>
    order.remind_at ? toLocalInputValue(order.remind_at) : '',
  );
  const overdue = order.remind_at != null && new Date(order.remind_at) <= new Date();

  if (editing) {
    return (
      <div className="flex flex-wrap items-end gap-2">
        <Field
          label={ORDERS.reminderLabel}
          type="datetime-local"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-56"
        />
        <Button
          variant="primary"
          busy={busy}
          disabled={value === ''}
          onClick={() => {
            onSet(new Date(value).toISOString());
            setEditing(false);
          }}
        >
          {ORDERS.reminderSaveAction}
        </Button>
        <Button variant="quiet" onClick={() => setEditing(false)}>
          {ORDERS.reminderCancelAction}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {order.remind_at ? (
        <span
          className={
            overdue
              ? 'rounded bg-red-100 px-2 py-0.5 font-medium text-red-900'
              : 'rounded bg-amber-100 px-2 py-0.5 text-amber-900'
          }
        >
          {overdue
            ? ORDERS.reminderOverdue(new Date(order.remind_at).toLocaleString())
            : ORDERS.reminderSet(new Date(order.remind_at).toLocaleString())}
        </span>
      ) : (
        <span className="text-slate-500">{ORDERS.reminderNone}</span>
      )}
      <Button
        variant="quiet"
        busy={busy}
        onClick={() => {
          setValue(order.remind_at ? toLocalInputValue(order.remind_at) : '');
          setEditing(true);
        }}
      >
        {order.remind_at ? ORDERS.reminderChangeAction : ORDERS.reminderSetAction}
      </Button>
      {order.remind_at ? (
        <Button variant="quiet" busy={busy} onClick={() => onSet(null)}>
          {ORDERS.reminderClearAction}
        </Button>
      ) : null}
    </div>
  );
}

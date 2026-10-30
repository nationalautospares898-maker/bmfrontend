/**
 * Draft persistence.
 *
 * The rule that shapes every function here: **every change is a Dexie transaction
 * first, then a store update** (ARCHITECTURE.md §4.1 rule 4). If the browser dies
 * between keystrokes, the last committed keystroke is on disk. Text fields are debounced
 * ~300 ms by the caller and structural changes (add or remove a line) are written
 * immediately, which bounds the loss window to a few hundred milliseconds of typing
 * rather than a whole bill.
 *
 * Nothing here deletes a draft the user did not ask to delete. In particular, reaching
 * the open-bill limit **refuses to open another** rather than closing the oldest — the
 * one thing this system must never do is lose a cashier's typing.
 */

import { uuidv7 } from '@/lib/ids';
import { serverNowIso } from '@/api/session';
import {
  db,
  type CounterDatabase,
  type DraftStatus,
  type LocalDraft,
  type LocalDraftLine,
} from './schema';

export class DraftLimitReached extends Error {
  constructor(readonly max: number) {
    super(`All ${max} bill tabs are in use.`);
    this.name = 'DraftLimitReached';
  }
}

function emptyDraft(counterId: string, label: string): LocalDraft {
  return {
    id: uuidv7(),
    counter_id: counterId,
    label,
    version: null,
    status: 'editing',
    header: {
      customer_id: null,
      customer_name: '',
      customer_business_name: '',
      vehicle_number: '',
      mechanic_name: '',
      phone: '',
      notes: '',
      is_credit_intent: false,
    },
    lines: [],
    dirty: true,
    last_synced_at: null,
    conflict: null,
    invoice_id: null,
    updated_at: serverNowIso(),
  };
}

/** Bills still being worked on, oldest first so tab order is stable across reloads. */
export async function openDrafts(
  counterId: string,
  database: CounterDatabase = db,
): Promise<LocalDraft[]> {
  const rows = await database.drafts.where('counter_id').equals(counterId).toArray();
  return rows
    .filter((draft) => draft.status !== 'finalized')
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function getDraft(
  draftId: string,
  database: CounterDatabase = db,
): Promise<LocalDraft | undefined> {
  return database.drafts.get(draftId);
}

/**
 * Open a new bill, or refuse.
 *
 * `max` comes from `bootstrap.counter.max_open_drafts` and is **never** a client
 * constant (rule 15). Refusing is the whole point: silently closing someone else's
 * half-typed bill to make room would be worse than the refusal (FR-DRAFT-003).
 */
export async function createDraft(
  counterId: string,
  max: number,
  label?: string,
  database: CounterDatabase = db,
): Promise<LocalDraft> {
  return database.transaction('rw', database.drafts, async () => {
    const existing = await openDrafts(counterId, database);
    if (existing.length >= max) throw new DraftLimitReached(max);
    const draft = emptyDraft(counterId, label ?? `Bill ${existing.length + 1}`);
    await database.drafts.add(draft);
    return draft;
  });
}

/**
 * Apply a change to a draft and persist it atomically.
 *
 * The mutation runs **inside** the transaction after a fresh read, so two concurrent
 * edits (a debounced header write landing while a line is added) cannot overwrite each
 * other with stale content.
 */
export async function updateDraft(
  draftId: string,
  mutate: (draft: LocalDraft) => void,
  database: CounterDatabase = db,
): Promise<LocalDraft | undefined> {
  return database.transaction('rw', database.drafts, async () => {
    const current = await database.drafts.get(draftId);
    if (!current) return undefined;
    // A finalised bill is a record, not a draft. Refusing to mutate it here means no
    // UI path can accidentally edit a completed sale.
    if (current.status === 'finalized') return current;

    const next: LocalDraft = structuredClone(current);
    mutate(next);
    next.dirty = true;
    next.updated_at = serverNowIso();
    await database.drafts.put(next);
    return next;
  });
}

export async function setDraftStatus(
  draftId: string,
  status: DraftStatus,
  database: CounterDatabase = db,
): Promise<void> {
  await database.transaction('rw', database.drafts, async () => {
    const current = await database.drafts.get(draftId);
    if (!current) return;
    await database.drafts.put({ ...current, status, updated_at: serverNowIso() });
  });
}

/** Record the server's state after a sync, clearing the dirty flag and any conflict. */
export async function markSynced(
  draftId: string,
  version: number,
  database: CounterDatabase = db,
): Promise<void> {
  await database.transaction('rw', database.drafts, async () => {
    const current = await database.drafts.get(draftId);
    if (!current) return;
    await database.drafts.put({
      ...current,
      version,
      dirty: false,
      conflict: null,
      last_synced_at: serverNowIso(),
    });
  });
}

/**
 * Record a version conflict for the user to resolve.
 *
 * **No automatic merge** (ADR-007): the server's state is stored alongside the local
 * one and the tab is badged, so the person who typed the bill decides which version is
 * right. Picking one automatically would silently discard somebody's work.
 */
export async function markConflict(
  draftId: string,
  serverState: unknown,
  database: CounterDatabase = db,
): Promise<void> {
  await database.transaction('rw', database.drafts, async () => {
    const current = await database.drafts.get(draftId);
    if (!current) return;
    await database.drafts.put({ ...current, status: 'conflict', conflict: serverState });
  });
}

/**
 * Mark a draft finalised and attach its invoice.
 *
 * The draft is **kept**, not deleted: the tab shows the completed bill so the cashier
 * can reprint it, and a replayed finalisation finds the draft already finalised instead
 * of looking like a fresh sale.
 */
export async function markFinalized(
  draftId: string,
  invoiceId: string,
  database: CounterDatabase = db,
): Promise<void> {
  await database.transaction(
    'rw',
    database.drafts,
    database.pending_finalizations,
    async () => {
      const current = await database.drafts.get(draftId);
      if (current) {
        await database.drafts.put({
          ...current,
          status: 'finalized',
          invoice_id: invoiceId,
          dirty: false,
          updated_at: serverNowIso(),
        });
      }
      // The intent has resolved, so the key must not be reused.
      await database.pending_finalizations.delete(draftId);
    },
  );
}

/**
 * Discard a draft the user explicitly cleared.
 *
 * Refuses while a finalisation is in flight: until the outcome is known, clearing the
 * bill would destroy the only local record of a sale that may already have committed
 * (E-2). The UI says so and points at Daily Bills.
 */
export async function clearDraft(
  draftId: string,
  database: CounterDatabase = db,
): Promise<'cleared' | 'refused_unconfirmed' | 'refused_finalized'> {
  return database.transaction(
    'rw',
    database.drafts,
    database.pending_finalizations,
    async () => {
      const current = await database.drafts.get(draftId);
      if (!current) return 'cleared';
      if (current.status === 'finalized') return 'refused_finalized';
      const pending = await database.pending_finalizations.get(draftId);
      if (
        pending ||
        current.status === 'submitting' ||
        current.status === 'unconfirmed'
      ) {
        return 'refused_unconfirmed';
      }
      await database.drafts.delete(draftId);
      return 'cleared';
    },
  );
}

// --- line helpers -------------------------------------------------------------

/** Append a line, numbering it after the current highest rather than by array length. */
export function appendLine(
  draft: LocalDraft,
  line: Omit<LocalDraftLine, 'id' | 'line_no'>,
): void {
  const highest = draft.lines.reduce(
    (max, existing) => Math.max(max, existing.line_no),
    0,
  );
  draft.lines.push({ ...line, id: uuidv7(), line_no: highest + 1 });
}

/**
 * Remove a line, keeping `line_no` contiguous.
 *
 * Renumbering matters because `line_no` is what the printed bill's serial column shows:
 * a gap would print as a missing row on a customer's bill.
 */
export function removeLine(draft: LocalDraft, lineId: string): void {
  draft.lines = draft.lines
    .filter((line) => line.id !== lineId)
    .map((line, index) => ({ ...line, line_no: index + 1 }));
}

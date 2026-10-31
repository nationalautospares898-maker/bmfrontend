/**
 * The draft store: Zustand over Dexie.
 *
 * Dexie is authoritative; Zustand is the render mirror (ADR-025). Every mutation writes
 * to IndexedDB **first** and only then updates the in-memory copy, so a crash between
 * keystrokes loses at most the last debounce window rather than the bill.
 *
 * Totals are **derived** by selectors, never stored (§4.1 rule 5). A stored total is a
 * total that can be stale, and a stale total on screen next to a customer is how a
 * disagreement with the server starts.
 */

import { create } from 'zustand';

import { drafts as draftsApi } from '@/api/endpoints';
import type { DraftUpsertRequest } from '@/api/types';
import * as draftsDb from '@/db/drafts';
import * as pending from '@/db/pendingFinalizations';
import { enqueue } from '@/db/outbox';
import type { LocalDraft, LocalDraftLine } from '@/db/schema';
import { lineExtension, parseMoney, previewTotal, ZERO, type Decimal } from '@/lib/money';

export interface BillingState {
  counterId: string | null;
  maxOpenDrafts: number;
  drafts: LocalDraft[];
  activeDraftId: string | null;
  /** Set when the limit refuses a new tab, so the UI can explain rather than fail. */
  limitMessage: string | null;
  ready: boolean;
}

interface BillingActions {
  initialise(counterId: string, maxOpenDrafts: number): Promise<void>;
  newDraft(): Promise<string | null>;
  selectDraft(draftId: string): void;
  addLine(draftId: string, line: Omit<LocalDraftLine, 'id' | 'line_no'>): Promise<void>;
  updateLine(
    draftId: string,
    lineId: string,
    patch: Partial<LocalDraftLine>,
  ): Promise<void>;
  removeLine(draftId: string, lineId: string): Promise<void>;
  updateHeader(draftId: string, patch: Partial<LocalDraft['header']>): Promise<void>;
  saveDraftToServer(draftId: string): Promise<void>;
  /**
   * Make sure the server has this draft, and return the version it now holds.
   *
   * Finalisation sends `draft_id` and `draft_version`, and the server looks the draft
   * up and refuses with `NOT_FOUND` if it has never seen it
   * (`sales/service.py`: "That bill does not exist"). Until this existed, the only
   * thing that ever pushed a draft was the `Save a Draft` button, so a cashier who
   * typed a bill and pressed `Print Bill` — the ordinary way to use this screen — got
   * "This bill is not confirmed" and three failed retries on a sale the server had
   * never heard of.
   *
   * Done through a direct `PUT` rather than the outbox because finalisation is
   * online-only by design (FR-OFFLINE-002), so the outbox's offline guarantees buy
   * nothing here and its debounce is exactly the delay that caused the bug.
   */
  ensureOnServer(draftId: string): Promise<number | null>;
  clearDraft(
    draftId: string,
  ): Promise<'cleared' | 'refused_unconfirmed' | 'refused_finalized'>;
  reload(): Promise<void>;
}

/**
 * Persist, then re-read, then publish.
 *
 * Re-reading rather than trusting the local object means the store always reflects what
 * is actually on disk — including whatever a concurrent debounced write committed.
 */
async function persist(
  draftId: string,
  mutate: (draft: LocalDraft) => void,
  set: (partial: Partial<BillingState>) => void,
  get: () => BillingState & BillingActions,
): Promise<void> {
  const updated = await draftsDb.updateDraft(draftId, mutate);
  if (!updated) return;

  // Any edit changes the intent, so a key claimed for the previous content must not be
  // reused — that is how a second invoice gets created for a bill that was edited
  // between attempts (§5 step 3).
  await pending.invalidateOnEdit(draftId);

  set({
    drafts: get().drafts.map((draft) => (draft.id === draftId ? updated : draft)),
  });
}

export const useBillingStore = create<BillingState & BillingActions>((set, get) => ({
  counterId: null,
  maxOpenDrafts: 1,
  drafts: [],
  activeDraftId: null,
  limitMessage: null,
  ready: false,

  /**
   * Load this counter's drafts.
   *
   * Called **before** authentication completes: drafts never depend on a session, so a
   * cashier whose token expired still sees their typing (§9).
   */
  async initialise(counterId, maxOpenDrafts) {
    const drafts = await draftsDb.openDrafts(counterId);
    set({
      counterId,
      maxOpenDrafts,
      drafts,
      activeDraftId: drafts[0]?.id ?? null,
      ready: true,
    });
    if (drafts.length === 0) await get().newDraft();
  },

  /**
   * Open a new bill, or explain why not.
   *
   * Returns `null` at the limit. **Nothing is closed to make room** — the message says
   * so explicitly, because a cashier who loses a half-typed bill to make space for a
   * new one will not trust the system again (FR-DRAFT-003).
   */
  async newDraft() {
    const { counterId, maxOpenDrafts, drafts } = get();
    if (!counterId) return null;
    try {
      const draft = await draftsDb.createDraft(counterId, maxOpenDrafts);
      set({
        drafts: [...drafts, draft],
        activeDraftId: draft.id,
        limitMessage: null,
      });
      return draft.id;
    } catch (error) {
      if (error instanceof draftsDb.DraftLimitReached) {
        set({ limitMessage: `All ${error.max} bill tabs are in use.` });
        return null;
      }
      throw error;
    }
  },

  selectDraft(draftId) {
    // Purely local: no fetch on tab switch, which is what keeps it under 100 ms with
    // twenty bills open (NFR-FE-PERF-003).
    set({ activeDraftId: draftId, limitMessage: null });
  },

  async addLine(draftId, line) {
    // Structural change: written immediately, not debounced.
    await persist(draftId, (draft) => draftsDb.appendLine(draft, line), set, get);
  },

  async updateLine(draftId, lineId, patch) {
    await persist(
      draftId,
      (draft) => {
        draft.lines = draft.lines.map((existing) =>
          existing.id === lineId ? { ...existing, ...patch } : existing,
        );
      },
      set,
      get,
    );
  },

  async removeLine(draftId, lineId) {
    await persist(draftId, (draft) => draftsDb.removeLine(draft, lineId), set, get);
  },

  async updateHeader(draftId, patch) {
    await persist(
      draftId,
      (draft) => {
        draft.header = { ...draft.header, ...patch };
      },
      set,
      get,
    );
  },

  /**
   * Queue the draft for the server.
   *
   * It goes through the **outbox**, not a direct call, so `Save a Draft` behaves
   * identically online and offline: the bill is already safe on disk, and the queue
   * carries it up when there is a connection. Pressing it offline is a success, not an
   * error.
   */
  async saveDraftToServer(draftId) {
    const draft = get().drafts.find((candidate) => candidate.id === draftId);
    if (!draft) return;
    await enqueue({
      type: 'draft.upsert',
      entity_type: 'draft_bill',
      entity_id: draft.id,
      base_version: draft.version,
      payload: toUpsertPayload(draft),
    });
  },

  async ensureOnServer(draftId) {
    const draft = get().drafts.find((candidate) => candidate.id === draftId);
    if (!draft) return null;

    const server = await draftsApi.upsert(
      draft.id,
      toUpsertPayload(draft),
      draft.version,
    );
    // Adopt the server's version, the same way the sync path does, so the finalise
    // request carries a `draft_version` the server will accept rather than a stale one.
    // `version` is nullable in the published contract; a draft without one is not a
    // draft finalisation can quote a version for, so it is left alone rather than
    // recorded as a guess.
    const version = typeof server.version === 'number' ? server.version : null;
    if (version !== null) {
      await draftsDb.markSynced(draft.id, version);
      set({
        drafts: get().drafts.map((candidate) =>
          candidate.id === draftId ? { ...candidate, version } : candidate,
        ),
      });
    }
    return version;
  },

  async clearDraft(draftId) {
    const outcome = await draftsDb.clearDraft(draftId);
    if (outcome !== 'cleared') return outcome;

    // A draft that was never synced has nothing on the server to delete, so queueing a
    // delete for it would be a 404 the user would have to look at.
    const draft = get().drafts.find((candidate) => candidate.id === draftId);
    if (draft?.version !== null && draft?.version !== undefined) {
      await enqueue({
        type: 'draft.delete',
        entity_type: 'draft_bill',
        entity_id: draftId,
        base_version: draft.version,
        payload: {},
      });
    }

    const remaining = get().drafts.filter((candidate) => candidate.id !== draftId);
    set({
      drafts: remaining,
      activeDraftId:
        get().activeDraftId === draftId
          ? (remaining[0]?.id ?? null)
          : get().activeDraftId,
    });
    if (remaining.length === 0) await get().newDraft();
    return 'cleared';
  },

  async reload() {
    const { counterId } = get();
    if (!counterId) return;
    set({ drafts: await draftsDb.openDrafts(counterId) });
  },
}));

// --- derived values -----------------------------------------------------------

/** One line's preview extension. Exact, unrounded — the server owns the real figure. */
export function lineTotal(line: LocalDraftLine): Decimal {
  return lineExtension({
    quantity: parseMoney(line.quantity),
    unitPrice: parseMoney(line.unit_price),
    discountPercent: line.discount_percent
      ? parseMoney(line.discount_percent)
      : undefined,
  });
}

/**
 * The on-screen total.
 *
 * A **preview**, labelled as such, and sent as `client_computed_total` only as a
 * cross-check (ADR-032). The server answers `TOTAL_MISMATCH` if it disagrees rather
 * than quietly accepting the client's arithmetic.
 */
export function draftTotal(draft: LocalDraft | undefined): Decimal {
  if (!draft) return ZERO;
  return previewTotal(draft.lines.map(lineTotal));
}

/** Whether a sale could be finalised at all — one line is the minimum. */
export function canFinalize(draft: LocalDraft | undefined): boolean {
  if (!draft) return false;
  if (draft.status === 'finalized' || draft.status === 'submitting') return false;
  return draft.lines.length > 0;
}

/** The `PUT /drafts/{id}` body. Field names come from the generated request type. */
export function toUpsertPayload(draft: LocalDraft): DraftUpsertRequest {
  return {
    counter_id: draft.counter_id,
    label: draft.label,
    customer_id: draft.header.customer_id,
    customer_name: draft.header.customer_name || null,
    customer_business_name: draft.header.customer_business_name || null,
    vehicle_number: draft.header.vehicle_number || null,
    mechanic_name: draft.header.mechanic_name || null,
    phone: draft.header.phone || null,
    notes: draft.header.notes || null,
    is_credit_intent: draft.header.is_credit_intent,
    items: draft.lines.map((line) => ({
      id: line.id,
      line_no: line.line_no,
      product_id: line.product_id,
      quantity: line.quantity,
      unit_price: line.unit_price,
      catalog_price_at_add: line.catalog_price_at_add,
      price_source: line.price_source,
      discount_percent: line.discount_percent,
    })),
  };
}

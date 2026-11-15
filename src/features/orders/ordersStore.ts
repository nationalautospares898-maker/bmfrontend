/**
 * Chitti orders (Feature B) — one shared store, not one hook per caller.
 *
 * NAS-NEW-01 (owner request, 2026-11-14) puts a second, persistent view of orders in
 * the sidebar (`OrdersPanel`) alongside the existing full page (`OrdersScreen`), and
 * both can be mounted **at the same time** — the sidebar panel never unmounts as the
 * owner moves between screens, including while Orders itself is open. A plain
 * component-local hook called from two places would give each its own fetch and its
 * own copy of the list, so completing an order from the panel would leave the open
 * Orders page showing it as still pending until something told it to reload — exactly
 * the "conflicting order states" the brief warns against. A Zustand store (the same
 * pattern `features/billing/draftStore.ts` already uses for the identical problem) is
 * one copy of the data and one in-flight request per list, read by as many components
 * as are mounted.
 *
 * `pending` and `completed` are loaded **independently** and only on demand — the
 * panel only ever needs `pending` (what needs attention), the full page's own toggle
 * decides which it needs, and neither view forces a fetch the other did not ask for.
 */

import { create } from 'zustand';

import { orders as ordersApi } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import type { Order } from '@/api/types';
import { uuidv7 } from '@/lib/ids';
import { COMMON } from '@/lib/strings';

/** A card still being written, with no server id yet. */
export interface DraftCard {
  localId: string;
  body: string;
  customerName: string;
  phone: string;
}

export interface OrdersState {
  pending: Order[] | null;
  completed: Order[] | null;
  drafts: DraftCard[];
  error: string | null;
  busyId: string | null;
  loadPending: () => Promise<void>;
  loadCompleted: () => Promise<void>;
  addDraft: () => void;
  updateDraft: (localId: string, patch: Partial<DraftCard>) => void;
  discardDraft: (localId: string) => void;
  saveDraft: (draft: DraftCard) => Promise<void>;
  saveEdit: (order: Order, body: string) => Promise<void>;
  complete: (order: Order) => Promise<void>;
  discard: (order: Order) => Promise<void>;
  setReminder: (order: Order, remindAt: string | null) => Promise<void>;
}

function describe(caught: unknown): string {
  return caught instanceof ApiError ? describeError(caught.code).message : COMMON.retry;
}

export const useOrdersStore = create<OrdersState>((set, get) => ({
  pending: null,
  completed: null,
  drafts: [],
  error: null,
  busyId: null,

  async loadPending() {
    set({ pending: null, error: null });
    try {
      const response = await ordersApi.list({ status: 'pending' });
      set({ pending: response.items });
    } catch (caught) {
      set({ pending: [], error: describe(caught) });
    }
  },

  async loadCompleted() {
    set({ completed: null, error: null });
    try {
      const response = await ordersApi.list({ status: 'completed' });
      set({ completed: response.items });
    } catch (caught) {
      set({ completed: [], error: describe(caught) });
    }
  },

  addDraft() {
    set((s) => ({
      drafts: [{ localId: uuidv7(), body: '', customerName: '', phone: '' }, ...s.drafts],
    }));
  },

  updateDraft(localId, patch) {
    set((s) => ({
      drafts: s.drafts.map((d) => (d.localId === localId ? { ...d, ...patch } : d)),
    }));
  },

  discardDraft(localId) {
    set((s) => ({ drafts: s.drafts.filter((d) => d.localId !== localId) }));
  },

  async saveDraft(draft) {
    if (!draft.body.trim()) return;
    set({ busyId: draft.localId, error: null });
    try {
      await ordersApi.create({
        body: draft.body,
        customer_name: draft.customerName || null,
        phone: draft.phone || null,
      });
      get().discardDraft(draft.localId);
      await get().loadPending();
    } catch (caught) {
      set({ error: describe(caught) });
    } finally {
      set({ busyId: null });
    }
  },

  async saveEdit(order, body) {
    set({ busyId: order.id });
    try {
      await ordersApi.update(order.id, { body });
      await get().loadPending();
    } catch (caught) {
      set({ error: describe(caught) });
    } finally {
      set({ busyId: null });
    }
  },

  async complete(order) {
    set({ busyId: order.id });
    try {
      await ordersApi.complete(order.id);
      // Only the lists already in use refetch — refreshing `completed` for a caller
      // that never asked for it would be a request nobody is waiting on.
      await Promise.all([
        get().loadPending(),
        get().completed !== null ? get().loadCompleted() : Promise.resolve(),
      ]);
    } finally {
      set({ busyId: null });
    }
  },

  async discard(order) {
    set({ busyId: order.id });
    try {
      await ordersApi.discard(order.id);
      await Promise.all([
        get().loadPending(),
        get().completed !== null ? get().loadCompleted() : Promise.resolve(),
      ]);
    } finally {
      set({ busyId: null });
    }
  },

  async setReminder(order, remindAt) {
    set({ busyId: order.id, error: null });
    try {
      await ordersApi.setReminder(order.id, remindAt);
      await get().loadPending();
    } catch (caught) {
      set({ error: describe(caught) });
    } finally {
      set({ busyId: null });
    }
  },
}));

/** Test-only: one store instance is shared module-wide, so a test that leaves orders,
 *  drafts or an error behind would otherwise leak into the next one. */
export function resetOrdersStore(): void {
  useOrdersStore.setState({
    pending: null,
    completed: null,
    drafts: [],
    error: null,
    busyId: null,
  });
}

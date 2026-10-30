/**
 * Local persistence (IndexedDB via Dexie).
 *
 * **Two queues, not one** (ADR-010), and that separation is the most important thing in
 * this file. An outbox operation is always safe to replay and may be created offline; a
 * pending finalisation may already have charged a customer and can never be created
 * offline. Keeping them in separate stores makes that distinction structural rather than
 * a convention someone has to remember.
 *
 * Drafts live here and **not** in the TanStack Query cache (ADR-025): a query cache is
 * keyed to a response and is cleared freely, while a draft has to survive a power cut.
 */

import Dexie, { type Table } from 'dexie';

/** `editing` → `submitting` → (`finalized` | `unconfirmed` | `conflict`). */
export type DraftStatus =
  | 'editing'
  | 'submitting'
  /** Sent, outcome unknown. The loudest state in the app (§4.9). */
  | 'unconfirmed'
  | 'conflict'
  | 'finalized';

export interface LocalDraftLine {
  id: string;
  line_no: number;
  product_id: string;
  product_name: string;
  sku: string | null;
  unit_code: string;
  /** Decimal **strings**, end to end. Never a `number` (ADR-013). */
  quantity: string;
  unit_price: string;
  catalog_price_at_add: string;
  price_source: 'catalog' | 'manual_override';
  discount_percent: string;
  /** Last known stock and when it was read, so the UI can say how stale it is. */
  known_stock: string | null;
  stock_as_of: string | null;
}

export interface LocalDraftHeader {
  customer_id: string | null;
  customer_name: string;
  customer_business_name: string;
  vehicle_number: string;
  mechanic_name: string;
  phone: string;
  notes: string;
  /** A hint only. Finalisation decides the sale type from the button pressed. */
  is_credit_intent: boolean;
}

export interface LocalDraft {
  id: string;
  counter_id: string;
  label: string;
  /** Server version; `null` means never synced, and the create path omits `If-Match`. */
  version: number | null;
  status: DraftStatus;
  header: LocalDraftHeader;
  lines: LocalDraftLine[];
  dirty: boolean;
  last_synced_at: string | null;
  /** The server's view, stored on a `409` for the user to compare against (§6). */
  conflict: unknown;
  /** Set once finalised, so the tab can show the completed bill. */
  invoice_id: string | null;
  updated_at: string;
}

/** The only three operation types that exist. There is no financial type (ADR-011). */
export type OutboxOpType = 'draft.upsert' | 'draft.delete' | 'customer.upsert';

export interface OutboxOp {
  /** Generated once, never changed — it is what makes a replay idempotent. */
  op_id: string;
  /** Monotonic per device, from `meta`. Defines the order the server applies them in. */
  client_seq: number;
  type: OutboxOpType;
  entity_type: 'draft_bill' | 'customer';
  entity_id: string;
  base_version: number | null;
  client_created_at: string;
  /** A JSON object, matching the `payload` the sync contract accepts. */
  payload: Record<string, unknown>;
  status: 'queued' | 'in_flight' | 'conflicted' | 'rejected';
  attempts: number;
  last_error: string | null;
}

/**
 * A finalisation attempt awaiting confirmation.
 *
 * Created **only** while online (FR-OFFLINE-002) — there is deliberately no code path
 * that creates one offline. The key is persisted **before** the first request, because
 * if the browser dies between sending and receiving, a key that was never written turns
 * the retry into a duplicate sale (E-2).
 */
export interface PendingFinalization {
  draft_id: string;
  idempotency_key: string;
  started_at: string;
  /** Detects an edit: a changed bill is a new intent and needs a new key. */
  payload_hash: string;
  attempts: number;
  last_attempt_at: string | null;
  last_error_code: string | null;
  /** Set when auto-retry has given up and a human must check Daily Bills. */
  stale: boolean;
}

/** A bounded subset of the catalog for offline search. Never carries a cost price. */
export interface CachedProductRow {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  normalized_name: string;
  normalized_sku: string | null;
  unit_code: string;
  allows_fraction: boolean;
  default_selling_price: string;
  is_active: boolean;
  branch_quantity: string;
  as_of: string;
  updated_at: string;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

export class CounterDatabase extends Dexie {
  drafts!: Table<LocalDraft, string>;
  outbox!: Table<OutboxOp, string>;
  pending_finalizations!: Table<PendingFinalization, string>;
  catalog_cache!: Table<CachedProductRow, string>;
  meta!: Table<MetaRow, string>;

  constructor(name = 'nas-counter') {
    super(name);
    // Lines are embedded in the draft rather than a separate table: a draft is always
    // read and written whole, and one object store means one transaction per keystroke
    // instead of two.
    this.version(1).stores({
      drafts: 'id, status, counter_id, updated_at',
      outbox: 'op_id, entity_id, client_seq, status',
      pending_finalizations: 'draft_id, idempotency_key, started_at',
      catalog_cache: 'id, normalized_sku, normalized_name, updated_at',
      meta: 'key',
    });
  }
}

export const db = new CounterDatabase();

/**
 * Whether local persistence actually works.
 *
 * Private browsing, a full disk and some locked-down profiles all make IndexedDB
 * unavailable. The app must never *imply* bills are safe when they are not (FE-E-1), so
 * this is checked at startup and a failure produces a blocking warning rather than a
 * silent online-only mode.
 */
export async function storageIsUsable(database: CounterDatabase = db): Promise<boolean> {
  try {
    await database.open();
    await database.meta.put({ key: '__probe', value: Date.now() });
    await database.meta.delete('__probe');
    return true;
  } catch {
    return false;
  }
}

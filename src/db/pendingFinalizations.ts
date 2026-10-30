/**
 * Pending finalisations — the store that exists to prevent a duplicate bill.
 *
 * Separate from the outbox **by design** (ADR-010). An outbox operation is always safe
 * to replay and may be created offline; a finalisation may already have charged the
 * customer. Putting them in one queue would mean one reconnect handler deciding between
 * two very different kinds of risk.
 *
 * The three rules, in the order they matter:
 *
 * 1. **The key is persisted before the first request.** If the browser dies between
 *    sending and receiving, the key must already be on disk, or the retry becomes a
 *    second sale (E-2, §5).
 * 2. **One intent, one key.** Every retry of that intent reuses it. A new key is minted
 *    only when the user changes the bill — which is why the payload is hashed.
 * 3. **Auto-retry stops.** After `finalization_stale_minutes` the client stops guessing
 *    and tells the cashier to check Daily Bills. Retrying forever in the background is
 *    how a sale silently fails to exist.
 *
 * There is deliberately **no function here that can be called offline**: `claim` is
 * invoked only from the online finalisation path (FR-OFFLINE-002).
 */

import { uuidv7 } from '@/lib/ids';
import { serverNowIso, serverNow } from '@/api/session';
import { db, type CounterDatabase, type PendingFinalization } from './schema';

/** Default from `bootstrap.settings`; passed in rather than assumed (rule 15). */
export const DEFAULT_STALE_MINUTES = 60;

/**
 * A stable fingerprint of what is being billed.
 *
 * Covers only what makes the sale *different*: the lines, the sale type, the customer
 * and the payment. A label change or a note is not a new intent, so it must not mint a
 * new key and risk a second invoice for the same goods.
 *
 * This is a **local** change-detector, not the server's canonical fingerprint — the
 * server computes its own from the request body (`§5.2.3`) and is the authority on
 * whether two submissions are the same.
 */
export function payloadHash(input: {
  sale_type: string;
  customer_id: string | null;
  lines: ReadonlyArray<{
    product_id: string;
    quantity: string;
    unit_price: string;
    discount_percent: string;
  }>;
  payment_amount: string | null;
}): string {
  const canonical = [
    input.sale_type,
    input.customer_id ?? '',
    input.payment_amount ?? '',
    ...input.lines
      .map((line) =>
        [line.product_id, line.quantity, line.unit_price, line.discount_percent].join(
          ':',
        ),
      )
      // Sorted so reordering lines on screen is not a different intent.
      .sort(),
  ].join('|');

  // FNV-1a. Not a cryptographic hash and does not need to be: a collision would have to
  // be between two edits of the same bill within one dialog, and the server's own
  // fingerprint is the real guard.
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export async function get(
  draftId: string,
  database: CounterDatabase = db,
): Promise<PendingFinalization | undefined> {
  return database.pending_finalizations.get(draftId);
}

/**
 * Claim an idempotency key for this intent, **persisting it before any request**.
 *
 * Returns the existing key when the bill has not changed, so every retry of one intent
 * carries the same key. Returns a **new** key when the hash differs, because the user
 * edited the bill and the old key now describes a different sale the server may already
 * have stored a response for (`IDEMPOTENCY_KEY_REUSE`).
 */
export async function claim(
  draftId: string,
  hash: string,
  database: CounterDatabase = db,
): Promise<PendingFinalization> {
  return database.transaction('rw', database.pending_finalizations, async () => {
    const existing = await database.pending_finalizations.get(draftId);
    if (existing && existing.payload_hash === hash) return existing;

    const claimed: PendingFinalization = {
      draft_id: draftId,
      idempotency_key: uuidv7(),
      started_at: serverNowIso(),
      payload_hash: hash,
      attempts: 0,
      last_attempt_at: null,
      last_error_code: null,
      stale: false,
    };
    await database.pending_finalizations.put(claimed);
    return claimed;
  });
}

export async function recordAttempt(
  draftId: string,
  errorCode: string | null,
  database: CounterDatabase = db,
): Promise<void> {
  await database.transaction('rw', database.pending_finalizations, async () => {
    const existing = await database.pending_finalizations.get(draftId);
    if (!existing) return;
    await database.pending_finalizations.put({
      ...existing,
      attempts: existing.attempts + 1,
      last_attempt_at: serverNowIso(),
      last_error_code: errorCode,
    });
  });
}

/**
 * Resolve the intent.
 *
 * Called when the sale completed **or** was definitively refused. Both are resolutions:
 * holding a key for a refused sale would make the next attempt replay a stored error.
 */
export async function resolve(
  draftId: string,
  database: CounterDatabase = db,
): Promise<void> {
  await database.pending_finalizations.delete(draftId);
}

/**
 * Drop the key because the user edited the bill.
 *
 * The intent changed, so the old key must not be reused (§5 step 3).
 */
export async function invalidateOnEdit(
  draftId: string,
  database: CounterDatabase = db,
): Promise<void> {
  await database.pending_finalizations.delete(draftId);
}

/**
 * Attempts the client should retry on reconnect, and those it should stop retrying.
 *
 * Splitting them here rather than in the scheduler keeps the stale rule in one place:
 * past the window, the client stops guessing and asks a person to look.
 */
export async function partitionByStaleness(
  staleMinutes = DEFAULT_STALE_MINUTES,
  database: CounterDatabase = db,
): Promise<{ retryable: PendingFinalization[]; stale: PendingFinalization[] }> {
  const all = await database.pending_finalizations.toArray();
  const cutoff = serverNow().getTime() - staleMinutes * 60_000;

  const retryable: PendingFinalization[] = [];
  const stale: PendingFinalization[] = [];
  for (const entry of all) {
    const started = Date.parse(entry.started_at);
    if (entry.stale || (Number.isFinite(started) && started < cutoff)) {
      stale.push(entry);
    } else {
      retryable.push(entry);
    }
  }
  return { retryable, stale };
}

export async function markStale(
  draftId: string,
  database: CounterDatabase = db,
): Promise<void> {
  await database.transaction('rw', database.pending_finalizations, async () => {
    const existing = await database.pending_finalizations.get(draftId);
    if (!existing) return;
    await database.pending_finalizations.put({ ...existing, stale: true });
  });
}

export async function all(
  database: CounterDatabase = db,
): Promise<PendingFinalization[]> {
  return database.pending_finalizations.toArray();
}

/**
 * The outbox: a durable, ordered queue of the three operations that are safe offline.
 *
 * `draft.upsert`, `draft.delete`, `customer.upsert` — and nothing else. There is no
 * financial operation type, which is enforced here as well as on the server (ADR-011):
 * a sale may already have charged a customer, so it can never be something a reconnect
 * silently replays.
 *
 * **Coalescing** is the reason typing feels free: repeated `draft.upsert` for the same
 * draft while still `queued` collapse to the latest payload, keeping the original
 * `op_id`. A minute of typing becomes one operation rather than sixty, and the `op_id`
 * is kept so a server that already saw the first attempt still recognises the replay.
 */

import { uuidv7 } from '@/lib/ids';
import { serverNowIso } from '@/api/session';
import { nextClientSeq } from './meta';
import { db, type CounterDatabase, type OutboxOp, type OutboxOpType } from './schema';

/** Server cap (`bootstrap.sync.max_batch_size`); used as the default slice size. */
export const DEFAULT_BATCH_SIZE = 100;

/**
 * Queue an operation, coalescing with a queued one for the same entity when possible.
 *
 * Only `draft.upsert` coalesces. A `draft.delete` must stay distinct — collapsing an
 * upsert and a delete would make the final state depend on which one the collapse kept.
 */
export async function enqueue(
  input: {
    type: OutboxOpType;
    entity_type: OutboxOp['entity_type'];
    entity_id: string;
    base_version: number | null;
    payload: Record<string, unknown>;
  },
  database: CounterDatabase = db,
): Promise<OutboxOp> {
  const coalescable = input.type === 'draft.upsert';

  if (coalescable) {
    const queued = await database.outbox
      .where('entity_id')
      .equals(input.entity_id)
      .filter((op) => op.status === 'queued' && op.type === input.type)
      .first();
    if (queued) {
      const updated: OutboxOp = {
        ...queued,
        // The newest content wins, but the original `op_id` and `client_seq` are kept:
        // the id is what the server deduplicates on, and the sequence is what keeps
        // this entity's operations in order relative to everything else.
        payload: input.payload,
        base_version: input.base_version,
        client_created_at: serverNowIso(),
      };
      await database.outbox.put(updated);
      return updated;
    }
  }

  const op: OutboxOp = {
    op_id: uuidv7(),
    client_seq: await nextClientSeq(database),
    type: input.type,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    base_version: input.base_version,
    client_created_at: serverNowIso(),
    payload: input.payload,
    status: 'queued',
    attempts: 0,
    last_error: null,
  };
  await database.outbox.add(op);
  return op;
}

/**
 * The next batch to send, in `client_seq` order.
 *
 * Operations for an entity that already has a `conflicted` or `rejected` operation are
 * **excluded**: sending a later change for the same draft would either fail the same way
 * or, worse, succeed and quietly discard the conflict the user has not resolved yet.
 */
export async function nextBatch(
  limit = DEFAULT_BATCH_SIZE,
  database: CounterDatabase = db,
): Promise<OutboxOp[]> {
  const all = await database.outbox.orderBy('client_seq').toArray();
  const blocked = new Set(
    all
      .filter((op) => op.status === 'conflicted' || op.status === 'rejected')
      .map((op) => op.entity_id),
  );
  return all
    .filter((op) => op.status === 'queued' && !blocked.has(op.entity_id))
    .slice(0, limit);
}

export async function markInFlight(
  opIds: readonly string[],
  database: CounterDatabase = db,
): Promise<void> {
  await database.transaction('rw', database.outbox, async () => {
    for (const opId of opIds) {
      const op = await database.outbox.get(opId);
      if (op) {
        await database.outbox.put({
          ...op,
          status: 'in_flight',
          attempts: op.attempts + 1,
        });
      }
    }
  });
}

/** Accepted or replayed: the operation has landed, so it leaves the queue. */
export async function acknowledge(
  opId: string,
  database: CounterDatabase = db,
): Promise<void> {
  await database.outbox.delete(opId);
}

/**
 * A conflict or rejection. **Never silently dropped.**
 *
 * It stays in the queue with its reason so the Sync panel can show it and a person can
 * decide. A `rejected` operation is never auto-retried — a retry that keeps failing in
 * the background is how a bill quietly fails to exist.
 */
export async function markNeedsAttention(
  opId: string,
  status: 'conflicted' | 'rejected',
  errorCode: string | null,
  database: CounterDatabase = db,
): Promise<void> {
  await database.transaction('rw', database.outbox, async () => {
    const op = await database.outbox.get(opId);
    if (!op) return;
    await database.outbox.put({ ...op, status, last_error: errorCode });
  });
}

/** Return an in-flight operation to the queue after a network failure. */
export async function requeue(
  opIds: readonly string[],
  errorCode: string | null,
  database: CounterDatabase = db,
): Promise<void> {
  await database.transaction('rw', database.outbox, async () => {
    for (const opId of opIds) {
      const op = await database.outbox.get(opId);
      if (op && op.status === 'in_flight') {
        await database.outbox.put({ ...op, status: 'queued', last_error: errorCode });
      }
    }
  });
}

export async function pendingCount(database: CounterDatabase = db): Promise<number> {
  return database.outbox.where('status').anyOf('queued', 'in_flight').count();
}

export async function needingAttention(
  database: CounterDatabase = db,
): Promise<OutboxOp[]> {
  return database.outbox.where('status').anyOf('conflicted', 'rejected').toArray();
}

/** Clear an operation the user has acknowledged in the Sync panel. */
export async function dismiss(
  opId: string,
  database: CounterDatabase = db,
): Promise<void> {
  await database.outbox.delete(opId);
}

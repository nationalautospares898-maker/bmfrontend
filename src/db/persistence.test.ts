/**
 * Local persistence, against **real IndexedDB** (`fake-indexeddb`).
 *
 * Not mocked, because the behaviour under test is survival: a draft has to still be
 * there after the page is gone, and a mock that returns what it was given proves
 * nothing about that.
 *
 * The cases here are the ones that cost money if they are wrong:
 *
 * - a draft survives a reload;
 * - the open-bill limit **refuses** rather than discarding someone's typing;
 * - an edit invalidates the idempotency key, so a changed bill is a new intent;
 * - an unconfirmed bill cannot be cleared;
 * - a conflicted entity blocks its own later operations instead of overwriting them.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import * as draftsDb from './drafts';
import * as outbox from './outbox';
import * as pending from './pendingFinalizations';
import { CounterDatabase, type LocalDraftLine } from './schema';
import { ensureDeviceId, nextClientSeq } from './meta';

const COUNTER = '0192f000-0000-7000-8000-000000000001';

function line(
  productId: string,
  quantity = '1.000',
): Omit<LocalDraftLine, 'id' | 'line_no'> {
  return {
    product_id: productId,
    product_name: 'Brake Shoe Set',
    sku: 'TT-407-BS',
    unit_code: 'SET',
    quantity,
    unit_price: '1250.0000',
    catalog_price_at_add: '1250.0000',
    price_source: 'catalog',
    discount_percent: '0.000',
    known_stock: '10.000',
    stock_as_of: '2026-10-30T10:00:00Z',
  };
}

let db: CounterDatabase;
let dbIndex = 0;

beforeEach(async () => {
  // A fresh database per test, so one test's drafts cannot explain another's pass.
  dbIndex += 1;
  db = new CounterDatabase(`test-${dbIndex}`);
  await db.open();
});

describe('drafts survive', () => {
  it('a draft written in one session is readable in the next', async () => {
    const draft = await draftsDb.createDraft(COUNTER, 4, 'Bill 1', db);
    await draftsDb.updateDraft(
      draft.id,
      (current) => draftsDb.appendLine(current, line('p1')),
      db,
    );
    db.close();

    // A new handle to the same database is as close as a test gets to a reload.
    const reopened = new CounterDatabase(`test-${dbIndex}`);
    await reopened.open();
    const recovered = await draftsDb.getDraft(draft.id, reopened);

    expect(recovered?.lines).toHaveLength(1);
    expect(recovered?.lines[0]?.product_id).toBe('p1');
    reopened.close();
  });

  it('every line edit is on disk, not only in memory', async () => {
    const draft = await draftsDb.createDraft(COUNTER, 4, 'Bill 1', db);
    await draftsDb.updateDraft(draft.id, (d) => draftsDb.appendLine(d, line('p1')), db);
    const updated = await draftsDb.updateDraft(
      draft.id,
      (d) => {
        const first = d.lines[0];
        if (first) first.quantity = '3.000';
      },
      db,
    );
    expect(updated?.lines[0]?.quantity).toBe('3.000');
    expect((await draftsDb.getDraft(draft.id, db))?.lines[0]?.quantity).toBe('3.000');
  });
});

describe('the open-bill limit refuses rather than discarding (FR-DRAFT-003)', () => {
  it('throws at the limit and keeps every existing bill', async () => {
    await draftsDb.createDraft(COUNTER, 2, 'Bill 1', db);
    await draftsDb.createDraft(COUNTER, 2, 'Bill 2', db);

    await expect(draftsDb.createDraft(COUNTER, 2, 'Bill 3', db)).rejects.toBeInstanceOf(
      draftsDb.DraftLimitReached,
    );

    // The point of the test: nothing was closed to make room.
    expect(await draftsDb.openDrafts(COUNTER, db)).toHaveLength(2);
  });

  it('counts only open bills, so a finalised one frees a tab', async () => {
    const first = await draftsDb.createDraft(COUNTER, 1, 'Bill 1', db);
    await draftsDb.markFinalized(first.id, 'invoice-1', db);
    const second = await draftsDb.createDraft(COUNTER, 1, 'Bill 2', db);
    expect(second.id).not.toBe(first.id);
  });
});

describe('a finalised draft is a record, not a draft', () => {
  it('cannot be edited', async () => {
    const draft = await draftsDb.createDraft(COUNTER, 4, 'Bill 1', db);
    await draftsDb.markFinalized(draft.id, 'invoice-1', db);
    await draftsDb.updateDraft(draft.id, (d) => draftsDb.appendLine(d, line('p9')), db);
    expect((await draftsDb.getDraft(draft.id, db))?.lines).toHaveLength(0);
  });

  it('cannot be cleared', async () => {
    const draft = await draftsDb.createDraft(COUNTER, 4, 'Bill 1', db);
    await draftsDb.markFinalized(draft.id, 'invoice-1', db);
    expect(await draftsDb.clearDraft(draft.id, db)).toBe('refused_finalized');
    expect(await draftsDb.getDraft(draft.id, db)).toBeDefined();
  });
});

describe('an unconfirmed bill cannot be cleared (E-2)', () => {
  it('refuses while a finalisation is pending', async () => {
    const draft = await draftsDb.createDraft(COUNTER, 4, 'Bill 1', db);
    await pending.claim(draft.id, 'hash-1', db);

    // Clearing here would destroy the only local record of a sale that may already
    // have committed and charged the customer.
    expect(await draftsDb.clearDraft(draft.id, db)).toBe('refused_unconfirmed');
    expect(await draftsDb.getDraft(draft.id, db)).toBeDefined();
  });

  it('refuses while the status is unconfirmed even with no pending row', async () => {
    const draft = await draftsDb.createDraft(COUNTER, 4, 'Bill 1', db);
    await draftsDb.setDraftStatus(draft.id, 'unconfirmed', db);
    expect(await draftsDb.clearDraft(draft.id, db)).toBe('refused_unconfirmed');
  });

  it('allows clearing an ordinary editing draft', async () => {
    const draft = await draftsDb.createDraft(COUNTER, 4, 'Bill 1', db);
    expect(await draftsDb.clearDraft(draft.id, db)).toBe('cleared');
    expect(await draftsDb.getDraft(draft.id, db)).toBeUndefined();
  });
});

describe('the idempotency key — one intent, one key (§5)', () => {
  it('returns the same key for an unchanged bill', async () => {
    const first = await pending.claim('draft-1', 'hash-a', db);
    const second = await pending.claim('draft-1', 'hash-a', db);
    expect(second.idempotency_key).toBe(first.idempotency_key);
  });

  it('mints a new key when the bill changed', async () => {
    const first = await pending.claim('draft-1', 'hash-a', db);
    const second = await pending.claim('draft-1', 'hash-b', db);
    // A changed bill is a different sale. Reusing the key would make the server
    // answer `IDEMPOTENCY_KEY_REUSE` instead of billing it.
    expect(second.idempotency_key).not.toBe(first.idempotency_key);
  });

  it('is persisted before any request could have been made', async () => {
    const claimed = await pending.claim('draft-1', 'hash-a', db);
    // Read back from disk, not from the return value: if the browser dies between
    // sending and receiving, this is what the retry has to find.
    expect((await pending.get('draft-1', db))?.idempotency_key).toBe(
      claimed.idempotency_key,
    );
  });

  it('is dropped when the user edits the bill', async () => {
    await pending.claim('draft-1', 'hash-a', db);
    await pending.invalidateOnEdit('draft-1', db);
    expect(await pending.get('draft-1', db)).toBeUndefined();
  });

  it('hashes the same bill identically whatever order the lines are in', () => {
    const a = pending.payloadHash({
      sale_type: 'cash',
      customer_id: null,
      lines: [
        {
          product_id: 'p1',
          quantity: '1.000',
          unit_price: '10.0000',
          discount_percent: '0',
        },
        {
          product_id: 'p2',
          quantity: '2.000',
          unit_price: '20.0000',
          discount_percent: '0',
        },
      ],
      payment_amount: '50.00',
    });
    const b = pending.payloadHash({
      sale_type: 'cash',
      customer_id: null,
      lines: [
        {
          product_id: 'p2',
          quantity: '2.000',
          unit_price: '20.0000',
          discount_percent: '0',
        },
        {
          product_id: 'p1',
          quantity: '1.000',
          unit_price: '10.0000',
          discount_percent: '0',
        },
      ],
      payment_amount: '50.00',
    });
    // Reordering lines on screen is not a different sale, so it must not mint a new
    // key and risk a second invoice for the same goods.
    expect(a).toBe(b);
  });

  it('hashes differently when a quantity changes', () => {
    const base = {
      sale_type: 'cash',
      customer_id: null,
      payment_amount: '10.00',
      lines: [
        {
          product_id: 'p1',
          quantity: '1.000',
          unit_price: '10.0000',
          discount_percent: '0',
        },
      ],
    };
    const changed = {
      ...base,
      lines: [
        {
          product_id: 'p1',
          quantity: '2.000',
          unit_price: '10.0000',
          discount_percent: '0',
        },
      ],
    };
    expect(pending.payloadHash(base)).not.toBe(pending.payloadHash(changed));
  });

  it('stops retrying past the stale window', async () => {
    await pending.claim('draft-1', 'hash-a', db);
    const { retryable, stale } = await pending.partitionByStaleness(0, db);
    // A zero-minute window makes everything stale; the real window is 60 minutes.
    // Past it the client stops guessing and asks a person to check Daily Bills.
    expect(retryable).toHaveLength(0);
    expect(stale).toHaveLength(1);
  });
});

describe('the outbox', () => {
  it('coalesces repeated draft upserts and keeps the original op_id', async () => {
    const first = await outbox.enqueue(
      {
        type: 'draft.upsert',
        entity_type: 'draft_bill',
        entity_id: 'draft-1',
        base_version: null,
        payload: { label: 'first' },
      },
      db,
    );
    const second = await outbox.enqueue(
      {
        type: 'draft.upsert',
        entity_type: 'draft_bill',
        entity_id: 'draft-1',
        base_version: null,
        payload: { label: 'second' },
      },
      db,
    );

    // One operation, the latest content, the original id — a minute of typing is one
    // push, and a server that already saw the first attempt still recognises it.
    expect(second.op_id).toBe(first.op_id);
    expect(await outbox.pendingCount(db)).toBe(1);
    expect((await outbox.nextBatch(100, db))[0]?.payload).toEqual({ label: 'second' });
  });

  it('does not coalesce a delete with an upsert', async () => {
    await outbox.enqueue(
      {
        type: 'draft.upsert',
        entity_type: 'draft_bill',
        entity_id: 'draft-1',
        base_version: null,
        payload: {},
      },
      db,
    );
    await outbox.enqueue(
      {
        type: 'draft.delete',
        entity_type: 'draft_bill',
        entity_id: 'draft-1',
        base_version: 1,
        payload: {},
      },
      db,
    );
    // Collapsing these would make the final state depend on which one survived.
    expect(await outbox.pendingCount(db)).toBe(2);
  });

  it('blocks later operations for an entity whose conflict is unresolved', async () => {
    const conflicted = await outbox.enqueue(
      {
        type: 'draft.upsert',
        entity_type: 'draft_bill',
        entity_id: 'draft-1',
        base_version: 1,
        payload: { label: 'a' },
      },
      db,
    );
    await outbox.markNeedsAttention(
      conflicted.op_id,
      'conflicted',
      'DRAFT_VERSION_CONFLICT',
      db,
    );

    await outbox.enqueue(
      {
        type: 'draft.upsert',
        entity_type: 'draft_bill',
        entity_id: 'draft-1',
        base_version: 2,
        payload: { label: 'b' },
      },
      db,
    );
    await outbox.enqueue(
      {
        type: 'customer.upsert',
        entity_type: 'customer',
        entity_id: 'cust-1',
        base_version: null,
        payload: {},
      },
      db,
    );

    const batch = await outbox.nextBatch(100, db);
    // The other entity is unaffected; the conflicted draft's later change waits for a
    // person rather than overwriting the conflict they have not seen yet.
    expect(batch.map((op) => op.entity_id)).toEqual(['cust-1']);
  });

  it('never silently drops a rejection', async () => {
    const op = await outbox.enqueue(
      {
        type: 'draft.upsert',
        entity_type: 'draft_bill',
        entity_id: 'draft-1',
        base_version: null,
        payload: {},
      },
      db,
    );
    await outbox.markNeedsAttention(op.op_id, 'rejected', 'CORRUPT_VERSION', db);
    const attention = await outbox.needingAttention(db);
    expect(attention).toHaveLength(1);
    expect(attention[0]?.last_error).toBe('CORRUPT_VERSION');
  });

  it('returns an in-flight operation to the queue after a network failure', async () => {
    const op = await outbox.enqueue(
      {
        type: 'draft.upsert',
        entity_type: 'draft_bill',
        entity_id: 'draft-1',
        base_version: null,
        payload: {},
      },
      db,
    );
    await outbox.markInFlight([op.op_id], db);
    await outbox.requeue([op.op_id], 'NETWORK', db);
    expect((await outbox.nextBatch(100, db))[0]?.op_id).toBe(op.op_id);
  });

  it('allocates client_seq monotonically', async () => {
    const seqs = [
      await nextClientSeq(db),
      await nextClientSeq(db),
      await nextClientSeq(db),
    ];
    expect(seqs).toEqual([1, 2, 3]);
  });
});

describe('device identity', () => {
  it('generates the device id once and never replaces it', async () => {
    const first = await ensureDeviceId(db);
    const second = await ensureDeviceId(db);
    // A new id on each load would orphan this machine's registration and force a
    // re-login every time.
    expect(second).toBe(first);
  });
});

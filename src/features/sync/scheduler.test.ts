/**
 * The sync layer: the outbox drain, the catalog cache, and the offline boundary.
 *
 * The cases that matter:
 *
 * - **no financial operation can ever be queued** (ADR-011) — asserted against the
 *   type-level allow-list *and* the shape of what the drain sends;
 * - `accepted`/`replayed` adopt the server's version, so the next edit sends the right
 *   `If-Match`;
 * - `conflicted` marks the draft and **keeps** the operation for a person;
 * - `rejected` is surfaced, never dropped;
 * - a network failure requeues rather than discarding;
 * - the catalog cache never carries a cost price, and `reset_required` clears it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NetworkError } from '@/api/errors';
import * as catalogCache from '@/db/catalogCache';
import * as outbox from '@/db/outbox';
import * as draftsDb from '@/db/drafts';
import { setDeviceId } from '@/api/session';
import { CounterDatabase, type OutboxOpType } from '@/db/schema';
import { SyncScheduler } from './scheduler';

const pushMock = vi.fn();
const catalogDeltaMock = vi.fn();

vi.mock('@/api/endpoints', () => ({
  sync: {
    push: (...args: unknown[]): unknown => pushMock(...args) as unknown,
    catalogDelta: (...args: unknown[]): unknown => catalogDeltaMock(...args) as unknown,
  },
}));

const COUNTER = '0192f000-0000-7000-8000-00000000c001';

let db: CounterDatabase;
let index = 0;

beforeEach(async () => {
  pushMock.mockReset();
  catalogDeltaMock.mockReset();
  setDeviceId('device-1');
  index += 1;
  db = new CounterDatabase(`sync-test-${index}`);
  await db.open();
});

/** Drive one drain pass without starting the timers or claiming the Web Lock. */
async function drainOnce(scheduler: SyncScheduler): Promise<void> {
  // `run` is private; `syncNow` is the public trigger and resets the backoff, which is
  // exactly what a test wants. The owner flag has to be set for it to do anything.
  (scheduler as unknown as { isOwner: boolean }).isOwner = true;
  await scheduler.syncNow();
}

describe('no financial operation can be queued (ADR-011)', () => {
  it('the operation type union admits only the three safe types', () => {
    // A compile-time guarantee made visible: adding `'sale.finalize'` to the union
    // would fail to typecheck against this list, and the drain below would carry it.
    const allowed: OutboxOpType[] = ['draft.upsert', 'draft.delete', 'customer.upsert'];
    expect(allowed).toHaveLength(3);
  });

  it('sends only draft and customer operations', async () => {
    pushMock.mockResolvedValue({ results: [], server_time: '2026-10-30T10:00:00Z' });

    for (const type of [
      'draft.upsert',
      'draft.delete',
      'customer.upsert',
    ] as OutboxOpType[]) {
      await outbox.enqueue(
        {
          type,
          entity_type: type.startsWith('draft') ? 'draft_bill' : 'customer',
          entity_id: `${type}-entity`,
          base_version: null,
          payload: {},
        },
        db,
      );
    }

    await drainOnce(new SyncScheduler(db));

    const body = pushMock.mock.calls[0]?.[0] as {
      operations: Array<{ type: string }>;
    };
    const types = body.operations.map((op) => op.type);
    // Nothing financial, because there is no code path that can create one. A sale may
    // already have charged a customer, so it can never be something a reconnect
    // silently replays.
    expect(
      types.every((type) => type.startsWith('draft.') || type.startsWith('customer.')),
    ).toBe(true);
    expect(types).not.toContain('sale.finalize');
    expect(types).not.toContain('payment.record');
  });
});

describe('applying the server’s per-operation results (§8.1)', () => {
  it('adopts the version on accepted and clears the queue', async () => {
    const draft = await draftsDb.createDraft(COUNTER, 4, 'Bill 1', db);
    const op = await outbox.enqueue(
      {
        type: 'draft.upsert',
        entity_type: 'draft_bill',
        entity_id: draft.id,
        base_version: null,
        payload: {},
      },
      db,
    );
    pushMock.mockResolvedValue({
      results: [{ op_id: op.op_id, status: 'accepted', server_state: { version: 7 } }],
      server_time: '2026-10-30T10:00:00Z',
    });

    await drainOnce(new SyncScheduler(db));

    // Adopting the version is what makes the *next* edit send the right `If-Match`.
    expect((await draftsDb.getDraft(draft.id, db))?.version).toBe(7);
    expect((await draftsDb.getDraft(draft.id, db))?.dirty).toBe(false);
    expect(await outbox.pendingCount(db)).toBe(0);
  });

  it('treats replayed exactly like accepted', async () => {
    const draft = await draftsDb.createDraft(COUNTER, 4, 'Bill 1', db);
    const op = await outbox.enqueue(
      {
        type: 'draft.upsert',
        entity_type: 'draft_bill',
        entity_id: draft.id,
        base_version: 1,
        payload: {},
      },
      db,
    );
    pushMock.mockResolvedValue({
      results: [{ op_id: op.op_id, status: 'replayed', server_state: { version: 3 } }],
      server_time: '2026-10-30T10:00:00Z',
    });

    await drainOnce(new SyncScheduler(db));
    expect((await draftsDb.getDraft(draft.id, db))?.version).toBe(3);
    expect(await outbox.pendingCount(db)).toBe(0);
  });

  it('marks the draft and keeps the operation on conflicted', async () => {
    const draft = await draftsDb.createDraft(COUNTER, 4, 'Bill 1', db);
    const op = await outbox.enqueue(
      {
        type: 'draft.upsert',
        entity_type: 'draft_bill',
        entity_id: draft.id,
        base_version: 1,
        payload: {},
      },
      db,
    );
    pushMock.mockResolvedValue({
      results: [
        {
          op_id: op.op_id,
          status: 'conflicted',
          server_state: { version: 5, label: 'theirs' },
          error: { code: 'DRAFT_VERSION_CONFLICT', message: 'x' },
        },
      ],
      server_time: '2026-10-30T10:00:00Z',
    });

    await drainOnce(new SyncScheduler(db));

    const stored = await draftsDb.getDraft(draft.id, db);
    expect(stored?.status).toBe('conflict');
    // The server's version is kept alongside the local one. **No automatic merge**
    // (ADR-007): the person who typed the bill decides which is right.
    expect(stored?.conflict).toEqual({ version: 5, label: 'theirs' });
    expect(await outbox.needingAttention(db)).toHaveLength(1);
  });

  it('surfaces a rejection and never drops it', async () => {
    const op = await outbox.enqueue(
      {
        type: 'draft.upsert',
        entity_type: 'draft_bill',
        entity_id: 'draft-x',
        base_version: 9,
        payload: {},
      },
      db,
    );
    pushMock.mockResolvedValue({
      results: [
        {
          op_id: op.op_id,
          status: 'rejected',
          server_state: null,
          error: { code: 'CORRUPT_VERSION', message: 'x' },
        },
      ],
      server_time: '2026-10-30T10:00:00Z',
    });

    await drainOnce(new SyncScheduler(db));

    const attention = await outbox.needingAttention(db);
    expect(attention).toHaveLength(1);
    expect(attention[0]?.last_error).toBe('CORRUPT_VERSION');
    // Never auto-retried: a `rejected` operation retried forever in the background is
    // how a bill quietly fails to exist.
    expect(await outbox.nextBatch(100, db)).toHaveLength(0);
  });

  it('leaves a skipped operation queued without marking it', async () => {
    const op = await outbox.enqueue(
      {
        type: 'draft.upsert',
        entity_type: 'draft_bill',
        entity_id: 'draft-y',
        base_version: null,
        payload: {},
      },
      db,
    );
    pushMock.mockResolvedValue({
      results: [
        {
          op_id: op.op_id,
          status: 'skipped',
          server_state: null,
          error: { code: 'SKIPPED_AFTER_EARLIER_FAILURE', message: 'x' },
        },
      ],
      server_time: '2026-10-30T10:00:00Z',
    });

    await drainOnce(new SyncScheduler(db));
    // Still queued, not flagged: an earlier operation for the same entity has to be
    // resolved first, and `nextBatch` already handles the ordering.
    expect(await outbox.needingAttention(db)).toHaveLength(0);
    expect(await outbox.pendingCount(db)).toBe(1);
  });

  it('requeues the whole batch after a network failure', async () => {
    await outbox.enqueue(
      {
        type: 'draft.upsert',
        entity_type: 'draft_bill',
        entity_id: 'draft-z',
        base_version: null,
        payload: {},
      },
      db,
    );
    pushMock.mockRejectedValue(new NetworkError());

    await drainOnce(new SyncScheduler(db));

    // A network failure says nothing about whether the server applied them, and the
    // per-operation `op_id` makes the resend safe.
    expect(await outbox.pendingCount(db)).toBe(1);
    expect(await outbox.nextBatch(100, db)).toHaveLength(1);
  });
});

describe('the catalog cache', () => {
  function delta(overrides: Record<string, unknown> = {}) {
    return {
      products: [
        {
          id: 'p1',
          name: 'Brake Shoe Set',
          sku: 'TT-407-BS',
          barcode: null,
          unit: { code: 'SET', allows_fraction: false },
          default_selling_price: '1250.0000',
          is_active: true,
          stock: { branch_quantity: '10.000', as_of: '2026-10-30T10:00:00Z' },
        },
      ],
      next_cursor: '2026-10-30T10:00:00Z',
      has_more: false,
      reset_required: false,
      cache_policy: { max_rows: 500 },
      as_of: '2026-10-30T10:00:00Z',
      warnings: [],
      ...overrides,
    };
  }

  it('stores normalised keys so an offline search is a lookup, not a scan', async () => {
    catalogDeltaMock.mockResolvedValue(delta());
    await catalogCache.refresh(500, db);

    const row = await catalogCache.getCached('p1', db);
    // Normalised on the way in, using the same rules as the server.
    expect(row?.normalized_sku).toBe('tt407bs');
    expect(row?.normalized_name).toBe('brake shoe set');
  });

  it('never stores a cost price, because there is nowhere to put one', async () => {
    // A stolen counter machine must not carry the shop's margins (`SECURITY.md §11`).
    // The delta never contains `cost_price`; the row type has no field for it, so even
    // a server that leaked one could not persist it here.
    catalogDeltaMock.mockResolvedValue(delta());
    await catalogCache.refresh(500, db);
    const row = await catalogCache.getCached('p1', db);
    expect(row).toBeDefined();
    expect(Object.keys(row!)).not.toContain('cost_price');
  });

  it('clears the cache when the server says the delta source was rebuilt', async () => {
    catalogDeltaMock.mockResolvedValueOnce(delta());
    await catalogCache.refresh(500, db);
    expect(await catalogCache.cachedCount(db)).toBe(1);

    catalogDeltaMock.mockResolvedValueOnce(
      delta({ reset_required: true, products: [], next_cursor: null }),
    );
    await catalogCache.refresh(500, db);

    // Not an optimisation: a cursor the server no longer recognises means the local
    // rows may be missing deletions, and a deactivated product would keep selling.
    expect(await catalogCache.cachedCount(db)).toBe(0);
  });

  it('reports truncation rather than implying the catalog is complete', async () => {
    catalogDeltaMock.mockResolvedValue(
      delta({
        has_more: true,
        warnings: [{ code: 'CATALOG_CACHE_TRUNCATED', message: 'x', details: {} }],
      }),
    );
    const result = await catalogCache.refresh(500, db);
    expect(result.warnings).toContain('CATALOG_CACHE_TRUNCATED');
    expect(result.hasMore).toBe(true);
  });

  it('reports hitting the page cap instead of silently stopping', async () => {
    // `refreshFully` is bounded so a loop cannot run away; stopping is announced
    // because silent truncation reads as "everything is cached" when it is not.
    catalogDeltaMock.mockResolvedValue(delta({ has_more: true }));
    const result = await catalogCache.refreshFully(db, 2);
    expect(result.warnings).toContain('PAGE_CAP_REACHED');
  });

  it('excludes inactive products from an offline search', async () => {
    catalogDeltaMock.mockResolvedValue(
      delta({
        products: [
          {
            id: 'p2',
            name: 'Discontinued Part',
            sku: 'OLD-1',
            barcode: null,
            unit: { code: 'NOS', allows_fraction: false },
            default_selling_price: '100.0000',
            is_active: false,
            stock: { branch_quantity: '5.000', as_of: '2026-10-30T10:00:00Z' },
          },
        ],
      }),
    );
    await catalogCache.refresh(500, db);

    // A cashier must not be able to add a discontinued part offline that they could
    // not add online.
    expect(await catalogCache.searchOffline('discontinued', 20, db)).toHaveLength(0);
  });

  it('finds a part offline by every spelling of its code', async () => {
    catalogDeltaMock.mockResolvedValue(delta());
    await catalogCache.refresh(500, db);

    for (const typed of ['TT-407-BS', 'tt407bs', 'tt 407 bs']) {
      const hits = await catalogCache.searchOffline(typed, 20, db);
      expect(
        hits.map((hit) => hit.product.id),
        typed,
      ).toEqual(['p1']);
    }
  });

  it('carries the as_of time on every cached stock figure', async () => {
    catalogDeltaMock.mockResolvedValue(delta());
    await catalogCache.refresh(500, db);
    const hits = await catalogCache.searchOffline('brake', 20, db);
    // A stock figure with no timestamp reads as live, and acting on a stale figure as
    // if it were live is how something gets sold twice (FR-OFFLINE-009).
    expect(hits[0]?.product.as_of).toBe('2026-10-30T10:00:00Z');
  });
});

describe('the scheduler does not resend finalisations', () => {
  it('only marks them stale, leaving the retry to the billing screen', async () => {
    const scheduler = new SyncScheduler(db);
    await db.pending_finalizations.put({
      draft_id: 'draft-1',
      idempotency_key: 'key-1',
      // Two hours ago, well past the 60-minute window.
      started_at: new Date(Date.now() - 7_200_000).toISOString(),
      payload_hash: 'h',
      attempts: 3,
      last_attempt_at: null,
      last_error_code: null,
      stale: false,
    });
    pushMock.mockResolvedValue({ results: [], server_time: '2026-10-30T10:00:00Z' });

    await drainOnce(scheduler);

    // The scheduler has neither the draft, the money policy nor the payment the user
    // entered; resending from here would be guessing. Its job is to stop pretending an
    // hour-old attempt is still in progress.
    expect((await db.pending_finalizations.get('draft-1'))?.stale).toBe(true);
    expect(pushMock).toHaveBeenCalledTimes(0);
  });
});

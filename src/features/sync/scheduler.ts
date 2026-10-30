/**
 * The sync scheduler.
 *
 * Six triggers, not one (FR-OFFLINE-012), because Background Sync cannot be relied
 * upon: it is absent in several browsers, it is throttled, and a counter machine that
 * only syncs when the browser feels like it is a counter machine whose bills sit on one
 * computer. It is included as an **extra** opportunity, never the only one.
 *
 * Only the **owner tab** runs this. Two tabs on one counter machine would both push the
 * same operations, and the second would see conflicts it caused itself (FE-E-2).
 *
 * Two queues are drained with different rules:
 *
 * - the **outbox**, which is always safe to replay;
 * - **pending finalisations**, which may already have charged a customer, so they are
 *   retried with their original key and give up after the stale window rather than
 *   retrying forever.
 */

import { ApiError, NetworkError } from '@/api/errors';
import { sync } from '@/api/endpoints';
import { getDeviceId } from '@/api/session';
import * as catalogCache from '@/db/catalogCache';
import * as outbox from '@/db/outbox';
import * as pending from '@/db/pendingFinalizations';
import * as draftsDb from '@/db/drafts';
import { db, type CounterDatabase, type OutboxOp } from '@/db/schema';

/** §7 schedule, with jitter applied at use. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 60_000, 300_000] as const;

const BUSY_INTERVAL_MS = 30_000;
const IDLE_INTERVAL_MS = 300_000;
const CATALOG_INTERVAL_MS = 1_800_000;
const MUTATION_DEBOUNCE_MS = 500;

export interface SyncStatus {
  pendingOperations: number;
  needingAttention: number;
  unconfirmedSales: number;
  lastRunAt: string | null;
  lastError: string | null;
  running: boolean;
}

type StatusListener = (status: SyncStatus) => void;

export class SyncScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private catalogTimer: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private running = false;
  private isOwner = false;
  private lockRelease: (() => void) | null = null;
  private readonly listeners = new Set<StatusListener>();
  private status: SyncStatus = {
    pendingOperations: 0,
    needingAttention: 0,
    unconfirmedSales: 0,
    lastRunAt: null,
    lastError: null,
    running: false,
  };

  constructor(private readonly database: CounterDatabase = db) {}

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  private publish(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.status);
  }

  /**
   * Claim the owner lock and start.
   *
   * A Web Lock is held for the tab's whole lifetime; `BroadcastChannel` is not used as a
   * fallback here because a failed claim simply means another tab is the owner, which is
   * the correct outcome rather than something to work around.
   */
  start(): void {
    if (typeof navigator !== 'undefined' && 'locks' in navigator) {
      // Not awaited: the promise resolves only when the lock is released.
      void navigator.locks.request(
        'nas-sync-owner',
        { ifAvailable: true },
        async (lock) => {
          if (!lock) return;
          this.isOwner = true;
          this.attachTriggers();
          void this.run('owner-elected');
          await new Promise<void>((resolve) => {
            this.lockRelease = resolve;
          });
        },
      );
    } else {
      // No Web Locks (an old browser): run anyway rather than never syncing. The server
      // is idempotent per operation, so a duplicated push is harmless.
      this.isOwner = true;
      this.attachTriggers();
      void this.run('no-lock-support');
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.catalogTimer) clearInterval(this.catalogTimer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null;
    this.catalogTimer = null;
    this.debounce = null;
    this.detachTriggers();
    this.lockRelease?.();
    this.lockRelease = null;
    this.isOwner = false;
  }

  private readonly onOnline = () => void this.run('online-event');
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') void this.run('visibility');
  };

  private attachTriggers(): void {
    // 1. `online`, 2. visibility/focus.
    window.addEventListener('online', this.onOnline);
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('focus', this.onVisible);
    // 3. the timer.
    this.schedule();
    // The catalog is refreshed on its own slower cadence.
    this.catalogTimer = setInterval(
      () => void this.refreshCatalog(),
      CATALOG_INTERVAL_MS,
    );
  }

  private detachTriggers(): void {
    window.removeEventListener('online', this.onOnline);
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('focus', this.onVisible);
  }

  /** 4. After a local mutation, debounced, so a minute of typing is one push. */
  notifyMutation(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.run('mutation'), MUTATION_DEBOUNCE_MS);
  }

  /** 5. The explicit "Try now" button. Resets the backoff: the user is asking. */
  async syncNow(): Promise<void> {
    this.failures = 0;
    await this.run('manual');
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    void outbox.pendingCount(this.database).then((count) => {
      const base = count > 0 ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS;
      const backoff =
        this.failures > 0 ? (BACKOFF_MS[Math.min(this.failures - 1, 5)] ?? 300_000) : 0;
      const delay = Math.max(base, backoff) * (0.75 + Math.random() * 0.5);
      this.timer = setTimeout(() => void this.run('timer'), delay);
    });
  }

  /** One pass over both queues. Never overlapping — a second call while busy returns. */
  private async run(_trigger: string): Promise<void> {
    if (!this.isOwner || this.running) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.schedule();
      return;
    }

    this.running = true;
    this.publish({ running: true });
    try {
      await this.drainOutbox();
      await this.resolvePendingFinalizations();
      this.failures = 0;
      this.publish({ lastRunAt: new Date().toISOString(), lastError: null });
    } catch (error) {
      this.failures += 1;
      this.publish({
        lastError: error instanceof ApiError ? error.code : 'NETWORK',
      });
    } finally {
      this.running = false;
      this.publish({
        running: false,
        pendingOperations: await outbox.pendingCount(this.database),
        needingAttention: (await outbox.needingAttention(this.database)).length,
        unconfirmedSales: (await pending.all(this.database)).length,
      });
      this.schedule();
    }
  }

  private async drainOutbox(): Promise<void> {
    const batch = await outbox.nextBatch(outbox.DEFAULT_BATCH_SIZE, this.database);
    if (batch.length === 0) return;

    const deviceId = getDeviceId();
    if (!deviceId) return;

    await outbox.markInFlight(
      batch.map((op) => op.op_id),
      this.database,
    );

    let response;
    try {
      response = await sync.push({
        device_id: deviceId,
        operations: batch.map((op) => ({
          op_id: op.op_id,
          client_seq: op.client_seq,
          type: op.type,
          entity_type: op.entity_type,
          entity_id: op.entity_id,
          base_version: op.base_version,
          client_created_at: op.client_created_at,
          payload: op.payload,
        })),
      });
    } catch (error) {
      if (error instanceof NetworkError || error instanceof ApiError) {
        // Back to `queued`. A network failure says nothing about whether the server
        // applied them, and the per-operation `op_id` makes the resend safe.
        await outbox.requeue(
          batch.map((op) => op.op_id),
          error instanceof ApiError ? error.code : 'NETWORK',
          this.database,
        );
      }
      throw error;
    }

    for (const result of response.results) {
      const op = batch.find((candidate) => candidate.op_id === result.op_id);
      if (!op) continue;
      await this.applyOperationResult(op, result);
    }
  }

  private async applyOperationResult(
    op: OutboxOp,
    result: { status: string; server_state: unknown; error?: { code: string } | null },
  ): Promise<void> {
    switch (result.status) {
      case 'accepted':
      case 'replayed': {
        // Adopt the server's version so the next edit sends the right `If-Match`.
        const version = (result.server_state as { version?: number } | null)?.version;
        if (op.entity_type === 'draft_bill' && typeof version === 'number') {
          await draftsDb.markSynced(op.entity_id, version, this.database);
        }
        await outbox.acknowledge(op.op_id, this.database);
        return;
      }
      case 'conflicted': {
        // Kept for the user. No automatic merge, ever (ADR-007).
        await outbox.markNeedsAttention(
          op.op_id,
          'conflicted',
          result.error?.code ?? 'DRAFT_VERSION_CONFLICT',
          this.database,
        );
        if (op.entity_type === 'draft_bill') {
          await draftsDb.markConflict(op.entity_id, result.server_state, this.database);
        }
        return;
      }
      case 'skipped':
        // An earlier operation for this entity is unresolved. Stay queued; `nextBatch`
        // already excludes this entity, so it will not be retried until that is sorted.
        return;
      default:
        // `rejected`, and anything a future server adds. Surfaced, never dropped.
        await outbox.markNeedsAttention(
          op.op_id,
          'rejected',
          result.error?.code ?? 'UNKNOWN',
          this.database,
        );
    }
  }

  /**
   * Mark pending finalisations stale once the window has passed.
   *
   * The scheduler deliberately does **not** resend them: a finalisation needs the
   * draft, the money policy and the payment the user entered, which only the billing
   * screen has. The screen retries on reconnect with the same key; the scheduler's job
   * is to stop pretending an hour-old attempt is still in progress.
   */
  private async resolvePendingFinalizations(): Promise<void> {
    const { stale } = await pending.partitionByStaleness(
      pending.DEFAULT_STALE_MINUTES,
      this.database,
    );
    for (const entry of stale) {
      await pending.markStale(entry.draft_id, this.database);
    }
  }

  private async refreshCatalog(): Promise<void> {
    if (!this.isOwner) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    try {
      await catalogCache.refreshFully(this.database);
    } catch {
      // A failed catalog refresh degrades offline search; it never blocks billing, so
      // it is not reported as a sync failure.
    }
  }
}

export const scheduler = new SyncScheduler();

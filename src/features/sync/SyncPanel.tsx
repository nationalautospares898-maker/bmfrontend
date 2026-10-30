/**
 * The Sync panel — where nothing is allowed to disappear quietly.
 *
 * Its whole reason for existing is that a `rejected` or `conflicted` operation must
 * never be silently dropped (§8.1). A background queue that keeps failing with nobody
 * told is how a bill ends up not existing, and the cashier only finds out when the
 * customer comes back.
 *
 * It also shows **unconfirmed sales**, which are the loudest state in the application
 * (§4.9): a finalisation that was sent and whose outcome is unknown. The only
 * affordances offered for one are "check Daily Bills" and, past the stale window,
 * nothing at all — never a bare retry.
 */

import { useEffect, useState } from 'react';

import * as outboxDb from '@/db/outbox';
import * as pendingDb from '@/db/pendingFinalizations';
import type { OutboxOp, PendingFinalization } from '@/db/schema';
import { describeError, type ErrorCode } from '@/api/errors';
import { COMMON, OFFLINE } from '@/lib/strings';
import { Button, Panel, StatusDot, type ConnectionState } from '@/components/primitives';
import { scheduler, type SyncStatus } from './scheduler';

export interface SyncPanelProps {
  online: boolean;
}

export function SyncPanel({ online }: SyncPanelProps) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [attention, setAttention] = useState<OutboxOp[]>([]);
  const [unconfirmed, setUnconfirmed] = useState<PendingFinalization[]>([]);

  useEffect(() => scheduler.subscribe(setStatus), []);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      const [ops, pending] = await Promise.all([
        outboxDb.needingAttention(),
        pendingDb.all(),
      ]);
      if (!cancelled) {
        setAttention(ops);
        setUnconfirmed(pending);
      }
    }
    void load();
    // Re-read whenever the scheduler reports a change rather than polling blind.
    const unsubscribe = scheduler.subscribe(() => void load());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const state: ConnectionState = !online
    ? 'offline'
    : attention.length > 0 || unconfirmed.length > 0
      ? 'attention'
      : status?.running
        ? 'syncing'
        : 'online';

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-[#232852]">Saving and syncing</h1>
        <div className="flex items-center gap-4">
          <StatusDot state={state} />
          <Button
            variant="secondary"
            onClick={() => void scheduler.syncNow()}
            disabled={!online}
          >
            Try now
          </Button>
        </div>
      </header>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 rounded border border-slate-300 p-4 text-sm sm:grid-cols-3">
        <dt className="text-slate-500">Waiting to be saved</dt>
        <dd>{status?.pendingOperations ?? 0}</dd>
        <dt className="text-slate-500">Needing attention</dt>
        <dd>{attention.length}</dd>
        <dt className="text-slate-500">Unconfirmed bills</dt>
        <dd>{unconfirmed.length}</dd>
        <dt className="text-slate-500">Last checked</dt>
        <dd>
          {status?.lastRunAt
            ? new Date(status.lastRunAt).toLocaleTimeString()
            : 'not yet'}
        </dd>
      </dl>

      {/* Unconfirmed sales first: they are the only ones that can have taken a
          customer's money. */}
      {unconfirmed.length > 0 ? (
        <Panel tone="danger" title="These bills are not confirmed">
          <p>{OFFLINE.notConfirmed}</p>
          <ul className="mt-2 list-inside list-disc">
            {unconfirmed.map((entry) => (
              <li key={entry.draft_id}>
                Started {new Date(entry.started_at).toLocaleTimeString()} ·{' '}
                {entry.attempts} attempt{entry.attempts === 1 ? '' : 's'}
                {entry.stale ? ' · stopped retrying, please check Daily Bills' : ''}
                {entry.last_error_code ? ` · ${entry.last_error_code}` : ''}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {attention.length > 0 ? (
        <Panel tone="warning" title="These changes need a decision">
          <ul className="mt-1 flex flex-col gap-3">
            {attention.map((op) => (
              <li
                key={op.op_id}
                className="flex flex-wrap items-baseline justify-between gap-3"
              >
                <span>
                  {op.type.replace('.', ' ')} ·{' '}
                  {op.last_error
                    ? describeError(op.last_error as ErrorCode).message
                    : 'Could not be saved.'}
                </span>
                {/* Dismiss is explicit and per-operation. Nothing clears itself. */}
                <Button variant="quiet" onClick={() => void outboxDb.dismiss(op.op_id)}>
                  {COMMON.close}
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {attention.length === 0 && unconfirmed.length === 0 ? (
        <p className="text-sm text-slate-600">
          {status?.pendingOperations
            ? 'Everything is queued and will be saved automatically.'
            : 'Everything on this computer has been saved to the server.'}
        </p>
      ) : null}

      {status?.lastError ? (
        <p className="text-xs text-slate-500">
          Last problem: {status.lastError}. Retrying automatically.
        </p>
      ) : null}
    </section>
  );
}

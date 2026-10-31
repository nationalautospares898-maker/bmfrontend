/**
 * The Sync panel, rendered.
 *
 * The 30 October 2026 audit measured this file at **0% coverage**, which is the worst
 * place in the application to have none: the panel's entire reason for existing is that
 * a `rejected` or `conflicted` operation must never be dropped silently (§8.1), and an
 * unconfirmed finalisation is the loudest state the application has (§4.9).
 *
 * So the assertions are about what the user is *told*, and about what the panel refuses
 * to offer:
 *
 * - a rejected or conflicted operation is **shown, with its reason in words**, and
 *   clears only when a person dismisses it — nothing clears itself;
 * - an unconfirmed bill is shown **first**, above everything else, because it is the
 *   only state that can already have taken a customer's money;
 * - an unconfirmed bill is **never offered a retry**. Past the stale window the only
 *   advice is to check Daily Bills;
 * - `Try now` is **disabled offline**, so the one control that talks to the server
 *   cannot be pressed when there is nothing to talk to;
 * - the connection state reflects attention before syncing before online, so a problem
 *   is never masked by a spinner;
 * - the panel re-reads whenever the scheduler reports a change, rather than polling;
 * - it unsubscribes on unmount, so a late scheduler tick cannot write into a dead
 *   component;
 * - it passes axe.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OutboxOp, PendingFinalization } from '@/db/schema';
import type { SyncStatus } from './scheduler';
import { SyncPanel } from './SyncPanel';

const needingAttention = vi.fn();
const dismiss = vi.fn();
const pendingAll = vi.fn();
const syncNow = vi.fn();

/** The listeners the component registers, so a test can drive a scheduler tick. */
let listeners: Array<(status: SyncStatus) => void> = [];
/** Unsubscribe calls, so unmount can be asserted rather than assumed. */
let unsubscribes = 0;

vi.mock('@/db/outbox', () => ({
  needingAttention: (...args: unknown[]) => needingAttention(...args) as unknown,
  dismiss: (...args: unknown[]) => dismiss(...args) as unknown,
}));

vi.mock('@/db/pendingFinalizations', () => ({
  all: (...args: unknown[]) => pendingAll(...args) as unknown,
}));

vi.mock('./scheduler', () => ({
  scheduler: {
    subscribe: (listener: (status: SyncStatus) => void) => {
      listeners.push(listener);
      return () => {
        unsubscribes += 1;
      };
    },
    syncNow: (...args: unknown[]) => syncNow(...args) as unknown,
  },
}));

const STATUS: SyncStatus = {
  pendingOperations: 3,
  needingAttention: 0,
  unconfirmedSales: 0,
  lastRunAt: '2026-10-30T10:15:00Z',
  lastError: null,
  running: false,
};

const REJECTED_OP: OutboxOp = {
  op_id: 'op-1',
  client_seq: 7,
  type: 'draft.upsert',
  entity_type: 'draft_bill',
  entity_id: 'draft-1',
  base_version: 2,
  client_created_at: '2026-10-30T10:00:00Z',
  payload: {},
  status: 'rejected',
  attempts: 4,
  last_error: 'PERMISSION_DENIED',
};

const UNCONFIRMED: PendingFinalization = {
  draft_id: 'draft-9',
  idempotency_key: 'key-9',
  started_at: '2026-10-30T11:45:00Z',
  payload_hash: 'hash',
  attempts: 1,
  last_attempt_at: '2026-10-30T11:46:00Z',
  last_error_code: 'TIMEOUT',
  stale: false,
};

/**
 * Push a scheduler status to every subscriber, as the real scheduler does.
 *
 * Wrapped in `act` because the real scheduler notifies from a timer rather than from a
 * React event, so the state updates it causes are outside React's batching. Without it
 * every tick logged an "update was not wrapped in act(...)" warning, and a suite that
 * prints warnings is one where a real warning goes unread.
 */
function tick(status: SyncStatus = STATUS): void {
  act(() => {
    for (const listener of listeners) listener(status);
  });
}

beforeEach(() => {
  listeners = [];
  unsubscribes = 0;
  needingAttention.mockReset();
  dismiss.mockReset();
  pendingAll.mockReset();
  syncNow.mockReset();
  needingAttention.mockResolvedValue([]);
  pendingAll.mockResolvedValue([]);
  dismiss.mockResolvedValue(undefined);
  syncNow.mockResolvedValue(undefined);
});

// --- the quiet case -----------------------------------------------------------

describe('when everything has been saved', () => {
  it('says so plainly', async () => {
    render(<SyncPanel online />);
    expect(
      await screen.findByText(
        'Everything on this computer has been saved to the server.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the connection as connected', async () => {
    render(<SyncPanel online />);
    expect(await screen.findByText('Connected')).toBeInTheDocument();
  });

  it('says queued work will be saved automatically rather than claiming it is done', async () => {
    render(<SyncPanel online />);
    await screen.findByText('Everything on this computer has been saved to the server.');

    tick({ ...STATUS, pendingOperations: 3 });

    expect(
      await screen.findByText('Everything is queued and will be saved automatically.'),
    ).toBeInTheDocument();
  });

  it('reports "not yet" before the first sync run', async () => {
    render(<SyncPanel online />);
    await screen.findByText('Last checked');
    expect(screen.getByText('Last checked').nextElementSibling).toHaveTextContent(
      'not yet',
    );
  });

  it('shows the counts the scheduler reports', async () => {
    render(<SyncPanel online />);
    await screen.findByText('Waiting to be saved');

    tick({ ...STATUS, pendingOperations: 5 });

    await waitFor(() =>
      expect(
        screen.getByText('Waiting to be saved').nextElementSibling,
      ).toHaveTextContent('5'),
    );
  });

  it('defaults the pending count to zero rather than blank', async () => {
    render(<SyncPanel online />);
    await screen.findByText('Waiting to be saved');
    expect(screen.getByText('Waiting to be saved').nextElementSibling).toHaveTextContent(
      '0',
    );
  });
});

// --- offline ------------------------------------------------------------------

describe('when offline', () => {
  it('says it is working offline', async () => {
    render(<SyncPanel online={false} />);
    expect(await screen.findByText('Working offline')).toBeInTheDocument();
  });

  it('disables "Try now", because there is nothing to try against', async () => {
    render(<SyncPanel online={false} />);
    expect(await screen.findByRole('button', { name: 'Try now' })).toBeDisabled();
  });

  it('does not call the scheduler when the disabled control is pressed', async () => {
    const user = userEvent.setup();
    render(<SyncPanel online={false} />);
    const button = await screen.findByRole('button', { name: 'Try now' });

    await user.click(button);

    expect(syncNow).not.toHaveBeenCalled();
  });

  it('still shows offline even when there is work needing attention', async () => {
    // Offline must win: the user cannot act on an attention item without a connection,
    // and telling them the connection is fine would be a lie.
    needingAttention.mockResolvedValue([REJECTED_OP]);
    render(<SyncPanel online={false} />);
    await screen.findByText('These changes need a decision');
    expect(screen.getByText('Working offline')).toBeInTheDocument();
  });
});

// --- operations needing a decision -------------------------------------------

describe('an operation that was rejected or conflicted', () => {
  beforeEach(() => {
    needingAttention.mockResolvedValue([REJECTED_OP]);
  });

  it('is never dropped silently', async () => {
    render(<SyncPanel online />);
    expect(await screen.findByText('These changes need a decision')).toBeInTheDocument();
  });

  it('gives the reason in words rather than an error code', async () => {
    render(<SyncPanel online />);
    await screen.findByText('These changes need a decision');
    expect(screen.getByText(/You do not have permission to do this/)).toBeInTheDocument();
    expect(screen.queryByText(/PERMISSION_DENIED/)).not.toBeInTheDocument();
  });

  it('names the operation readably', async () => {
    render(<SyncPanel online />);
    // `draft.upsert` is shown as `draft upsert`, not as a dotted identifier.
    expect(await screen.findByText(/draft upsert/)).toBeInTheDocument();
  });

  it('falls back to a plain sentence when the server named no error', async () => {
    needingAttention.mockResolvedValue([{ ...REJECTED_OP, last_error: null }]);
    render(<SyncPanel online />);
    expect(await screen.findByText(/Could not be saved\./)).toBeInTheDocument();
  });

  it('raises the connection state to "needs attention"', async () => {
    render(<SyncPanel online />);
    expect(await screen.findByText('Needs attention')).toBeInTheDocument();
  });

  it('counts it in the summary', async () => {
    render(<SyncPanel online />);
    await screen.findByText('Needing attention');
    expect(screen.getByText('Needing attention').nextElementSibling).toHaveTextContent(
      '1',
    );
  });

  it('clears only when a person dismisses it, per operation', async () => {
    const user = userEvent.setup();
    render(<SyncPanel online />);
    await screen.findByText('These changes need a decision');

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(dismiss).toHaveBeenCalledWith('op-1');
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('offers one dismiss per operation and not a clear-all', async () => {
    needingAttention.mockResolvedValue([
      REJECTED_OP,
      { ...REJECTED_OP, op_id: 'op-2', status: 'conflicted' as const },
    ]);
    render(<SyncPanel online />);
    await screen.findByText('These changes need a decision');
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2);
  });

  it('hides the all-clear sentence while an item needs a decision', async () => {
    render(<SyncPanel online />);
    await screen.findByText('These changes need a decision');
    expect(
      screen.queryByText('Everything on this computer has been saved to the server.'),
    ).not.toBeInTheDocument();
  });
});

// --- unconfirmed sales --------------------------------------------------------

describe('an unconfirmed bill', () => {
  beforeEach(() => {
    pendingAll.mockResolvedValue([UNCONFIRMED]);
  });

  it('is announced, and says not to bill it again', async () => {
    render(<SyncPanel online />);
    expect(await screen.findByText('These bills are not confirmed')).toBeInTheDocument();
    expect(screen.getByText(/Do not bill it again/)).toBeInTheDocument();
    expect(screen.getByText(/check Daily Bills first/)).toBeInTheDocument();
  });

  it('is never offered a retry', async () => {
    render(<SyncPanel online />);
    await screen.findByText('These bills are not confirmed');
    // The only button on this panel is the global `Try now`; an unconfirmed bill must
    // not get one of its own, because retrying is how a customer is charged twice.
    const panel = screen.getByText('These bills are not confirmed').closest('section');
    expect(within(panel!).queryByRole('button')).not.toBeInTheDocument();
  });

  it('appears above the operations needing a decision', async () => {
    needingAttention.mockResolvedValue([REJECTED_OP]);
    render(<SyncPanel online />);
    await screen.findByText('These bills are not confirmed');

    const unconfirmed = screen.getByText('These bills are not confirmed');
    const attention = screen.getByText('These changes need a decision');
    // An unconfirmed sale can already have taken money; it comes first.
    expect(
      unconfirmed.compareDocumentPosition(attention) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('counts its attempts, singular and plural', async () => {
    render(<SyncPanel online />);
    expect(await screen.findByText(/1 attempt(?!s)/)).toBeInTheDocument();
  });

  it('pluralises more than one attempt', async () => {
    pendingAll.mockResolvedValue([{ ...UNCONFIRMED, attempts: 3 }]);
    render(<SyncPanel online />);
    expect(await screen.findByText(/3 attempts/)).toBeInTheDocument();
  });

  it('says retrying has stopped once it is stale', async () => {
    pendingAll.mockResolvedValue([{ ...UNCONFIRMED, stale: true }]);
    render(<SyncPanel online />);
    expect(
      await screen.findByText(/stopped retrying, please check Daily Bills/),
    ).toBeInTheDocument();
  });

  it('does not claim retrying has stopped while it has not', async () => {
    render(<SyncPanel online />);
    await screen.findByText('These bills are not confirmed');
    expect(screen.queryByText(/stopped retrying/)).not.toBeInTheDocument();
  });

  it('shows the last error code when there is one', async () => {
    render(<SyncPanel online />);
    expect(await screen.findByText(/TIMEOUT/)).toBeInTheDocument();
  });

  it('omits the error fragment when there is none', async () => {
    pendingAll.mockResolvedValue([{ ...UNCONFIRMED, last_error_code: null }]);
    render(<SyncPanel online />);
    await screen.findByText('These bills are not confirmed');
    expect(screen.queryByText(/TIMEOUT/)).not.toBeInTheDocument();
  });

  it('raises the connection state to "needs attention"', async () => {
    render(<SyncPanel online />);
    expect(await screen.findByText('Needs attention')).toBeInTheDocument();
  });

  it('counts it in the summary', async () => {
    render(<SyncPanel online />);
    await screen.findByText('Unconfirmed bills');
    expect(screen.getByText('Unconfirmed bills').nextElementSibling).toHaveTextContent(
      '1',
    );
  });
});

// --- syncing and errors -------------------------------------------------------

describe('while syncing', () => {
  it('shows the syncing state when a run is in progress and nothing needs attention', async () => {
    render(<SyncPanel online />);
    await screen.findByText('Connected');

    tick({ ...STATUS, running: true });

    expect(await screen.findByText('Saving to the server')).toBeInTheDocument();
  });

  it('does not let a spinner mask an item needing attention', async () => {
    needingAttention.mockResolvedValue([REJECTED_OP]);
    render(<SyncPanel online />);
    await screen.findByText('These changes need a decision');

    tick({ ...STATUS, running: true });

    // Attention outranks syncing.
    await waitFor(() => expect(screen.getByText('Needs attention')).toBeInTheDocument());
    expect(screen.queryByText('Saving to the server')).not.toBeInTheDocument();
  });

  it('reports the last run time once there has been one', async () => {
    render(<SyncPanel online />);
    await screen.findByText('Last checked');

    tick(STATUS);

    await waitFor(() =>
      expect(screen.getByText('Last checked').nextElementSibling).not.toHaveTextContent(
        'not yet',
      ),
    );
  });

  it('reports a last problem and says it keeps trying', async () => {
    render(<SyncPanel online />);
    await screen.findByText('Connected');

    tick({ ...STATUS, lastError: 'connection reset' });

    expect(
      await screen.findByText(
        /Last problem: connection reset\. Retrying automatically\./,
      ),
    ).toBeInTheDocument();
  });

  it('shows no problem line when there is no problem', async () => {
    render(<SyncPanel online />);
    await screen.findByText('Connected');
    tick(STATUS);
    await waitFor(() =>
      expect(screen.queryByText(/Last problem/)).not.toBeInTheDocument(),
    );
  });

  it('asks the scheduler to run when "Try now" is pressed online', async () => {
    const user = userEvent.setup();
    render(<SyncPanel online />);

    await user.click(await screen.findByRole('button', { name: 'Try now' }));

    expect(syncNow).toHaveBeenCalledTimes(1);
  });
});

// --- lifecycle ----------------------------------------------------------------

describe('the panel lifecycle', () => {
  it('re-reads the queues when the scheduler reports a change, instead of polling', async () => {
    render(<SyncPanel online />);
    await waitFor(() => expect(needingAttention).toHaveBeenCalledTimes(1));

    tick(STATUS);

    await waitFor(() => expect(needingAttention).toHaveBeenCalledTimes(2));
    expect(pendingAll).toHaveBeenCalledTimes(2);
  });

  it('reflects a queue that filled up after the first read', async () => {
    needingAttention.mockResolvedValueOnce([]).mockResolvedValue([REJECTED_OP]);
    render(<SyncPanel online />);
    await screen.findByText('Everything on this computer has been saved to the server.');

    tick(STATUS);

    expect(await screen.findByText('These changes need a decision')).toBeInTheDocument();
  });

  it('unsubscribes from the scheduler on unmount', async () => {
    const { unmount } = render(<SyncPanel online />);
    await waitFor(() => expect(needingAttention).toHaveBeenCalled());

    unmount();

    // Both subscriptions — the status one and the reload one — are released.
    expect(unsubscribes).toBe(2);
  });

  it('does not write state from a read that finishes after unmount', async () => {
    let resolve: ((value: unknown) => void) | undefined;
    needingAttention.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args);
    });

    const { unmount } = render(<SyncPanel online />);
    unmount();
    resolve?.([REJECTED_OP]);
    await Promise.resolve();

    expect(errors).toEqual([]);
    spy.mockRestore();
  });
});

// --- accessibility ------------------------------------------------------------

describe('accessibility', () => {
  it('passes axe in the quiet state', async () => {
    const { container } = render(<SyncPanel online />);
    await screen.findByText('Everything on this computer has been saved to the server.');
    const results = await axe.run(container, {
      // Contrast needs real layout; `tests/e2e/accessibility.spec.ts` checks it in a
      // browser, where axe can actually compute it.
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it('passes axe with both alert panels showing', async () => {
    needingAttention.mockResolvedValue([REJECTED_OP]);
    pendingAll.mockResolvedValue([UNCONFIRMED]);
    const { container } = render(<SyncPanel online />);
    await screen.findByText('These bills are not confirmed');
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it('announces the two alert panels to a screen reader', async () => {
    needingAttention.mockResolvedValue([REJECTED_OP]);
    pendingAll.mockResolvedValue([UNCONFIRMED]);
    render(<SyncPanel online />);
    await screen.findByText('These bills are not confirmed');
    // `Panel` is `role="alert"` with `aria-live="assertive"`: the user is about to press
    // a button that will not work, so this must not wait for focus.
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });
});

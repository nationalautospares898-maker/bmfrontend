/**
 * Proactive renewal (`renewal.ts`) — **when** a renewal is attempted.
 *
 * The defects named below are the counter-visible ones behind "the app refreshes and logs
 * me out": every one of them is a moment where the access token died with nothing having
 * renewed it, so the next thing the cashier pressed was the thing that appeared broken.
 * Each test is named for the defect rather than the behaviour, because a renewal that
 * works is invisible and a test called "renews" says nothing about what it is defending.
 *
 * `./client` is mocked here on purpose. What this module owns is the schedule — when to
 * wake, when to skip, when to stop — and it deliberately owns no refresh logic of its
 * own: it calls the shared single-flight path so several tabs waking together produce one
 * rotation (FR-AUTH-002). That path is asserted against the real client, with a stubbed
 * `fetch` and a stubbed `navigator.locks`, in `client.test.ts`. Mocking it also keeps the
 * two suites from fighting over one clock: fake timers here, real ones there.
 *
 * **One behaviour is deliberately not asserted here**: that an attempted renewal actually
 * rotates the token. It does not yet — `refreshSession` short-circuits on a session that
 * has not expired, which is every proactive renewal — and the open defect is recorded at
 * the top of `renewal.ts`, where the next person will be standing. It is left as a report
 * rather than a passing test, because a test written against the present behaviour would
 * cement it and read, for ever after, as the intended design.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { refreshSession } from './client';
import { startSessionRenewal, stopSessionRenewal } from './renewal';
import { clearSession, getSession, setSession, type SessionState } from './session';

// Only `refreshSession` is imported by `renewal.ts`, so only `refreshSession` is faked:
// a factory that invented the rest of the module would hide an import being added.
vi.mock('./client', () => ({
  refreshSession: vi.fn(() => Promise.resolve(null)),
}));

const refreshMock = vi.mocked(refreshSession);

/**
 * The server's access-token lifetime, and the module's own two constants.
 *
 * Restated rather than imported because `renewal.ts` exports neither, and should not: the
 * margin is a decision about when to wake, not a value any caller supplies. The cost is
 * that a change there must be made here too, which is the point — a test that read the
 * constant would keep passing whatever it was changed to, including zero.
 */
const TOKEN_LIFETIME_MS = 900_000;
const RENEW_MARGIN_MS = 120_000;
const MIN_INTERVAL_MS = 30_000;

/** When the renewal timer is due: a margin before the token dies. */
const DUE_AFTER_MS = TOKEN_LIFETIME_MS - RENEW_MARGIN_MS;

function sessionExpiringIn(ms: number): SessionState {
  return {
    accessToken: 'token-1',
    expiresAt: Date.now() + ms,
    userId: 'u1',
    fullName: 'Ravi',
    role: 'cashier',
    permissions: new Set(['billing.sale.finalize']),
    businessId: 'b1',
    activeBranchId: 'br1',
    mustChangePassword: false,
  };
}

beforeEach(() => {
  // Fake timers, because the thing under test is a fifteen-minute schedule and the
  // alternative is a suite nobody runs.
  vi.useFakeTimers();
  clearSession();
  refreshMock.mockReset();
  // Stands in for a successful rotation: the real shared path installs the new session
  // before resolving, and the schedule that follows depends on it having done so.
  refreshMock.mockImplementation(() => {
    const renewed = sessionExpiringIn(TOKEN_LIFETIME_MS);
    setSession(renewed);
    return Promise.resolve(renewed);
  });
  setSession(sessionExpiringIn(TOKEN_LIFETIME_MS));
});

afterEach(() => {
  // Module state outlives a test: `renewal.ts` keeps `running` and its timer at module
  // scope, so a suite that forgot this would leak a timer and a `visibilitychange`
  // listener into the next test and renew on its behalf.
  stopSessionRenewal();
  clearSession();
  vi.useRealTimers();
});

describe('a token that died on the critical path (FR-AUTH-002)', () => {
  it('nothing renewed until a request had already failed, so the cashier waited for a token round trip mid-sale', async () => {
    const expiresAt = getSession()!.expiresAt;
    startSessionRenewal();

    await vi.advanceTimersByTimeAsync(DUE_AFTER_MS - 1_000);
    expect(refreshMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    // Ahead of expiry, which is the entire point: the renewal lands in a quiet moment
    // instead of under the cashier's finger on Print Bill.
    expect(Date.now()).toBeLessThan(expiresAt);
  });

  it('a token already inside its renewal margin scheduled a renewal for right now, in a loop', async () => {
    // A tab that woke with less than the margin left, or a server that shortened the
    // lifetime. `untilExpiry - margin` is negative here, and a delay taken literally
    // would spin: renew, reschedule, renew, each one presenting the same single-use
    // cookie, which is how the client trips reuse detection against itself.
    setSession(sessionExpiringIn(MIN_INTERVAL_MS));
    startSessionRenewal();

    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS - 1_000);
    expect(refreshMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('a laptop woken after lunch waited for the next request to fail before noticing its token was dead', async () => {
    startSessionRenewal();
    // The lid was shut over lunch: timers do not fire while the machine is suspended, so
    // the schedule above never ran and the token is long gone.
    setSession(sessionExpiringIn(-60_000));

    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshMock).toHaveBeenCalledTimes(1);
  });
});

describe('renewals that must not happen', () => {
  it('a timer that fired after another tab had renewed spent the single-use cookie a second time', async () => {
    startSessionRenewal();
    await vi.advanceTimersByTimeAsync(DUE_AFTER_MS - 1_000);

    // The other tab's renewal lands first and installs a token with a full lifetime
    // left. This tab's timer is now due but there is nothing to do, and presenting the
    // cookie again is precisely what reuse detection is watching for.
    setSession(sessionExpiringIn(TOKEN_LIFETIME_MS));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refreshMock).not.toHaveBeenCalled();

    // Skipped, not abandoned: it rearms against the *new* expiry, or a tab that was
    // beaten to one renewal would never renew again and would 401 at the till instead.
    await vi.advanceTimersByTimeAsync(DUE_AFTER_MS);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('a wake with plenty of token left still refreshed, so every tab switch cost a rotation', async () => {
    startSessionRenewal();

    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('a signed-out tab renewed a session it did not have, turning the login screen into a refresh loop', async () => {
    clearSession();
    startSessionRenewal();

    // No timer at all, rather than one that wakes to find nothing: the cookie belongs to
    // a session that has ended, and asking about it is how a logged-out tab talks itself
    // into `REFRESH_TOKEN_REUSED`.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(TOKEN_LIFETIME_MS * 2);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('renewal kept its timer and its wake hook after sign-out and refreshed for nobody', async () => {
    startSessionRenewal();
    expect(vi.getTimerCount()).toBe(1);

    stopSessionRenewal();
    // Disarmed at once, not merely ignored thirteen minutes later when it fires: the
    // `running` flag happens to catch a leaked timer too, and a test that leaned on that
    // would pass while `stopSessionRenewal` quietly stopped clearing anything.
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(TOKEN_LIFETIME_MS * 2);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('every sign-in attached another wake hook that sign-out never detached', () => {
    // A listener leak is invisible for a day and then is not: a counter PC signs in and
    // out all day without reloading, and each orphaned hook renews on its own schedule,
    // which is several tabs' worth of contention for one single-use cookie inside one
    // tab. Reference identity is the part that actually breaks — `removeEventListener`
    // with a fresh closure removes nothing and reports nothing.
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    let attached: unknown[] = [];
    let detached: unknown[] = [];
    try {
      startSessionRenewal();
      stopSessionRenewal();
      // Read inside the `try`, because Vitest 4's `mockRestore` resets the spy as well as
      // restoring it: calls read afterwards are always an empty list, and an assertion on
      // an empty list of hooks looks exactly like a module that never attached one.
      attached = added.mock.calls
        .filter(([type]) => type === 'visibilitychange')
        .map(([, listener]) => listener);
      detached = removed.mock.calls
        .filter(([type]) => type === 'visibilitychange')
        .map(([, listener]) => listener);
    } finally {
      added.mockRestore();
      removed.mockRestore();
    }

    expect(attached).toHaveLength(1);
    expect(detached).toHaveLength(1);
    expect(detached[0]).toBe(attached[0]);
  });
});

describe('starting twice', () => {
  it('React’s development double-mount armed two renewal timers, and two timers race for one single-use cookie', async () => {
    // The same double-invocation that made every `npm run dev` page reload sign the user
    // out through `bootstrap.ts`: `AppShell` starts renewal from an effect, and in
    // development React runs that effect twice.
    //
    // Asserted as the outcome — one armed timer, one rotation — rather than against the
    // `running` guard, because two separate things prevent it: that guard, and
    // `scheduleNext` clearing any previous timer before arming its own. Removing either
    // one alone still leaves the outcome correct, which is why neither is redundant and
    // why this test is written to fail only when the outcome itself is wrong.
    startSessionRenewal();
    expect(vi.getTimerCount()).toBe(1);

    startSessionRenewal();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(DUE_AFTER_MS);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('a restart after sign-out left renewal stopped, so the next shift never renewed at all', async () => {
    startSessionRenewal();
    stopSessionRenewal();

    // Sign-in again: `running` must be back to false, or this start is swallowed by the
    // idempotence guard and the new session is never renewed.
    setSession(sessionExpiringIn(TOKEN_LIFETIME_MS));
    startSessionRenewal();

    await vi.advanceTimersByTimeAsync(DUE_AFTER_MS);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });
});

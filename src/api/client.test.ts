/**
 * The API client's safety rules, exercised against a stubbed `fetch`.
 *
 * These are the rules that stop a duplicate invoice, so each one is asserted rather
 * than reviewed:
 *
 * - `Idempotency-Key` is **stable** across retries; `X-Request-Id` is **fresh** every
 *   attempt. Confusing the two is the single most likely way to bill a customer twice.
 * - A mutating request **without** a key is never retried automatically.
 * - Concurrent 401s share **one** refresh. Twenty parallel refreshes would trip the
 *   server's reuse detection and log the counter out mid-bill.
 * - `DRAFT_ALREADY_FINALIZED` is never retried, at all.
 * - A refresh that failed **in transport** leaves the session alone; one the server
 *   **refused** still ends it. Collapsing the two together is what produced the reported
 *   "the app refreshes and logs me out" (FR-AUTH-002).
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  api,
  configureAuth,
  lastRefreshFailedInTransport,
  refreshSession,
  resetAuthState,
} from './client';
import { ApiError, NetworkError, type ApiErrorBody, type ErrorCode } from './errors';
import {
  clearSession,
  getAccessToken,
  getSession,
  setDeviceId,
  setSession,
  type SessionState,
} from './session';
// Type-only, so the compile-time contract guards at the bottom of this file cost nothing
// at runtime and the tests keep using the same `await import('./endpoints')` as the rest.
import type {
  credit,
  customers,
  imports,
  inventory,
  invoices,
  purchases,
  reports,
} from './endpoints';
import type { operations } from './generated/schema';

const SESSION: SessionState = {
  accessToken: 'token-1',
  expiresAt: Date.now() + 900_000,
  userId: 'u1',
  fullName: 'Ravi',
  role: 'cashier',
  permissions: new Set(['billing.sale.finalize']),
  businessId: 'b1',
  activeBranchId: 'br1',
  mustChangePassword: false,
};

/**
 * The same session, with an access token that has already died.
 *
 * Every test that wants the refresh **implementation** to run installs this one first,
 * because that is the state a `TOKEN_EXPIRED` 401 actually arrives in. `refreshOnce`
 * re-checks the session inside the cross-tab lock and short-circuits when what it finds
 * is still fresh, so a test holding a token fifteen minutes from expiry exercises the
 * re-check and never reaches the refresh at all.
 *
 * The three tests in the next block predate the lock and failed outright when it landed,
 * which was the good outcome — they now name the state they need instead of inheriting
 * whatever `beforeEach` happens to install. The re-check is asserted on its own below.
 */
const EXPIRED_SESSION: SessionState = { ...SESSION, expiresAt: Date.now() - 1_000 };

/** Mirrors the injected signature in `client.ts`, which does not export it. */
type RefreshFn = () => Promise<SessionState | null>;

/** Mirrors `REFRESH_LOCK` in `client.ts`; not exported, so not imported. */
const REFRESH_LOCK = 'bm-auth-refresh';

function errorBody(code: string, retryable = false) {
  return {
    error: { code, message: 'x', details: {}, request_id: 'r1', retryable },
  };
}

/** A refusal the server really answered with, shaped as the refresh call rejects it. */
function serverRefusal(code: ErrorCode, status = 401): ApiError {
  return new ApiError(status, errorBody(code) as ApiErrorBody);
}

/**
 * Drain microtasks until `condition` holds.
 *
 * The refresh path is pure promises — no timers — so there is nothing to advance; what a
 * test waits for is a number of microtask turns that depends on how many `await`s the
 * client happens to contain. Counting them by hand is how a test becomes a puzzle the
 * next person is afraid to edit, and how it silently starts passing for the wrong reason.
 */
async function flushUntil(condition: () => boolean, waitingFor: string): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error(`gave up waiting for ${waitingFor}`);
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// Typed as the real `fetch` rather than a bare `ReturnType<typeof vi.fn>`. Under Vitest 2
// an untyped `vi.fn()` inferred an `any` return, so every implementation below typechecked
// whatever it returned; Vitest 4 infers `void` instead, which correctly flags a
// Promise-returning implementation as `no-misused-promises`. Naming the real signature
// fixes the cause rather than the symptom — and now a mock that returns the wrong shape is
// a type error, which is what this file wanted all along.
let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  resetAuthState();
  clearSession();
  setDeviceId('device-1');
  setSession(SESSION);
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  // Real timers on purpose. The backoff schedule starts at one second with jitter, and
  // the retrying tests below allow for that rather than faking a clock the client's own
  // promise chain would have to be hand-advanced through.
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function headersOf(call: number): Headers {
  return (fetchMock.mock.calls[call]?.[1] as RequestInit).headers as Headers;
}

describe('headers', () => {
  it('sends the bearer token, device and counter ids', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await api.get('/anything');
    const headers = headersOf(0);
    expect(headers.get('Authorization')).toBe('Bearer token-1');
    expect(headers.get('X-Device-Id')).toBe('device-1');
  });

  it('omits the token when the caller asks it to', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await api.post('/auth/login', {}, { skipAuth: true });
    expect(headersOf(0).get('Authorization')).toBeNull();
  });

  it('sends If-Match only when a version was supplied', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await api.put('/drafts/1', {}, { ifMatch: 3 });
    expect(headersOf(0).get('If-Match')).toBe('3');

    await api.put('/drafts/2', {});
    // A draft that has never synced must omit the header entirely — that is how the
    // server distinguishes a create from a blind overwrite.
    expect(headersOf(1).get('If-Match')).toBeNull();
  });
});

describe('the idempotency contract — the asymmetry that matters (§3.2)', () => {
  it('keeps one key across retries but mints a fresh request id each attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, errorBody('SERVICE_UNAVAILABLE', true)))
      .mockResolvedValueOnce(jsonResponse(201, { ok: true }));

    await api.post('/sales:finalize', {}, { idempotencyKey: 'key-1', retry: 'auto' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = headersOf(0);
    const second = headersOf(1);

    // Stable: this is what makes the retry a replay rather than a second sale.
    expect(first.get('Idempotency-Key')).toBe('key-1');
    expect(second.get('Idempotency-Key')).toBe('key-1');

    // Fresh: so each attempt is traceable separately in the server's logs.
    expect(first.get('X-Request-Id')).not.toBe(second.get('X-Request-Id'));
  }, 10_000);

  it('never retries a mutating request that has no key', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(503, errorBody('SERVICE_UNAVAILABLE', true)),
    );

    await expect(api.post('/payments', {}, { retry: 'auto' })).rejects.toBeInstanceOf(
      ApiError,
    );

    // One attempt only. Without a key the client cannot know whether the first
    // attempt committed, so a retry could take the money twice (E-2).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries an idempotent GET on a network failure', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await api.get('/invoices', { retry: 'auto' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('surfaces a network failure as NetworkError when retry is off', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    await expect(api.get('/invoices', { retry: 'never' })).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it('reports a replayed response so the UI can say "already completed"', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { ok: true }, { 'Idempotent-Replay': 'true' }),
    );
    const result = await api.post('/sales:finalize', {}, { idempotencyKey: 'key-1' });
    expect(result.idempotentReplay).toBe(true);
  });
});

describe('never retried, whatever the server says', () => {
  it('does not retry DRAFT_ALREADY_FINALIZED', async () => {
    // Marked retryable by a hypothetical misconfigured server; the client refuses
    // anyway, because a retry affordance on a completed bill is how a customer gets
    // charged twice.
    fetchMock.mockResolvedValue(
      jsonResponse(409, errorBody('DRAFT_ALREADY_FINALIZED', true)),
    );

    await expect(
      api.post('/sales:finalize', {}, { idempotencyKey: 'key-1', retry: 'auto' }),
    ).rejects.toMatchObject({ code: 'DRAFT_ALREADY_FINALIZED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry TOTAL_MISMATCH or PRICE_CHANGED', async () => {
    for (const code of ['TOTAL_MISMATCH', 'PRICE_CHANGED']) {
      fetchMock.mockClear();
      fetchMock.mockResolvedValue(jsonResponse(422, errorBody(code, true)));
      await expect(
        api.post('/sales:finalize', {}, { idempotencyKey: 'key-1', retry: 'auto' }),
      ).rejects.toMatchObject({ code });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('does not retry a 4xx that is simply wrong', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, errorBody('NOT_FOUND')));
    await expect(api.get('/invoices/x', { retry: 'auto' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('refresh is a singleton (§9)', () => {
  it('twenty concurrent 401s cause exactly one refresh', async () => {
    // The token this tab holds is dead, which is the state a `TOKEN_EXPIRED` 401 arrives
    // in. Without it the in-lock re-check returns the still-fresh session and the refresh
    // never runs, so "exactly one" would pass while measuring zero.
    setSession(EXPIRED_SESSION);
    const refresh = vi.fn(() => Promise.resolve({ ...SESSION, accessToken: 'token-2' }));
    configureAuth({ refresh, onSessionLost: vi.fn() });

    let firstRound = true;
    fetchMock.mockImplementation(() => {
      // Every request 401s once, then succeeds — so all twenty hit the refresh path.
      if (firstRound) {
        return Promise.resolve(jsonResponse(401, errorBody('TOKEN_EXPIRED')));
      }
      return Promise.resolve(jsonResponse(200, { ok: true }));
    });

    const inFlight = Array.from({ length: 20 }, () => api.get('/invoices'));
    // Let the 401s land and queue on the shared promise, then let retries succeed.
    await Promise.resolve();
    firstRound = false;
    await Promise.all(inFlight);

    // The whole point: not twenty. Parallel refreshes trip the server's token-reuse
    // detection and log the counter out mid-bill.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('retries the original request once after a successful refresh', async () => {
    setSession(EXPIRED_SESSION);
    configureAuth({
      refresh: () => Promise.resolve({ ...SESSION, accessToken: 'token-2' }),
      onSessionLost: vi.fn(),
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, errorBody('TOKEN_EXPIRED')))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await api.get('/invoices');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The retry carries the new token, not the expired one.
    expect(headersOf(1).get('Authorization')).toBe('Bearer token-2');
  });

  it('gives up and reports a lost session when the refresh fails', async () => {
    setSession(EXPIRED_SESSION);
    const onSessionLost = vi.fn();
    configureAuth({ refresh: () => Promise.resolve(null), onSessionLost });
    fetchMock.mockResolvedValue(jsonResponse(401, errorBody('TOKEN_EXPIRED')));

    await expect(api.get('/invoices')).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect(onSessionLost).toHaveBeenCalled();
    // Not a loop: asking again only delays the login prompt.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops the session immediately on REFRESH_TOKEN_REUSED', async () => {
    const onSessionLost = vi.fn();
    configureAuth({ refresh: () => Promise.resolve(null), onSessionLost });
    fetchMock.mockResolvedValue(jsonResponse(401, errorBody('REFRESH_TOKEN_REUSED')));

    await expect(api.get('/invoices')).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_REUSED',
    });
    expect(onSessionLost).toHaveBeenCalled();
  });
});

describe('“the app refreshes and logs me out” (FR-AUTH-002)', () => {
  /**
   * Each test here is named for the defect, not the feature, because the feature — "the
   * session survives" — is invisible when it works. These are the distinct ways it
   * stopped working at a counter, and all of them were reported as one bug.
   *
   * The refresh cookie is single-use and rotated; presenting a spent one revokes the
   * whole family. Nothing below relaxes that. What is asserted is that the client stops
   * tripping it against itself, and that it still obeys a genuine refusal.
   */
  let onSessionLost: Mock<() => void>;

  beforeEach(() => {
    onSessionLost = vi.fn<() => void>();
  });

  it('two concurrent 401s spent the single-use refresh token twice and revoked the family', async () => {
    setSession(EXPIRED_SESSION);
    const refresh = vi.fn<RefreshFn>(() =>
      Promise.resolve({ ...SESSION, accessToken: 'token-2' }),
    );
    configureAuth({ refresh, onSessionLost });

    let tokenStillDead = true;
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        tokenStillDead
          ? jsonResponse(401, errorBody('TOKEN_EXPIRED'))
          : jsonResponse(200, { ok: true }),
      ),
    );

    // Two is the smallest number that reproduces it, and two is what a counter actually
    // does: the catalogue search and the draft push that fire together after a lull.
    const both = [api.get('/invoices'), api.get('/drafts')];
    await Promise.resolve();
    tokenStillDead = false;
    await Promise.all(both);

    expect(refresh).toHaveBeenCalledTimes(1);
    // Both retries carry the rotated token, so the second request is not a second 401
    // chasing a second refresh.
    expect(headersOf(2).get('Authorization')).toBe('Bearer token-2');
    expect(headersOf(3).get('Authorization')).toBe('Bearer token-2');
    expect(onSessionLost).not.toHaveBeenCalled();
  });

  it('a queued refresh spent the cookie again although another tab had already rotated it', async () => {
    // What a second tab does: it queues holding the token it found stale, and by the time
    // it is let through the winner has installed a different one. Spending the cookie
    // here is precisely what reuse detection is watching for, and it was the whole family
    // that paid for it.
    //
    // The caller passes **the token it found stale**, which is what makes this
    // distinguishable from a proactive renewal. Keying the decision on expiry instead —
    // "is the session still in date?" — got this case right by accident and two others
    // wrong: a renewal runs before expiry by design and so never rotated anything, and a
    // 401 arriving while the clock still thought the token fresh returned the dead token
    // back out of the lock, never prompting a sign-in.
    const refresh = vi.fn<RefreshFn>(() =>
      Promise.resolve({ ...SESSION, accessToken: 'token-never-minted' }),
    );
    configureAuth({ refresh, onSessionLost });
    // The winner's token is what is in memory now.
    setSession({ ...SESSION, accessToken: 'token-2' });

    const state = await refreshSession('token-1');

    expect(refresh).not.toHaveBeenCalled();
    expect(state).toBe(getSession());
    expect(state?.accessToken).toBe('token-2');
    expect(onSessionLost).not.toHaveBeenCalled();
  });

  it('a 401 on a token the clock still thinks is fresh refreshes anyway, rather than stranding the tab', async () => {
    // Clock skew between the counter PC and the server, a signing key rotated, a session
    // revoked server-side: the 401 is real while `expiresAt` is still in the future. The
    // expiry-based re-check returned the dead token straight back out of the lock, the
    // retry failed with it, and `clearSession`/`onSessionLost` were never reached — so
    // every later request failed too and nothing ever asked the cashier to sign in.
    const refresh = vi.fn<RefreshFn>(() =>
      Promise.resolve({ ...SESSION, accessToken: 'token-2' }),
    );
    configureAuth({ refresh, onSessionLost });
    // Comfortably in date, and nonetheless refused by the server.
    setSession({ ...SESSION, accessToken: 'token-1', expiresAt: Date.now() + 600_000 });

    const state = await refreshSession('token-1');

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(state?.accessToken).toBe('token-2');
  });

  /**
   * Two shapes of "not an `ApiError`", because that is how the rule is defined — by what
   * the rejection is *not*, never by a message. `NetworkError` is what the client's own
   * `attemptRequest` raises, and so what the injected refresh really rejects with when
   * the counter's wifi blinks; a raw `TypeError` stands for anything else that throws in
   * the refresh path before a response has been parsed. In neither case did an HTTP
   * response exist, so in neither case was the cookie presented.
   */
  const TRANSPORT_FAILURES: ReadonlyArray<[label: string, failure: Error]> = [
    ['a NetworkError from the client', new NetworkError()],
    ['a TypeError straight out of fetch', new TypeError('Failed to fetch')],
  ];

  it.each(TRANSPORT_FAILURES)(
    'a refresh that failed in transport (%s) cleared the session and signed the cashier out mid-bill',
    async (_label, failure) => {
      setSession(EXPIRED_SESSION);
      const refresh = vi.fn<RefreshFn>(() => Promise.reject(failure));
      configureAuth({ refresh, onSessionLost });
      fetchMock.mockResolvedValue(jsonResponse(401, errorBody('TOKEN_EXPIRED')));

      // The request did fail, so it still rejects — with its own error, for the caller
      // to retry. What must not happen is the session ending over it: no HTTP response
      // existed, so the cookie was never presented and nothing was invalidated.
      await expect(api.get('/invoices')).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });

      expect(lastRefreshFailedInTransport()).toBe(true);
      expect(onSessionLost).not.toHaveBeenCalled();
      expect(getSession()).not.toBeNull();
      // Still there for the next request, or the proactive renewal, to try again with.
      expect(getAccessToken()).toBe('token-1');
    },
  );

  it('a refresh the server refused left the session in place, so nothing ever prompted a sign-in', async () => {
    setSession(EXPIRED_SESSION);
    const refresh = vi.fn<RefreshFn>(() =>
      Promise.reject(serverRefusal('REFRESH_TOKEN_REUSED')),
    );
    configureAuth({ refresh, onSessionLost });
    fetchMock.mockResolvedValue(jsonResponse(401, errorBody('TOKEN_EXPIRED')));

    // The error the caller sees is the request's own, not the refresh's: the sale failed,
    // and that is what the screen has to say.
    await expect(api.get('/invoices')).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });

    // The control still works. A spent, revoked or expired cookie means the session is
    // genuinely over, and prompting is the only honest response — the transport fix above
    // must not have bought itself a way past this.
    expect(lastRefreshFailedInTransport()).toBe(false);
    expect(getSession()).toBeNull();
    expect(onSessionLost).toHaveBeenCalledTimes(1);
  });

  it('a transport verdict outlived its attempt and hid the next real refusal', async () => {
    setSession(EXPIRED_SESSION);
    const refresh = vi
      .fn<RefreshFn>()
      .mockRejectedValueOnce(new NetworkError())
      .mockRejectedValueOnce(serverRefusal('REFRESH_TOKEN_REUSED'));
    configureAuth({ refresh, onSessionLost });
    fetchMock.mockResolvedValue(jsonResponse(401, errorBody('TOKEN_EXPIRED')));

    // The wifi blinked: session kept, nothing prompted.
    await expect(api.get('/invoices')).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect(getSession()).not.toBeNull();

    // Then the cookie really was gone. The flag is per-attempt, so this verdict is this
    // attempt's: a `true` left over from the blink would leave a signed-out cashier
    // staring at failures with no sign-in prompt — the dangerous direction of the two.
    await expect(api.get('/invoices')).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(getSession()).toBeNull();
    expect(onSessionLost).toHaveBeenCalledTimes(1);
  });
});

describe('the cross-tab lock, with navigator.locks stubbed', () => {
  /**
   * jsdom implements no Web Locks, so every test above runs the fallback — the per-tab
   * promise on its own, which is what the client did before this change. The lock is the
   * half that stops a **second tab** spending the cookie, and it cannot be exercised at
   * all without a stub.
   *
   * The stub serialises on purpose. The behaviour under test is what the losing tab does
   * once it is finally granted the lock, and a stub that granted both at once would
   * assert nothing while looking like it did.
   */
  function serialisingLocks(): {
    manager: LockManager;
    requested: () => number;
    granted: () => number;
  } {
    let tail: Promise<unknown> = Promise.resolve();
    let requested = 0;
    let granted = 0;
    const request = (name: string, callback: (lock: unknown) => Promise<unknown>) => {
      requested += 1;
      const run = tail.then(() => {
        granted += 1;
        return callback({ name, mode: 'exclusive' });
      });
      // Settled either way before the queue moves on: a holder that rejects must release
      // the lock, not wedge every later waiter behind its own failure.
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };
    return {
      manager: { request } as unknown as LockManager,
      requested: () => requested,
      granted: () => granted,
    };
  }

  function installLocks(manager: LockManager): void {
    Object.defineProperty(navigator, 'locks', { value: manager, configurable: true });
  }

  afterEach(() => {
    // `vi.unstubAllGlobals` does not know about this one: it is defined on `navigator`
    // rather than replacing it, so that nothing else `navigator` carries is lost.
    Reflect.deleteProperty(navigator, 'locks');
  });

  it('the tab that waited for the lock refreshed anyway, spending a cookie the winner had already rotated', async () => {
    const { manager, requested } = serialisingLocks();
    installLocks(manager);

    setSession(EXPIRED_SESSION);
    const refresh = vi.fn<RefreshFn>(() =>
      Promise.resolve({ ...SESSION, accessToken: 'token-never-minted' }),
    );
    const onSessionLost = vi.fn<() => void>();
    configureAuth({ refresh, onSessionLost });

    // Stand-in for the other tab: hold the lock, and install a fresh session before
    // releasing it. That is exactly the sequence the winner of the race performs.
    let release!: () => void;
    const releasable = new Promise<void>((resolve) => {
      release = resolve;
    });
    const otherTab = navigator.locks.request(REFRESH_LOCK, () => releasable);

    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, errorBody('TOKEN_EXPIRED')))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const inFlight = api.get('/invoices');

    // Queued behind the holder, and no further. If the session were re-checked *before*
    // the lock rather than inside it, `refresh` would already have been called here —
    // against a token the winner was in the middle of replacing.
    await flushUntil(() => requested() === 2, 'this tab to queue for the refresh lock');
    expect(refresh).not.toHaveBeenCalled();

    setSession({ ...SESSION, accessToken: 'token-2' });
    release();
    await otherTab;
    await inFlight;

    expect(refresh).not.toHaveBeenCalled();
    // And it used what the winner left, rather than failing or retrying with the dead one.
    expect(headersOf(1).get('Authorization')).toBe('Bearer token-2');
    expect(onSessionLost).not.toHaveBeenCalled();
  });

  it('a refresh held the lock after finishing, so every later refresh in the browser deadlocked', async () => {
    const { manager, granted } = serialisingLocks();
    installLocks(manager);

    setSession(EXPIRED_SESSION);
    const refresh = vi.fn<RefreshFn>(() =>
      Promise.resolve({ ...SESSION, accessToken: 'token-2' }),
    );
    configureAuth({ refresh, onSessionLost: vi.fn<() => void>() });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, errorBody('TOKEN_EXPIRED')))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await api.get('/invoices');

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(granted()).toBe(1);
    expect(getAccessToken()).toBe('token-2');
    // The lock is a browser-wide resource: one never released would strand this tab and
    // every other one, which at the till looks like the app has frozen. Granting it a
    // second time is the only way to prove it came back.
    //
    // Typed `unknown` because lib.dom declares `request` as returning `Promise<any>` and
    // accepts no type argument; `any` here would quietly disable the assertion below.
    const afterwards: unknown = await navigator.locks.request(REFRESH_LOCK, () =>
      Promise.resolve('released'),
    );
    expect(afterwards).toBe('released');
  });
});

describe('the error envelope', () => {
  it('parses code, request id and retryability', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: 'INSUFFICIENT_STOCK',
          message: 'no',
          details: { shortfalls: [] },
          request_id: 'req-9',
          retryable: false,
        },
      }),
    );
    const error = await api.get('/x').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('INSUFFICIENT_STOCK');
    expect((error as ApiError).requestId).toBe('req-9');
  });

  it('treats a non-envelope error body as an unknown outcome', async () => {
    // A proxy or gateway answered, not the application. The request's fate is
    // genuinely unknown, so inventing a code would be worse than saying so.
    fetchMock.mockResolvedValue(jsonResponse(502, '<html>bad gateway</html>'));
    await expect(api.get('/x', { retry: 'never' })).rejects.toBeInstanceOf(NetworkError);
  });

  it('returns no body for a 204', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 204,
      headers: new Headers(),
      // A partial stub: a 204 has no body, which is the behaviour under test. Cast the
      // same way `jsonResponse` above does — the client reads `ok`, `status`, `headers`
      // and `json`, and a full `Response` would add eleven fields nothing here touches.
      json: () => Promise.reject(new Error('no body')),
    } as unknown as Response);
    const result = await api.delete('/drafts/1');
    expect(result.status).toBe(204);
  });
});

describe('the customer endpoints address the right paths', () => {
  /**
   * These assert the **URL**, which is the one thing a screen test cannot see: the
   * component suites mock `@/api/endpoints` wholesale, so a client method pointing at a
   * path that does not exist looks identical to one that works.
   *
   * It did not work. `customers.search` requested `/customers`, which was not a route
   * at all, so every call 404'd. Its only caller is the duplicate-phone check in the
   * Add-a-customer dialog, which swallows errors by design, so the duplicate warning
   * silently never appeared — and the same customer could be added twice without a
   * word. `FR-CUST-004`'s own test passed throughout, because it mocked the method.
   */
  it('search asks /customers/search, not /customers', async () => {
    const { customers } = await import('./endpoints');
    fetchMock.mockResolvedValue(jsonResponse(200, { items: [] }));

    await customers.search('9306432399');

    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('/customers/search');
    expect(url).toContain('query=9306432399');
  });

  it('list asks /customers, which is the directory', async () => {
    const { customers } = await import('./endpoints');
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        items: [],
        page: { next_cursor: null, has_more: false, limit: 50 },
      }),
    );

    await customers.list({ limit: 50 });

    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toMatch(/\/customers(\?|$)/);
    expect(url).not.toContain('/customers/search');
  });
});

describe('the print payload asks for a reprint in the server’s own terms', () => {
  /**
   * Same class of defect as the customer paths above, and found the same way — by
   * comparing what the client sends against the route's declared parameters rather than
   * by trusting a mock.
   *
   * `printPayload` sent `is_duplicate`, which the route does not declare. FastAPI
   * ignores unknown query parameters, so the server's `copy` stayed `None`, its
   * `is_duplicate` evaluated `False` every time, and every reprint from Daily Bills
   * rendered **without** the `DUPLICATE COPY` watermark — a bill that could be handed
   * over a second time as an original. No request failed, so nothing surfaced it.
   */
  it('a reprint sends copy=reprint', async () => {
    const { invoices } = await import('./endpoints');
    fetchMock.mockResolvedValue(jsonResponse(200, { lines: [] }));

    await invoices.printPayload('inv-1', true);

    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('copy=reprint');
    // The old parameter name must not come back: it is silently ignored, which is why
    // the defect survived.
    expect(url).not.toContain('is_duplicate');
  });

  it('a first print asks for no copy at all', async () => {
    const { invoices } = await import('./endpoints');
    fetchMock.mockResolvedValue(jsonResponse(200, { lines: [] }));

    await invoices.printPayload('inv-1');

    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).not.toContain('copy=');
    // Whether a document is marked is the server's decision from the print log and the
    // `print.mark_reprints_duplicate` setting, never the client's claim (FR-PRINT-004).
    expect(url).toContain('/invoices/inv-1/print-payload');
  });
});

describe('the client cannot send a query parameter the route does not declare', () => {
  /**
   * The third sighting of one defect, so this time it is closed structurally rather than
   * example by example.
   *
   * `customers.search` used a path that did not exist; `invoices.printPayload` sent
   * `is_duplicate` where the route declares `copy`; and `purchases.list` accepted and
   * forwarded a `status` that `GET /purchases` has never declared. FastAPI drops
   * undeclared query parameters in silence, so each one failed by returning cheerfully
   * wrong data: an unfiltered purchase register labelled "draft" would have invited a
   * second confirm of a delivery already received, and confirming is **the only path
   * that receives stock** (FR-PUR-003).
   *
   * The guards below are checked by `tsc`, against `generated/schema.d.ts` — which is
   * produced from the backend's own `openapi.json` by `npm run api:types`. That is the
   * point: the contract is not restated here, so re-adding a parameter the server does
   * not declare is a build failure, and a parameter the server *does* later declare
   * widens the guard automatically without anyone editing this file.
   */

  /** `true` only when every member of `Keys` is a key the route declares. */
  type DeclaredBy<Keys extends PropertyKey, Operation> = [Keys] extends [
    keyof NonNullable<
      (Operation & { parameters: { query?: unknown } })['parameters']['query']
    >,
  ]
    ? true
    : false;

  /** The keys a client method can put into `options.params`, for a method whose first
   * (or `Nth`) argument is passed straight through as the query. */
  type QueryKeysOf<
    Fn extends (...args: never[]) => unknown,
    At extends number = 0,
  > = keyof NonNullable<Parameters<Fn>[At]>;

  it('purchases.list declares no parameter GET /purchases lacks — notably not status', () => {
    // The regression this file exists to prevent. If `status` (or anything else the
    // route does not declare) reappears in the signature, this stops compiling.
    const guard: DeclaredBy<
      QueryKeysOf<typeof purchases.list>,
      operations['list_purchases_api_v1_purchases_get']
    > = true;
    expect(guard).toBe(true);
  });

  it('every pass-through filter object across the client is a subset of its route', () => {
    // One entry per client method that forwards an argument object as the query string
    // verbatim. Methods that map named arguments by hand (`catalog.search`,
    // `drafts.list`, `sync.catalogDelta`) are asserted by URL elsewhere instead.
    const guards: Record<string, true> = {
      'customers.list': true satisfies DeclaredBy<
        QueryKeysOf<typeof customers.list>,
        operations['list_customers_api_v1_customers_get']
      >,
      'invoices.list': true satisfies DeclaredBy<
        QueryKeysOf<typeof invoices.list>,
        operations['list_invoices_api_v1_invoices_get']
      >,
      'credit.payments': true satisfies DeclaredBy<
        QueryKeysOf<typeof credit.payments>,
        operations['list_payments_api_v1_payments_get']
      >,
      'credit.customers': true satisfies DeclaredBy<
        QueryKeysOf<typeof credit.customers>,
        operations['credit_customers_api_v1_credit_customers_get']
      >,
      'inventory.balances': true satisfies DeclaredBy<
        QueryKeysOf<typeof inventory.balances>,
        operations['list_balances_api_v1_inventory_balances_get']
      >,
      'inventory.movements': true satisfies DeclaredBy<
        QueryKeysOf<typeof inventory.movements>,
        operations['list_movements_api_v1_inventory_movements_get']
      >,
      'imports.list': true satisfies DeclaredBy<
        QueryKeysOf<typeof imports.list>,
        operations['list_imports_api_v1_imports_get']
      >,
      // `jobId` is the path segment, so the query object is the second argument.
      'imports.rows': true satisfies DeclaredBy<
        QueryKeysOf<typeof imports.rows, 1>,
        operations['get_import_rows_api_v1_imports__job_id__rows_get']
      >,
      'reports.dailySales': true satisfies DeclaredBy<
        QueryKeysOf<typeof reports.dailySales>,
        operations['daily_sales_api_v1_reports_daily_sales_get']
      >,
      'reports.stockPosition': true satisfies DeclaredBy<
        QueryKeysOf<typeof reports.stockPosition>,
        operations['stock_position_api_v1_reports_stock_position_get']
      >,
      'reports.itemSales': true satisfies DeclaredBy<
        QueryKeysOf<typeof reports.itemSales>,
        operations['item_sales_api_v1_reports_item_sales_get']
      >,
    };
    expect(Object.values(guards).every(Boolean)).toBe(true);
  });

  it('a purchase register filtered by supplier sends supplier_id and limit only', async () => {
    const { purchases: live } = await import('./endpoints');
    fetchMock.mockResolvedValue(jsonResponse(200, { items: [] }));

    await live.list({ supplier_id: 'sup-1', limit: 50 });

    const url = new URL(fetchMock.mock.calls[0]?.[0] as string, 'http://localhost');
    expect([...url.searchParams.keys()].sort()).toEqual(['limit', 'supplier_id']);
    // The dropped parameter must not come back by any route: it was ignored in silence,
    // which is exactly why it survived unnoticed as a loaded gun behind a status filter
    // the screen was already half built for.
    expect(url.searchParams.has('status')).toBe(false);
  });
});

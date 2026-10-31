/**
 * The one HTTP client. Every request in the application goes through here, and a
 * structural test asserts `fetch(` appears nowhere else in `src/`.
 *
 * It exists to make four things impossible to get wrong per call site:
 *
 * 1. **The idempotency contract.** `Idempotency-Key` is stable across retries of one
 *    user intent; `X-Request-Id` is fresh on every attempt. Confusing the two is the
 *    single most likely way to create a duplicate invoice, so the client takes the key
 *    from the caller and mints the request id itself — the caller cannot accidentally
 *    reuse a request id or accidentally change a key.
 * 2. **One refresh at a time.** Twenty concurrent 401s await one shared promise.
 *    Twenty parallel refreshes would trip the server's token-reuse detection and log
 *    the counter out mid-bill.
 * 3. **Retry only where it is safe.** A keyless mutating request is never retried
 *    automatically (§7). `DRAFT_ALREADY_FINALIZED` and friends are never retried at
 *    all, because a retry affordance on an already-completed bill is how a customer
 *    gets charged twice.
 * 4. **One error shape.** Every failure arrives as `ApiError` with a registry `code`,
 *    or `NetworkError` when the outcome is unknown. Nothing branches on a message.
 */

import { ApiError, NetworkError, mayAutoRetry, type ApiErrorBody } from './errors';
import {
  clearSession,
  getAccessToken,
  getCounter,
  getDeviceId,
  getSession,
  setSession,
  type SessionState,
} from './session';
import { uuidv7 } from '@/lib/ids';

/** Only `VITE_`-prefixed public configuration exists; never a secret (NFR-FE-SEC-001). */
const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');

/**
 * Timeouts, from §7.
 *
 * `finalize` is 30 s and not less **on purpose**: a slow commit is still a commit, and
 * aborting at 10 s does not cancel the sale — it just manufactures the lost-response
 * case the client then has to reason about.
 */
export const TIMEOUTS = {
  read: 10_000,
  finalize: 30_000,
  upload: 60_000,
} as const;

export type TimeoutClass = keyof typeof TIMEOUTS;

/** Backoff schedule from §7, in milliseconds. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 60_000, 300_000] as const;

export interface RequestOptions {
  /**
   * Required by the caller for financial POSTs. Must be **stable across retries of one
   * intent** and minted fresh only when the user changes the bill (§5).
   */
  idempotencyKey?: string | undefined;
  /** Draft `version` for optimistic concurrency. Omitted when creating. */
  ifMatch?: number | undefined;
  signal?: AbortSignal | undefined;
  /** `'auto'` is honoured only alongside an idempotency key, or for a `GET`. */
  retry?: 'auto' | 'never' | undefined;
  timeout?: TimeoutClass | undefined;
  /** Query parameters; `undefined` and `null` values are dropped. */
  params?: Record<string, string | number | boolean | null | undefined> | undefined;
  /** Suppresses the refresh-and-retry dance. Used by the auth endpoints themselves. */
  skipAuth?: boolean | undefined;
}

export interface ApiResponse<T> {
  readonly data: T;
  /** `true` when the server replayed a stored response for this idempotency key. */
  readonly idempotentReplay: boolean;
  readonly status: number;
}

// --- the shared refresh promise ----------------------------------------------

type RefreshFn = () => Promise<SessionState | null>;

let refreshImplementation: RefreshFn | null = null;
let inFlightRefresh: Promise<SessionState | null> | null = null;
let onSessionLost: (() => void) | null = null;

/**
 * Wire in the refresh call.
 *
 * Injected rather than imported so `client.ts` does not depend on `endpoints/auth.ts`,
 * which depends on `client.ts`. The cycle is avoidable and the indirection is also what
 * lets a test drive the refresh path without a server.
 */
export function configureAuth(options: {
  refresh: RefreshFn;
  onSessionLost: () => void;
}): void {
  refreshImplementation = options.refresh;
  onSessionLost = options.onSessionLost;
}

/** The cross-tab lock name. Why there is a lock at all is on `refreshOnce` below. */
const REFRESH_LOCK = 'bm-auth-refresh';

/**
 * Whether the last refresh failed because the network did, rather than because the
 * server said no.
 *
 * Both outcomes reach the caller as `null` — `refreshOnce` resolves to a session or to
 * nothing — so its `.catch` below is the last place the rejection can still be examined.
 * The reason is recorded here as it happens, and read back by `send` the moment it has
 * awaited the refresh.
 *
 * The injected `refreshImplementation` **rejects**: `bootstrap.ts` deliberately no longer
 * swallows the error, because swallowing it there was the defect. A dropped packet and a
 * revoked cookie both arrived as a bare `null`, the 401 handler could only assume the
 * worst, and a two-second blink of the counter's wifi signed a cashier out mid-bill.
 *
 * A transport failure is any rejection that is not an `ApiError`: `fetch` rejecting means
 * no HTTP response existed, so the single-use cookie was never presented and nothing was
 * invalidated (FR-AUTH-002). An `ApiError` means the server answered and refused, and the
 * session really is over — that half is not relaxed anywhere.
 *
 * Reset when an attempt starts, so the verdict always belongs to the attempt just
 * awaited. A stale `true` outliving its attempt would suppress the sign-in prompt that a
 * real refusal has to produce, which is the more dangerous direction of the two.
 */
let refreshFailedInTransport = false;

export function lastRefreshFailedInTransport(): boolean {
  return refreshFailedInTransport;
}

/**
 * Refresh the access token — once per tab, and once per browser.
 *
 * Two layers of mutual exclusion, because the refresh token is **single-use and
 * rotated**, and presenting a spent one revokes the whole family (FR-AUTH-002). That
 * control is correct and is not relaxed here; what is fixed is the client's habit of
 * tripping it against itself.
 *
 * 1. **Per tab:** every concurrent 401 awaits the same promise, cleared in a `finally`
 *    so a later 401 can start a fresh attempt but never a parallel one.
 * 2. **Across tabs:** a Web Lock, because the cookie is shared by every tab on the
 *    origin and the per-tab promise knows nothing about the others. Two tabs idling
 *    past the 15-minute access-token expiry both woke up, both sent the same cookie,
 *    one rotated and the other was judged a thief — so the shop was signed out of both
 *    for doing nothing but leaving a second tab open.
 *
 *    Inside the lock the session is re-checked: the tab that waited usually finds the
 *    winner has already installed a fresh token, and returns it without spending the
 *    cookie a second time. That re-check is the part that actually prevents the reuse;
 *    the lock only makes it reliable.
 *
 * `navigator.locks` is used rather than `localStorage` because a structural test bans
 * both storage APIs from `src/` (NFR-FE-SEC-002), and `scheduler.ts` already establishes
 * Web Locks as this application's cross-tab primitive. Browsers without them fall back
 * to the per-tab guard, which is what the code did before.
 */
async function refreshOnce(staleToken: string | null): Promise<SessionState | null> {
  if (!refreshImplementation) return null;
  if (!inFlightRefresh) {
    refreshFailedInTransport = false;
    inFlightRefresh = withRefreshLock(async () => {
      // Another tab may have refreshed while this one queued for the lock. The test is
      // **token identity**, not the clock: has the session in memory changed since the
      // caller decided it needed refreshing?
      //
      // It was `!isSessionExpired()` — "is the session still in date?" — and that is the
      // wrong question in both directions:
      //
      //   * A proactive renewal runs *before* expiry by design, so the answer was always
      //     "yes, in date", and the renewal returned without rotating anything. The
      //     feature was inert: the token was still being replaced reactively, after it
      //     had already died.
      //   * Worse, a 401 arriving while the clock still thought the token was fresh —
      //     skew between the counter PC and the server, a signing key rotated, a session
      //     revoked server-side — also answered "in date". So the dead token came back
      //     out of the lock, the retry failed with it, and `clearSession()` and
      //     `onSessionLost` were never reached. Every later request repeated it and
      //     **nothing ever prompted a sign-in**: a tab stuck failing silently, which is
      //     the more dangerous of the two directions this guard can err in.
      //
      // Comparing tokens answers the question actually being asked. A different token
      // means somebody else rotated and this caller should take theirs rather than spend
      // the single-use cookie again (FR-AUTH-002). The same token means the caller's
      // complaint still stands, whatever the clock says, and the rotation must proceed.
      const current = getSession();
      if (current && current.accessToken !== staleToken) return current;
      return refreshImplementation ? await refreshImplementation() : null;
    })
      .then((state) => {
        if (state) setSession(state);
        return state;
      })
      .catch((caught: unknown) => {
        // An `ApiError` means the server answered and refused. Anything else means no
        // response existed, so the refresh cookie was never spent and the session is
        // still recoverable — see `lastRefreshFailedInTransport`.
        refreshFailedInTransport = !(caught instanceof ApiError);
        return null;
      })
      .finally(() => {
        inFlightRefresh = null;
      });
  }
  return inFlightRefresh;
}

async function withRefreshLock<T>(work: () => Promise<T>): Promise<T> {
  const locks = navigator.locks;
  if (!locks) return work();
  return locks.request(REFRESH_LOCK, work) as Promise<T>;
}

/**
 * Renew the session through the shared, cross-tab-coordinated path.
 *
 * Exported so startup and the proactive renewal use the same single-flight attempt as a
 * 401 does. Calling `auth.refresh()` directly bypasses both guards and races the other
 * callers for a single-use cookie, which revokes the family.
 */
export async function refreshSession(
  staleToken: string | null = getAccessToken(),
): Promise<SessionState | null> {
  return refreshOnce(staleToken);
}

/** Exposed for tests: forget any in-flight refresh. */
export function resetAuthState(): void {
  inFlightRefresh = null;
  refreshFailedInTransport = false;
}

// --- request plumbing ---------------------------------------------------------

function buildUrl(path: string, params?: RequestOptions['params']): string {
  const url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  if (!params) return url;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${url}?${query}` : url;
}

function buildHeaders(
  options: RequestOptions,
  hasBody: boolean,
  isFormData: boolean,
): Headers {
  const headers = new Headers();

  if (hasBody && !isFormData) headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json');

  // A **fresh** id per attempt, so a retry is traceable separately from the attempt it
  // replaces. This is the deliberate asymmetry with `Idempotency-Key` (§3.2).
  headers.set('X-Request-Id', uuidv7());

  if (!options.skipAuth) {
    const token = getAccessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  const device = getDeviceId();
  if (device) headers.set('X-Device-Id', device);

  const counter = getCounter();
  if (counter) headers.set('X-Counter-Id', counter.id);

  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
  if (options.ifMatch !== undefined) headers.set('If-Match', String(options.ifMatch));

  return headers;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;
  return typeof (error as { code?: unknown }).code === 'string';
}

async function parseError(response: Response): Promise<ApiError | NetworkError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A non-JSON error body means something between the client and the app answered —
    // a proxy, a gateway. The outcome of the request is genuinely unknown, so it is a
    // NetworkError rather than an invented code.
    return new NetworkError();
  }
  if (!isErrorBody(body)) return new NetworkError();
  return new ApiError(response.status, body);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Jittered backoff, so reconnecting counters do not all retry on the same tick. */
function backoffFor(attempt: number): number {
  // Clamped, so an attempt number past the end of the schedule reuses the last step
  // rather than reading undefined.
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 300_000;
  return base * (0.75 + Math.random() * 0.5);
}

/**
 * Whether another attempt is permitted.
 *
 * The method rule is the important one: a mutating request **without** an idempotency
 * key is never retried, because the client cannot know whether the first attempt
 * committed (§7, E-2).
 */
function retryAllowed(
  method: string,
  options: RequestOptions,
  error: unknown,
  attempt: number,
): boolean {
  if (options.retry === 'never') return false;
  if (attempt >= BACKOFF_MS.length) return false;
  if (!mayAutoRetry(error)) return false;

  const mutating = method !== 'GET' && method !== 'HEAD';
  if (mutating && !options.idempotencyKey) return false;
  return true;
}

async function attemptRequest(
  method: string,
  path: string,
  body: unknown,
  options: RequestOptions,
): Promise<Response> {
  const isFormData = body instanceof FormData;
  const hasBody = body !== undefined && body !== null;
  const timeoutMs = TIMEOUTS[options.timeout ?? 'read'];

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

  // The caller's signal and the timeout both need to abort this attempt.
  const abortFromCaller = () => timeoutController.abort();
  options.signal?.addEventListener('abort', abortFromCaller);

  try {
    return await fetch(buildUrl(path, options.params), {
      method,
      headers: buildHeaders(options, hasBody, isFormData),
      body: hasBody ? (isFormData ? body : JSON.stringify(body)) : null,
      // The refresh cookie rides along; it is `HttpOnly` and never read here.
      credentials: 'include',
      signal: timeoutController.signal,
    });
  } catch {
    // Network failure, abort or timeout: the request may or may not have been applied.
    throw new NetworkError();
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

async function send<T>(
  method: string,
  path: string,
  body: unknown,
  options: RequestOptions,
): Promise<ApiResponse<T>> {
  let refreshed = false;

  for (let attempt = 0; ; attempt += 1) {
    // The token this attempt is about to send, read before the request rather than
    // after the 401. By then another tab may have rotated, and the refresh needs to
    // compare against what *this* request found stale — see `refreshOnce`.
    const tokenSent = getAccessToken();
    let response: Response;
    try {
      response = await attemptRequest(method, path, body, options);
    } catch (error) {
      if (retryAllowed(method, options, error, attempt)) {
        await sleep(backoffFor(attempt));
        continue;
      }
      throw error;
    }

    if (response.ok) {
      const idempotentReplay = response.headers.get('Idempotent-Replay') === 'true';
      if (response.status === 204) {
        return { data: undefined as T, idempotentReplay, status: response.status };
      }
      return {
        data: (await response.json()) as T,
        idempotentReplay,
        status: response.status,
      };
    }

    const error = await parseError(response);

    // A 401 gets exactly one transparent refresh-and-retry. Not a loop: if the retry
    // also 401s, the session is genuinely over and asking again only delays the prompt.
    if (
      response.status === 401 &&
      !refreshed &&
      !options.skipAuth &&
      error instanceof ApiError &&
      error.code === 'TOKEN_EXPIRED'
    ) {
      refreshed = true;
      // The token this attempt actually sent. Captured before awaiting, so that if
      // another tab rotates meanwhile the comparison inside the lock is against what
      // *this* request found stale rather than whatever is current by then.
      const state = await refreshOnce(tokenSent);
      if (state) continue;
      // The refresh did not produce a session. **Why** decides what happens next, and
      // the two reasons are not alike:
      //
      //   * The server refused — a spent, revoked or expired cookie. The session really
      //     is over, and prompting is the only honest response.
      //   * The request never reached the server — a dropped connection, a keep-alive
      //     the server had already closed, a counter PC whose wifi blinked. Nothing has
      //     been invalidated and the cookie is still good.
      //
      // These were treated identically, so a two-second network blip at the wrong
      // moment signed a cashier out mid-bill. Now a transport failure leaves the
      // session alone and surfaces as the request error it is: the next request, or the
      // proactive renewal, tries again and succeeds.
      if (lastRefreshFailedInTransport()) throw error;
      clearSession();
      onSessionLost?.();
      throw error;
    }

    if (error instanceof ApiError && error.code === 'REFRESH_TOKEN_REUSED') {
      // Drafts are kept; only the in-memory session is dropped (§4).
      clearSession();
      onSessionLost?.();
      throw error;
    }

    if (retryAllowed(method, options, error, attempt)) {
      // The server tells us how long to wait when it knows; otherwise use the schedule.
      const retryAfter = response.headers.get('Retry-After');
      const serverDelay = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : NaN;
      const detailDelay =
        error instanceof ApiError && typeof error.details.retry_after_ms === 'number'
          ? error.details.retry_after_ms
          : NaN;
      const delay = Number.isFinite(detailDelay)
        ? detailDelay
        : Number.isFinite(serverDelay)
          ? serverDelay
          : backoffFor(attempt);
      await sleep(delay);
      continue;
    }

    throw error;
  }
}

export const api = {
  get<T>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    return send<T>('GET', path, undefined, options);
  },
  post<T>(
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    return send<T>('POST', path, body, options);
  },
  put<T>(
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    return send<T>('PUT', path, body, options);
  },
  patch<T>(
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    return send<T>('PATCH', path, body, options);
  },
  delete<T>(path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    return send<T>('DELETE', path, undefined, options);
  },
};

/** Unwrap to the body when the caller does not need the replay flag or status. */
export async function data<T>(promise: Promise<ApiResponse<T>>): Promise<T> {
  return (await promise).data;
}

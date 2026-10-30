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

/**
 * Refresh the access token, sharing one in-flight attempt.
 *
 * Every concurrent 401 awaits the same promise. The promise is cleared in a `finally`
 * so a later 401 can start a fresh attempt, but never a parallel one.
 */
async function refreshOnce(): Promise<SessionState | null> {
  if (!refreshImplementation) return null;
  if (!inFlightRefresh) {
    inFlightRefresh = refreshImplementation()
      .then((state) => {
        if (state) setSession(state);
        return state;
      })
      .catch(() => null)
      .finally(() => {
        inFlightRefresh = null;
      });
  }
  return inFlightRefresh;
}

/** Exposed for tests: forget any in-flight refresh. */
export function resetAuthState(): void {
  inFlightRefresh = null;
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
      const state = await refreshOnce();
      if (state) continue;
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

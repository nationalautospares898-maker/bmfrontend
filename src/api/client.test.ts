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
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { api, configureAuth, resetAuthState } from './client';
import { ApiError, NetworkError } from './errors';
import { clearSession, setDeviceId, setSession, type SessionState } from './session';

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

function errorBody(code: string, retryable = false) {
  return {
    error: { code, message: 'x', details: {}, request_id: 'r1', retryable },
  };
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

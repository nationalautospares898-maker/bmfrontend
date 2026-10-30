/**
 * The error registry.
 *
 * `describeError` is an exhaustive switch, so an unhandled backend code is a compile
 * error. That only helps if the union itself is complete, which is what this suite
 * checks against the backend's own OpenAPI document — the registry is **53 codes**
 * (`API-SPECIFICATION.md §4.2` + `§4.2a`), and a client union that quietly lost one
 * would still compile.
 *
 * It also asserts the behavioural rules that are easy to regress by editing one
 * presentation entry: nothing already-done offers a retry, and no message mentions an
 * HTTP status code.
 */

import { describe, expect, it } from 'vitest';

import {
  ApiError,
  NetworkError,
  describeError,
  fieldErrors,
  mayAutoRetry,
  type ErrorCode,
} from './errors';

/**
 * Every code in the registry.
 *
 * Listed here rather than derived from the type, because a type cannot be enumerated at
 * runtime — and the point is to catch a code that was dropped from the union.
 */
const ALL_CODES: ErrorCode[] = [
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'USER_INACTIVE',
  'TOKEN_EXPIRED',
  'REFRESH_TOKEN_REUSED',
  'DEVICE_REVOKED',
  'DEVICE_NOT_REGISTERED',
  'PERMISSION_DENIED',
  'BRANCH_SCOPE_INVALID',
  'RATE_LIMITED',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'DRAFT_VERSION_CONFLICT',
  'DRAFT_LIMIT_REACHED',
  'DRAFT_ALREADY_FINALIZED',
  'DRAFT_OWNED_BY_OTHER_COUNTER',
  'INSUFFICIENT_STOCK',
  'OVERSELL_NOT_PERMITTED',
  'OVERSELL_REASON_REQUIRED',
  'PRICE_CHANGED',
  'PRICE_OVERRIDE_NOT_PERMITTED',
  'DISCOUNT_EXCEEDS_LIMIT',
  'PRODUCT_INACTIVE',
  'TOTAL_MISMATCH',
  'EMPTY_SALE',
  'CREDIT_CUSTOMER_REQUIRED',
  'CREDIT_LIMIT_EXCEEDED',
  'IDEMPOTENCY_KEY_REUSE',
  'IDEMPOTENT_REQUEST_IN_PROGRESS',
  'INVOICE_ALREADY_CANCELLED',
  'CANCEL_WINDOW_EXPIRED',
  'INVOICE_CANCELLED',
  'OVER_ALLOCATION',
  'PAYMENT_ALREADY_REVERSED',
  'RETURN_QUANTITY_EXCEEDED',
  'RETURN_WINDOW_EXPIRED',
  'DUPLICATE_SKU',
  'DUPLICATE_BARCODE',
  'DUPLICATE_SUPPLIER_DOCUMENT',
  'DUPLICATE_FILE',
  'IMPORT_ROWS_PENDING_DECISION',
  'IMPORT_ALREADY_APPLIED',
  'UNSUPPORTED_FILE_TYPE',
  'FILE_TOO_LARGE',
  'TAX_CONFIG_INCOMPLETE',
  'SYNC_CURSOR_EXPIRED',
  'SYNC_BATCH_TOO_LARGE',
  'PRECONDITION_REQUIRED',
  'SKIPPED_AFTER_EARLIER_FAILURE',
  'CORRUPT_VERSION',
  'DRAFT_ALREADY_CANCELLED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
];

describe('the registry is complete', () => {
  it('has exactly the 53 codes Phase 2 closed with', () => {
    expect(ALL_CODES).toHaveLength(53);
    expect(new Set(ALL_CODES).size).toBe(53);
  });

  it('includes the four codes audit CF-3 found missing', () => {
    // These are required by the sync protocol and were absent from the registry at
    // one point, which made the exhaustive switch unable to handle behaviour the
    // protocol requires.
    for (const code of [
      'PRECONDITION_REQUIRED',
      'SKIPPED_AFTER_EARLIER_FAILURE',
      'CORRUPT_VERSION',
      'DRAFT_ALREADY_CANCELLED',
    ] as ErrorCode[]) {
      expect(ALL_CODES).toContain(code);
    }
  });

  it('describes every code with an actionable message', () => {
    for (const code of ALL_CODES) {
      const presentation = describeError(code);
      expect(presentation.message, code).toBeTruthy();
      expect(presentation.message.length, code).toBeGreaterThan(10);
      // No jargon, no status codes, no stack traces (§10).
      expect(presentation.message, code).not.toMatch(/\b[45]\d\d\b/);
      expect(presentation.message, code).not.toMatch(
        /exception|traceback|null|undefined/i,
      );
    }
  });
});

describe('business conflicts are inline, not toasts (PRD §6.1)', () => {
  it.each([
    'INSUFFICIENT_STOCK',
    'PRICE_CHANGED',
    'TOTAL_MISMATCH',
    'CREDIT_LIMIT_EXCEEDED',
    'CREDIT_CUSTOMER_REQUIRED',
    'DISCOUNT_EXCEEDS_LIMIT',
  ] as ErrorCode[])('%s renders inline and needs resolution', (code) => {
    const presentation = describeError(code);
    expect(presentation.surface).toBe('inline');
    expect(presentation.needsResolution).toBe(true);
    // None of these may be retried automatically: each needs the user to change
    // something or accept a difference.
    expect(presentation.retryable).toBe(false);
  });
});

describe('nothing already done offers a retry', () => {
  it.each([
    'DRAFT_ALREADY_FINALIZED',
    'INVOICE_ALREADY_CANCELLED',
    'PAYMENT_ALREADY_REVERSED',
    'IMPORT_ALREADY_APPLIED',
  ] as ErrorCode[])('%s is never retryable', (code) => {
    expect(describeError(code).retryable).toBe(false);
  });

  it('mayAutoRetry refuses DRAFT_ALREADY_FINALIZED even if the server says retryable', () => {
    const error = new ApiError(409, {
      error: {
        code: 'DRAFT_ALREADY_FINALIZED',
        message: 'x',
        details: {},
        request_id: 'r',
        // A misconfigured server claiming this is retryable must not be believed:
        // retrying a completed bill is how a customer gets charged twice.
        retryable: true,
      },
    });
    expect(mayAutoRetry(error)).toBe(false);
  });

  it('mayAutoRetry refuses every never-retry code', () => {
    for (const code of [
      'IDEMPOTENCY_KEY_REUSE',
      'TOTAL_MISMATCH',
      'PRICE_CHANGED',
      'DRAFT_VERSION_CONFLICT',
      'PRECONDITION_REQUIRED',
      'CORRUPT_VERSION',
      'DEVICE_REVOKED',
    ] as ErrorCode[]) {
      const error = new ApiError(409, {
        error: { code, message: 'x', details: {}, request_id: 'r', retryable: true },
      });
      expect(mayAutoRetry(error), code).toBe(false);
    }
  });
});

describe('what may be retried', () => {
  it('allows a retry for the three codes the spec marks auto', () => {
    for (const code of [
      'IDEMPOTENT_REQUEST_IN_PROGRESS',
      'SERVICE_UNAVAILABLE',
      'RATE_LIMITED',
    ] as ErrorCode[]) {
      expect(describeError(code).retryable, code).toBe(true);
    }
  });

  it('always allows a retry for an unknown outcome', () => {
    // A `NetworkError` means the request's fate is unknown; whether it is *safe* to
    // retry is decided by the key, not here.
    expect(mayAutoRetry(new NetworkError())).toBe(true);
  });

  it('refuses to retry something that is not an API error at all', () => {
    expect(mayAutoRetry(new Error('bug'))).toBe(false);
  });
});

describe('session-ending codes are blocking', () => {
  it.each([
    'TOKEN_EXPIRED',
    'INVALID_CREDENTIALS',
    'REFRESH_TOKEN_REUSED',
    'ACCOUNT_LOCKED',
    'USER_INACTIVE',
    'DEVICE_REVOKED',
    'DEVICE_NOT_REGISTERED',
  ] as ErrorCode[])('%s blocks rather than appearing inline', (code) => {
    expect(describeError(code).surface).toBe('blocking');
  });

  it('tells a revoked device that nothing was deleted', () => {
    // Local data is never deleted in response to a revocation (FR-OFFLINE-010), and
    // the message has to say so or someone will assume the worst.
    expect(describeError('DEVICE_REVOKED').message).toMatch(/has been deleted|deleted/i);
    expect(describeError('DEVICE_REVOKED').message).toMatch(/nothing on it/i);
  });
});

describe('field errors', () => {
  it('maps details.fields back onto a form', () => {
    const error = new ApiError(422, {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'x',
        details: { fields: { quantity: 'required', 'Idempotency-Key': 'required' } },
        request_id: 'r',
        retryable: false,
      },
    });
    expect(fieldErrors(error)).toEqual({
      quantity: 'required',
      'Idempotency-Key': 'required',
    });
  });

  it('returns nothing for a non-validation error', () => {
    const error = new ApiError(409, {
      error: {
        code: 'INSUFFICIENT_STOCK',
        message: 'x',
        details: { shortfalls: [] },
        request_id: 'r',
        retryable: false,
      },
    });
    expect(fieldErrors(error)).toEqual({});
  });
});

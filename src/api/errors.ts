/**
 * The error contract, and the exhaustive handling the backend's registry requires.
 *
 * `ErrorCode` mirrors `../bmbackend/docs/API-SPECIFICATION.md §4.2` — **53 codes**. Two
 * of them (`CORRUPT_VERSION`, `SKIPPED_AFTER_EARLIER_FAILURE`) arrive as per-operation
 * outcomes inside a `200` sync batch rather than HTTP errors, and are branched on
 * identically (§4.2a).
 *
 * `describeError` is an **exhaustive** switch. Adding a backend code without handling it
 * here is a compile error, which is intentional (ADR-029): an unhandled code at the
 * counter means a cashier sees nothing useful while a customer waits.
 *
 * Clients branch on `code`, never on `message` (§4).
 */

import { ERRORS, OFFLINE } from '@/lib/strings';

export type ErrorCode =
  // authentication and identity
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'USER_INACTIVE'
  | 'TOKEN_EXPIRED'
  | 'REFRESH_TOKEN_REUSED'
  | 'DEVICE_REVOKED'
  | 'DEVICE_NOT_REGISTERED'
  | 'PERMISSION_DENIED'
  | 'BRANCH_SCOPE_INVALID'
  | 'RATE_LIMITED'
  // generic
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  // drafts
  | 'DRAFT_VERSION_CONFLICT'
  | 'DRAFT_LIMIT_REACHED'
  | 'DRAFT_ALREADY_FINALIZED'
  | 'DRAFT_OWNED_BY_OTHER_COUNTER'
  // stock and pricing
  | 'INSUFFICIENT_STOCK'
  | 'OVERSELL_NOT_PERMITTED'
  | 'OVERSELL_REASON_REQUIRED'
  | 'PRICE_CHANGED'
  | 'PRICE_OVERRIDE_NOT_PERMITTED'
  | 'DISCOUNT_EXCEEDS_LIMIT'
  | 'PRODUCT_INACTIVE'
  | 'TOTAL_MISMATCH'
  | 'EMPTY_SALE'
  // credit
  | 'CREDIT_CUSTOMER_REQUIRED'
  | 'CREDIT_LIMIT_EXCEEDED'
  // idempotency
  | 'IDEMPOTENCY_KEY_REUSE'
  | 'IDEMPOTENT_REQUEST_IN_PROGRESS'
  // invoice lifecycle
  | 'INVOICE_ALREADY_CANCELLED'
  | 'CANCEL_WINDOW_EXPIRED'
  | 'INVOICE_CANCELLED'
  // payments and returns
  | 'OVER_ALLOCATION'
  | 'PAYMENT_ALREADY_REVERSED'
  | 'RETURN_QUANTITY_EXCEEDED'
  | 'RETURN_WINDOW_EXPIRED'
  // duplicates
  | 'DUPLICATE_SKU'
  | 'DUPLICATE_BARCODE'
  | 'DUPLICATE_SUPPLIER_DOCUMENT'
  | 'DUPLICATE_FILE'
  // imports
  | 'IMPORT_ROWS_PENDING_DECISION'
  | 'IMPORT_ALREADY_APPLIED'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'FILE_TOO_LARGE'
  // tax
  | 'TAX_CONFIG_INCOMPLETE'
  // sync
  | 'SYNC_CURSOR_EXPIRED'
  | 'SYNC_BATCH_TOO_LARGE'
  | 'PRECONDITION_REQUIRED'
  | 'SKIPPED_AFTER_EARLIER_FAILURE'
  | 'CORRUPT_VERSION'
  | 'DRAFT_ALREADY_CANCELLED'
  // infrastructure
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

/** The envelope every non-2xx response carries, without exception (§4). */
export interface ApiErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details: Record<string, unknown>;
    readonly request_id: string;
    readonly retryable: boolean;
  };
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;
  /** Echoed in logs and readable to the user over the phone. */
  readonly requestId: string;
  readonly retryable: boolean;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error.message);
    this.name = 'ApiError';
    this.code = body.error.code;
    this.status = status;
    this.details = body.error.details;
    this.requestId = body.error.request_id;
    this.retryable = body.error.retryable;
  }
}

/** Raised when the request never reached the server, or its outcome is unknown. */
export class NetworkError extends Error {
  readonly retryable = true;
  constructor(message = OFFLINE.notConfirmed) {
    super(message);
    this.name = 'NetworkError';
  }
}

/** How the UI should present a failure. */
export interface ErrorPresentation {
  /** Plain language: what happened **and** what to do next (§10). */
  readonly message: string;
  /**
   * Business conflicts render as **inline panels above the action buttons**, never
   * toasts — a toast can be missed while a customer waits (§6).
   */
  readonly surface: 'inline' | 'dialog' | 'blocking';
  /** Whether a retry affordance may be offered at all. */
  readonly retryable: boolean;
  /** True when the user must resolve something before the action can succeed. */
  readonly needsResolution: boolean;
}

/**
 * Map a code to its presentation. **Exhaustive** — the `never` check at the end makes a
 * new backend code a compile error until it is handled here.
 */
export function describeError(code: ErrorCode): ErrorPresentation {
  switch (code) {
    // --- business conflicts: inline, above the actions -----------------------
    case 'INSUFFICIENT_STOCK':
      return {
        message: ERRORS.insufficientStock,
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'PRICE_CHANGED':
      // Never auto-accepted: the user sees the difference and decides (E-5).
      return {
        message: ERRORS.priceChanged,
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'TOTAL_MISMATCH':
      // Never auto-resubmitted.
      return {
        message: ERRORS.totalMismatch,
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'EMPTY_SALE':
      return {
        message: 'Add at least one item before completing the bill.',
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'PRODUCT_INACTIVE':
      return {
        message: ERRORS.insufficientStock,
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'DISCOUNT_EXCEEDS_LIMIT':
      return {
        message: 'This discount is above your limit. Ask a supervisor.',
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'CREDIT_LIMIT_EXCEEDED':
      return {
        message: ERRORS.creditLimitExceeded,
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'CREDIT_CUSTOMER_REQUIRED':
      return {
        message: ERRORS.creditCustomerRequired,
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'OVERSELL_REASON_REQUIRED':
      return {
        message: ERRORS.oversellReasonRequired,
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'VALIDATION_ERROR':
      // `details.fields` is mapped back onto the form by the caller.
      return {
        message: 'Some values need correcting.',
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };

    // --- already done: show it, never offer a retry ---------------------------
    case 'DRAFT_ALREADY_FINALIZED':
      // No retry affordance at all — that is how a duplicate bill happens.
      return {
        message: ERRORS.draftAlreadyFinalized,
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'INVOICE_ALREADY_CANCELLED':
      return {
        message: 'This bill was already cancelled.',
        surface: 'inline',
        retryable: false,
        needsResolution: false,
      };
    case 'PAYMENT_ALREADY_REVERSED':
      return {
        message: 'This payment was already reversed.',
        surface: 'inline',
        retryable: false,
        needsResolution: false,
      };
    case 'IMPORT_ALREADY_APPLIED':
      return {
        message: 'This import was already applied.',
        surface: 'inline',
        retryable: false,
        needsResolution: false,
      };

    // --- conflicts needing a choice: dialog -----------------------------------
    case 'DRAFT_VERSION_CONFLICT':
      // No automatic merge (ADR-007); the user chooses.
      return {
        message: ERRORS.draftVersionConflict,
        surface: 'dialog',
        retryable: false,
        needsResolution: true,
      };
    case 'DRAFT_ALREADY_CANCELLED':
      return {
        message: 'This bill was cleared elsewhere. You can recreate it as a new bill.',
        surface: 'dialog',
        retryable: false,
        needsResolution: true,
      };
    case 'CORRUPT_VERSION':
      // Never auto-retried; surfaced in the sync panel as needing attention.
      return {
        message: 'This bill could not be synced and needs attention. Tell the owner.',
        surface: 'dialog',
        retryable: false,
        needsResolution: true,
      };
    case 'SKIPPED_AFTER_EARLIER_FAILURE':
      return {
        message: 'Skipped until an earlier change to the same bill is resolved.',
        surface: 'dialog',
        retryable: false,
        needsResolution: true,
      };
    case 'DRAFT_LIMIT_REACHED':
      return {
        message: 'All bill tabs are in use. Complete or clear one first.',
        surface: 'dialog',
        retryable: false,
        needsResolution: true,
      };

    // --- permission: explain, offer a supervisor -----------------------------
    case 'PERMISSION_DENIED':
      return {
        message: ERRORS.permissionDenied,
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'OVERSELL_NOT_PERMITTED':
      return {
        message: ERRORS.oversellNotPermitted,
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'PRICE_OVERRIDE_NOT_PERMITTED':
      return {
        message: 'Changing a price needs a supervisor.',
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'DRAFT_OWNED_BY_OTHER_COUNTER':
      return {
        message: 'This bill belongs to another counter.',
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'BRANCH_SCOPE_INVALID':
      return {
        message: 'You are not assigned to that branch.',
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };

    // --- session: blocking ----------------------------------------------------
    case 'TOKEN_EXPIRED':
    case 'INVALID_CREDENTIALS':
    case 'REFRESH_TOKEN_REUSED':
      // Drafts are always kept across a re-login.
      return {
        message: ERRORS.signInAgain,
        surface: 'blocking',
        retryable: false,
        needsResolution: true,
      };
    case 'ACCOUNT_LOCKED':
      return {
        message: ERRORS.accountLocked(900),
        surface: 'blocking',
        retryable: false,
        needsResolution: true,
      };
    case 'USER_INACTIVE':
      return {
        message: 'This account is no longer active. Ask the owner.',
        surface: 'blocking',
        retryable: false,
        needsResolution: true,
      };
    case 'DEVICE_REVOKED':
      // Local data is **never** deleted in response (§8).
      return {
        message: OFFLINE.deviceRevoked,
        surface: 'blocking',
        retryable: false,
        needsResolution: true,
      };
    case 'DEVICE_NOT_REGISTERED':
      return {
        message: 'This computer is not registered. Ask the owner to add it.',
        surface: 'blocking',
        retryable: false,
        needsResolution: true,
      };

    // --- retryable ------------------------------------------------------------
    case 'IDEMPOTENT_REQUEST_IN_PROGRESS':
      // Retry the **same** key with backoff.
      return {
        message: 'Still completing this bill. Please wait.',
        surface: 'inline',
        retryable: true,
        needsResolution: false,
      };
    case 'SERVICE_UNAVAILABLE':
      return {
        message: ERRORS.serviceUnavailable,
        surface: 'inline',
        retryable: true,
        needsResolution: false,
      };
    case 'RATE_LIMITED':
      return {
        message: 'Too many requests. Please wait a moment.',
        surface: 'inline',
        retryable: true,
        needsResolution: false,
      };

    // --- client bugs: report, do not retry blindly ---------------------------
    case 'IDEMPOTENCY_KEY_REUSE':
      return {
        message: ERRORS.unexpected,
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'PRECONDITION_REQUIRED':
      // Refetch the draft; never retry blindly.
      return {
        message: 'This bill may be open elsewhere. Reload it before saving.',
        surface: 'dialog',
        retryable: false,
        needsResolution: true,
      };

    // --- the rest -------------------------------------------------------------
    case 'NOT_FOUND':
      return {
        message: 'That record no longer exists.',
        surface: 'inline',
        retryable: false,
        needsResolution: false,
      };
    case 'CANCEL_WINDOW_EXPIRED':
      return {
        message: 'This bill is too old to cancel. Record a return instead.',
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'INVOICE_CANCELLED':
      return {
        message: 'This bill was cancelled.',
        surface: 'inline',
        retryable: false,
        needsResolution: false,
      };
    case 'OVER_ALLOCATION':
      return {
        message: 'That would pay more than the amount outstanding.',
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'RETURN_QUANTITY_EXCEEDED':
      return {
        message: 'That is more than was sold on this bill.',
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'RETURN_WINDOW_EXPIRED':
      return {
        message: 'This bill is outside the return window.',
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'DUPLICATE_SKU':
      return {
        message: 'Another product already uses this part code.',
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'DUPLICATE_BARCODE':
      return {
        message: 'Another product already uses this barcode.',
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'DUPLICATE_SUPPLIER_DOCUMENT':
      return {
        message: 'This supplier bill was already received.',
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'DUPLICATE_FILE':
      return {
        message: 'This exact file was already uploaded.',
        surface: 'dialog',
        retryable: false,
        needsResolution: true,
      };
    case 'IMPORT_ROWS_PENDING_DECISION':
      return {
        message: 'Some rows still need a decision before this can be applied.',
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'UNSUPPORTED_FILE_TYPE':
      return {
        message: 'Only .xlsx, .csv and .pdf files can be uploaded.',
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'FILE_TOO_LARGE':
      return {
        message: 'This file is too large.',
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'TAX_CONFIG_INCOMPLETE':
      return {
        message: 'Tax settings are incomplete. Ask the owner.',
        surface: 'inline',
        retryable: false,
        needsResolution: true,
      };
    case 'SYNC_CURSOR_EXPIRED':
      return {
        message: 'The offline catalog is being rebuilt.',
        surface: 'inline',
        retryable: true,
        needsResolution: false,
      };
    case 'SYNC_BATCH_TOO_LARGE':
      return {
        message: 'Too many changes to sync at once. Retrying in smaller batches.',
        surface: 'inline',
        retryable: true,
        needsResolution: false,
      };
    case 'INTERNAL_ERROR':
      return {
        message: ERRORS.unexpected,
        surface: 'inline',
        retryable: true,
        needsResolution: false,
      };
    default: {
      // If this assignment stops compiling, a new backend code reached the client and
      // nothing above handles it. That is the mechanism behind FBO-5: an unhandled code
      // at the counter means a cashier sees nothing useful while a customer waits, so it
      // has to be a build failure rather than a runtime surprise.
      //
      // The fallback below is still reachable at runtime — a deployed client can be
      // older than the server — and a generic message is better than a blank panel.
      const unhandled: never = code;
      void unhandled;
      return {
        message: ERRORS.unexpected,
        surface: 'inline',
        retryable: false,
        needsResolution: false,
      };
    }
  }
}

/** Codes whose request must **never** be retried automatically. */
const NEVER_AUTO_RETRY: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'DRAFT_ALREADY_FINALIZED',
  'IDEMPOTENCY_KEY_REUSE',
  'TOTAL_MISMATCH',
  'PRICE_CHANGED',
  'DRAFT_VERSION_CONFLICT',
  'PRECONDITION_REQUIRED',
  'CORRUPT_VERSION',
  'DEVICE_REVOKED',
]);

export function mayAutoRetry(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  if (!(error instanceof ApiError)) return false;
  if (NEVER_AUTO_RETRY.has(error.code)) return false;
  return error.retryable;
}

/** Field-level messages from a `VALIDATION_ERROR`, for mapping back onto a form. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || error.code !== 'VALIDATION_ERROR') return {};
  const fields = error.details.fields;
  if (typeof fields !== 'object' || fields === null) return {};
  return Object.fromEntries(
    Object.entries(fields as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
  );
}

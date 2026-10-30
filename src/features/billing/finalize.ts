/**
 * Finalisation. The most safety-critical code in this client.
 *
 * `Print Bill` and `Credit Bill` both land here and both call the **same** endpoint
 * (ADR-033). `sale_type` selects the behaviour; it does not select a code path, exactly
 * as on the server. "Credit" is about who owes money, never about whether the sale
 * happened — which is why credit is refused offline for the same reason cash is.
 *
 * The sequence, and why each step is in this order:
 *
 * 1. **Refuse offline.** No key, no pending row, no queued operation — nothing is
 *    created (FR-OFFLINE-002). The bill is already safe on disk and the cashier is told
 *    so.
 * 2. **Claim and persist the key.** Before the first request, so a browser that dies
 *    mid-flight retries the same intent rather than creating a second sale (E-2).
 * 3. **Send.** One request, no intermediate call, 30-second timeout.
 * 4. **On success, mark the draft finalised and resolve the key.**
 * 5. **On a definitive refusal, resolve the key too** — holding it would make the next
 *    attempt replay a stored error.
 * 6. **On an unknown outcome, keep the key and mark the bill `unconfirmed`.** Never
 *    offer a plain "try again": the client does not know whether the customer has
 *    already been charged.
 */

import { ApiError, NetworkError, type ErrorCode } from '@/api/errors';
import { sales } from '@/api/endpoints';
import { serverNowIso } from '@/api/session';
import * as draftsDb from '@/db/drafts';
import * as pending from '@/db/pendingFinalizations';
import type { LocalDraft } from '@/db/schema';
import type { FinalizeRequest, FinalizeResponse } from '@/api/types';
import { formatForScreen, toApiString, type MoneyPolicy } from '@/lib/money';
import { draftTotal } from './draftStore';

export type SaleType = 'cash' | 'credit';

export interface PaymentInput {
  method: string;
  /** A decimal string. For cash it must cover the total; the server checks. */
  amount: string;
}

export interface FinalizeOutcome {
  kind: 'completed' | 'already_completed' | 'refused' | 'unknown';
  response?: FinalizeResponse | undefined;
  /** The registry code, for the UI's exhaustive switch. */
  code?: ErrorCode | undefined;
  error?: ApiError | NetworkError | undefined;
}

/**
 * Error codes whose answer is definitive: the sale did not happen and will not happen
 * for this request as it stands.
 *
 * The key is released for these, because the user has to change something before trying
 * again, and a released key means the changed bill gets a clean attempt.
 */
const DEFINITIVE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
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
  'VALIDATION_ERROR',
  'PERMISSION_DENIED',
  'DRAFT_VERSION_CONFLICT',
]);

/**
 * `DRAFT_ALREADY_FINALIZED` is **not** a refusal — the sale exists.
 *
 * Treating it as an error would offer a retry on a bill that has already been printed
 * and paid for. It is handled as a success whose invoice has to be fetched instead.
 */
function isAlreadyCompleted(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'DRAFT_ALREADY_FINALIZED';
}

export interface FinalizeArgs {
  draft: LocalDraft;
  saleType: SaleType;
  policy: MoneyPolicy;
  /** Required for `cash`; omitted for `credit` at save time (FR-CREDIT-025). */
  payment?: PaymentInput;
  /** Set after the user has seen and accepted a `PRICE_CHANGED` panel. Never automatic. */
  acceptPriceChanges?: boolean;
  /** At least 10 characters, and only where the user holds the permission. */
  oversellReason?: string;
  online: boolean;
  signal?: AbortSignal;
}

export class OfflineFinalizationRefused extends Error {
  constructor() {
    super('Completing a bill needs a connection.');
    this.name = 'OfflineFinalizationRefused';
  }
}

/** Build the request body from the generated field names. */
function buildBody(args: FinalizeArgs): FinalizeRequest {
  const { draft, saleType, policy, payment } = args;
  const total = draftTotal(draft);

  return {
    draft_id: draft.id,
    draft_version: draft.version,
    counter_id: draft.counter_id,
    sale_type: saleType,
    customer: draft.header.customer_id
      ? { mode: 'existing', customer_id: draft.header.customer_id }
      : { mode: 'none' },
    header: {
      // Sent whenever present, for **both** sale types (FR-CREDIT-012). A vehicle
      // number typed on a cash bill is still what the customer will quote next time.
      customer_name: draft.header.customer_name || null,
      customer_business_name: draft.header.customer_business_name || null,
      vehicle_number: draft.header.vehicle_number || null,
      mechanic_name: draft.header.mechanic_name || null,
      phone: draft.header.phone || null,
      notes: draft.header.notes || null,
    },
    lines: draft.lines.map((line) => ({
      product_id: line.product_id,
      quantity: line.quantity,
      unit_price: line.unit_price,
      price_source: line.price_source,
      discount_percent: line.discount_percent || null,
    })),
    // Omitted entirely for credit: the invoice is simply unpaid (FR-CREDIT-025).
    payment: payment ? { method: payment.method, amount: payment.amount } : null,
    // A cross-check only (FR-SALE-003). The server recomputes and refuses on mismatch.
    client_computed_total: toApiString(total, policy.amount_scale),
    accept_price_changes: args.acceptPriceChanges ?? false,
    oversell_override: args.oversellReason ? { reason: args.oversellReason } : null,
  };
}

/**
 * Finalise a sale.
 *
 * Never throws for a business outcome — every result is a `FinalizeOutcome` the caller
 * switches on, so there is no path where an unhandled rejection leaves the bill in an
 * unknown state on screen.
 */
export async function finalizeSale(args: FinalizeArgs): Promise<FinalizeOutcome> {
  const { draft, online } = args;

  // 1. Offline: create nothing at all. Not a key, not a pending row, not a queued
  // operation. The counter slip is offered instead, and it is not a bill.
  if (!online) throw new OfflineFinalizationRefused();

  // 2. The key, on disk, before the first request.
  const hash = pending.payloadHash({
    sale_type: args.saleType,
    customer_id: draft.header.customer_id,
    lines: draft.lines.map((line) => ({
      product_id: line.product_id,
      quantity: line.quantity,
      unit_price: line.unit_price,
      discount_percent: line.discount_percent,
    })),
    payment_amount: args.payment?.amount ?? null,
  });
  const claim = await pending.claim(draft.id, hash);

  await draftsDb.setDraftStatus(draft.id, 'submitting');

  try {
    // 3. One request. The client retries this same key internally on a network error,
    // a 503 or `IDEMPOTENT_REQUEST_IN_PROGRESS`.
    const result = await sales.finalize(
      buildBody(args),
      claim.idempotency_key,
      args.signal,
    );

    // 4. Committed. The draft keeps its tab so the bill can be reprinted.
    await draftsDb.markFinalized(draft.id, result.data.invoice.id);

    return {
      // A replay is reported distinctly so the UI says "already completed" rather than
      // implying a second sale just happened.
      kind: result.idempotentReplay ? 'already_completed' : 'completed',
      response: result.data,
    };
  } catch (error) {
    if (isAlreadyCompleted(error)) {
      // The sale exists. Resolve the key and let the caller load the invoice.
      await pending.resolve(draft.id);
      await draftsDb.setDraftStatus(draft.id, 'finalized');
      return { kind: 'already_completed', code: 'DRAFT_ALREADY_FINALIZED' };
    }

    if (error instanceof ApiError && DEFINITIVE.has(error.code)) {
      // 5. A clear "no". The bill goes back to editing and the key is released so the
      // corrected bill is a fresh intent.
      await pending.resolve(draft.id);
      await draftsDb.setDraftStatus(draft.id, 'editing');
      return { kind: 'refused', code: error.code, error };
    }

    // 6. Unknown. The key stays, the bill is `unconfirmed`, and the UI must not offer a
    // bare retry: the customer may already have been charged.
    await pending.recordAttempt(
      draft.id,
      error instanceof ApiError ? error.code : 'NETWORK',
    );
    await draftsDb.setDraftStatus(draft.id, 'unconfirmed');
    return {
      kind: 'unknown',
      code: error instanceof ApiError ? error.code : undefined,
      error:
        error instanceof ApiError || error instanceof NetworkError ? error : undefined,
    };
  }
}

/**
 * Whether the bill can be finalised under the current money policy.
 *
 * Checked client-side purely so the cashier is told **before** pressing the button
 * rather than after. The server revalidates regardless — this never replaces server
 * validation, it just moves the bad news earlier.
 */
export function blockingMoneyProblem(
  draft: LocalDraft,
  policy: MoneyPolicy,
): string | null {
  const total = draftTotal(draft);
  if (policy.require_integral_amounts && !total.eq(total.toDecimalPlaces(0))) {
    // Never rounded for the user (addendum §3.5): rounding silently would print a
    // figure that disagrees with what the server will store.
    return `The total ${formatForScreen(total)} includes paise, which this bill format cannot show.`;
  }
  return null;
}

/**
 * Retry an unconfirmed finalisation with the **same** key.
 *
 * Used by the reconnect path. Deliberately separate from `finalizeSale` so the retry
 * can never mint a key: the whole point is that this is the same intent.
 */
export async function retryUnconfirmed(
  args: Omit<FinalizeArgs, 'online'>,
): Promise<FinalizeOutcome> {
  const existing = await pending.get(args.draft.id);
  if (!existing) {
    // Nothing pending means the intent already resolved. Retrying would be a new sale.
    return { kind: 'refused', code: 'IDEMPOTENCY_KEY_REUSE' };
  }
  if (existing.stale) {
    // Past the window the client stops guessing and asks a person to look.
    return { kind: 'unknown' };
  }
  return finalizeSale({ ...args, online: true });
}

/** The counter slip's content, for the offline case. Built locally and clearly not a bill. */
export function counterSlipData(draft: LocalDraft, policy: MoneyPolicy) {
  return {
    printedAt: serverNowIso(),
    lines: draft.lines.map((line) => ({
      sl_no: line.line_no,
      item: line.product_name,
      quantity: line.quantity,
      price: line.unit_price,
    })),
    total: toApiString(draftTotal(draft), policy.amount_scale),
    customerName: draft.header.customer_name,
    vehicleNumber: draft.header.vehicle_number,
  };
}

/**
 * Finalisation: the client's duplicate-bill defences.
 *
 * Each case here is a specific way a customer could be charged twice, or a sale could
 * silently fail to exist:
 *
 * - finalising offline must create **nothing** — no key, no pending row;
 * - the key must be on disk **before** the request;
 * - an unknown outcome must leave the key in place and the bill `unconfirmed`;
 * - a definitive refusal must **release** the key so the corrected bill is a clean
 *   attempt;
 * - `DRAFT_ALREADY_FINALIZED` is a success, not an error — the sale exists;
 * - a retry must never mint a key.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, NetworkError } from '@/api/errors';
import * as draftsDb from '@/db/drafts';
import * as pending from '@/db/pendingFinalizations';
import { db, type LocalDraft } from '@/db/schema';
import type { MoneyPolicy } from '@/lib/money';
import { finalizeSale, OfflineFinalizationRefused, retryUnconfirmed } from './finalize';

const POLICY: MoneyPolicy = {
  version: 1,
  currency: 'INR',
  amount_scale: 2,
  unit_price_scale: 4,
  quantity_scale: 3,
  percent_scale: 3,
  rounding_mode: 'reject_fractional',
  round_grand_total_to_rupee: false,
  require_integral_amounts: true,
  display_decimal_places: 0,
};

const finalizeMock = vi.fn();
vi.mock('@/api/endpoints', () => ({
  sales: {
    finalize: (...args: unknown[]): unknown => finalizeMock(...args) as unknown,
  },
}));

function draftWith(overrides: Partial<LocalDraft> = {}): LocalDraft {
  return {
    id: 'draft-1',
    counter_id: 'counter-1',
    label: 'Bill 1',
    version: 1,
    status: 'editing',
    header: {
      customer_id: null,
      customer_name: '',
      customer_business_name: '',
      vehicle_number: '',
      mechanic_name: '',
      phone: '',
      notes: '',
      is_credit_intent: false,
    },
    lines: [
      {
        id: 'line-1',
        line_no: 1,
        product_id: 'p1',
        product_name: 'Brake Shoe Set',
        sku: 'TT-407-BS',
        unit_code: 'SET',
        quantity: '1.000',
        unit_price: '1250.0000',
        catalog_price_at_add: '1250.0000',
        price_source: 'catalog',
        discount_percent: '0.000',
        known_stock: '10.000',
        stock_as_of: '2026-10-30T10:00:00Z',
      },
    ],
    dirty: true,
    last_synced_at: null,
    conflict: null,
    invoice_id: null,
    updated_at: '2026-10-30T10:00:00Z',
    ...overrides,
  };
}

function apiError(code: string, status = 409): ApiError {
  return new ApiError(status, {
    error: {
      code: code as never,
      message: 'x',
      details: {},
      request_id: 'r',
      retryable: false,
    },
  });
}

beforeEach(async () => {
  finalizeMock.mockReset();
  await db.open();
  await db.drafts.clear();
  await db.pending_finalizations.clear();
  await db.drafts.put(draftWith());
});

describe('offline (FR-OFFLINE-002)', () => {
  it('refuses and creates nothing at all', async () => {
    await expect(
      finalizeSale({
        draft: draftWith(),
        saleType: 'cash',
        policy: POLICY,
        online: false,
      }),
    ).rejects.toBeInstanceOf(OfflineFinalizationRefused);

    // The whole point: no key, no pending row, no request. Creating a key offline
    // would mean a reconnect could replay a sale the server never agreed to.
    expect(await pending.get('draft-1')).toBeUndefined();
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it('refuses a credit sale offline exactly like a cash sale (ADR-033)', async () => {
    // "Credit" is about who owes money, never about whether the sale happened. Since
    // `Credit Bill` finalises, it cannot be available offline either.
    await expect(
      finalizeSale({
        draft: draftWith(),
        saleType: 'credit',
        policy: POLICY,
        online: false,
      }),
    ).rejects.toBeInstanceOf(OfflineFinalizationRefused);
    expect(finalizeMock).not.toHaveBeenCalled();
  });
});

describe('the key is on disk before the request (§5, E-2)', () => {
  it('persists the key before calling the server', async () => {
    let keyAtRequestTime: string | undefined;
    finalizeMock.mockImplementation(async () => {
      // Read from IndexedDB *during* the request. If the browser died right here, this
      // is what the retry would have to find.
      keyAtRequestTime = (await pending.get('draft-1'))?.idempotency_key;
      return {
        data: { invoice: { id: 'inv-1' }, print_payload: {}, warnings: [] },
        idempotentReplay: false,
        status: 201,
      };
    });

    await finalizeSale({
      draft: draftWith(),
      saleType: 'cash',
      policy: POLICY,
      online: true,
      payment: { method: 'cash', amount: '1250.00' },
    });

    expect(keyAtRequestTime).toBeTruthy();
    // And it is the key the request actually carried.
    expect(finalizeMock.mock.calls[0]?.[1]).toBe(keyAtRequestTime);
  });

  it('sends the same key when the same intent is attempted again', async () => {
    finalizeMock.mockRejectedValue(new NetworkError());
    const args = {
      draft: draftWith(),
      saleType: 'cash' as const,
      policy: POLICY,
      online: true,
      payment: { method: 'cash', amount: '1250.00' },
    };

    await finalizeSale(args);
    const firstKey = finalizeMock.mock.calls[0]?.[1];
    await finalizeSale(args);
    const secondKey = finalizeMock.mock.calls[1]?.[1];

    expect(secondKey).toBe(firstKey);
  });
});

describe('a committed sale', () => {
  it('marks the draft finalised and resolves the key', async () => {
    finalizeMock.mockResolvedValue({
      data: { invoice: { id: 'inv-1' }, print_payload: {}, warnings: [] },
      idempotentReplay: false,
      status: 201,
    });

    const outcome = await finalizeSale({
      draft: draftWith(),
      saleType: 'cash',
      policy: POLICY,
      online: true,
      payment: { method: 'cash', amount: '1250.00' },
    });

    expect(outcome.kind).toBe('completed');
    const stored = await draftsDb.getDraft('draft-1');
    expect(stored?.status).toBe('finalized');
    expect(stored?.invoice_id).toBe('inv-1');
    // The intent has resolved, so the key must not survive to be reused.
    expect(await pending.get('draft-1')).toBeUndefined();
  });

  it('reports a replay distinctly, so the UI never implies a second sale', async () => {
    finalizeMock.mockResolvedValue({
      data: { invoice: { id: 'inv-1' }, print_payload: {}, warnings: [] },
      idempotentReplay: true,
      status: 201,
    });
    const outcome = await finalizeSale({
      draft: draftWith(),
      saleType: 'cash',
      policy: POLICY,
      online: true,
      payment: { method: 'cash', amount: '1250.00' },
    });
    expect(outcome.kind).toBe('already_completed');
  });

  it('treats DRAFT_ALREADY_FINALIZED as the sale existing, not as an error', async () => {
    finalizeMock.mockRejectedValue(apiError('DRAFT_ALREADY_FINALIZED'));
    const outcome = await finalizeSale({
      draft: draftWith(),
      saleType: 'cash',
      policy: POLICY,
      online: true,
      payment: { method: 'cash', amount: '1250.00' },
    });

    expect(outcome.kind).toBe('already_completed');
    expect((await draftsDb.getDraft('draft-1'))?.status).toBe('finalized');
    expect(await pending.get('draft-1')).toBeUndefined();
  });
});

describe('a definitive refusal releases the key', () => {
  it.each([
    'INSUFFICIENT_STOCK',
    'PRICE_CHANGED',
    'TOTAL_MISMATCH',
    'CREDIT_LIMIT_EXCEEDED',
    'VALIDATION_ERROR',
  ])('%s returns the bill to editing and drops the key', async (code) => {
    finalizeMock.mockRejectedValue(apiError(code, 422));

    const outcome = await finalizeSale({
      draft: draftWith(),
      saleType: 'cash',
      policy: POLICY,
      online: true,
      payment: { method: 'cash', amount: '1250.00' },
    });

    expect(outcome.kind).toBe('refused');
    expect(outcome.code).toBe(code);
    expect((await draftsDb.getDraft('draft-1'))?.status).toBe('editing');
    // Released, because the user has to change something and the corrected bill
    // deserves a clean attempt rather than a replay of this refusal.
    expect(await pending.get('draft-1')).toBeUndefined();
  });
});

describe('an unknown outcome keeps the key', () => {
  it('marks the bill unconfirmed and retains the key for the same intent', async () => {
    finalizeMock.mockRejectedValue(new NetworkError());

    const outcome = await finalizeSale({
      draft: draftWith(),
      saleType: 'cash',
      policy: POLICY,
      online: true,
      payment: { method: 'cash', amount: '1250.00' },
    });

    expect(outcome.kind).toBe('unknown');
    expect((await draftsDb.getDraft('draft-1'))?.status).toBe('unconfirmed');
    // Kept: the sale may have committed, and the retry has to be the same intent.
    const kept = await pending.get('draft-1');
    expect(kept).toBeDefined();
    expect(kept?.attempts).toBe(1);
  });

  it('treats a 500 as unknown rather than as a refusal', async () => {
    finalizeMock.mockRejectedValue(apiError('INTERNAL_ERROR', 500));
    const outcome = await finalizeSale({
      draft: draftWith(),
      saleType: 'cash',
      policy: POLICY,
      online: true,
      payment: { method: 'cash', amount: '1250.00' },
    });
    // A 500 says nothing about whether the transaction committed.
    expect(outcome.kind).toBe('unknown');
    expect(await pending.get('draft-1')).toBeDefined();
  });
});

describe('retryUnconfirmed never mints a key', () => {
  it('refuses when nothing is pending', async () => {
    const outcome = await retryUnconfirmed({
      draft: draftWith(),
      saleType: 'cash',
      policy: POLICY,
    });
    // Nothing pending means the intent already resolved. Retrying would be a new sale.
    expect(outcome.kind).toBe('refused');
    expect(outcome.code).toBe('IDEMPOTENCY_KEY_REUSE');
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it('stops once the attempt is stale', async () => {
    await pending.claim('draft-1', 'hash-a');
    await pending.markStale('draft-1');

    const outcome = await retryUnconfirmed({
      draft: draftWith(),
      saleType: 'cash',
      policy: POLICY,
    });
    // Past the window the client stops guessing; a person checks Daily Bills.
    expect(outcome.kind).toBe('unknown');
    expect(finalizeMock).not.toHaveBeenCalled();
  });
});

describe('the request body', () => {
  it('omits payment for a credit sale (FR-CREDIT-025)', async () => {
    finalizeMock.mockResolvedValue({
      data: { invoice: { id: 'inv-1' }, print_payload: {}, warnings: [] },
      idempotentReplay: false,
      status: 201,
    });

    await finalizeSale({
      draft: draftWith({ header: { ...draftWith().header, customer_id: 'cust-1' } }),
      saleType: 'credit',
      policy: POLICY,
      online: true,
    });

    const body = finalizeMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.payment).toBeNull();
    expect(body.sale_type).toBe('credit');
    // Credit needs a persisted customer, not a typed name (FR-CREDIT-009).
    expect(body.customer).toEqual({ mode: 'existing', customer_id: 'cust-1' });
  });

  it('sends the client total as a cross-check, at the policy scale', async () => {
    finalizeMock.mockResolvedValue({
      data: { invoice: { id: 'inv-1' }, print_payload: {}, warnings: [] },
      idempotentReplay: false,
      status: 201,
    });

    await finalizeSale({
      draft: draftWith(),
      saleType: 'cash',
      policy: POLICY,
      online: true,
      payment: { method: 'cash', amount: '1250.00' },
    });

    const body = finalizeMock.mock.calls[0]?.[0] as Record<string, unknown>;
    // A cross-check only (FR-SALE-003) — the server recomputes and answers
    // `TOTAL_MISMATCH` rather than trusting this.
    expect(body.client_computed_total).toBe('1250.00');
  });

  it('never sets accept_price_changes on its own (E-5)', async () => {
    finalizeMock.mockResolvedValue({
      data: { invoice: { id: 'inv-1' }, print_payload: {}, warnings: [] },
      idempotentReplay: false,
      status: 201,
    });
    await finalizeSale({
      draft: draftWith(),
      saleType: 'cash',
      policy: POLICY,
      online: true,
      payment: { method: 'cash', amount: '1250.00' },
    });
    const body = finalizeMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.accept_price_changes).toBe(false);
  });
});

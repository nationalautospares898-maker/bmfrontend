/**
 * Typed wrappers over `client.ts`, one function per endpoint.
 *
 * Thin on purpose. These add no behaviour beyond the path, the HTTP verb and the
 * correct options — a business rule here would be a business rule the server does not
 * know about, which is the failure mode ground rule 6 exists to prevent.
 *
 * Every path appears in `../../bmbackend/docs/API-SPECIFICATION.md`. The client never
 * invents an endpoint.
 */

import { api, data, type ApiResponse, type RequestOptions } from './client';
import type {
  Bootstrap,
  CancelResponse,
  CatalogDelta,
  CreditCustomersResponse,
  CustomerUpsertRequest,
  DailySales,
  DraftListResponse,
  DraftUpsertRequest,
  FinalizeRequest,
  FinalizeResponse,
  Invoice,
  InvoiceListResponse,
  LoginRequest,
  MeResponse,
  Named,
  PaymentRequest,
  PaymentResponse,
  PrintPayload,
  Product,
  ProductCreateRequest,
  ProductSearchResult,
  ProductUpdateRequest,
  Report,
  ReversalResponse,
  ServerDraft,
  SessionResponse,
  SyncBatchRequest,
  SyncBatchResponse,
} from './types';

// --- auth ---------------------------------------------------------------------

export const auth = {
  /** `skipAuth` because there is no token yet, and a 401 here must not trigger refresh. */
  login(body: LoginRequest): Promise<SessionResponse> {
    return data(api.post<SessionResponse>('/auth/login', body, { skipAuth: true }));
  },
  /**
   * Exchange the `HttpOnly` refresh cookie for a new access token.
   *
   * `skipAuth` and `retry: 'never'`: a retried refresh is exactly what the server's
   * reuse detection is designed to catch, and being logged out mid-bill for a retry
   * would be self-inflicted.
   */
  refresh(): Promise<SessionResponse> {
    return data(
      api.post<SessionResponse>('/auth/refresh', undefined, {
        skipAuth: true,
        retry: 'never',
      }),
    );
  },
  logout(): Promise<void> {
    return data(api.post<void>('/auth/logout', undefined, { retry: 'never' }));
  },
  me(): Promise<MeResponse> {
    return data(api.get<MeResponse>('/auth/me'));
  },
  changePassword(body: {
    current_password: string;
    new_password: string;
  }): Promise<void> {
    return data(api.post<void>('/auth/change-password', body, { retry: 'never' }));
  },
};

// --- catalog ------------------------------------------------------------------

export const catalog = {
  /**
   * The autocomplete endpoint. **No retry**: the user is typing, and a stale retry
   * arriving after three more keystrokes is worse than a quick "Retry" affordance (§7).
   */
  search(
    query: string,
    options: {
      limit?: number | undefined;
      includeInactive?: boolean | undefined;
      signal?: AbortSignal | undefined;
    } = {},
  ): Promise<ProductSearchResult> {
    return data(
      api.get<ProductSearchResult>('/products/search', {
        params: {
          query,
          limit: options.limit,
          include_inactive: options.includeInactive,
        },
        retry: 'never',
        signal: options.signal,
      }),
    );
  },
  lookupBarcode(code: string): Promise<Product> {
    return data(api.get<Product>('/products/lookup-barcode', { params: { code } }));
  },
  get(productId: string): Promise<Product> {
    return data(api.get<Product>(`/products/${productId}`));
  },
  create(body: ProductCreateRequest): Promise<Product> {
    return data(api.post<Product>('/products', body));
  },
  update(productId: string, body: ProductUpdateRequest): Promise<Product> {
    return data(api.patch<Product>(`/products/${productId}`, body));
  },
  deactivate(productId: string): Promise<void> {
    return data(api.post<void>(`/products/${productId}:deactivate`));
  },
  addAlias(
    productId: string,
    alias: string,
    aliasType?: string,
  ): Promise<{ id: string }> {
    return data(
      api.post<{ id: string }>(`/products/${productId}/aliases`, {
        alias,
        alias_type: aliasType ?? 'alternate_name',
      }),
    );
  },
  brands(): Promise<Named[]> {
    return data(api.get<Named[]>('/brands'));
  },
  categories(): Promise<Named[]> {
    return data(api.get<Named[]>('/categories'));
  },
};

// --- customers ----------------------------------------------------------------

export const customers = {
  /**
   * Naturally idempotent via the **client-generated** id, so no key is needed and an
   * offline-created customer syncs as an upsert rather than a duplicate (FR-CUST-003).
   */
  upsert(customerId: string, body: CustomerUpsertRequest): Promise<{ id: string }> {
    return data(api.put<{ id: string }>(`/customers/${customerId}`, body));
  },
  search(
    query: string,
    signal?: AbortSignal,
  ): Promise<{ items: Array<{ id: string; name: string; phone: string | null }> }> {
    return data(api.get('/customers', { params: { query }, retry: 'never', signal }));
  },
};

// --- drafts -------------------------------------------------------------------

export const drafts = {
  list(counterId?: string): Promise<DraftListResponse> {
    return data(
      api.get<DraftListResponse>('/drafts', { params: { counter_id: counterId } }),
    );
  },
  get(draftId: string): Promise<ServerDraft> {
    return data(api.get<ServerDraft>(`/drafts/${draftId}`));
  },
  /**
   * Create or update a draft.
   *
   * `If-Match` carries the last known server `version`; it is **omitted** when the
   * draft has never synced, which is how the server distinguishes a create from a
   * blind overwrite (§6, `428 PRECONDITION_REQUIRED`).
   */
  upsert(
    draftId: string,
    body: DraftUpsertRequest,
    version: number | null,
  ): Promise<ServerDraft> {
    const options: RequestOptions = version === null ? {} : { ifMatch: version };
    return data(api.put<ServerDraft>(`/drafts/${draftId}`, body, options));
  },
  clear(draftId: string): Promise<void> {
    return data(api.delete<void>(`/drafts/${draftId}`));
  },
  takeover(draftId: string): Promise<ServerDraft> {
    return data(api.post<ServerDraft>(`/drafts/${draftId}:takeover`));
  },
};

// --- sales --------------------------------------------------------------------

export const sales = {
  /**
   * Finalise a sale — **cash and credit alike** (ADR-033).
   *
   * Returns the full response so the caller can see `Idempotent-Replay`: a replayed
   * finalisation must be presented as "already completed", never as a second sale.
   *
   * The key is mandatory and must have been persisted **before** the first attempt
   * (§5). Retries are automatic for `NetworkError`, 503 and
   * `IDEMPOTENT_REQUEST_IN_PROGRESS`, always with this same key.
   */
  finalize(
    body: FinalizeRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ApiResponse<FinalizeResponse>> {
    return api.post<FinalizeResponse>('/sales:finalize', body, {
      idempotencyKey,
      timeout: 'finalize',
      retry: 'auto',
      signal,
    });
  },
};

// --- invoices -----------------------------------------------------------------

export const invoices = {
  list(filters: {
    from?: string;
    to?: string;
    payment_status?: string;
    customer_id?: string;
    counter_id?: string;
    is_credit?: boolean;
    limit?: number;
  }): Promise<InvoiceListResponse> {
    return data(api.get<InvoiceListResponse>('/invoices', { params: filters }));
  },
  get(invoiceId: string): Promise<Invoice> {
    return data(api.get<Invoice>(`/invoices/${invoiceId}`));
  },
  /** Immutable once issued, which is why the query cache holds it forever (§10). */
  printPayload(invoiceId: string, isDuplicate = false): Promise<PrintPayload> {
    return data(
      api.get<PrintPayload>(`/invoices/${invoiceId}/print-payload`, {
        params: { is_duplicate: isDuplicate },
      }),
    );
  },
  /**
   * Best-effort print logging.
   *
   * A logging failure must **never** block printing — a customer waiting for their bill
   * is not the moment to fail on an audit nicety — so this swallows every error.
   */
  async recordPrintEvent(invoiceId: string, isDuplicate: boolean): Promise<void> {
    try {
      await api.post(
        `/invoices/${invoiceId}/print-events`,
        { is_duplicate: isDuplicate },
        {
          retry: 'never',
        },
      );
    } catch {
      // Intentionally ignored. See above.
    }
  },
  cancel(
    invoiceId: string,
    reason: string,
    idempotencyKey: string,
  ): Promise<CancelResponse> {
    return data(
      api.post<CancelResponse>(
        `/invoices/${invoiceId}:cancel`,
        { reason },
        { idempotencyKey, retry: 'auto' },
      ),
    );
  },
};

// --- credit -------------------------------------------------------------------

export const credit = {
  /** Never moves stock: collecting money and selling goods are distinct events. */
  recordPayment(body: PaymentRequest, idempotencyKey: string): Promise<PaymentResponse> {
    return data(
      api.post<PaymentResponse>('/payments', body, { idempotencyKey, retry: 'auto' }),
    );
  },
  reversePayment(
    paymentId: string,
    reason: string,
    idempotencyKey: string,
  ): Promise<ReversalResponse> {
    return data(
      api.post<ReversalResponse>(
        `/payments/${paymentId}:reverse`,
        { reason },
        { idempotencyKey, retry: 'auto' },
      ),
    );
  },
  payments(filters: { invoice_id?: string; customer_id?: string }): Promise<{
    items: Array<Record<string, unknown>>;
  }> {
    return data(api.get('/payments', { params: filters }));
  },
  /** Server-computed aggregates. The client never sums these (FR-RPT-030). */
  customers(filters: {
    include_settled?: boolean;
    query?: string;
    limit?: number;
  }): Promise<CreditCustomersResponse> {
    return data(
      api.get<CreditCustomersResponse>('/credit/customers', { params: filters }),
    );
  },
};

// --- sync ---------------------------------------------------------------------

export const sync = {
  bootstrap(): Promise<Bootstrap> {
    return data(api.get<Bootstrap>('/sync/bootstrap'));
  },
  catalogDelta(since: string | null, limit = 500): Promise<CatalogDelta> {
    return data(
      api.get<CatalogDelta>('/sync/catalog', {
        params: { since: since ?? undefined, limit },
      }),
    );
  },
  /**
   * Push the outbox.
   *
   * Per-operation `op_id` provides idempotency, so no request-level key is used. A
   * `rejected` or `conflicted` result is **never** auto-retried; it waits for a human.
   */
  push(body: SyncBatchRequest): Promise<SyncBatchResponse> {
    return data(
      api.post<SyncBatchResponse>('/sync/operations', body, { retry: 'never' }),
    );
  },
};

// --- reports ------------------------------------------------------------------

export const reports = {
  /** Typed field-by-field, because a screen renders these figures individually. */
  dailySales(params: {
    from?: string;
    to?: string;
    counter_id?: string;
  }): Promise<DailySales> {
    return data(api.get<DailySales>('/reports/daily-sales', { params }));
  },
  creditOutstanding(): Promise<Report> {
    return data(api.get<Report>('/reports/credit-outstanding'));
  },
  stockPosition(params: { low_stock_only?: boolean } = {}): Promise<Report> {
    return data(api.get<Report>('/reports/stock-position', { params }));
  },
  itemSales(params: { from?: string; to?: string }): Promise<Report> {
    return data(api.get<Report>('/reports/item-sales', { params }));
  },
};

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
  ImportJob,
  ImportJobs,
  ImportReport,
  ImportRow,
  ImportRows,
  ImportUpload,
  Invoice,
  InvoiceListResponse,
  AmendRequest,
  AmendResponse,
  InvoiceRevisionsResponse,
  LoginRequest,
  MechanicEnsureResponse,
  MechanicListResponse,
  MeResponse,
  Named,
  NotificationListResponse,
  Order,
  OrderListResponse,
  ReminderListResponse,
  StockCountFinalizeResponse,
  StockCountReview,
  StockCountSession,
  StockCountSessionListResponse,
  PaymentHistoryList,
  PaymentRequest,
  PaymentResponse,
  PrintPayload,
  Product,
  ProductCreateRequest,
  ProductSearchResult,
  ProductUpdateRequest,
  PurchaseList,
  Report,
  ReversalResponse,
  ServerDraft,
  SessionResponse,
  MovementReport,
  StockBalances,
  StockEntries,
  StockEntryMatch,
  StockMovements,
  SupplierList,
  SyncBatchRequest,
  SyncBatchResponse,
  AdminDevice,
  Counter,
  CustomerListResponse,
  CustomerUpsertResponse,
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
  /**
   * Ask for a session without a password.
   *
   * Succeeds only on a server whose operator has turned unattended access on; anywhere
   * else it is refused with `PERMISSION_DENIED`, and the caller falls back to the
   * sign-in form. `skipAuth` because there is no session yet — that is the point — and
   * `retry: 'never'` because a refusal is a settled answer about how the server is
   * configured, not a transient failure worth repeating.
   */
  unattended(body: { device: { id: string; label: string } }): Promise<SessionResponse> {
    return data(
      api.post<SessionResponse>('/auth/unattended', body, {
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
   * The customer directory, newest first.
   *
   * Not `credit.customers`, which inner-joins credit invoices and is the top of the
   * Credit Bills view — a customer with no credit history is absent from it, so one
   * created through `Add a customer` could not be seen or searched for on the Customers
   * screen at all.
   *
   * `cursor` is the previous page's opaque `next_cursor` (epoch microseconds, digits
   * only, so it needs no escaping in a query string).
   */
  list(params: { limit?: number; cursor?: string } = {}): Promise<CustomerListResponse> {
    return data(api.get<CustomerListResponse>('/customers', { params }));
  },
  /**
   * Naturally idempotent via the **client-generated** id, so no key is needed and an
   * offline-created customer syncs as an upsert rather than a duplicate (FR-CUST-003).
   */
  upsert(
    customerId: string,
    body: CustomerUpsertRequest,
  ): Promise<CustomerUpsertResponse> {
    return data(api.put<CustomerUpsertResponse>(`/customers/${customerId}`, body));
  },
  /**
   * Search the directory by name, phone, business name or vehicle.
   *
   * The path was `/customers`, which **did not exist** — so every call 404'd. Its only
   * caller is the duplicate-phone check in the Add-a-customer dialog, and that swallows
   * errors on purpose ("a failed lookup must not stop someone adding a customer"), so
   * the warning simply never appeared and the same customer could be added twice
   * without a word. The declared return shape was wrong too: `phone`, where the API
   * sends `primary_phone`.
   */
  search(query: string, signal?: AbortSignal): Promise<CustomerListResponse> {
    return data(
      api.get<CustomerListResponse>('/customers/search', {
        params: { query },
        retry: 'never',
        signal,
      }),
    );
  },
};

// --- mechanics ----------------------------------------------------------------

export const mechanics = {
  /**
   * Suggestions for the billing header's Mechanic field.
   *
   * **`query` is optional**, and omitting it is a real use: the field is focused before
   * anything has been typed, and the server answers with the recently-used list — which
   * is the most useful thing to show at that moment and is why `mechanics.last_used_at`
   * exists.
   *
   * `retry: 'never'`, matching `catalog.search` and `customers.search`: the user is
   * typing, and a stale retry landing after three more keystrokes is worse than a quick
   * retry affordance (§7).
   */
  search(
    query?: string,
    options: { limit?: number | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<MechanicListResponse> {
    return data(
      api.get<MechanicListResponse>('/mechanics', {
        params: { query, limit: options.limit },
        retry: 'never',
        signal: options.signal,
      }),
    );
  },
  /**
   * Get-or-create by normalised name.
   *
   * Sending a name that already exists is the **common** case and is not an error — the
   * server matches on the normalised name and returns the existing mechanic with
   * `created: false`. So this needs no `Idempotency-Key` (it moves neither money nor
   * stock) and a double press, a retry or two counters racing all converge on one row.
   */
  ensure(name: string, phone?: string | null): Promise<MechanicEnsureResponse> {
    return data(
      api.post<MechanicEnsureResponse>('/mechanics', {
        name,
        ...(phone ? { phone } : {}),
      }),
    );
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
  /**
   * Edit a finalised bill **in place** (owner Decision A, 2026-11-07).
   *
   * Keeps the invoice's identity; the server writes the complete before-state to
   * `invoice_revisions` first, recomputes the money, reconciles stock with new
   * append-only movements and never touches a payment.
   *
   * `idempotencyKey` is **required** and must be reused across retries of the *same*
   * save: without it a retried edit writes a second revision and a second set of stock
   * movements, and stock movements can never be deleted.
   *
   * `retry: 'never'` — this is a financial mutation, and the caller decides whether to
   * resend after showing the operator what happened.
   */
  amend(
    invoiceId: string,
    body: AmendRequest,
    idempotencyKey: string,
  ): Promise<AmendResponse> {
    return data(
      api.post<AmendResponse>(`/invoices/${invoiceId}:amend`, body, {
        idempotencyKey,
        retry: 'never',
      }),
    );
  },
  /** The edit history of one bill, newest first. */
  revisions(invoiceId: string): Promise<InvoiceRevisionsResponse> {
    return data(api.get<InvoiceRevisionsResponse>(`/invoices/${invoiceId}/revisions`));
  },
  list(filters: {
    from?: string;
    to?: string;
    payment_status?: string;
    customer_id?: string;
    counter_id?: string;
    is_credit?: boolean;
    /**
     * Canceled Bills (2026-11-10). Omit for Daily/Credit Bills, which now excludes
     * cancelled bills server-side by default; pass `'cancelled'` for the dedicated
     * Canceled Bills screen.
     */
    status?: 'cancelled';
    limit?: number;
  }): Promise<InvoiceListResponse> {
    return data(api.get<InvoiceListResponse>('/invoices', { params: filters }));
  },
  get(invoiceId: string): Promise<Invoice> {
    return data(api.get<Invoice>(`/invoices/${invoiceId}`));
  },
  /**
   * Immutable once issued, which is why the query cache holds it forever (§10).
   *
   * `copy=reprint` **asks** rather than asserts: whether the document comes back marked
   * `DUPLICATE COPY` is the server's decision, taken from the `print_log` and the
   * `print.mark_reprints_duplicate` setting (FR-PRINT-004). The client is not trusted to
   * declare a bill a duplicate, and must not be — a reprint that prints as an original
   * is a bill that can be handed over twice.
   *
   * This used to send `is_duplicate`, which is not a parameter the route has. FastAPI
   * ignores unknown query parameters, so `copy` stayed `None`, `is_duplicate` evaluated
   * `False` for every request, and **every reprint from Daily Bills rendered as an
   * original**. Nothing failed and nothing was logged; the only visible symptom was a
   * missing watermark on paper, which no test looked at.
   */
  printPayload(invoiceId: string, isDuplicate = false): Promise<PrintPayload> {
    return data(
      api.get<PrintPayload>(`/invoices/${invoiceId}/print-payload`, {
        params: { copy: isDuplicate ? 'reprint' : undefined },
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
  payments(filters: {
    invoice_id?: string;
    customer_id?: string;
  }): Promise<PaymentHistoryList> {
    return data(api.get<PaymentHistoryList>('/payments', { params: filters }));
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

// --- inventory ----------------------------------------------------------------

export const inventory = {
  balances(
    params: { low_stock_only?: boolean; limit?: number } = {},
  ): Promise<StockBalances> {
    return data(api.get<StockBalances>('/inventory/balances', { params }));
  },
  /**
   * One product's complete history — every movement, not only sales.
   *
   * `oldest_first` is what the History panel wants: read downwards, each row's
   * `balance_after` follows from the one above it. Each row also carries a `reference`
   * (an invoice reference for a sale or its reversal) when the movement has a document a
   * human can look up, and `null` when it does not — a sheet arrival has none, and the
   * screen shows nothing rather than inventing a placeholder.
   */
  movements(
    params: { product_id?: string; limit?: number; oldest_first?: boolean } = {},
  ): Promise<StockMovements> {
    return data(api.get<StockMovements>('/inventory/movements', { params }));
  },
  /**
   * One day's movements, for the Stock Movement Report.
   *
   * The sibling of `movements` above: that one answers "what happened to this part",
   * this one answers "what moved today". Both read the same append-only ledger, so the
   * two screens can never disagree.
   *
   * `on_date` is a **business-local** date (`YYYY-MM-DD`) — the server resolves the day
   * boundary in the shop's own timezone, the same way Daily Bills does, so the client
   * never has to reason about UTC. `kind` is `added` (everything that increased stock),
   * `sold` (sale deductions only), or `adjusted` (every other decrease — a correction,
   * scrap, a transfer out). `end_date` is optional and defaults to `on_date` on the
   * server; the owner's Stock Report passes both for a date range.
   *
   * `signal` is accepted so the caller can abandon a request whose answer is no longer
   * wanted: changing the date twice quickly must not let the first reply land last.
   */
  movementReport(
    params: {
      on_date: string;
      kind: 'added' | 'sold' | 'adjusted';
      end_date?: string;
    },
    signal?: AbortSignal,
  ): Promise<MovementReport> {
    return data(
      api.get<MovementReport>('/inventory/movements/report', {
        params,
        ...(signal ? { signal } : {}),
      }),
    );
  },
  /**
   * Save the owner's four-column sheet. **Adds to stock; never replaces it.**
   *
   * One request per sheet, applied all-or-nothing, so a row with an ambiguous name does
   * not leave the first four received and the rest not.
   *
   * The key is persisted-key discipline's simpler cousin: the server **claims** it, so
   * the double-tap this button invites books one delivery. `retry: 'auto'` is only safe
   * because of that — and because `stock_movements` can never be deleted, a second
   * booking could not be tidied away afterwards.
   */
  saveStockEntries(
    body: {
      entries: Array<{ item: string; price: string; min_qty: string; stock_qty: string }>;
    },
    idempotencyKey: string,
  ): Promise<StockEntries> {
    return data(
      api.post<StockEntries>('/inventory/stock-entries', body, {
        idempotencyKey,
        retry: 'auto',
      }),
    );
  },
  /**
   * Will this name add a new product, or top up an existing one?
   *
   * **No retry**: the user is typing, exactly as with product search (§7).
   */
  resolveStockEntry(item: string, signal?: AbortSignal): Promise<StockEntryMatch> {
    return data(
      api.get<StockEntryMatch>('/inventory/stock-entries:resolve', {
        params: { item },
        retry: 'never',
        signal,
      }),
    );
  },
  /**
   * A reasoned, audited correction — **never** a way to set a quantity.
   *
   * `quantity_delta` is a change, and `reason_code` is what gives it a sign. The key is
   * required by the server so a retried adjustment cannot be applied twice, which is
   * also why `retry: 'auto'` is safe here.
   */
  adjust(
    body: {
      product_id: string;
      quantity_delta: string;
      reason_code: string;
      reason_text: string;
    },
    idempotencyKey: string,
  ): Promise<{ movement_id: string }> {
    return data(
      api.post<{ movement_id: string }>('/inventory/adjustments', body, {
        idempotencyKey,
        retry: 'auto',
      }),
    );
  },

  // --- physical stock count (Feature A.6) ---------------------------------------

  listStockCounts(): Promise<StockCountSessionListResponse> {
    return data(api.get<StockCountSessionListResponse>('/inventory/stock-counts'));
  },
  /** Refused with `STOCK_COUNT_ALREADY_OPEN` if one is already open for this branch. */
  startStockCount(notes?: string): Promise<StockCountSession> {
    return data(
      api.post<StockCountSession>(
        '/inventory/stock-counts',
        { notes: notes || null },
        { retry: 'never' },
      ),
    );
  },
  /** Every product with a balance in the branch, counted or not, with the *current*
   * system quantity — never the figure from when it was counted. */
  reviewStockCount(sessionId: string): Promise<StockCountReview> {
    return data(api.get<StockCountReview>(`/inventory/stock-counts/${sessionId}`));
  },
  recordStockCountItem(
    sessionId: string,
    productId: string,
    countedQuantity: string,
  ): Promise<void> {
    return data(
      api.put<void>(
        `/inventory/stock-counts/${sessionId}/items/${productId}`,
        { counted_quantity: countedQuantity },
        { retry: 'never' },
      ),
    );
  },
  finalizeStockCount(sessionId: string): Promise<StockCountFinalizeResponse> {
    return data(
      api.post<StockCountFinalizeResponse>(
        `/inventory/stock-counts/${sessionId}:finalize`,
        undefined,
        { retry: 'never' },
      ),
    );
  },
  cancelStockCount(sessionId: string): Promise<{ status: string }> {
    return data(
      api.post<{ status: string }>(
        `/inventory/stock-counts/${sessionId}:cancel`,
        undefined,
        {
          retry: 'never',
        },
      ),
    );
  },
};

// --- purchases ----------------------------------------------------------------

export const purchases = {
  suppliers(): Promise<SupplierList> {
    return data(api.get<SupplierList>('/suppliers'));
  },
  upsertSupplier(
    supplierId: string,
    body: {
      name: string;
      phone?: string | null;
      business_name?: string | null;
      tax_identifier?: string | null;
    },
  ): Promise<{ id: string }> {
    return data(api.put<{ id: string }>(`/suppliers/${supplierId}`, body));
  },
  /**
   * The purchase register, newest first.
   *
   * **There is deliberately no `status` parameter.** This used to accept and forward
   * one, and `GET /purchases` (`list_purchases`) declares only `supplier_id` and
   * `limit`. FastAPI silently drops query parameters it does not declare, so the filter
   * would have been thrown away and the register would have returned *every* purchase
   * while the screen said it was showing only drafts — the identical mechanism to the
   * `is_duplicate`/`copy` defect on `invoices.printPayload` above. Nothing fails,
   * nothing is logged, and the only symptom is wrong rows presented confidently.
   *
   * On this screen that is more than cosmetic. The register's one action is `Confirm`,
   * and confirming is **the only path that receives stock** (FR-PUR-003), so a list
   * labelled "draft" that actually contains confirmed rows invites someone to receive
   * the same delivery twice.
   *
   * Declaring it server-side instead was the alternative, and was rejected because
   * nothing beneath the route can filter yet: `PurchaseService.list_purchases` takes
   * only `supplier_id` and `limit`, there is no purchases repository, and the `LIMIT`
   * is applied in SQL. Filtering the rows after they return would yield only the drafts
   * that happen to fall inside the newest 200 purchases, reading as "no drafts" once
   * the shop has more than that — a half-working filter, which is this same defect in a
   * new costume. `API-SPECIFICATION.md` §3.8 does not promise a status filter either.
   *
   * When the service learns to filter, declare `status` on the route validated against
   * the `PurchaseStatus` enum — never as a free string — regenerate `openapi.json`, and
   * add it back here in that same change. `client.test.ts` holds the client's keys to
   * the generated contract, so it will widen on its own and not before.
   */
  list(params: { supplier_id?: string; limit?: number } = {}): Promise<PurchaseList> {
    return data(api.get<PurchaseList>('/purchases', { params }));
  },
  /** Creates a `draft`. **No stock changes** until it is confirmed (FR-PUR-003). */
  create(
    body: {
      supplier_id: string;
      items: Array<{ product_id: string; quantity: string; unit_cost: string }>;
      supplier_document_number?: string | null;
      document_date?: string | null;
      notes?: string | null;
    },
    idempotencyKey: string,
  ): Promise<{ id: string }> {
    return data(
      api.post<{ id: string }>('/purchases', body, { idempotencyKey, retry: 'auto' }),
    );
  },
  /**
   * **The only path that receives stock** (FR-PUR-003), and idempotent on the server,
   * so a retried confirm cannot receive the same goods twice.
   */
  confirm(purchaseId: string, idempotencyKey: string): Promise<{ movements: number }> {
    return data(
      api.post<{ movements: number }>(`/purchases/${purchaseId}:confirm`, undefined, {
        idempotencyKey,
        retry: 'auto',
      }),
    );
  },
  cancel(purchaseId: string): Promise<void> {
    return data(api.post<void>(`/purchases/${purchaseId}:cancel`));
  },
};

// --- imports (M23) ------------------------------------------------------------

export const imports = {
  /**
   * Upload a file. The **one** multipart request in this client.
   *
   * No `Content-Type` is set: the browser has to add the multipart boundary itself, and
   * setting the header by hand omits it and makes the server unable to parse the body.
   *
   * `retry: 'never'` — a 10 MB body is not something to resend blind, and the server's
   * duplicate detection (FR-IMP-004) already makes a deliberate re-upload explicit.
   */
  upload(
    file: File,
    options: {
      intent: 'price_list' | 'purchase_receipt';
      supplierId?: string | undefined;
      allowDuplicate?: boolean | undefined;
      duplicateReason?: string | undefined;
    },
  ): Promise<ImportUpload> {
    const form = new FormData();
    form.append('file', file);
    form.append('intent', options.intent);
    if (options.supplierId) form.append('supplier_id', options.supplierId);
    if (options.allowDuplicate) form.append('allow_duplicate', 'true');
    if (options.duplicateReason) {
      form.append('duplicate_reason', options.duplicateReason);
    }
    return data(api.post<ImportUpload>('/imports', form, { retry: 'never' }));
  },
  list(params: { limit?: number } = {}): Promise<ImportJobs> {
    return data(api.get<ImportJobs>('/imports', { params }));
  },
  get(jobId: string): Promise<ImportJob> {
    return data(api.get<ImportJob>(`/imports/${jobId}`));
  },
  rows(
    jobId: string,
    params: { match_status?: string; decision?: string; limit?: number } = {},
  ): Promise<ImportRows> {
    return data(api.get<ImportRows>(`/imports/${jobId}/rows`, { params }));
  },
  /** One human decision on one row (FR-IMP-007). */
  decide(
    jobId: string,
    rowId: string,
    body: {
      decision: 'accept_match' | 'create_new' | 'skip';
      matched_product_id?: string;
    },
  ): Promise<{ row: ImportRow }> {
    return data(api.patch<{ row: ImportRow }>(`/imports/${jobId}/rows/${rowId}`, body));
  },
  /** One decision for every pending row in a status. */
  decideAll(
    jobId: string,
    body: { match_status: string; decision: 'accept_match' | 'create_new' | 'skip' },
  ): Promise<ImportJob> {
    return data(api.post<ImportJob>(`/imports/${jobId}/rows:decide-all`, body));
  },
  /**
   * Apply the accepted rows. The key is required by the contract; the job's terminal
   * `applied` state is what actually prevents a second application.
   */
  apply(jobId: string, idempotencyKey: string): Promise<ImportJob> {
    return data(
      api.post<ImportJob>(`/imports/${jobId}:apply`, undefined, {
        idempotencyKey,
        timeout: 'finalize',
        retry: 'auto',
      }),
    );
  },
  cancel(jobId: string): Promise<ImportJob> {
    return data(api.post<ImportJob>(`/imports/${jobId}:cancel`));
  },
  report(jobId: string): Promise<ImportReport> {
    return data(api.get<ImportReport>(`/imports/${jobId}/report`));
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

/**
 * Counter administration (C-2, FR-ADMIN-003).
 *
 * All three require `admin.settings.manage`. Assigning a counter decides whose takings
 * a machine's next sale is attributed to, so it is held to the settings permission
 * rather than the weaker `admin.devices.manage` — see `bm.domain.auth.counters` in the
 * backend for the reasoning.
 */
export const adminCounters = {
  list(): Promise<Counter[]> {
    return data(api.get<Counter[]>('/admin/counters'));
  },
  listDevices(): Promise<AdminDevice[]> {
    return data(api.get<AdminDevice[]>('/admin/devices'));
  },
  update(
    counterId: string,
    body: { name?: string; max_open_drafts?: number; is_active?: boolean },
  ): Promise<Counter> {
    return data(api.put<Counter>(`/admin/counters/${counterId}`, body));
  },
  /**
   * `counterId: null` detaches the computer from every counter. Not retried
   * automatically: it is a deliberate administrative act, and a silent retry after an
   * ambiguous failure could repoint a till the administrator thought they had left
   * alone.
   */
  assignDevice(deviceId: string, counterId: string | null): Promise<AdminDevice> {
    return data(
      api.put<AdminDevice>(
        `/admin/devices/${deviceId}/counter`,
        {
          counter_id: counterId,
        },
        { retry: 'never' },
      ),
    );
  },
};

// --- notifications (Feature A.1/A.2) -------------------------------------------

export const notifications = {
  list(limit = 50): Promise<NotificationListResponse> {
    return data(
      api.get<NotificationListResponse>('/notifications', { params: { limit } }),
    );
  },
  dismiss(notificationId: string): Promise<{ status: string }> {
    return data(
      api.post<{ status: string }>(
        `/notifications/${notificationId}:dismiss`,
        undefined,
        {
          retry: 'never',
        },
      ),
    );
  },
  acknowledge(notificationId: string): Promise<{ status: string }> {
    return data(
      api.post<{ status: string }>(
        `/notifications/${notificationId}:acknowledge`,
        undefined,
        {
          retry: 'never',
        },
      ),
    );
  },
  snooze(notificationId: string, minutes: number): Promise<{ status: string }> {
    return data(
      api.post<{ status: string }>(
        `/notifications/${notificationId}:snooze`,
        { minutes },
        { retry: 'never' },
      ),
    );
  },
};

// --- scheduled reminders (Feature A.5) ------------------------------------------

export const reminders = {
  list(): Promise<ReminderListResponse> {
    return data(api.get<ReminderListResponse>('/reminders'));
  },
  create(body: {
    label: string;
    fire_time?: string | null;
    interval_hours?: number | null;
  }): Promise<{ id: string }> {
    return data(api.post<{ id: string }>('/reminders', body, { retry: 'never' }));
  },
  update(
    reminderId: string,
    body: { label?: string; enabled?: boolean },
  ): Promise<{ updated: boolean }> {
    return data(
      api.put<{ updated: boolean }>(`/reminders/${reminderId}`, body, { retry: 'never' }),
    );
  },
  remove(reminderId: string): Promise<void> {
    return data(api.delete<void>(`/reminders/${reminderId}`, { retry: 'never' }));
  },
};

// --- Chitti orders (Feature B) --------------------------------------------------

export const orders = {
  list(
    params: { status?: 'pending' | 'completed' | 'discarded'; limit?: number } = {},
  ): Promise<OrderListResponse> {
    return data(api.get<OrderListResponse>('/orders', { params }));
  },
  create(body: {
    body: string;
    customer_name?: string | null;
    phone?: string | null;
  }): Promise<{ id: string }> {
    return data(api.post<{ id: string }>('/orders', body, { retry: 'never' }));
  },
  update(
    orderId: string,
    body: { body?: string; customer_name?: string | null; phone?: string | null },
  ): Promise<{ updated: boolean }> {
    return data(
      api.put<{ updated: boolean }>(`/orders/${orderId}`, body, { retry: 'never' }),
    );
  },
  complete(orderId: string): Promise<{ status: string }> {
    return data(
      api.post<{ status: string }>(`/orders/${orderId}:complete`, undefined, {
        retry: 'never',
      }),
    );
  },
  discard(orderId: string): Promise<{ status: string }> {
    return data(
      api.post<{ status: string }>(`/orders/${orderId}:discard`, undefined, {
        retry: 'never',
      }),
    );
  },
  /**
   * Set or clear (`remind_at: null`) the owner's own one-time reminder for one order.
   * Fires ahead of the flat ten-minute nudge once due, and is server-consumed the
   * instant it fires — see `domain/orders/service.py::nudge_pending`.
   */
  setReminder(orderId: string, remindAt: string | null): Promise<{ updated: boolean }> {
    return data(
      api.put<{ updated: boolean }>(
        `/orders/${orderId}/reminder`,
        { remind_at: remindAt },
        { retry: 'never' },
      ),
    );
  },
};

export type { Order };

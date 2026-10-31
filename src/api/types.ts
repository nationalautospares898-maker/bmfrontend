/**
 * Domain types, **derived** from the generated schema.
 *
 * Nobody hand-writes a request or response field name (ADR-029). Everything below is an
 * alias into `generated/schema.d.ts`, which comes from the backend's OpenAPI document
 * via `npm run api:types`. If the backend renames a field, the alias still resolves but
 * every consumer stops compiling — which is the point.
 *
 * The backend publishes these response shapes from `api/v1/schemas/responses.py`, and a
 * backend contract test validates **real** responses against them, so a shape here that
 * compiles is a shape the server actually sends.
 */

import type { components } from './generated/schema';

type Schemas = components['schemas'];

// --- catalog ------------------------------------------------------------------

export type Product = Schemas['ProductOut'];
export type ProductSearchResult = Schemas['ProductSearchOut'];
export type Unit = Schemas['UnitOut'];
export type MatchInfo = Schemas['MatchOut'];
export type Named = Schemas['NamedOut'];
export type ProductCreateRequest = Schemas['ProductCreateRequest'];
export type ProductUpdateRequest = Schemas['ProductUpdateRequest'];

// --- drafts -------------------------------------------------------------------

export type ServerDraft = Schemas['DraftOut'];
export type ServerDraftItem = ServerDraft['items'][number];
export type DraftListResponse = Schemas['DraftListOut'];
export type DraftUpsertRequest = Schemas['DraftUpsertRequest'];

// --- sales --------------------------------------------------------------------

export type FinalizeRequest = Schemas['FinalizeRequest'];
export type FinalizeResponse = Schemas['FinalizeOut'];
export type SaleLineIn = Schemas['SaleLineIn'];
export type SaleHeaderIn = Schemas['SaleHeaderIn'];
export type CustomerSelectionIn = Schemas['CustomerSelectionIn'];
export type PaymentIn = Schemas['PaymentIn'];

// --- invoices -----------------------------------------------------------------

export type Invoice = Schemas['InvoiceOut'];
export type InvoiceItem = Invoice['items'][number];
export type InvoiceListResponse = Schemas['InvoiceListOut'];
export type InvoiceSummary = InvoiceListResponse['items'][number];
export type CancelResponse = Schemas['CancelOut'];

/**
 * The printed bill's content, decided entirely by the server.
 *
 * ⚠️ There is **no invoice-number field in this type**, because there is none in the
 * payload (OD-3). The client renders this verbatim and invents nothing.
 */
export type PrintPayload = Schemas['PrintPayloadOut'];
export type PrintLine = PrintPayload['lines'][number];
export type PrintTotals = PrintPayload['totals'];
export type PrintBusiness = Schemas['PrintBusinessOut'];
export type PrintCustomer = Schemas['PrintCustomerOut'];

// --- credit -------------------------------------------------------------------

export type PaymentResponse = Schemas['PaymentOut'];
export type PaymentRequest = Schemas['PaymentRequest'];
export type ReversalResponse = Schemas['ReversalOut'];
export type CreditCustomersResponse = Schemas['CreditCustomersOut'];
export type PaymentHistoryList = Schemas['PaymentHistoryListOut'];
export type PaymentHistoryEntry = Schemas['PaymentHistoryOut'];
export type CreditCustomer = CreditCustomersResponse['items'][number];

// --- customers ----------------------------------------------------------------

export type CustomerUpsertRequest = Schemas['CustomerUpsertRequest'];
/**
 * `GET /customers` — the directory, and `GET /customers/search`.
 *
 * Hand-written rather than derived from the generated schema because both routes are
 * declared `-> dict[str, Any]` on the server, so the published contract carries no
 * response shape to derive from. `customers.search` already had a hand-written type for
 * the same reason — and it was **wrong**, declaring `phone` where the API sends
 * `primary_phone`, which nothing caught because its only caller reads `items.length`.
 *
 * Distinct from `CreditCustomer`, which comes from `/credit/customers` and exists only
 * for customers holding credit invoices.
 */
export interface DirectoryCustomer {
  id: string;
  name: string;
  business_name: string | null;
  primary_phone: string | null;
  phones: string[];
  vehicles: string[];
  address_lines: string[];
  default_mechanic_name: string | null;
  credit_terms_days: number | null;
  credit_limit: string | null;
  is_active: boolean;
  /** Present only with `credit.read`. */
  credit?: { outstanding: string; oldest_due_date: string | null };
}

/**
 * `PUT /customers/{id}` — the real response shape.
 *
 * The client declared `{ id: string }`, which the server never sends: it returns the
 * saved customer, whether it was created, and any warnings. Nothing caught it because
 * the only caller ignored the return value — so `CUSTOMER_DUPLICATE_SUSPECTED` was
 * being delivered and discarded.
 */
export interface CustomerUpsertResponse {
  customer: DirectoryCustomer;
  created: boolean;
  warnings: Warning[];
}

export interface CustomerListResponse {
  items: DirectoryCustomer[];
  page: { next_cursor: string | null; has_more: boolean; limit: number };
}

// --- sync and bootstrap -------------------------------------------------------

export type Bootstrap = Schemas['BootstrapOut'];
export type ServerMoneyPolicy = Schemas['MoneyPolicyOut'];
export type CatalogDelta = Schemas['CatalogDeltaOut'];
export type CachedProduct = CatalogDelta['products'][number];
export type SyncBatchRequest = Schemas['SyncBatchRequest'];
export type SyncBatchResponse = Schemas['SyncBatchOut'];
export type SyncOperationResult = SyncBatchResponse['results'][number];
export type SyncOperationIn = Schemas['SyncOperationIn'];
export type OperationTypes = Schemas['OperationTypesOut'];

// --- auth ---------------------------------------------------------------------

export type LoginRequest = Schemas['LoginRequest'];
export type SessionResponse = Schemas['SessionOut'];
export type MeResponse = Schemas['MeOut'];

// --- reports ------------------------------------------------------------------

export type Report = Schemas['ReportOut'];
/** GET /reports/daily-sales — the one report a screen renders field by field. */
export type DailySales = Schemas['DailySalesOut'];

// --- stock (M25) --------------------------------------------------------------

export type StockBalances = Schemas['StockBalancesOut'];
export type StockBalance = StockBalances['items'][number];
export type StockMovements = Schemas['StockMovementsOut'];
export type StockMovement = StockMovements['items'][number];

// --- purchases (M25) ----------------------------------------------------------

export type SupplierList = Schemas['SupplierListOut'];
export type Supplier = SupplierList['items'][number];
export type PurchaseList = Schemas['PurchaseListOut'];
export type PurchaseSummary = PurchaseList['items'][number];

// --- imports (M23/M25) --------------------------------------------------------

export type ImportUpload = Schemas['ImportUploadOut'];
export type ImportJob = Schemas['ImportJobOut'];
export type ImportJobs = Schemas['ImportJobsOut'];
export type ImportRows = Schemas['ImportRowsOut'];
/**
 * One schema, not two. FastAPI used to publish `…Out-Input` and `…Out-Output` for any
 * model carrying a money or quantity field, because the value is a decimal on the way in
 * and a **string** on the way out (ADR-013); a client only ever saw the output shape.
 * FastAPI 0.141 unifies the pair when the two shapes agree, so the suffix is gone from
 * the generated contract for all 18 models that had it. The published field types are
 * unchanged — only the schema *name* was ever split.
 */
export type ImportRow = Schemas['ImportRowOut'];
export type ImportReport = Schemas['ImportReportOut'];

// --- warnings -----------------------------------------------------------------

/**
 * Rides along with a **successful** response. Handled permissively — a new warning code
 * must never break a completed sale (§4.1).
 */
export type Warning = Schemas['WarningOut'];

// --- counter administration (C-2) ---------------------------------------------

export type Counter = Schemas['CounterOut'];
export type CounterDevice = Schemas['CounterDeviceOut'];
export type AdminDevice = Schemas['DeviceOut'];

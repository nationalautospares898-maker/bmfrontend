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
export type CreditCustomer = CreditCustomersResponse['items'][number];

// --- customers ----------------------------------------------------------------

export type CustomerUpsertRequest = Schemas['CustomerUpsertRequest'];

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

// --- warnings -----------------------------------------------------------------

/**
 * Rides along with a **successful** response. Handled permissively — a new warning code
 * must never break a completed sale (§4.1).
 */
export type Warning = Schemas['WarningOut'];

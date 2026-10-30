# API Integration — `bmfrontend`

> **Current Phase 2 design disposition (2026-10-30):** [Backend Design Completion Addendum](../../bmbackend/docs/PHASE-2-DESIGN-COMPLETION-ADDENDUM-2026-10-30.md) is the current cross-cutting decision record. It resolves superseded open labels and defines the Phase 3 implementation baseline. Historical closure reports/addenda remain unchanged; legal, physical and operational gates remain gates. It does not represent implementation or test completion.


| Field | Value |
|---|---|
| Status | **Phase 1 proposal — no client code exists yet** |
| Authoritative contract | **`../../bmbackend/docs/API-SPECIFICATION.md`** |
| Last updated | 2026-10-29 |

> **This document describes how the client consumes the contract. It does not define the contract.**
> If anything here disagrees with `../../bmbackend/docs/API-SPECIFICATION.md`, the backend document
> wins and this one is corrected. The client must never invent an endpoint, a field, or an error
> code, and must never assume a behaviour the backend has not documented (ADR-021).

---

## 1. Ground rules

| # | Rule |
|---|---|
| 1 | **The server is the authority on money, stock, permissions and totals.** The client computes previews only (ADR-032). |
| 2 | **API types are generated** from the backend OpenAPI document. Nobody hand-writes a request or response field name (ADR-029). |
| 3 | JSON is **`snake_case`** (ADR-012). Money and quantities are **strings** (ADR-013). |
| 4 | Clients branch on `error.code`, **never** on `error.message`. |
| 5 | A mutating `POST` is retried **only** when it was sent with an `Idempotency-Key`, and only with the same key. |
| 6 | No business rule is reimplemented client-side to "save a round trip". |
| 7 | The access token lives in memory. **Never** `localStorage`/`sessionStorage`. |
| 8 | Only `VITE_API_BASE_URL` and public flags exist as configuration. No secrets, ever. |

---

## 2. Type generation

```bash
# regenerate after any backend contract change
npm run api:types      # openapi-typescript <API>/api/v1/openapi.json -o src/api/generated/schema.d.ts
```

- `src/api/generated/schema.d.ts` is **committed** (so builds are reproducible offline) and **never
  hand-edited**. A CI check regenerates it against the staging OpenAPI document and fails on a diff
  — which is how a silent contract drift gets caught before it reaches the counter.
- `src/api/endpoints/*.ts` are thin typed wrappers over `client.ts`, one file per resource.
- Domain types used in UI code are derived from generated types, not re-declared:

```ts
import type { components } from '@/api/generated/schema';
export type Invoice      = components['schemas']['InvoiceResponse'];
export type ProductHit   = components['schemas']['ProductSearchItem'];
export type PrintPayload = components['schemas']['PrintPayload'];
```

---

## 3. The API client

```ts
// src/api/client.ts (illustrative shape)
interface RequestOptions {
  idempotencyKey?: string;    // required by the caller for financial POSTs
  ifMatch?: number;           // draft version
  signal?: AbortSignal;
  retry?: 'auto' | 'never';   // 'auto' is only honoured with an idempotency key
}
```

### 3.1 Request pipeline

```
caller
  → attach Authorization: Bearer <in-memory access token>
  → attach X-Device-Id (from Dexie meta), X-Counter-Id (active counter)
  → attach X-Request-Id (new UUID per attempt)
  → attach Idempotency-Key / If-Match when supplied
  → fetch(credentials: 'include')        // refresh cookie rides along
  → 2xx         → parse, return typed body
  → 401         → single shared refresh → retry once → else logout prompt
  → other 4xx/5xx → parse error envelope → throw ApiError
  → network/abort/timeout → throw NetworkError (retryable: true)
```

### 3.2 Headers the client always sends

| Header | Value |
|---|---|
| `Authorization` | `Bearer <access token>` (omitted on login/refresh) |
| `X-Device-Id` | Stable UUIDv7 from Dexie `meta`, generated once per browser profile |
| `X-Counter-Id` | Active counter (billing, draft, sale, payment calls) |
| `X-Request-Id` | Fresh UUID **per attempt** — so each retry is traceable separately |
| `Idempotency-Key` | **Stable across retries of one user intent** (§5) |
| `If-Match` | Draft `version` on draft updates |
| `Content-Type` | `application/json`, or `multipart/form-data` for uploads |

Note the deliberate asymmetry: `X-Request-Id` changes every attempt (for log correlation),
`Idempotency-Key` does not (for correctness). Confusing the two is the single most likely way to
create a duplicate invoice.

### 3.3 Error types

```ts
class ApiError extends Error {
  code: ErrorCode;             // union generated from the backend registry
  status: number;
  details?: unknown;
  requestId: string;
  retryable: boolean;
}
class NetworkError extends Error { retryable = true as const; }
```

`ErrorCode` is a **generated union** of every code in
`../../bmbackend/docs/API-SPECIFICATION.md §4.2` — **53 codes** as of Phase 2 closure. Feature code
handles it with an exhaustive `switch`, so adding a backend code produces a TypeScript error until
the client handles it — this is the mechanism behind FBO-5 ("errors are actionable"), not a promise
to be careful.

> **Phase 2 closure (audit CF-3).** Four codes required by the sync specification —
> `PRECONDITION_REQUIRED`, `SKIPPED_AFTER_EARLIER_FAILURE`, `CORRUPT_VERSION`,
> `DRAFT_ALREADY_CANCELLED` — were **missing** from the registry, so this generated union could not
> contain them and the exhaustive `switch` could not handle behaviour the protocol requires. They are
> now registered (`API-SPECIFICATION.md §4.2a`) and appear in §4 below. Two of them
> (`SKIPPED_AFTER_EARLIER_FAILURE`, `CORRUPT_VERSION`) arrive as **per-operation outcomes inside a
> `200` sync batch**, not as HTTP errors — the client branches on `code` identically in both cases.

---

## 4. Error code → client behaviour

Full UI presentation in `docs/UI-UX-SPECIFICATION.md §9`; mechanics here.

| Code | Retry? | Client behaviour |
|---|---|---|
| `INVALID_CREDENTIALS` | no | Inline login error |
| `ACCOUNT_LOCKED` | no | Countdown from `retry_after_seconds` |
| `USER_INACTIVE` | no | Blocking message |
| `TOKEN_EXPIRED` | **auto** | Transparent refresh + one retry |
| `REFRESH_TOKEN_REUSED` | no | Force logout, **keep drafts**, report to error tracking |
| `DEVICE_REVOKED` | no | Blocking screen, stop sync, **never delete local data** |
| `DEVICE_NOT_REGISTERED` | no | Re-register the device via login |
| `PERMISSION_DENIED` | no | Explain + supervisor authorisation path |
| `BRANCH_SCOPE_INVALID` | no | Re-fetch bootstrap, prompt branch selection |
| `RATE_LIMITED` | **auto** | Backoff from `Retry-After`; silent for search, explicit for login |
| `VALIDATION_ERROR` | no | Map `details.fields` to form fields |
| `NOT_FOUND` | no | "This record no longer exists" + refresh the list |
| `DRAFT_VERSION_CONFLICT` | no | Conflict dialog with `details.current_state` |
| `DRAFT_LIMIT_REACHED` | no | Explain limit, list open bills |
| `DRAFT_ALREADY_FINALIZED` | **never** | Show the existing invoice. **No retry affordance at all.** |
| `DRAFT_OWNED_BY_OTHER_COUNTER` | no | Explain; offer takeover if permitted |
| `INSUFFICIENT_STOCK` | no | Shortfall panel with per-line "use available" |
| `OVERSELL_NOT_PERMITTED` | no | Supervisor authorisation |
| `OVERSELL_REASON_REQUIRED` | no | Focus the reason field, state the 10-char minimum |
| `PRICE_CHANGED` | no | Price-diff panel; accept or keep editing. **Never auto-accept.** |
| `PRICE_OVERRIDE_NOT_PERMITTED` | no | Revert the cell, offer supervisor path |
| `DISCOUNT_EXCEEDS_LIMIT` | no | State the cap inline |
| `PRODUCT_INACTIVE` | no | Flag the line, offer removal |
| `TOTAL_MISMATCH` | no | Refetch the draft, warn, **do not resubmit automatically** |
| `EMPTY_SALE` | no | Should be prevented client-side; log as a client bug if seen |
| `CREDIT_CUSTOMER_REQUIRED` | no | Focus customer selection |
| `CREDIT_LIMIT_EXCEEDED` | no | Show figures; override where permitted |
| `IDEMPOTENCY_KEY_REUSE` | no | **Client bug** — report to error tracking, reload the bill from the server |
| `IDEMPOTENT_REQUEST_IN_PROGRESS` | **auto** | Stay busy, retry same key with backoff from `retry_after_ms` |
| `INVOICE_ALREADY_CANCELLED` | no | Refresh the row |
| `CANCEL_WINDOW_EXPIRED` | no | Explain; suggest a return/credit note |
| `OVER_ALLOCATION` | no | Show remaining allocatable amount |
| `PAYMENT_ALREADY_REVERSED` | no | Refresh the payment row; no second reversal is offered |
| `RETURN_QUANTITY_EXCEEDED` | no | Show remaining returnable per item |
| `RETURN_WINDOW_EXPIRED` | no | Explain the window; suggest a reasoned adjustment instead |
| `INVOICE_CANCELLED` | no | "This bill was cancelled — a return cannot be recorded against it" |
| `DUPLICATE_SKU` / `DUPLICATE_BARCODE` | no | Link to the conflicting product |
| `DUPLICATE_SUPPLIER_DOCUMENT` | no | Link to the existing receipt |
| `DUPLICATE_FILE` | no | Show the existing job; require an explicit reason to proceed |
| `IMPORT_ROWS_PENDING_DECISION` | no | Filter the review table to undecided rows |
| `IMPORT_ALREADY_APPLIED` | no | Navigate to the report |
| `UNSUPPORTED_FILE_TYPE` / `FILE_TOO_LARGE` | no | State accepted types and the size cap |
| `TAX_CONFIG_INCOMPLETE` | no | Render `details.missing` as a checklist |
| `SYNC_CURSOR_EXPIRED` | **auto** | Clear `catalog_cache`, re-pull from scratch |
| `SYNC_BATCH_TOO_LARGE` | **auto** | Split the batch and resend |
| `PRECONDITION_REQUIRED` | no | **Client bug** (missing `If-Match` on an existing draft) — report to error tracking, refetch the draft. **Never** retry blindly |
| `SKIPPED_AFTER_EARLIER_FAILURE` | no | Per-operation outcome in a `200` sync batch: an earlier operation for the **same entity** failed. Keep queued; retry only after the user resolves that conflict. Other entities are unaffected |
| `CORRUPT_VERSION` | no | Per-operation `rejected`: local `base_version` exceeds the server's — impossible normally. Surface in the Sync panel as needing attention and report to error tracking. **Never** auto-retry |
| `DRAFT_ALREADY_CANCELLED` | no | The draft was cancelled server-side. Offer **"recreate as a new bill"** with a fresh id so the typed lines are not lost |
| `INTERNAL_ERROR` | no | Friendly message + copyable `request_id` |
| `SERVICE_UNAVAILABLE` | **auto** | Outbox/pending-finalisation retry with backoff |

### 4.1 Warnings — successful responses that still have something to say

A `201` from `POST /sales:finalize` may include a `warnings` array
(`../../bmbackend/docs/API-SPECIFICATION.md §3.3`). Warnings are **not** errors: the sale committed.
They are shown on the confirmation card, never as a blocking panel.

| Warning code | Client behaviour |
|---|---|
| `LOW_STOCK_AFTER_SALE` | Note on the confirmation card listing the affected products and their new quantities, so the counter knows to reorder |

Unknown warning codes are rendered from their `message` and logged — a new warning must never break
a completed sale, which is why warnings are handled permissively while errors are handled
exhaustively.

---

## 5. Idempotency — the most important client rule

**One user intent = one key. Every retry of that intent reuses it. A new key is minted only when the
user changes the bill.**

```ts
// features/billing/finalize.ts (illustrative)
async function startFinalization(draft: Draft) {
  // 1. mint the key ONCE and persist it BEFORE the first request
  const key = draft.finalization?.idempotency_key ?? uuidv7();
  await db.pending_finalizations.put({
    draft_id: draft.id, idempotency_key: key, started_at: serverNow(),
    payload_hash: hashPayload(draft)
  });

  // 2. every attempt — first and all retries — uses the SAME key
  return attempt(key);
}

function onDraftEdited(draft: Draft) {
  // 3. the intent changed, so the old key must not be reused
  db.pending_finalizations.delete(draft.id);
}
```

| Endpoint | Key required | Key lifetime |
|---|---|---|
| `POST /sales:finalize` | **yes** | Until the sale resolves or the bill is edited |
| `POST /payments`, `/payments/{id}:reverse` | **yes** | Until the dialog resolves |
| `POST /returns` | **yes** | Until resolved |
| `POST /purchases/{id}:confirm` | **yes** | Until resolved |
| `POST /inventory/adjustments` | **yes** | Until resolved |
| `POST /invoices/{id}:cancel` | **yes** | Until resolved |
| `POST /imports/{id}:apply` | **yes** | Until resolved |
| `PUT /drafts/{id}`, `PUT /customers/{id}` | no | Naturally idempotent via the client-generated id |
| `POST /sync/operations` | per-operation `op_id` | Until acknowledged |

**Persist the key before the first request**, not after. If the browser dies between sending and
receiving, the key must already be on disk or the retry becomes a duplicate sale (E-2).

---

## 5A. Credit sales and the Credit Bills view

Added 2026-10-29 for the owner-confirmed credit workflow
([OD-21](../../bmbackend/docs/OWNER-DECISIONS.md#od-21), ADR-033). **No new client-side concepts** —
the credit path reuses the contracts already described above.

### 5A.1 Finalising a credit sale

```ts
// features/billing/finalize.ts — the SAME call as a cash sale
await api.post('/sales:finalize', {
  draft_id, draft_version, counter_id,
  sale_type: 'credit',                       // ← the only structural difference
  customer: { mode: 'existing', customer_id },// ← REQUIRED for credit (FR-CREDIT-009)
  header: { /* optional values the cashier typed — always sent if present */ },
  lines: [...],
  payment: null,                              // ← optional for credit; omitted at save time
  client_computed_total,
}, { idempotencyKey: key });                  // ← same key discipline as cash (§5)
```

Rules:
- **One request, no intermediate call.** There is no "prepare credit sale" endpoint and no
  credit-details step. Pressing **`Credit Bill`** finalises (FR-CREDIT-020).
- `customer.mode` must be `existing` or `new`; a free-text name alone is rejected with
  `409 CREDIT_CUSTOMER_REQUIRED`. For `new`, **only `name` is required** (FR-CUST-010).
- `payment` is **omitted** at save time — the invoice is simply `unpaid` (FR-CREDIT-025).
- **Idempotency works identically to a cash sale** (§5): one key per intent, reused on every retry,
  persisted before the first attempt. A credit sale can create a duplicate invoice just as easily as
  a cash one.
- **Every finalisation error applies** — `INSUFFICIENT_STOCK`, `PRICE_CHANGED`,
  `DRAFT_ALREADY_FINALIZED`, `TOTAL_MISMATCH` — handled exactly as in §4.
- **Offline: refused.** The client creates nothing — no key, no `pending_finalizations` row, no
  queued operation (§8.4, FR-OFFLINE-002).
- No print dialog opens on success; the response is rendered as a confirmation card.

### 5A.2 Reading Credit Bills — two levels, two existing shapes

```
GET /credit/customers?include_settled=&ageing_bucket=&query=&cursor=   ← level 1 (new endpoint)
GET /invoices?customer_id=<id>&is_credit=true&cursor=                  ← level 2 (existing)
GET /payments?invoice_id=<id>                                          ← history (existing)
```

- Level 1 returns customers with **server-computed** aggregates (`outstanding`, ageing buckets) plus
  an overall `summary`. **The client never sums these itself** (FR-RPT-030, ADR-032).
- Level 2 reuses the invoice list endpoint — no new contract was introduced for per-customer
  invoices.
- Grouping keys on `customer_id`; the `name` is a display label only (FR-RPT-029).
- `include_settled=true` shows customers at zero balance; their history is never hidden permanently
  (FR-RPT-031).

Query keys:

```ts
['credit','customers', filters]                 staleTime 30s
['invoices', { customer_id, is_credit: true }]  staleTime 15s
['payments', { invoice_id }]                    staleTime 30s
```

After a successful credit finalisation or a recorded payment, invalidate `['credit','customers']`,
`['invoices']`, `['credit','outstanding']`, `['inventory','balances']` and `['reports']`.

### 5A.3 Recording a payment

`POST /payments` with an `Idempotency-Key` (§5). **It never moves stock** — payment collection and
sale finalisation are distinct events (FR-CREDIT-010). Over-allocation returns
`422 OVER_ALLOCATION`; the dialog shows the remaining allocatable amount rather than guessing.
**Payment is never available offline and never enters the sync queue** (§8).

---

## 6. Optimistic concurrency on drafts

```
PUT /api/v1/drafts/{id}
If-Match: 3
→ 200 { version: 4, ... }                     // applied
→ 409 DRAFT_VERSION_CONFLICT                   // details.current_state + current_version
→ 428 PRECONDITION_REQUIRED                    // client bug: missing If-Match on an existing draft
```

Client rules:
- `version` is stored per draft in Dexie; `null` means "never synced", and the create path omits
  `If-Match`.
- On `409`: **do not retry automatically.** Store `sync.conflict = details.current_state`, mark the
  draft `conflict`, badge the tab, and open the resolution dialog when the user goes to that bill.
- "Keep mine" re-sends with the server's `current_version` as the new `base_version`.
- "Keep theirs" replaces the local draft with `current_state`.
- `428` is a client bug: report it and refetch.

---

## 7. Retry and backoff policy

| Request class | Policy |
|---|---|
| `GET` (queries) | TanStack Query: 2 retries on network/5xx, exponential backoff; **no retry on 4xx** |
| `GET /products/search` | **No retry** — the user is typing; a stale retry is worse than a quick "Retry" affordance |
| `POST` with idempotency key | Retry on `NetworkError`, 503, 502, 504, `IDEMPOTENT_REQUEST_IN_PROGRESS`: 1 s → 2 s → 5 s → 15 s → 60 s → 5 min, with jitter |
| `POST` without a key | **Never** retried automatically |
| Any 4xx (except the auto list in §4) | Never retried |
| Sync batch | Scheduler backoff (§8); `rejected` operations are **never** auto-retried |

Timeouts: 10 s for search and reads, **30 s for finalisation** (a slow commit is still a commit —
aborting early just manufactures the lost-response case), 60 s for uploads.

---

## 8. Offline synchronisation (client side)

Protocol: `../../bmbackend/docs/OFFLINE-SYNCHRONIZATION.md`. Client responsibilities:

### 8.1 Outbox

```ts
interface OutboxOp {
  op_id: string;              // UUIDv7, generated once, never changed
  client_seq: number;         // monotonic per device, from Dexie meta
  type: 'draft.upsert' | 'draft.delete' | 'customer.upsert';
  entity_type: 'draft_bill' | 'customer';
  entity_id: string;
  base_version: number | null;
  client_created_at: string;
  payload: unknown;
  status: 'queued' | 'in_flight' | 'conflicted' | 'rejected';
  attempts: number;
}
```

- **Coalescing:** repeated `draft.upsert` for the same draft while still `queued` collapse to the
  latest payload (keeping the original `op_id`), so a minute of typing is one operation, not sixty.
- Batches of ≤ 100, ordered by `client_seq`, grouped so one entity's operations stay in order.
- `accepted`/`replayed` → delete from the outbox and adopt `server_state`.
- `conflicted` → mark the draft, keep the operation for the user to resolve.
- `rejected` → surface in the Sync panel until acknowledged. **Never silently dropped.**

### 8.2 Scheduler triggers (FR-OFFLINE-012)

1. `online` event
2. Visibility / focus
3. Timer — 30 s while the outbox is non-empty, 5 min idle
4. After each local mutation, debounced 500 ms
5. Explicit "Try now"
6. Background Sync **if available** — an extra trigger only, never the only one

Only the **owner tab** (Web Lock, `ARCHITECTURE.md §7.1`) runs the scheduler.

### 8.3 Catalog cache

```
GET /api/v1/sync/catalog?since=<cursor>&limit=500
→ upsert products/aliases/stock into Dexie, store next_cursor in meta
→ reset_required: true → clear catalog_cache and re-pull from scratch
```

- Refreshed on login, on reconnect, and every 30 minutes while online.
- Respects the server's `cache_policy.max_rows` — the client never tries to pull the full catalog.
- `cost_price` is never present and must never be cached even if it somehow appeared.
- Every rendered price or stock figure from the cache carries its `as_of` (FR-OFFLINE-009).

### 8.4 Pending finalisations — a separate queue (ADR-010)

Stored in `pending_finalizations`, **never** in the outbox, because an outbox operation is always
safe to replay offline while a finalisation may already have charged the customer.

- Created **only** while online. There is no code path that creates one offline (FR-OFFLINE-002).
- Retried with the same key on reconnect/focus/timer/manual.
- Auto-retry stops after `finalization_stale_minutes` (default 60) and asks the user to check Daily
  Bills.
- Surfaced as the loudest UI state in the app (`UI-UX-SPECIFICATION.md §4.9`).

---

## 9. Authentication flow

```
app load
  → load drafts from Dexie            // ALWAYS first; drafts never depend on auth
  → POST /auth/refresh (cookie)
       ├─ 200 → store access token in memory → GET /sync/bootstrap → render app
       └─ 401 → render login

login
  → POST /auth/login { username, password, device: { id, label } }
  → access token in memory; refresh cookie set by the server
  → GET /sync/bootstrap → branch, counter, permissions, settings, server time, catalog cursor

on 401 during any request
  → one shared refresh promise (concurrent 401s await it)
       ├─ success → retry the original request once
       └─ failure → prompt login, KEEP DRAFTS
```

Rules:
- Access token in a module variable. **Never** persisted (NFR-FE-SEC-002).
- One in-flight refresh at a time — concurrent refreshes would trip the server's reuse detection and
  log the user out.
- `GET /sync/bootstrap` provides `max_open_drafts`, `tax.mode`, rounding policy and discount caps, so
  the client never hardcodes a business rule.
- Server time from bootstrap establishes a clock offset used for display; the client never derives a
  business date (FE-E-3).
- Logout prompts if drafts are unsynced and **does not clear Dexie** — bills belong to the shop, not
  the session.

---

## 10. Query keys and cache policy

```ts
['products','search', query, branchId]          staleTime 30s   gcTime 5m
['product', productId]                          staleTime 60s
['drafts', counterId]                           — Dexie-backed, not a query
['invoices', filters]                            staleTime 15s
['invoice', invoiceId]                          staleTime ∞ (immutable)
['print-payload', invoiceId, copy]              staleTime ∞ (immutable)
['credit','outstanding', filters]               staleTime 30s
['customer', customerId, 'ledger']              staleTime 30s
['reports', name, params]                       staleTime 60s
['inventory','balances', branchId, filters]     staleTime 30s
['auth','me']                                   staleTime 5m
['meta']                                        staleTime 5m, refetch on focus
```

- **Invoices and print payloads are immutable, so `staleTime: Infinity`** — a reprint can never show
  different figures from the original.
- Invalidation after a successful finalisation: `['invoices']`, `['credit','outstanding']`,
  `['inventory','balances']`, `['reports']`.
- **No optimistic updates on financial data.** Stock, totals and payment status are only ever
  rendered from a server response. Optimism belongs to drafts, which are local anyway.

---

## 11. File upload (imports)

```ts
const form = new FormData();
form.append('file', file);
form.append('intent', 'purchase_receipt');   // or 'price_list' — explicit, never inferred
form.append('supplier_id', supplierId);      // required for purchase_receipt
form.append('branch_id', branchId);
```

- Client-side pre-checks mirror the server's and **never replace** them: extension in
  `.xlsx/.csv/.pdf`, size under the cap from bootstrap. Failing fast is a courtesy; the server
  decides.
- Upload progress via `XMLHttpRequest` (fetch lacks upload progress).
- `409 DUPLICATE_FILE` → show the existing job; proceeding requires `allow_duplicate` **and** a
  typed reason.
- After upload, poll `GET /imports/{id}` (2 s while `parsing`/`applying`, stop on a terminal state).
- **Upload is disabled offline** — no queuing of binary payloads.

---

## 12. Request tracing

- `X-Request-Id` per attempt, surfaced in error UI as a copyable code so the owner can read it to
  support (`UI-UX-SPECIFICATION.md §9.5`).
- Error reports include `request_id`, error `code`, route and build version — **never** token,
  password, PIN or full request body.
- The client logs no PII to the console in production.

---

## 13. Contract-change protocol

When the backend changes the API:

1. Backend updates `../../bmbackend/docs/API-SPECIFICATION.md` (including the error registry).
2. Frontend runs `npm run api:types` and commits the regenerated schema.
3. New error codes cause **compile errors** at the exhaustive switches until handled — intentionally.
4. If the change is shared-ADR-worthy, both repositories get a matching ADR entry in the same change
   set (ADR-021).
5. `GET /api/v1/meta` carries the API version; the client warns when a cached build is older than
   the server expects (FE-E-4).
6. Breaking changes mean `/api/v2`; the client pins its version and both are served during migration.

**The frontend never "temporarily" adds a field, endpoint or error code that the backend has not
documented.** If something is needed, it is a backend change first.

---

## 14. What the client must never do

- Compute an authoritative total, tax figure, outstanding balance or stock number.
- Decide whether a sale is allowed — only render what the server decided.
- Retry a keyless mutating request.
- Generate, guess, or display an invoice number the server did not return.
- Print an invoice for an unconfirmed sale (counter slip only).
- Cache an API response in the service worker.
- Store a token outside memory.
- Hardcode a business rule that bootstrap provides (`max_open_drafts`, `tax.mode`, discount caps,
  rounding).
- Render a cost price or margin.
- Hand-edit `src/api/generated/schema.d.ts`.
- Call an endpoint not present in `../../bmbackend/docs/API-SPECIFICATION.md`.

---

## 15. Related documents

`docs/PRD.md` · `docs/ARCHITECTURE.md` · `docs/UI-UX-SPECIFICATION.md` ·
`docs/TESTING-STRATEGY.md` · `docs/DECISIONS.md` ·
**`../../bmbackend/docs/API-SPECIFICATION.md`** *(authoritative)* ·
**`../../bmbackend/docs/OFFLINE-SYNCHRONIZATION.md`** *(authoritative)*

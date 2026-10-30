# Frontend Architecture — `bmfrontend`

| Field | Value |
|---|---|
| Status | **Phase 1 proposal — no code exists yet** |
| Last updated | 2026-10-29 |
| Decisions | `docs/DECISIONS.md` (ADR-023…032) and `../../bmbackend/docs/DECISIONS.md` (shared ADRs) |

> **Verified repository state (2026-10-29).** `bmfrontend/` was an **empty directory**. It is not a
> Git repository and contains no source, `package.json`, configuration or documentation other than
> what Phase 1 creates. **Nothing below describes existing code** — every technology choice is a
> recommendation to be approved before Phase 2.

---

## 1. Shape of the application

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Browser (Chrome/Edge at the shop counter)                               │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  React app (SPA)                                                     │ │
│  │                                                                      │ │
│  │   routes/        BillingCounter, DailyBills, CreditBills, Stock, …   │ │
│  │   features/      billing/ catalog/ credit/ stock/ imports/ reports/  │ │
│  │   components/    shared primitives (Button, Table, Field, …)         │ │
│  │                                                                      │ │
│  │   ┌──────────────┐  ┌────────────────┐  ┌────────────────────────┐  │ │
│  │   │ TanStack     │  │ Zustand         │  │ Dexie (IndexedDB)      │  │ │
│  │   │ Query        │  │ draft store +   │  │ drafts, draft_items,   │  │ │
│  │   │ server state │  │ UI state        │  │ outbox,                │  │ │
│  │   │ (cache)      │  │ (authoritative  │  │ pending_finalizations, │  │ │
│  │   │              │  │  while offline) │  │ catalog_cache, meta    │  │ │
│  │   └──────┬───────┘  └────────┬────────┘  └───────────┬────────────┘  │ │
│  │          │                   │                        │               │ │
│  │          └───────────────────┴────────────┬───────────┘               │ │
│  │                                            │                           │ │
│  │                              ┌─────────────▼──────────────┐           │ │
│  │                              │  apiClient                  │           │ │
│  │                              │  auth, idempotency, retry,  │           │ │
│  │                              │  error envelope, request-id │           │ │
│  │                              └─────────────┬──────────────┘           │ │
│  └────────────────────────────────────────────┼──────────────────────────┘ │
│                                                │                            │
│  ┌─────────────────────────────────────────────▼──────────────────────────┐ │
│  │  Service worker (Workbox) — app shell precache, nothing else cached    │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────┬──────────────────────────┘
                                                 │ HTTPS /api/v1
                                   ┌─────────────▼──────────────┐
                                   │  bmbackend (separate repo)  │
                                   └─────────────────────────────┘
```

**One deliberate structural decision governs everything else:** drafts are owned by
**IndexedDB + Zustand**, not by the server-state cache. A draft must survive offline, so it cannot
live in a query cache keyed to a network response (ADR-025).

---

## 2. Recommended stack

All items are **proposals**; nothing is verified from the repository because the repository was empty.

| Concern | Choice | Why | Alternative considered |
|---|---|---|---|
| Framework | React 19 + TypeScript (`strict`) | Largest ecosystem for the primitives needed (virtualised tables, forms); team familiarity | Vue, Svelte — fine technically, smaller hiring/ecosystem advantage |
| Build | Vite 6 | Fast dev, simple PWA plugin, good code splitting | Next.js — SSR adds nothing here; this is an authenticated desktop tool, not a public site |
| Routing | React Router (data router) | Nested layouts, deep links (FR-NAV-005), lazy routes | TanStack Router |
| Server state | TanStack Query v5 | Caching, retries, invalidation, request dedup — exactly the hard parts | Hand-rolled fetch hooks |
| Draft/UI state | Zustand | Small, no boilerplate, easy persistence bridge to Dexie | Redux Toolkit (heavier), Context (re-render problems at 20 drafts) |
| Local persistence | Dexie (IndexedDB) | Transactions, indexes, typed schema, well-tested | `localStorage` (synchronous, 5 MB, loses structure), raw IDB |
| PWA | `vite-plugin-pwa` + Workbox | Precaching the shell with a controlled update flow | Hand-written service worker |
| Styling | Tailwind CSS v4 | Fast, consistent spacing/typography by construction; trivial to keep restrained | CSS Modules, styled-components |
| Components | A **minimal** shadcn/ui subset, copied in and owned | Accessible primitives (dialog, popover, select) without a framework dependency | Full MUI/AntD — too opinionated, too heavy, too decorative |
| Forms | react-hook-form + Zod | Uncontrolled inputs keep a 20-line table fast; schema validation shared with API types | Formik |
| Decimal maths | `decimal.js-light` | **Mandatory** — money must never touch `parseFloat` (ADR-013) | `big.js`, native `Intl` only |
| API types | `openapi-typescript` from the backend OpenAPI document | Types cannot drift from the contract (ADR-029) | Hand-written interfaces |
| Table | TanStack Table (headless) | Keyboard nav and virtualisation when needed, no imposed markup | AG Grid — heavy, spreadsheet-like look we explicitly don't want |
| Tests | Vitest + React Testing Library + Playwright + axe-core + MSW | Unit → integration → E2E → a11y, with contract-level API mocking | Jest + Cypress |
| Lint/format | ESLint (typescript-eslint) + Prettier | Standard | Biome |

Verified present on the development machine: Node 24.11.0, npm 11.6.1, Git 2.47.1.

---

## 3. Directory layout (proposed)

```
bmfrontend/
├── package.json  vite.config.ts  tsconfig.json  tailwind.config.ts
├── playwright.config.ts  vitest.config.ts
├── docs/                              # this documentation set
├── public/                            # icons, manifest
└── src/
    ├── main.tsx                       # app bootstrap, providers
    ├── routes/                        # route components, lazy-loaded beyond billing
    │   ├── billing/                   # the primary screen
    │   ├── daily-bills/  credit-bills/
    │   ├── stock/  purchases/  customers/  imports/  reports/  settings/
    │   └── auth/
    ├── features/
    │   ├── billing/                   # draft store, tab strip, item table, totals, actions
    │   ├── catalog/                   # search box, product cache, product forms
    │   ├── credit/                    # Credit Bills (customer-wise), payment dialogs
│   │                              # NOTE: no credit-details step — `Credit Bill`
│   │                              # finalises directly from the billing screen (ADR-033)
    │   ├── sync/                      # outbox, scheduler, conflict UI, status indicator
    │   ├── print/                     # print root, invoice layout, counter slip
    │   └── <module>/{components, hooks, api, model}
    ├── api/
    │   ├── client.ts                  # fetch wrapper: auth, retry, idempotency, errors
    │   ├── generated/schema.d.ts      # from OpenAPI — never hand-edited
    │   ├── endpoints/                 # thin typed functions per resource
    │   └── errors.ts                  # error code → typed domain error
    ├── db/
    │   ├── schema.ts                  # Dexie tables and versions
    │   ├── drafts.ts  outbox.ts  catalogCache.ts  meta.ts
    │   └── migrations.ts
    ├── lib/
    │   ├── money.ts                   # the ONLY place decimal arithmetic happens
    │   ├── ids.ts                     # uuid v7 generation
    │   ├── keyboard.ts  format.ts  normalize.ts
    │   └── strings.ts                 # all user-facing text
    ├── components/                    # shared primitives
    ├── styles/
    │   ├── index.css                  # Tailwind + tokens
    │   └── print.css                  # @page and @media print — isolated
    └── test/                          # setup, MSW handlers, factories
```

---

## 4. State boundaries — the most important design decision

Four distinct kinds of state, with strict rules about which owns what.

| Kind | Owner | Persisted? | Authority |
|---|---|---|---|
| **Server state** | TanStack Query | No (memory cache) | The server. Products, invoices, customers, reports. |
| **Draft state** | Zustand + Dexie | **Yes (IndexedDB)** | The client while offline; reconciled with the server by version |
| **UI state** | Zustand / local component | No | The client. Active tab, focus, dialog open, filters. |
| **Session state** | In-memory module | **No — never persisted** | Access token, permissions, active branch/counter |

### 4.1 Rules

1. **A draft is never stored in the TanStack Query cache.** Query caches are keyed to responses and
   are cleared freely; a draft must survive offline. Drafts live in Dexie, mirrored into Zustand for
   rendering (ADR-025).
2. **Server state is never duplicated into Zustand.** Products, invoices and customers are read
   through queries so there is one cache, one invalidation story, no stale copies.
3. **The access token is never persisted.** Not `localStorage`, not Dexie, not a non-`HttpOnly`
   cookie (NFR-FE-SEC-002).
4. **Every write to a draft is a Dexie transaction first, then a store update.** If the browser dies
   between keystrokes, the last committed keystroke is on disk. Writes are debounced ~300 ms for
   text fields and immediate for structural changes (add/remove line).
5. **Computed values are derived, never stored.** Line totals and grand totals are selectors over
   draft state, so they cannot go stale.
6. **Server-confirmed money is never recomputed.** Once an invoice exists, its figures are displayed
   from the response verbatim.

### 4.2 Draft store shape

```ts
// features/billing/draftStore.ts  (illustrative)
type DraftId = string;                      // client-generated UUIDv7

interface DraftLine {
  id: string; line_no: number;
  product_id: string; product_name: string; sku: string | null; unit_code: string;
  quantity: string;                         // decimal STRING, never number
  unit_price: string;                       // decimal STRING
  catalog_price_at_add: string;
  price_source: 'catalog' | 'manual_override';
  discount_percent: string;
  known_stock: string | null; stock_as_of: string | null;
}

interface Draft {
  id: DraftId; label: string;
  version: number | null;                   // server version; null until first sync
  status: 'editing' | 'submitting' | 'unconfirmed' | 'conflict' | 'finalized';
  header: { customer_id: string | null; customer_name: string; customer_business_name: string;
            vehicle_number: string; mechanic_name: string; phone: string; notes: string;
            is_credit_intent: boolean };
  lines: DraftLine[];
  sync: { dirty: boolean; last_synced_at: string | null; conflict: ServerDraft | null };
  finalization: { idempotency_key: string; started_at: string } | null;
  invoice: Invoice | null;                  // set once finalised
}
```

**All money and quantity values are strings** end to end — from the API, through the store, into the
input, and back out (ADR-013). They are converted to `Decimal` only inside `lib/money.ts`.

---

## 5. Money handling

```ts
// lib/money.ts — the ONLY module that imports decimal.js-light
export const lineTotal = (qty: string, price: string, discountPct: string): string => …
export const sumAmounts = (values: string[]): string => …
export const formatAmount = (value: string): string => …   // display only
export const parseUserAmount = (input: string): string | null => …  // validation
```

Rules enforced by lint:
- `parseFloat`, `Number()`, `+`, `-`, `*` on a money or quantity value **outside `lib/money.ts`** is
  a lint error.
- `toFixed()` is never used for arithmetic, only inside `formatAmount`.
- Rounding matches the server's documented policy (half-up at line level, then sum —
  `../../bmbackend/docs/ARCHITECTURE.md §6.5`), so client previews and server totals agree. Any
  disagreement is a bug on one side, surfaced as `TOTAL_MISMATCH` rather than hidden.
- The client's total is always labelled a preview and never treated as authoritative (ADR-032).

---

## 6. API client

```
request
  → attach Authorization (in-memory access token)
  → attach X-Device-Id, X-Counter-Id, X-Request-Id
  → attach Idempotency-Key when the caller supplies one
  → fetch
  → 401 once?        → single shared refresh → retry once → else prompt login
  → non-2xx?         → parse error envelope → throw typed ApiError(code, details, request_id)
  → network/timeout? → throw NetworkError (retryable)
  → 2xx              → typed response
```

Design points:

- **One client, one error shape.** Every caller handles `ApiError` with a `code` from the registry;
  nothing branches on `message` (`../../bmbackend/docs/API-SPECIFICATION.md §4`).
- **Refresh is singleton.** Concurrent 401s await one refresh promise, so 20 queries do not fire 20
  refreshes and trip reuse detection.
- **Retries by method:** idempotent `GET` retries on network errors and 5xx with backoff; `POST`
  retries **only** when an `Idempotency-Key` was supplied, and then only with the same key.
  A `POST` without a key is never retried automatically.
- **No retry on 4xx** except `IDEMPOTENT_REQUEST_IN_PROGRESS`.
- `X-Request-Id` is generated per request and surfaced in error UI so the owner can quote it.
- Types come from `api/generated/schema.d.ts`; `api/endpoints/*` are thin typed wrappers. **Nobody
  hand-writes a field name** (ADR-029).

---

## 7. Local persistence (Dexie / IndexedDB)

```ts
// db/schema.ts
db.version(1).stores({
  drafts:                 'id, status, updated_at',
  draft_lines:            'id, draft_id, line_no',
  outbox:                 'op_id, entity_id, client_seq, status',
  pending_finalizations:  'draft_id, idempotency_key, started_at',
  catalog_cache:          'id, normalized_sku, normalized_name, updated_at',
  catalog_aliases:        'id, product_id, normalized_alias',
  meta:                   'key'            // device_id, cursors, server_time_offset
});
```

| Store | Purpose | Retention |
|---|---|---|
| `drafts` / `draft_lines` | Authoritative draft content while offline | Until finalised or discarded |
| `outbox` | Ordered, durable queue of draft/customer operations | Until acknowledged |
| `pending_finalizations` | Finalisation attempts awaiting confirmation (separate by design, ADR-010) | Until resolved |
| `catalog_cache` | Bounded product subset for offline search | Rebuilt on `reset_required`; capped by the server's `max_rows` |
| `meta` | `device_id`, sync cursors, server-time offset | Permanent |

**Two queues, not one** (ADR-010): an outbox operation is always safe to replay and may be created
offline; a pending finalisation may already have charged the customer and can never be created
offline. Keeping them in separate stores makes that distinction structural rather than a convention.

Handling quota/unavailability: if IndexedDB cannot be opened or a write fails on quota, the app shows
a **blocking** warning that offline safety is unavailable and continues online-only (FE-E-1). It never
degrades silently — a user must never believe their bills are safe when they are not.

### 7.1 Cross-tab coordination

Two tabs on one counter machine would otherwise both write drafts and both sync. A Web Lock (with a
`BroadcastChannel` fallback) elects one **owner tab** for sync and draft writes; other tabs render
read-only with a clear banner and an action to take over (FE-E-2).

---

## 8. Offline and PWA strategy

Protocol in `../../bmbackend/docs/OFFLINE-SYNCHRONIZATION.md`; client responsibilities here.

### 8.1 Service worker caching

| Resource | Strategy |
|---|---|
| App shell (HTML, JS, CSS, fonts, icons) | **Precache**, versioned per build |
| `GET /api/v1/**` | **Network only.** API responses are *not* service-worker cached — offline reads come from Dexie, which has explicit staleness labelling. A silently cached API response would show stale stock with no `as_of`. |
| `POST`/`PATCH`/`PUT` | **Never** intercepted or queued by the service worker. Queuing is the app's job, with business rules attached (ADR-031). |

Update flow: a new service worker installs, the app detects `waiting`, and prompts a reload **at a
safe moment** — never while a bill is in flight (FE-E-4). A deploy must reach counter machines
without anyone clearing a cache (go-live gate 10).

### 8.2 Sync scheduler

Triggers (FR-OFFLINE-012) — Background Sync is only one of several because it cannot be relied upon:

1. `online` event
2. Tab becomes visible / window focus
3. Timer — 30 s while the outbox is non-empty, 5 min when idle
4. After each local mutation, debounced 500 ms (so in normal use the outbox is near-empty)
5. Explicit "Sync now"
6. Background Sync, if available, as an extra opportunistic trigger

Backoff on failure: 1 s → 2 s → 5 s → 15 s → 60 s → 5 min, with jitter. `rejected` operations are
**not** auto-retried; they wait for a human.

### 8.3 Offline search

Offline, search runs against `catalog_cache` using the same normalisation rules as the server
(`lib/normalize.ts`, mirroring `products.normalized_*`). The UI states plainly that results come from
the cached list and may be incomplete, and every price and stock figure carries its `as_of`
(FR-OFFLINE-009).

A deliberate constraint: **normalisation logic is duplicated** between client and server. It is
kept in one small, pure, heavily tested module on each side, with a shared fixture list of
part-number variants used by both test suites, so drift is caught rather than assumed away.

---

## 9. Printing architecture

```
Invoice finalised → print_payload (from the server, verbatim)
                        │
                 <PrintRoot>  — a portal into #print-root, outside the app layout
                        │
      ┌─────────────────┴──────────────────┐
      │ InvoicePrintLayout                  │  @media print: app chrome display:none
      │ (reads payload fields only)         │  @page { size: A5 portrait; margin: 8mm }
      └─────────────────────────────────────┘
                        │
                 window.print()
```

Rules:
- **The print layout renders `print_payload` and nothing else.** No client-computed total, no
  invented header text, no hardcoded document title (FR-PRINT-010/011).
- `print.css` is a separate stylesheet with its own tokens. Restyling the application cannot change
  the bill — which is what makes FR-PRINT-014 enforceable rather than aspirational.
- `document_title` comes from the payload. **The literal string "Tax Invoice" must not appear
  anywhere in the frontend source** (AC-FE-10).
- `totals.tax === null` renders **no tax row** — not a zero row (FR-PRINT-012).
- Reprints render `DUPLICATE COPY` when the payload says so, and fire a best-effort print event;
  a logging failure never blocks printing.
- The **counter slip** is a distinct layout, clearly watermarked, with no invoice number and the
  words "not an invoice" — used only in the offline/unconfirmed case (FR-OFFLINE-015).

---

## 10. Authentication and session handling

| Concern | Implementation |
|---|---|
| Access token | In-memory module variable. Lost on reload, recovered by a silent refresh. |
| Refresh token | `HttpOnly` cookie set by the server; the client never reads it. |
| Bootstrap | On load: attempt `POST /auth/refresh` → on success `GET /sync/bootstrap`; on failure show login. Drafts load from Dexie **regardless of auth state**, so a logged-out user never loses work. |
| Device id | UUIDv7 generated once, stored in Dexie `meta`, sent as `X-Device-Id`. |
| Permissions | From the login/`/auth/me` response, held in session state, used for rendering only. |
| Expiry mid-bill | Transparent refresh; on failure a login prompt that returns the user to the same bill (FE-E-9). |
| Revoked device | Blocking screen, sync stopped, **local data retained** (FR-OFFLINE-010). |
| Logout | Clears memory state and the cookie. **Prompts first if drafts are unsynced**, and does not clear Dexie — bills belong to the shop, not the session. |

---

## 11. Routing and code splitting

```
/                         → redirect by role (cashier → /billing)
/login
/billing                  → eager, in the main bundle (the hot path)
/daily-bills              → lazy
/daily-bills/:invoiceId   → lazy
/credit-bills             → lazy
/customers, /customers/:id
/stock, /stock/:productId
/purchases, /purchases/:id
/imports, /imports/:jobId
/reports/*
/settings/*
/sync                     → pending operations and conflicts
```

Only the shell, the API client, the draft layer and the billing feature are in the initial bundle
(NFR-FE-PERF-005). Everything else is lazy, so a cold start at the counter loads the one screen that
matters.

---

## 12. Error handling architecture

Three layers:

1. **Typed API errors.** `ApiError` carries `code`, `details`, `request_id`. Features branch on
   `code` via an exhaustive `switch`, so adding a backend code produces a TypeScript error until it
   is handled — the mechanism that makes FBO-5 real rather than a promise.
2. **Feature-level handling.** Business conflicts (`INSUFFICIENT_STOCK`, `PRICE_CHANGED`,
   `DRAFT_VERSION_CONFLICT`) are rendered as inline panels or dialogs with a next step, per
   `PRD.md §6.1`. They are **not** toasts — a toast can be missed, and these block a sale.
3. **Error boundaries.** Per-route boundaries catch render failures and offer a reload without
   losing drafts. A top-level boundary is the last resort and still reports the `request_id`.

Never shown to a counter user: HTTP status codes, stack traces, raw server messages, JSON.

---

## 13. Performance approach

| Budget | How it is met |
|---|---|
| Search ≤ 250 ms p95 (NFR-FE-PERF-001) | 120 ms debounce, request cancellation on new input, server budget 150 ms, no client-side filtering of a large list |
| Line add ≤ 50 ms (NFR-FE-PERF-002) | Uncontrolled inputs (react-hook-form), memoised selectors, no full-table re-render on one cell change |
| Tab switch ≤ 100 ms (NFR-FE-PERF-003) | Pure local state; no fetch on switch; drafts already in memory |
| 20 bills × 20 lines responsive | Per-draft store slices; only the active draft renders; table virtualised above 50 rows |
| Bundle ≤ 300 KB gz (NFR-FE-PERF-005) | Lazy routes, no component framework, no moment/lodash, `decimal.js-light` not full `decimal.js` |
| Print ≤ 500 ms | Print layout mounted on demand, no images, no webfont dependency in print CSS |

Debounced Dexie writes (300 ms for text) keep typing smooth while bounding the loss window to a few
hundred milliseconds.

---

## 14. Design system (brief)

Full specification in `docs/UI-UX-SPECIFICATION.md §2`. Architecturally:

- Tailwind tokens for a restrained palette (one neutral ramp, one accent, semantic success/warning/
  danger), a 4 px spacing scale, and a type scale starting at 15 px body.
- A small set of owned primitives in `components/` — `Button`, `Field`, `Table`, `Dialog`, `Popover`,
  `Badge`, `StatusDot`, `Toast`. Copied-in shadcn/ui where accessibility behaviour is non-trivial.
- **No gradients, no decorative animation, no icon-only navigation, no card-heavy layouts**
  (NFR-FE-UX-007). Transitions ≤ 200 ms and disabled under `prefers-reduced-motion`.
- All user-facing strings in `lib/strings.ts` — one file the owner can review, and the seam for a
  future second language (NFR-FE-MAINT-004).

---

## 15. Environment and configuration

| Variable | Purpose |
|---|---|
| `VITE_API_BASE_URL` | Backend base URL |
| `VITE_APP_VERSION` | Build identifier, injected by CI |
| `VITE_SENTRY_DSN` | Optional error reporting (a public DSN, not a secret) |
| `VITE_ENABLE_DEVTOOLS` | Dev only |

**That is the whole list, and it is an enforced boundary.** No database URL, no JWT key, no storage
credential, no third-party secret may ever exist in this repository — anything prefixed `VITE_` is
compiled into a publicly readable bundle (NFR-FE-SEC-001, `../../bmbackend/docs/SECURITY.md §8`). A CI
check fails the build if an unexpected `VITE_` variable appears.

---

## 16. Known architectural risks

| Risk | Impact | Mitigation |
|---|---|---|
| Print fidelity varies by browser/printer | The bill looks wrong to the owner | Chrome/Edge only for print; verification on real hardware is a go-live gate; `print.css` isolated |
| IndexedDB quota or private-browsing restrictions | Offline safety silently absent | Blocking warning, online-only fallback, never silent (FE-E-1) |
| Two tabs on one counter | Conflicting draft writes | Web Lock owner-tab election (FE-E-2) |
| Normalisation drift between client and server | Offline search disagrees with online search | One small pure module each side + a shared fixture list in both test suites |
| Stale cached client after deploy | Counter runs old code against a new API | Service-worker update prompt + `/api/v1/meta` version check |
| Users misreading "saved" as "sold" | A customer leaves without a bill, or stock is wrong | Explicit wording (FR-CREDIT-026), distinct states, staff training as a go-live gate |
| Decimal discipline eroding | Wrong totals | `lib/money.ts` as the only arithmetic site, enforced by lint + property tests |
| Keyboard flow regressions | Billing slows to mouse speed | E2E tests that complete a whole bill using only keys |

---

## 17. Related documents

`docs/PRD.md` · `docs/UI-UX-SPECIFICATION.md` · `docs/API-INTEGRATION.md` ·
`docs/TESTING-STRATEGY.md` · `docs/DECISIONS.md` ·
`../../bmbackend/docs/API-SPECIFICATION.md` *(authoritative contract)* ·
`../../bmbackend/docs/OFFLINE-SYNCHRONIZATION.md` *(authoritative sync protocol)* ·
`../../bmbackend/docs/SECURITY.md`

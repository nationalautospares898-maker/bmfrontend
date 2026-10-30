# CLAUDE.md — `bmfrontend`

Persistent engineering context for AI-assisted work in this repository. Keep it loaded. It is
**rules**, not a specification — the specifications are in `docs/`.

---

## 1. What this is

The counter application for an automobile spare-parts shop (**National Auto Spares**): billing,
stock, credit, purchases, imports, reports. Desktop-first, offline-capable PWA.

The users are staff with little computer experience, standing at a busy counter, serving a customer.
**Speed, clarity and never losing a bill beat everything else.**

The backend (`../bmbackend`, a separate repository) is the authority on money, stock and
permissions. This client renders and never second-guesses it.

---

## 2. Current state — verified, not assumed

**As of 2026-10-30 this repository contains documentation only.** No source, no `package.json`.
It **is** now a Git repository connected to `github.com/nationalautospares898-maker/bmfrontend`,
holding the documentation baseline and nothing else.
Phase 1 produced documentation only. **Phase 2 also produced documentation only** — planning
artifacts, no code.

**Current phase: Phase 2 CLOSED (planning). Phase 3 (implementation) has not started.**
Before writing any code read `docs/PHASE-2-INDEX.md`, then your milestone's **"must not build yet"**
row in the plan. Three things specifically affect this repository:

- **The credit UI must never reinstate a credit-details form.** `Credit Bill` finalises in
  **one** request from the billing screen; only a persisted `customer_id` + name is required, payment
  is **not** requested at save time, and no print dialog opens (OD-21, ADR-033). *(Audit CF-4: the
  traceability matrix once named `CreditDetailsForm` for FR-CREDIT-001 — corrected in Phase 2
  closure. Treat any surviving mention of that component as a **rejected** design, never as an
  instruction; the remaining specification/test cleanup is tracked as T3-05 and must finish before M19/M25 exit.)*
- **The `ErrorCode` union has 53 codes**, including `PRECONDITION_REQUIRED`,
  `SKIPPED_AFTER_EARLIER_FAILURE`, `CORRUPT_VERSION` and `DRAFT_ALREADY_CANCELLED` — added to the
  registry in Phase 2 closure (audit CF-3). The last two arrive as **per-operation outcomes inside a
  `200` sync batch**, not HTTP errors; branch on `code` identically. Semantics in
  `../bmbackend/docs/API-SPECIFICATION.md §4.2a` and `docs/API-INTEGRATION.md §4`.
- **Editing a bill is blocked while its finalisation outcome is unconfirmed** (`P2-D-08`). The
  illustrative `onDraftEdited()` in `docs/API-INTEGRATION.md §5` deletes the
  `pending_finalizations` row — **do not implement it that way**: it would discard the idempotency
  key of a sale that may already have committed. **Full 12-case state machine, forbidden transitions
  and acceptance criteria in `../bmbackend/docs/PHASE-2-IMPLEMENTATION-BLUEPRINT.md §5.4`** — read it
  before building M18 or M22.

Therefore:
- **Never claim a file, component, hook or test exists without reading it first.**
- The stack below is a **proposal from `docs/DECISIONS.md`**, not verified existing code. If you find
  code that contradicts it, the code is the fact — read it and reconcile the documentation rather
  than rewriting the code to match the docs.
- Do not say "tests pass" or "the build is green" unless you ran it and saw output.

---

## 3. Proposed stack (ADR-023…031)

React 19 · TypeScript `strict` · Vite 6 · React Router · TanStack Query v5 · Zustand ·
Dexie (IndexedDB) · `vite-plugin-pwa`/Workbox · Tailwind v4 · a **minimal owned** shadcn/ui subset ·
react-hook-form + Zod · `decimal.js-light` · `openapi-typescript` · Vitest + RTL + Playwright + axe +
MSW

Do not add a component framework (MUI/AntD), a state library beyond these two, a date library, lodash,
moment, or an HTTP client other than the project's `api/client.ts` wrapper, without a new ADR.

---

## 4. State boundaries — the rule most likely to be broken

| State | Owner | Persisted | Authority |
|---|---|---|---|
| Server data (products, invoices, customers, reports) | **TanStack Query** | No | The server |
| Draft bills | **Zustand + Dexie** | **Yes, IndexedDB** | The client while offline |
| UI state (active tab, focus, filters, dialogs) | Zustand / local | No | The client |
| Session (access token, permissions, branch, counter) | In-memory module | **Never** | The server |

1. **A draft never goes in the query cache.** Query caches get cleared; drafts must survive offline
   (ADR-025).
2. **Server data is never copied into Zustand.** One cache, one invalidation story.
3. **The access token is never persisted** — not `localStorage`, not `sessionStorage`, not Dexie, not
   a readable cookie.
4. **Every draft mutation writes to Dexie first** (debounced ~300 ms for text, immediate for
   add/remove line), then updates the store.
5. **Totals are derived selectors, never stored**, so they cannot go stale.

---

## 5. Hard rules

1. **No secret in this repository, ever.** Only `VITE_API_BASE_URL`, `VITE_APP_VERSION`,
   `VITE_SENTRY_DSN`, `VITE_ENABLE_DEVTOOLS`. Anything `VITE_` is compiled into a publicly readable
   bundle. No database URL, no JWT key, no storage credential.
2. **The server owns money, stock, permissions and totals.** The client computes a labelled preview
   and sends `client_computed_total` only as a cross-check (ADR-032).
3. **All money and quantity values are strings** from the API to the input and back. **Arithmetic
   only in `src/lib/money.ts`** using `decimal.js-light`. `parseFloat`, `Number()` and `+`/`-`/`*`
   on money outside that file are lint errors (ADR-013).
4. **One idempotency key per user intent.** Persist it **before** the first request; reuse it on
   every retry; mint a new one only when the user edits the bill. `X-Request-Id` changes per
   attempt; `Idempotency-Key` does not.
5. **Retry a mutating `POST` only if it carried an idempotency key.** Never auto-retry a keyless
   mutation.
6. **Never print an invoice for an unconfirmed sale.** Only a watermarked, un-numbered counter slip.
7. **Never invent, guess or predict an invoice number.** It comes from the server (ADR-009).
8. **No edit UI for invoices, invoice items, payments or stock movements** (ADR-015).
9. **No paid/unpaid checkbox, toggle or input anywhere** — `payment_status` is derived (ADR-022).
10. **The literal `"Tax Invoice"` must not appear in `src/`.** The document title comes from
    `print_payload.document_title`. When `totals.tax === null`, render **no tax row** — not a zero
    (ADR-020).
11. **Branch on `error.code`, never on `error.message`.**
12. **Permission-based hiding is UX only**, never a security control. Handle `403` gracefully
    everywhere.
13. **Never render or derive a cost price or margin.**
14. **No `fetch`/`axios` outside `src/api/`.** Every request goes through the client so it gets auth,
    idempotency, retry and error handling.
15. **Never hardcode a business rule that `/sync/bootstrap` provides** — `max_open_drafts`,
    `tax.mode`, rounding policy, discount caps.
16. **Never hand-edit `src/api/generated/`.** Regenerate with `npm run api:types` (ADR-029).
17. **The service worker caches the app shell only.** No `/api/` route is ever cached; no mutation is
    ever queued by the service worker (ADR-031).
18. **No draft is ever auto-closed, auto-finalised or silently discarded.** At the limit, tell the
    user; never make room by closing a bill.

---

## 6. Billing screen rules

The billing counter is the product. Full spec in `docs/UI-UX-SPECIFICATION.md §4`.

- **Search is auto-focused on load and after every added line.** This single behaviour is what makes
  keyboard-only billing possible (FR-BILL-001) — never break it.
- Results appear from the **first character**, debounced ~120 ms, prior request aborted.
- `↓`/`↑` highlight, `Enter` adds, `Esc` closes, focus returns to search.
- **≥ 20 bill tabs**, all reachable, switching is local-only and instant — never a fetch, never a
  finalisation.
- Item table columns are exactly **S.No · Item · Qty · Unit Price · Total · remove**. Stock is a
  sub-line annotation, not a column.
  > These are the **on-screen** labels and are deliberately *not* the printed bill's labels. The
  > **printed** bill uses the owner's own headers **`S R · ITEM · QTY · PRICE · TOTAL`**
  > (`docs/UI-UX-SPECIFICATION.md §12.1`). The app is not a spreadsheet replica; the bill is.
  > **Do not "align" one to the other** — they are different surfaces with different audiences.
- Editing is **in place**. No edit dialog for a line.
- Stock warnings are **non-blocking** — the server decides (ADR-006).
- Removal has a 5-second inline **undo**, not a confirmation dialog.
- The grand total is labelled *"preview — confirmed on completion"*.
- Business conflicts (`INSUFFICIENT_STOCK`, `PRICE_CHANGED`, conflicts) render as **inline panels
  above the action buttons** — **never toasts**. A toast can be missed while a customer waits.
- **Three actions, three distinct effects** — the distinction is the requirement, not copy polish
  (ADR-027, FR-BILL-009, FR-BILL-013, FR-CREDIT-026):

  | Action | API call | Stock | Invoice | Number | Prints? |
  |---|---|---|---|---|---|
  | `Clear Draft` (`Ctrl+Shift+Backspace`) | local + `DELETE /drafts/{id}` | unchanged | none | none | no |
  | `Save a Draft` (`Ctrl+S`) | `PUT /drafts/{id}` **only** | unchanged | none | none | no |
  | `Credit Bill` (`Ctrl+Shift+Enter`) | `POST /sales:finalize` (`credit`) | **reduced** | **issued** | internal only | no |
  | `Print Bill` (`Ctrl+Enter`) | `POST /sales:finalize` (`cash`) | **reduced** | **issued** | **allocated** | yes |

  Both finalising actions hit the **same** endpoint — never add a second finalisation path. Exact
  wording is pending owner approval ([OD-14](../bmbackend/docs/OWNER-DECISIONS.md#od-14)), so treat
  the strings as a single source in `lib/strings.ts`, not scattered literals.

- **`Credit Bill` FINALISES A SALE** (ADR-033; label set by OD-14's re-answer). It is **not** a
  draft-save. On click it posts **one** `POST /sales:finalize` with `sale_type: credit` — **no
  intermediate dialog, no credit-details page, no second confirm button.** An earlier Phase 1 draft
  specified a mandatory credit-details form; **that design is superseded — do not reinstate it.**
  - Only an identified customer (persisted `customer_id` + name) is required; **nothing else**
    (FR-CUST-010). Creating one inline needs a **name alone**.
  - Optional header values the cashier typed must still be sent and persisted (FR-CREDIT-012).
  - No print dialog opens; the confirmation card offers `Print now` and must say
    **"Stock has been updated."**
  - Initial payment is **optional** and not requested at save time.

---

## 7. API integration

- Base `/api/v1`, JSON, **`snake_case`** field names (ADR-012). Types are generated.
- Always send `X-Device-Id`, `X-Counter-Id` (where relevant) and a fresh `X-Request-Id` per attempt.
- `401` → **one shared refresh promise** (concurrent 401s await it, or the server's reuse detection
  logs the user out) → retry once → else prompt login **keeping all drafts**.
- Draft updates use `If-Match: <version>`. On `409 DRAFT_VERSION_CONFLICT`: **do not retry** — mark
  the draft, badge the tab, open the resolution dialog. **No automatic merge** (ADR-007).
- Timeouts: 10 s reads, **30 s finalisation** (a slow commit is still a commit), 60 s uploads.
- `GET /products/search` is **not retried** — the user is typing; preserve the query and offer Retry.
- Every code in the generated `ErrorCode` union is handled in an exhaustive `switch`. A new backend
  code should break the build until handled — that is intentional.

---

## 8. Offline rules

Scope is deliberately bounded (ADR-011). Full protocol in
`../bmbackend/docs/OFFLINE-SYNCHRONIZATION.md`.

**Offline you can:** open the app, search the cached catalog, create/edit/switch/delete drafts,
create a customer, print a counter slip.

**Offline you cannot:** finalise a sale — **cash (`Print Bill`) *or* credit (`Credit Bill`)**
— record a payment, confirm a purchase, create a return or adjustment, apply an import. These are
visibly disabled with the reason stated.

> **`Credit Bill` is refused offline exactly like `Print Bill`.** Since ADR-033 it finalises
> a sale: it reduces stock and allocates an invoice number. It creates **nothing** offline — no
> invoice, no idempotency key, no `pending_finalizations` row, no queued operation. "Credit" is
> about *who owes money*, never about *whether the sale happened*.

- **Two separate Dexie queues** (ADR-010): `outbox` (drafts/customers — always safe to replay, may
  be created offline) and `pending_finalizations` (may already have charged the customer — **never**
  created offline). Do not merge them.
- **Three states, never conflated** (`../bmbackend/docs/OFFLINE-SYNCHRONIZATION.md §3.1`):
  1. *Safe offline op* — nothing happened server-side; queue it in `outbox`, replay freely.
  2. *Lost response* — sent while **online**, may already have committed; retry the **same**
     `Idempotency-Key`. Never mint a new key.
  3. *Unconfirmed outcome* — still unresolved; hold in `pending_finalizations`, show the loud
     not-confirmed UI, stop auto-retrying after the stale threshold.
  A `pending_finalizations` row is written **immediately before the first online attempt** and may
  never be created by an offline action. An offline `Print Bill` press creates **nothing** — no key,
  no row, no queued item; the bill stays an editable draft. Never drain
  `pending_finalizations` through `/sync/operations`; it retries `POST /sales:finalize` directly.
- Sync triggers: `online`, focus, timer, post-mutation debounce, manual, and Background Sync only as
  an extra. **Never rely on Background Sync alone.**
- Operation outcomes are explicit: `accepted` / `replayed` / `conflicted` / `rejected`. Conflicted
  and rejected stay visible until the user acts — **nothing is dropped silently**.
- Every cached price and stock figure is rendered with its `as_of` time.
- `DEVICE_REVOKED` → blocking screen, stop sync, **never delete local data**.
- IndexedDB unavailable or over quota → **blocking warning** that offline safety is off, then
  online-only. **Never degrade silently** — a user must never believe their bills are safe when they
  are not.
- Only the **owner tab** (Web Lock) syncs and writes drafts; other tabs are read-only.

---

## 9. Printing

- Render `print_payload` from the server **verbatim**. Add no field, compute no total, invent no
  header text.
- A dedicated print root (`#print-root`) with its own `print.css` and `@page` rules — **isolated from
  application styling**, so restyling the app can never change the bill (ADR-028).
- Reprint is a `GET` of the print payload. **It never calls a finalisation endpoint.**
- A failed or cancelled print **never** retries the sale.
- Long item names wrap fully on paper; they are only truncated on screen.
- Empty optional business fields print nothing — **never a placeholder**.
- The counter slip is a separate layout: watermarked, no invoice number, "not an invoice".
- Print fidelity is only guaranteed on Chrome/Edge, and **must be verified on the shop's real printer
  against the owner's real Excel invoice before go-live**.
- ✅ **The print LAYOUT is verified.** The owner's workbook `ANAS_1234_20260606_231456.xlsx` was
  supplied and **inspected part by part** on 2026-10-30; `docs/UI-UX-SPECIFICATION.md §12.1` is read
  from the file. ⚠️ **Verified layout is not verified print** — the workbook sets **no page setup,
  no print area, no paper size, no orientation and no scaling** (§12.1b).
  - Column headers are exactly **`S R · ITEM · QTY · PRICE · TOTAL`**. Earlier drafts said
    `S.No · Item · Qty · Price · Total` — **wrong, superseded.**
  - `ESTIMATE` is **left-aligned in column A on the DATE row**, not a centred banner.
  - §12.2a classifies every element `[VERIFIED]` / `[PROPOSED]`. Render `[PROPOSED]` elements so
    they can be switched off without breaking the layout.
  - **Signature block, amount in words, tax/GST lines, a paid/balance block and any invoice number
    are VERIFIED ABSENT** from the whole sheet — their absence is evidence now, not an unknown.
    **Do not invent them** ([OD-5](../bmbackend/docs/OWNER-DECISIONS.md#od-5)).
  - **The sheet contains no formulas.** Every value in the original, including `GRAND TOTAL`, is
    typed by hand. Our system computes totals — that is an improvement, not a reproduction.
  - ⚠️ **The date order is NOT settled.** The workbook formats `E7` as **`mm-dd-yyyy`**; the
    project assumed `dd-mm-yyyy`. The only example date is 6 June, identical either way
    ([OD-26](../bmbackend/docs/OWNER-DECISIONS.md#od-26), task T3-11).
- **Print rules settled by owner preference 2026-10-29** — implement exactly:
  - **`PRICE` and `GRAND TOTAL` print with NO decimal places** (`240`, `3850`) — OD-23 **amended** by
    the owner. Line `TOTAL` follows the same rule *(inference)*. No separators, no currency symbol
    (FR-PRINT-017). **Formatting is presentation only — it never changes a stored value, and no
    amount is ever rounded or truncated to satisfy a display rule.**
  - 🔴 **If a stored amount carries paise, zero decimals would misstate the bill** — raise a visible
    validation warning; **do NOT silently round** (recorded conflict in OD-23, task T3-08).
  - **Empty item rows print blank** — never the reference's `0` (FR-PRINT-018). *(Those `0`s are
    hand-typed literals in the original, not formula output — corrected 2026-10-30.)*
  - ❌ **NO invoice number is printed** — OD-3 re-answered: *"No need of invoice numbering."*
    `print_payload` carries none, render none, and **never invent a replacement visible scheme**.
    FR-PRINT-019 is **retired**; a structural test asserts this.
  - **Credit bills print payment/balance info; cash bills do not** (FR-PRINT-020). Figures come from
    the payload verbatim — never computed client-side.
  - **Label is `ESTIMATE` for cash *and* credit** (FR-PRINT-021, OD-24). `BILL`, `INVOICE` and
    `Tax Invoice` must not appear as source literals.
- **Cash and credit print the SAME layout** (FR-CREDIT-030). They differ only in the payment
  information the payload carries. Never create a second invoice design for credit.

---

## 10. Accessibility and UX conventions

- **Every billing task completable by keyboard alone** — a speed requirement as much as an
  accessibility one (ADR-030).
- Visible focus on everything; never `outline: none` without a replacement.
- Labels programmatically associated; a placeholder is never the only label.
- Errors via `aria-live` + `aria-describedby`.
- The item table is a real `<table>` with `<th scope>`.
- Status never conveyed by colour alone.
- Body text ≥ 15 px, nothing meaningful below 13 px, targets ≥ 40 px.
- axe: zero serious/critical violations per screen.
- **No gradients, no decorative animation, no icon-only navigation, no card soup.** Motion ≤ 200 ms
  and disabled under `prefers-reduced-motion`.
- Plain language. **No HTTP status codes, no jargon, no stack traces shown to a counter user.** Every
  error says what happened **and what to do next**.
- All user-facing strings in `src/lib/strings.ts` — one file the owner can review.

---

## 11. Forms and validation

- react-hook-form with uncontrolled inputs (a 20-line table must stay fast) + Zod schemas.
- Validate on blur, re-validate on change once touched. Do not shout at a user mid-keystroke.
- Field errors inline, 13 px, danger colour, associated with the field.
- **Client validation never replaces server validation** — map `details.fields` from
  `VALIDATION_ERROR` back onto the form.
- Money inputs accept and emit **strings**, validated through `lib/money.ts`.

---

## 12. Testing

- Vitest + RTL for unit/component/integration; **MSW handlers written from
  `../bmbackend/docs/API-SPECIFICATION.md`** so passing a mock means honouring the real contract.
- Playwright for E2E, offline (real `setOffline`), print (PDF snapshots) and axe.
- `fake-indexeddb` for persistence tests.
- **`src/lib/money.ts` requires 100% branch coverage**; billing, sync and db ≥ 95%.
- Structural tests (`tests/structural/`) enforce §5 rules 1, 2, 3, 9, 10, 14, 16, 17 — keep them
  passing rather than weakening them.
- Commands: `npm test`, `npm run test:e2e`, `npm run lint`, `npm run typecheck`, `npm run build`.
  **Do not claim any of these passed unless you ran them.**

---

## 13. Things you must not do

- Do not invent backend behaviour. If an endpoint, field or error code is not in
  `../bmbackend/docs/API-SPECIFICATION.md`, it does not exist — it is a backend change first.
- Do not reimplement a business rule client-side to save a round trip.
- Do not bypass server validation, even "just in dev" or behind a flag.
- Do not add an endpoint, field or error code "temporarily".
- Do not weaken a structural test to make a build green.
- Do not store a token outside memory, or cache an API response in the service worker.
- Do not auto-accept a `PRICE_CHANGED`, auto-retry a `TOTAL_MISMATCH`, or offer a retry on
  `DRAFT_ALREADY_FINALIZED`.
- Do not delete local drafts in response to an auth or sync error.
- Do not invent business facts (shop name, address, tax status, paper size, credit terms). If it is
  not confirmed in `../bmbackend/docs/PRD.md §4`, it is an open question — record it in
  `../bmbackend/docs/OWNER-DECISIONS.md` and ask.
- **Do not present a recommended default as an owner decision.** Nothing in that register is
  approved — including the offline scope (OD-8), the billing wording (OD-14) and the print layout
  (OD-5).
- Do not commit, push or deploy unless explicitly asked.
- Do not claim external documentation was consulted, a repository was inspected, or a test was run,
  unless it actually happened.

---

## 14. When a requirement is ambiguous

1. Check `docs/PRD.md` and `../bmbackend/docs/PRD.md §4–§5` — it may already be recorded.
2. Business fact → **do not guess**. Add it to `../bmbackend/docs/PRD.md §5` (business questions are
   authoritative there) or `docs/PRD.md §4` if it is frontend-specific, with options and a
   recommended default, and surface it.
3. API behaviour → check `../bmbackend/docs/API-SPECIFICATION.md`. If it is silent, it is a backend
   question, not a client assumption.
4. Technical choice → write an ADR in `docs/DECISIONS.md` (next free number, status `proposed`).
   Numbers are **global across both repositories**; frontend owns 023+.
5. Affects both sides → mark the ADR **shared** and add the matching stub in
   `../bmbackend/docs/DECISIONS.md` in the same change set (ADR-021).

---

## 15. Documentation map

| Need | Document |
|---|---|
| **★ Workbook inspection + repository connection (READ FIRST)** | `../bmbackend/docs/PHASE-2-CLOSURE-ADDENDUM-2.md` |
| **Owner answers four–seven** | `../bmbackend/docs/PHASE-2-CLOSURE-ADDENDUM-1.md` |
| **Phase 2 closure verdict + corrections** | `../bmbackend/docs/PHASE-2-CLOSURE-REPORT.md` |
| **Phase 2 artifacts (what to build next, in order)** | `docs/PHASE-2-INDEX.md` → `../bmbackend/docs/PHASE-2-*.md` |
| What the client must do | `docs/PRD.md` |
| Screens, interactions, **print layout** | `docs/UI-UX-SPECIFICATION.md` |
| Structure, state, persistence, PWA | `docs/ARCHITECTURE.md` |
| Idempotency, retries, errors, sync | `docs/API-INTEGRATION.md` |
| Test layers and structural rules | `docs/TESTING-STRATEGY.md` |
| Why a choice was made | `docs/DECISIONS.md` |
| **Business rules** | `../bmbackend/docs/PRD.md` *(authoritative)* |
| **Unresolved business decisions** | `../bmbackend/docs/OWNER-DECISIONS.md` *(authoritative)* |
| **The API contract** | `../bmbackend/docs/API-SPECIFICATION.md` *(authoritative)* |
| **The sync protocol** | `../bmbackend/docs/OFFLINE-SYNCHRONIZATION.md` *(authoritative)* |
| Requirement → endpoint → table → test | `../bmbackend/docs/TRACEABILITY.md` *(the single matrix)* |

When documentation and code disagree, **the code is the fact** — read it, then fix the documentation
and say that you did.

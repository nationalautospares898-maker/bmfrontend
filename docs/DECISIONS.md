# Architecture Decision Records — `bmfrontend`

| Field | Value |
|---|---|
| Status | **Phase 1 — all records are `proposed` unless marked otherwise** |
| Numbering | **Global across both repositories.** ADR numbers are never reused. |
| Last updated | 2026-10-29 |

---

## How to read this file

Categories, status values and the ownership rule are defined once in
**`../../bmbackend/docs/DECISIONS.md`** (see its "How to read this file" section) and are not restated
here (ADR-021).

Short version:
- This file holds the **full records for ADR-023…032**, which the frontend owns.
- **ADR-001…022** are owned by `bmbackend`; §Stubs lists them with why the frontend cares.
- **Shared** ADRs affect both repositories; a change to one requires a matching commit in the other.
- 🟢 Confirmed owner requirements (C-1…C-10), 🔴 unresolved business questions (Q-*), and
  🟡 assumptions (A-*) are **authoritative in `../../bmbackend/docs/PRD.md §4–§5`**. Frontend-specific
  open questions (Q-FE-1…6) are in `docs/PRD.md §4`.

---

## Index

| ADR | Title | Owner repo | Status | Owner approval needed |
|---|---|---|---|---|
| [023](#adr-023) | React + TypeScript + Vite | frontend | proposed | No |
| [024](#adr-024) | TanStack Query for server state, Zustand for drafts | frontend | proposed | No |
| [025](#adr-025) | Dexie/IndexedDB owns draft state, not the query cache | frontend | proposed | No |
| [026](#adr-026) | Tailwind CSS with a minimal owned component set | frontend | proposed | No |
| [027](#adr-027) | Keep two billing actions; fix clarity with wording | **shared** | proposed · *credit mechanism superseded by ADR-033* | **Yes** (wording) |
| [033](#adr-033) | `Save / Credit Bill` finalises directly; no mandatory credit-details step | **shared** | **accepted** (owner-specified 2026-10-29) | ✔ granted |
| [028](#adr-028) | Printing via an isolated print root and `@page` CSS | frontend | proposed | No |
| [029](#adr-029) | API types generated from OpenAPI, never hand-written | frontend | proposed | No |
| [030](#adr-030) | Keyboard-first billing interaction model | frontend | proposed | No |
| [031](#adr-031) | Service worker caches the app shell only, never API responses | frontend | proposed | No |
| [032](#adr-032) | The client never treats its own totals as authoritative | **shared** | proposed | No |
| 001–022 | Backend-owned and shared decisions | backend | — | see `../../bmbackend/docs/DECISIONS.md` |

---

<a id="adr-023"></a>
## ADR-023 — React + TypeScript + Vite

**Status** proposed · **Owner** frontend · **Related** `ARCHITECTURE.md §2`

**Context.** The repository is empty (verified 2026-10-29). Node 24.11 and npm 11.6 are present. The
application is an authenticated, desktop-first, offline-capable internal tool with one dominant
screen.

**Options.**
1. **React 19 + TypeScript + Vite (SPA).**
2. Next.js (App Router).
3. Vue 3 or Svelte + Vite.

**Decision.** Option 1.

**Rationale.** SSR, routing conventions and server components — Next.js's main advantages — buy
nothing here: every screen is behind a login, SEO is irrelevant, and the app must run from a service
worker cache while offline, which fights SSR rather than benefiting from it. Vite gives faster dev
feedback and a simpler PWA story. React is chosen over Vue/Svelte for the maturity of the specific
primitives needed (headless tables with keyboard navigation, accessible dialogs, virtualisation) and
for ecosystem depth, not on syntax preference.

**Consequences.** A client-rendered SPA, so first paint depends on the JS bundle — bounded by the
300 KB gzip budget and lazy routes (NFR-FE-PERF-005). No server-side rendering if it is ever wanted
for a public page; that would be a separate surface.

---

<a id="adr-024"></a>
## ADR-024 — TanStack Query for server state, Zustand for draft and UI state

**Status** proposed · **Owner** frontend · **Related** `ARCHITECTURE.md §4`

**Context.** Two very different kinds of state: cacheable server data (products, invoices, reports)
and locally authoritative draft bills that must survive offline.

**Options.**
1. **TanStack Query for server state + Zustand for drafts/UI.**
2. Redux Toolkit (+ RTK Query) for everything.
3. React Context + `useReducer`.

**Decision.** Option 1.

**Rationale.** Caching, deduplication, retries and invalidation are the genuinely hard parts of
server state, and TanStack Query solves them well. Drafts are a different problem — they are
locally authoritative, persisted, and mutated on every keystroke — so they get a small, fast store.
Option 2 would work but adds boilerplate for no gain. Option 3 fails concretely at 20 open drafts:
a context update re-renders every consumer, and the billing table is the one place that cannot
afford it (NFR-FE-PERF-002).

**Consequences.** Two state tools to learn. A firm boundary is required: **server data is never
copied into Zustand, and drafts are never put in the query cache** (ADR-025). The boundary is stated
in `CLAUDE.md` because it is the rule most likely to be violated by a well-meaning change.

---

<a id="adr-025"></a>
## ADR-025 — Dexie/IndexedDB owns draft state, not the query cache

**Status** proposed · **Owner** frontend · **Related** FR-DRAFT-008, FR-OFFLINE-003, FBO-2

**Context.** Twenty or more draft bills must survive refresh, browser restart, crash and network
loss (`PRD.md` FBO-2). Each may hold 20 lines with header fields.

**Options.**
1. **Dexie (IndexedDB) as the durable store, mirrored into Zustand for rendering.**
2. `localStorage` with JSON serialisation.
3. Query-cache persistence plugin.
4. Server-only drafts, no local persistence.

**Decision.** Option 1.

**Rationale.** `localStorage` is synchronous (so it would stall typing), ~5 MB, string-only, and has
no transactions — losing half a draft on a crash is a realistic outcome. Persisting the query cache
conflates server truth with local authorship and gives no transactional guarantee per draft. Option
4 fails the core offline requirement outright. IndexedDB with Dexie gives transactions, indexes and
a typed schema, which is what "no draft is ever lost" actually requires.

**Consequences.** An async storage layer and a schema to version. Every draft mutation is a Dexie
transaction first, then a store update, debounced ~300 ms for text — so the worst-case loss window
is a few hundred milliseconds, not a bill. Private-browsing or quota failures must be handled
loudly, never silently (FE-E-1): the user has to know when offline safety is absent.

---

<a id="adr-026"></a>
## ADR-026 — Tailwind CSS with a minimal, owned component set

**Status** proposed · **Owner** frontend · **Related** NFR-FE-UX-007, `UI-UX-SPECIFICATION.md §2`

**Context.** The interface must be minimal, consistent, fast and readable at a counter — explicitly
not decorative, and explicitly not spreadsheet-like.

**Options.**
1. **Tailwind v4 + a small copied-in shadcn/ui subset we own.**
2. A full component library (MUI, Ant Design).
3. CSS Modules with hand-written components.

**Decision.** Option 1.

**Rationale.** Tailwind's constrained scales make consistent spacing and typography the default
rather than a review burden. A full library brings a visual identity we would spend effort fighting,
plus bundle weight, plus accessibility behaviour we cannot adjust. Hand-writing accessible dialogs,
popovers and selects is a genuine trap — so those few come from shadcn/ui, **copied into the
repository and owned**, not taken as a dependency.

**Consequences.** Verbose class strings in markup (mitigated by small components). The component
subset is deliberately tiny — `Button`, `Field`, `Table`, `Dialog`, `Popover`, `Badge`, `StatusDot`,
`Toast`. Adding to it is a decision, not a reflex. `print.css` is entirely separate from Tailwind so
restyling the app can never change the printed bill (ADR-028).

---

<a id="adr-027"></a>
## ADR-027 — Keep two billing actions; fix clarity with wording, not restructuring

**Status** proposed · **Owner** shared · **Owner approval: YES** · **Related** FR-BILL-009,
FR-SALE-020, FR-CREDIT-020/026

**Context.** The owner's workflow has two buttons: `Print Bill` (cash) and `Save / Credit Bill`.
"Save" is genuinely ambiguous — it could mean "keep this draft" or "complete this credit sale", and
the second reduces stock and creates a receivable. The brief invited considering a single
`Complete & Print` action instead.

**Options.**
1. **Keep both buttons; disambiguate with sub-labels, a consequence sentence, and a separate quiet
   "Keep for later" draft action.**
2. One `Complete & Print` button with a cash/credit choice inside it.
3. Keep both buttons unchanged.

**Decision.** Option 1.

**Rationale.** Option 3 leaves a real risk: a staff member presses "Save", believes nothing happened,
and stock is already gone. Option 2 is arguably cleaner but discards the owner's existing mental
model and adds a step to the most common action (cash sale), which conflicts with FBO-1. Option 1
keeps the familiar shape and removes the ambiguity where it actually lives — in the words:

- `Print Bill` → sub-label **"Complete cash sale and print"**
- `Save / Credit Bill` → sub-label **"Record as credit — payment due later"**
- A separate, quieter `Keep for later` in the bill's overflow menu, labelled *"saves this bill as a
  draft without selling anything"*.

**Consequences.** Three affordances instead of two, but each is unambiguous, and the two prominent
ones match what the owner already does. **Owner approval is needed on the exact wording**, since
these are the words their staff will read a hundred times a day.

> ### ⚠️ Partially superseded by ADR-033 (2026-10-29)
>
> The **three-action structure and the wording principle above still stand.** What is superseded is
> the mechanism this ADR assumed for the credit action: it described a **confirm button inside a
> credit dialog** reading `Finalise Credit Bill`.
>
> **The owner replaced that flow on 2026-10-29.** `Save / Credit Bill` now finalises **directly**,
> with no intermediate dialog and no second confirm button. See **[ADR-033](#adr-033)** and
> [OD-21](../../bmbackend/docs/OWNER-DECISIONS.md#od-21).
>
> Everything else in this record — keeping the owner's two familiar buttons, disambiguating by
> wording rather than restructuring, and the separate quiet draft action — remains the decision.

---

<a id="adr-033"></a>
## ADR-033 — `Save / Credit Bill` finalises directly; no mandatory credit-details step

**Status** **accepted** · **Owner** shared · **Owner approval: GRANTED 2026-10-29** ·
**Supersedes** the credit-dialog mechanism in [ADR-027](#adr-027) · **Related** FR-CREDIT-020…031,
FR-CUST-010, FR-RPT-028, [OD-21](../../bmbackend/docs/OWNER-DECISIONS.md#od-21)

> **This is the only `accepted` ADR in either repository.** It is accepted because the business owner
> directly specified the workflow on 2026-10-29 — it is a confirmed requirement, not an engineering
> recommendation. The *technical* choices it implies remain `proposed` under their own ADRs.

**Context.** Phase 1 specified that `Save / Credit Bill` opened a mandatory credit-details page
collecting business name, vehicle, mechanic, phone, terms, due date, notes and an optional payment
before anything was finalised. The owner found this too slow for a busy counter: a credit customer is
usually a known regular, and the cashier should not re-enter details the system already holds.

**Options.**
1. **Finalise directly on click; require only an identified customer.**
2. Keep the mandatory details page (superseded design).
3. Finalise directly but *queue* the credit sale for later server confirmation.

**Decision.** Option 1, as specified by the owner.

**Rationale.** Option 2 is what the owner rejected — it taxes every credit sale to collect fields
that are optional for the sale's correctness, and most are already on the customer record or the bill
header. Option 3 is **rejected outright and must never be revisited casually**: a credit sale reduces
stock and consumes an invoice number exactly as a cash sale does, so queueing it offline would
reintroduce the overselling and numbering hazards that ADR-011 exists to prevent. "Credit" describes
*who owes the money*, not *whether the sale happened*.

The safety that the dialog used to provide — making it obvious that stock moves — is preserved by
wording instead: the confirmation states the invoice number, the outstanding amount and
*"Stock has been updated."*

**Consequences.**
- Faster credit billing: one click from a complete bill with a chosen customer.
- **Minimum customer identity becomes load-bearing**: a persisted `customer_id` + non-empty name
  (FR-CUST-010). The button is disabled until one exists, and the server independently rejects
  anything less.
- No print dialog at save; the invoice stays printable forever from Credit Bills (FR-CREDIT-029).
- Optional header values the cashier typed are still captured and persisted (FR-CREDIT-012) —
  removing the mandatory form must not mean losing data.
- The credit action inherits **every** finalisation constraint: atomicity, idempotency, stock
  validation, price-change detection, and the **offline refusal** (`OFFLINE-SYNCHRONIZATION.md
  §3.1` invariant 2a).
- Due date is derived from the customer's terms rather than asked for; it is editable afterwards.

**Revisit when** the owner reports that some field genuinely must be captured at sale time — in
which case it is added to the bill header inline, **not** restored as a blocking page.

---

<a id="adr-028"></a>
## ADR-028 — Printing via an isolated print root and `@page` CSS

**Status** proposed · **Owner** frontend · **Related** FR-PRINT-010…016, ADR-014

**Context.** The printed bill must closely reproduce the owner's Excel invoice (C-9) while the
application looks nothing like a spreadsheet. The backend supplies `print_payload`; the client
renders it.

**Options.**
1. **A React portal into `#print-root`, outside the app layout, styled only by `print.css` with
   `@page` rules.**
2. Open a new window and write the document into it.
3. Render into an iframe and print the iframe.
4. Reuse application components with print overrides.

**Decision.** Option 1.

**Rationale.** Option 4 is the trap: the bill would silently change whenever the app is restyled,
and C-9 would quietly rot. A separate print root with its own stylesheet makes isolation structural.
Option 2 trips popup blockers and loses styles; Option 3 complicates asset loading and debugging for
no benefit here.

**Consequences.** Print layout is maintained separately from the UI, which is the point. It must be
tested separately (PDF snapshots, `TESTING-STRATEGY.md §4.8`) and verified on real hardware before
go-live. Print fidelity is guaranteed only on Chrome/Edge (Q-FE-1). The counter slip is a second
layout in the same isolated root, so it can never be confused with the invoice.

---

<a id="adr-029"></a>
## ADR-029 — API types generated from OpenAPI, never hand-written

**Status** proposed · **Owner** frontend · **Related** NFR-FE-MAINT-002, ADR-012, ADR-013

**Context.** The backend publishes `GET /api/v1/openapi.json`. The API is `snake_case` with money as
strings — both of which are mildly awkward to hand-type in TypeScript, and therefore easy to get
subtly wrong.

**Options.**
1. **`openapi-typescript` generation, committed, with a CI drift check.**
2. Hand-written interfaces.
3. A full client generator (orval, openapi-codegen) producing hooks too.

**Decision.** Option 1, with thin hand-written endpoint wrappers over a shared client.

**Rationale.** Hand-written types drift from the contract, and the drift shows up as a runtime bug at
a counter rather than a compile error. Generation makes the backend document the single source of
truth, and makes ADR-012/013 painless because nobody types a field name at all. Full client
generation was rejected because the generated calling conventions would fight the bespoke
idempotency, retry and error handling in `api/client.ts`, which is where this application's real
complexity lives.

**Consequences.** A generation step on every contract change, with the output committed so builds
work offline. CI regenerates against staging and **fails on a diff** — contract drift is caught in
the pipeline. `src/api/generated/` is never hand-edited (a structural test asserts it). New error
codes surface as compile errors at exhaustive switches, which is exactly the behaviour wanted.

---

<a id="adr-030"></a>
## ADR-030 — Keyboard-first billing interaction model

**Status** proposed · **Owner** frontend · **Related** FBO-1, NFR-FE-A11Y-002,
`UI-UX-SPECIFICATION.md §11`

**Context.** The target is a 5-line bill in under 60 seconds at a busy counter. Mouse travel between
a search box and a table is the dominant cost in that budget.

**Options.**
1. **Keyboard-first: search auto-focused, `↓`/`↑`/`Enter` to add, focus returns to search after each
   line, `Tab` through editable cells, `Ctrl+Enter` to complete.**
2. Mouse-first with keyboard as an afterthought.
3. A command-palette-driven interface.

**Decision.** Option 1, with full mouse parity.

**Rationale.** A counter user types a part name, presses Enter, and types the next one — never
touching the mouse. Returning focus to search after every added line is the single highest-leverage
behaviour in the whole UI (FR-BILL-001). Option 3 is powerful for expert users but wrong for staff
with little computer experience, who need visible affordances rather than remembered commands.

**Consequences.** Focus management becomes a correctness concern, tested explicitly — a regression
here silently halves billing speed, which is why "complete a whole bill using only the keyboard" is
an E2E test (AC-FE-8). Shortcuts must not collide with browser defaults, and a `?` overlay documents
them. This also delivers most of NFR-FE-A11Y-002 for free: the accessibility requirement and the
speed requirement are the same requirement.

---

<a id="adr-031"></a>
## ADR-031 — Service worker caches the app shell only, never API responses

**Status** proposed · **Owner** frontend · **Related** FR-OFFLINE-008/009/012, NFR-FE-SEC

**Context.** A PWA service worker can cache API `GET`s and even queue failed `POST`s (Workbox
Background Sync). Both are tempting and both are wrong here.

**Options.**
1. **Precache the shell; API requests are network-only; offline data comes from Dexie.**
2. Also cache API `GET`s with stale-while-revalidate.
3. Also queue failed mutations in the service worker.

**Decision.** Option 1.

**Rationale.** Option 2 would show stale stock and prices **with no staleness label**, defeating
FR-OFFLINE-009 — Dexie data carries `as_of` and the UI shows it, a cached HTTP response does not.
Option 3 is worse: the service worker has no access to business context, so it could replay a
finalisation without the idempotency and ownership rules the app enforces — exactly the failure mode
ADR-010 and ADR-011 exist to prevent. Offline behaviour belongs in the application, where the rules
live.

**Consequences.** Offline reads must be explicitly implemented against Dexie (more code, correct
behaviour). The service worker stays small and uninteresting, which is a virtue. Its update flow must
prompt a reload at a safe moment so a stale client cannot persist after a deploy (FE-E-4, go-live
gate 10). A structural test asserts no `/api/` route appears in the caching config.

---

<a id="adr-032"></a>
## ADR-032 — The client never treats its own totals as authoritative

**Status** proposed · **Owner** shared · **Related** FR-SALE-003, FR-DRAFT-011, NFR-DATA-002

**Context.** The UI must show a running total instantly as lines are added, but the server
independently recomputes every figure at finalisation.

**Options.**
1. **Client computes a clearly labelled preview; the server's response is the only truth; mismatch
   surfaces as `TOTAL_MISMATCH`.**
2. Client is authoritative and the server trusts it.
3. Client shows no total until the server responds.

**Decision.** Option 1.

**Rationale.** Option 2 is disqualified — a browser figure can be edited and must never be the basis
of a bill. Option 3 would be correct but unusable: a counter user needs to see the total while
adding items. So the client previews, labels the preview as such, and sends
`client_computed_total` purely as a cross-check so a genuine disagreement becomes a visible error
rather than a silently wrong bill.

**Consequences.** The client must implement rounding **identically** to the server
(`../../bmbackend/docs/ARCHITECTURE.md §6.5`), which is why all arithmetic is confined to
`lib/money.ts` with 100% branch coverage and property tests. Totals carry a "preview — confirmed on
completion" label (`UI-UX-SPECIFICATION.md §4.5`). The duplicated rounding rule is a known
maintenance cost, accepted in exchange for a cross-check that catches drift on either side.

---

## Stubs — decisions owned by `bmbackend`

Full records in **`../../bmbackend/docs/DECISIONS.md`**. Listed so this file is a complete index and so
the frontend's dependency on each is explicit.

| ADR | Title | Why the frontend cares |
|---|---|---|
| ADR-001 | Modular monolith | One API base URL; no service discovery in the client |
| ADR-002 | Python + FastAPI | Produces the OpenAPI document ADR-029 depends on |
| ADR-003 | Sync SQLAlchemy sessions | None |
| ADR-004 | Postgres job queue, no Redis | Import jobs are polled, not pushed — drives the polling UI |
| ADR-005 | Postgres trigram search | Search is server-side and paginated; **the client must not download the catalog** |
| ADR-006 | **Drafts do not reserve stock** | Stock shown while editing is advisory; `INSUFFICIENT_STOCK` at finalisation is a normal, well-handled case (§9.2 of the UI spec) |
| ADR-007 | **Draft conflicts resolved by the user** | The client must implement a real conflict dialog; no silent merge |
| ADR-008 | READ COMMITTED + row locks | Finalisation may block briefly; client timeout is 30 s, not 5 |
| ADR-009 | Invoice numbers from a locked series row, allocated in-transaction *(gaplessness is the default consequence, **not** an approved requirement — [OD-3](../../bmbackend/docs/OWNER-DECISIONS.md#od-3) is open)* | **Only the server can produce an invoice number** — the client never invents or predicts one |
| ADR-010 | **Two client queues** | Outbox and `pending_finalizations` are separate Dexie stores with different rules |
| ADR-011 | **No offline sale finalisation** | `Print Bill` is refused offline; counter slip is the fallback |
| ADR-012 | `snake_case` JSON | DTO property names are `snake_case`; generated types make this a non-issue |
| ADR-013 | Money as JSON strings | **Never `parseFloat`** — all arithmetic in `lib/money.ts` |
| ADR-014 | Browser printing primary | The client owns rendering; the backend owns content (ADR-028) |
| ADR-015 | Immutable financial records | **No edit UI for invoices, payments or movements anywhere** |
| ADR-016 | Migrations as a deploy step | A deploy may briefly fail readiness; the client retries gracefully |
| ADR-017 | Real Postgres in tests | None |
| ADR-018 | No RLS in v1 | None |
| ADR-019 | Single API replica | Brief restarts; drafts keep working offline |
| ADR-020 | **Tax `estimate_only` behind a gate** | `document_title` comes from the payload; `totals.tax === null` renders **no** tax row; "Tax Invoice" is not a source literal |
| ADR-021 | Two repositories, documentation ownership | Business rules and open questions are **not** restated in frontend docs |
| ADR-022 | Payment status is derived | **No paid checkbox anywhere in the UI** |

---

## Unresolved decisions relevant to the frontend

**Blocking (owner/accountant):** Q-LEGAL-1 (shop identity for the invoice header), Q-PRINT-1 (paper
size and printer), Q-TAX-1/2/3 (tax mode, rates, series format), Q-MONEY-1 (rounding rule — affects
the preview in `lib/money.ts`). All detailed in `../../bmbackend/docs/PRD.md §5.1`.

**Needs owner input, not blocking:** ADR-027 wording, ADR-006 (whether staff should see stock
reserved in other drafts), ADR-014 (whether a PDF copy must be archived).

**Frontend-specific:** Q-FE-1…6 in `docs/PRD.md §4` — browser, screen size, barcode scanner,
touchscreen, language, tab labelling.

**Resolved 2026-10-30 — the bill layout.** The owner's original workbook
`ANAS_1234_20260606_231456.xlsx` was supplied and **inspected part by part**, so
`docs/UI-UX-SPECIFICATION.md §12.1` is now **read from the file**: used range `A1:E37`, 12 merged
ranges, 25 item rows, all widths/heights, Calibri typography, borders, number formats and both logo
images. A signature block, amount in words, tax line and any invoice number are **verified absent**
and must not be added ([OD-5](../../bmbackend/docs/OWNER-DECISIONS.md#od-5) — **resolved**).

**Still outstanding:** the workbook sets **no page setup at all** — no paper size, orientation,
scaling or print area — so those remain open
([OD-6](../../bmbackend/docs/OWNER-DECISIONS.md#od-6)); the credit payment block's placement is
unresolved ([OD-22](../../bmbackend/docs/OWNER-DECISIONS.md#od-22)); and the printed **date order**
is newly open ([OD-26](../../bmbackend/docs/OWNER-DECISIONS.md#od-26)).

> *Corrected in Phase 2 closure (audit finding CF-6): this paragraph previously described §12 as
> "a reconstruction", understating the evidence actually held for the upper section while obscuring
> the real remaining gap.*

---

## Related documents

`docs/PRD.md` · `docs/ARCHITECTURE.md` · `docs/UI-UX-SPECIFICATION.md` ·
`docs/API-INTEGRATION.md` · `docs/TESTING-STRATEGY.md` ·
**`../../bmbackend/docs/DECISIONS.md`** *(ADR-001…022, and the shared conventions for this file)* ·
`../../bmbackend/docs/TRACEABILITY.md` *(the single traceability matrix)*

# Frontend PRD — National Auto Spares Shop Management System

| Field | Value |
|---|---|
| Repository | `bmfrontend` (independent Git repository) |
| Document owner | Frontend engineering |
| Status | **Phase 1 draft — awaiting owner review** |
| Last updated | 2026-10-29 |
| Companion document | `../../bmbackend/docs/PRD.md` (business rules, data integrity, API behaviour) |

> **Scope of this document.** This PRD defines what the **client application** must do: screens,
> interactions, local state, offline behaviour, API integration, error presentation and
> accessibility. Business rules, money arithmetic, stock decisions and permissions are **enforced by
> the backend** and specified in the backend PRD.
>
> Requirement IDs are **shared across both repositories** — `FR-BILL-001` means the same end-to-end
> behaviour in both documents. The single traceability matrix is
> `../../bmbackend/docs/TRACEABILITY.md`.
>
> **Business facts and open questions are authoritative in `../../bmbackend/docs/PRD.md §4–§5`.** They
> are not restated here; §4 below links to them.

---

## 1. Product vision and business objectives

### 1.1 Vision

A billing counter screen that a staff member with little computer experience can use faster than
writing a bill by hand, that never loses work, and that prints a bill the shop's customers already
recognise.

### 1.2 What the frontend is specifically accountable for

| ID | Objective | Measure |
|---|---|---|
| FBO-1 | Billing is faster than paper | Median first-keystroke to printed bill < 60 s for a 5-line bill (BO-4) |
| FBO-2 | No draft work is ever lost | Zero draft loss across refresh, browser restart, crash and network failure |
| FBO-3 | Usable without training beyond one session | A new staff member completes a cash bill unaided after one 15-minute walkthrough |
| FBO-4 | The printed bill is accepted by the owner | Side-by-side sign-off against the existing Excel invoice |
| FBO-5 | Errors are actionable, never cryptic | Every documented backend error code maps to a specific UI state with a next step |
| FBO-6 | Offline state is never ambiguous | A user can always tell whether a bill is saved, synced, or finalised |

### 1.3 Explicit non-goals

A dashboard-first experience; mobile-first design (desktop counter is primary); a spreadsheet-like UI
for the whole app; offline sale finalisation; client-side authoritative totals; decorative animation.

---

## 2. Business context

See `../../bmbackend/docs/PRD.md §2` for the shop's current manual workflow. The frontend-relevant
points:

- Staff type part names and part codes from memory, with inconsistent spacing and separators
  (`JK-123`, `jk 123`). Search must be forgiving.
- Several customers are served at once, so multiple bills are open simultaneously — this is the
  normal case, not an edge case.
- Customers are often mechanics or drivers buying for a vehicle; the vehicle number and mechanic name
  matter on the bill.
- The counter is busy and noisy. Modal dialogs, confirmations and multi-step wizards cost real time.
- The existing bill is an Excel template; the printed output must look familiar.

---

## 3. Personas and permission-driven UI

Personas are defined in `../../bmbackend/docs/PRD.md §3.1`. Frontend consequences:

| Persona | Default landing screen | UI emphasis |
|---|---|---|
| Cashier | **Billing counter** | Search, bill tabs, totals, print. Everything else behind navigation. |
| Stock keeper | Stock position | Receive stock, adjustments, low stock |
| Manager | Billing counter | Same as cashier, plus overrides and cancellation actions |
| Owner | Daily summary | Totals, credit, reports; can reach everything |
| Accountant | Reports | Exports, credit ageing |
| Auditor | Reports (read-only) | No write affordances rendered at all |

### 3.1 Permission rules for the UI

| ID | Requirement |
|---|---|
| FR-UI-PERM-001 | The UI renders actions based on the permission list from `GET /auth/me`. An action the user lacks is **hidden**, not shown-and-disabled, except where hiding it would make the screen confusing — then it is disabled with a tooltip naming the needed permission. |
| FR-UI-PERM-002 | Hiding an action is a usability measure, **never a security control**. The client assumes the server will refuse anything unauthorised and handles `403 PERMISSION_DENIED` gracefully everywhere. |
| FR-UI-PERM-003 | When an action needs a permission the current user lacks (e.g. oversell override, price override), the UI offers a **supervisor authorisation** path rather than a dead end: a manager signs in on the same device and the action proceeds, recorded against the manager. |
| FR-UI-PERM-004 | Cost prices and margins are never rendered; the API omits them without `catalog.cost.read`, and the UI must not infer or display them from any other field. |

---

## 4. Confirmed requirements and open questions

Confirmed decisions C-1…C-10 and all open questions (Q-TAX-*, Q-LEGAL-1, Q-PRINT-1, Q-MONEY-1,
Q-BIZ-*) are authoritative in **`../../bmbackend/docs/PRD.md §4–§5`** and are not duplicated here
(ADR-021).

Frontend-specific open questions:

| ID | Question | Recommended default | Blocks |
|---|---|---|---|
| Q-FE-1 | Which browser(s) will the counter machines run? | Chrome or Edge, current version. Print fidelity is only guaranteed there. | Print sign-off |
| Q-FE-2 | Screen size at the counter | Design for 1366×768 minimum, optimise for 1920×1080 | Layout |
| Q-FE-3 | Will staff use a barcode scanner at launch? | No; keyboard-wedge scanners are supported by design but untested without hardware | FR-CAT-007 |
| Q-FE-4 | Is a touchscreen used at any counter? | No; keyboard + mouse assumed. Hit targets are still ≥40 px so touch is not excluded. | Control sizing |
| Q-FE-5 | Preferred UI language, and is a second language needed? | English only at launch; strings are externalised so a second language is additive | i18n scaffolding |
| Q-FE-6 | Should the bill tab label be the customer name or a number? | Number + customer name once entered (`3 · Imran`) | FR-BILL-004 |

### 4.1 Reference availability — updated 2026-10-29

**✅ Received and inspected:** the owner supplied a **screenshot of the actual Excel bill**. It was
inspected directly, and `docs/UI-UX-SPECIFICATION.md §12.1` is now **transcribed from it** rather
than reconstructed. The earlier reconstruction was **wrong in specifics** — in particular the column
headers are **`S R · ITEM · QTY · PRICE · TOTAL`** (not `S.No · Item · Qty · Price · Total`), and
`ESTIMATE` is **left-aligned on the DATE row**, not a centred banner.

**❌ Still unavailable:** the original `.xlsx` workbook. The screenshot ends at worksheet row 30,
inside the pre-numbered empty rows, so **the whole bottom section is unseen** — grand total,
signature area, footer text, the defined print area, page size, margins and scaling (§12.1b).

**Therefore the layout is PARTIALLY verified. Never describe it as verified** — only a screenshot
was seen, not the workbook, and no printed sample has been approved (FBO-4,
[OD-5](../../bmbackend/docs/OWNER-DECISIONS.md#od-5)).

---

## 5. Functional requirements

### 5.1 Application shell and navigation (`FR-NAV`)

| ID | P | Requirement |
|---|---|---|
| FR-NAV-001 | P0 | The default landing route for a user with `billing.sale.finalize` is the **billing counter**. No dashboard, splash or interstitial precedes it. |
| FR-NAV-002 | P0 | Primary navigation is a persistent left sidebar with at most 7 top-level items, each with a text label (not icon-only): Billing, Daily Bills, Credit Bills, Stock, Purchases, Reports, Settings. Items the user cannot access are hidden. |
| FR-NAV-003 | P0 | A persistent top bar shows: shop name, active branch and counter, current user, **network/sync status**, and a user menu. |
| FR-NAV-004 | P0 | Navigating away from the billing counter never discards draft state. Returning restores the same active bill and cursor context. |
| FR-NAV-005 | P0 | Deep links are supported for invoices, customers and products so a URL can be shared or bookmarked. |
| FR-NAV-006 | P1 | A global keyboard shortcut returns to billing (`F2`) and opens search within it (`F3` or `/`). |
| FR-NAV-007 | P0 | The app never opens a modal dialog for anything that can be done inline. Modals are reserved for: **conflict resolution, destructive confirmation (including `Clear Draft`), and supervisor authorisation**. ⚠️ **"Credit details" is NOT on this list** — that step was removed by [OD-21](../../bmbackend/docs/OWNER-DECISIONS.md#od-21)/ADR-033 and must not be reinstated (task T3-05). |

### 5.2 Billing counter (`FR-BILL`)

The single most important screen. Full behavioural spec in `docs/UI-UX-SPECIFICATION.md §4`.

| ID | P | Requirement |
|---|---|---|
| FR-BILL-001 | P0 | The product search field is focused on load and after every line is added, so a user can add many items without touching the mouse. |
| FR-BILL-002 | P0 | The screen layout is: bill tab strip, search field, item table, totals panel, action buttons. Nothing else competes for attention. |
| FR-BILL-003 | P0 | The **on-screen** item table has exactly these columns: **S.No, Item, Qty, Unit Price, Line Total, remove action.** Stock information appears as a subtle annotation on the item cell, not as an extra column. ⚠️ These are **screen** labels and deliberately differ from the **printed bill's** owner-observed headers `S R · ITEM · QTY · PRICE · TOTAL` (FR-PRINT-013). Two different surfaces for two different audiences — **do not align one to the other.** |
| FR-BILL-004 | P0 | A persistent tab strip shows all open bills with a stable label (number, plus customer name once known) and a visible indicator for unsynced / not-confirmed / conflicted state. |
| FR-BILL-005 | P0 | A clearly visible `+` action creates a new bill. At least 20 bills can be open; the tab strip scrolls horizontally with keyboard navigation (`Ctrl+Tab` / `Ctrl+1…9`) and never truncates access to a bill. |
| FR-BILL-006 | P0 | Switching tabs is instant (local state only), never triggers a finalisation, and never discards edits. |
| FR-BILL-007 | P0 | At the draft limit, `+` is disabled with a clear explanation and a prompt to finalise or discard a bill. **No existing bill is ever closed automatically.** |
| FR-BILL-008 | P0 | The grand total recalculates immediately on every change and is visually prominent. It is labelled as a preview until the server confirms (FR-SALE-003). |
| FR-BILL-009 | P0 | **Exactly four primary actions are present, and no others** ([OD-14](../../bmbackend/docs/OWNER-DECISIONS.md#od-14), re-answered by the owner): **`Print Bill`** (cash sale) · **`Credit Bill`** (credit sale) · **`Save a Draft`** (draft only) · **`Clear Draft`** (clears the editable draft). Semantics in §5.5. **Do not add a fifth primary action.** |
| FR-BILL-010 | P0 | Header fields (customer name, business name, vehicle number, mechanic name, phone, notes) are editable inline on the bill, not hidden behind a dialog. |
| FR-BILL-011 | P0 | An empty bill renders a short hint telling the user to start typing a part name — not an empty table with no guidance. |
| FR-BILL-012 | **P0** | **`Clear Draft`** clears the current editable draft with one action plus one confirmation stating how many lines will be lost. ⚠️ It **never** deletes or reverses a finalised sale, and it is **unavailable while that bill holds an unresolved `pending_finalizations` row** — it must never destroy an idempotency key that may already have produced a sale (Blueprint §5.4.4, `P2-D-08`). *Promoted from P1 to P0 and from a secondary affordance to a primary action by the owner's fourth answer set.* |
| FR-BILL-013 | P0 | **`Save a Draft`** (a primary action, shortcut `Ctrl+S`) saves the bill as a draft **without finalising anything**: no stock movement, no invoice, no payment, and **no customer-facing number**. Its confirmation text states *"saved as a draft — nothing has been sold"*. It maps to `PUT /drafts/{id}` **only**. *Renamed from `Keep for later`; semantics unchanged. The label now says "draft" explicitly, which is what removes the old ambiguity with the word "save".* |

### 5.3 Product search (`FR-CAT` — client side)

| ID | P | Requirement |
|---|---|---|
| FR-CAT-003 | P0 | Results appear from the **first typed character**. Input is debounced ~120 ms; an in-flight request is cancelled when the query changes. |
| FR-CAT-004 | P0 | Each result shows: product name, SKU/part code, brand, unit, default selling price and current stock with its `as_of` time when offline. |
| FR-CAT-005 | P0 | Search is always a server query against `GET /products/search` (or the local cache when offline). **The client never downloads the full catalog.** |
| FR-CAT-006 | P0 | The user's raw input is sent unmodified; normalisation is the server's job. The client never strips or rewrites a part code. |
| FR-CAT-007 | P1 | Barcode-scanner input (a fast keystroke burst ending in Enter) is detected and routed to exact-barcode lookup, adding the item directly. |
| FR-CAT-011 | P0 | Keyboard: `↓`/`↑` move the highlight, `Enter` adds the highlighted product, `Esc` closes the list and clears the query. Mouse and touch work identically. |
| FR-CAT-012 | P0 | Empty results show "No product found" plus an explicit "Add new product" affordance for users with `catalog.write` — never a blank dropdown. |
| FR-CAT-013 | P0 | A search failure (network/5xx) shows an inline retry affordance and does not clear what the user typed. |
| FR-CAT-014 | P0 | Selecting a product adds it to the active bill, populates the default selling price and a default quantity of 1, and returns focus to search. |
| FR-CAT-015 | P1 | Selecting a product already on the bill increments its quantity rather than adding a duplicate line, with a brief visual confirmation on the existing row. |

### 5.4 Bill item editing (`FR-ITEM`)

| ID | P | Requirement |
|---|---|---|
| FR-ITEM-001 | P0 | Quantity and unit price are directly editable in the table — click or tab into the cell, type, done. No edit dialog. |
| FR-ITEM-002 | P0 | Line total and grand total recalculate on every keystroke, using **decimal arithmetic** (never `parseFloat`). |
| FR-ITEM-003 | P0 | Validation is inline and immediate: quantity > 0, within the unit's decimal places; price ≥ 0. The offending cell is marked and the submit action is blocked with a specific message. |
| FR-ITEM-004 | P0 | Editing the unit price away from the catalog price marks the line as a manual override and shows it visibly. Without `billing.price.override` the price cell is read-only, with a supervisor-authorisation path (FR-UI-PERM-003). |
| FR-ITEM-005 | P0 | If the requested quantity exceeds known stock, the line shows a non-blocking warning with the available figure. **The client never blocks the sale on its own stock figure** — the server decides (ADR-006). |
| FR-ITEM-006 | P0 | `Tab`/`Shift+Tab` move through editable cells in a predictable order; `Enter` in the last cell returns focus to search. |
| FR-ITEM-007 | P0 | Removing a line requires one click and is undoable for ~5 seconds via an inline undo, not a confirmation dialog. |
| FR-ITEM-008 | P1 | Lines can be reordered; S.No always renumbers to stay contiguous. |
| FR-ITEM-009 | P0 | A line whose product has become inactive is flagged on the row with a clear fix path (remove the line). |

### 5.5 The two billing actions (`FR-SALE`, `FR-CREDIT` — client side)

#### Action A — Print Bill (cash sale)

| ID | P | Requirement |
|---|---|---|
| FR-SALE-020 | P0 | `Print Bill` validates locally (non-empty, all cells valid), then submits to `POST /sales:finalize` with `sale_type: cash`, a **single idempotency key generated for this attempt**, and `client_computed_total` as a cross-check. |
| FR-SALE-021 | P0 | While the request is in flight the button shows a busy state and **cannot be pressed again**. The bill is read-only during submission. |
| FR-SALE-022 | P0 | On `201`, the server's invoice is stored, the browser print dialog opens with the print layout, and the draft tab closes into a confirmation state showing the invoice number with a `Reprint` action. |
| FR-SALE-023 | P0 | **The invoice is recorded whether or not printing succeeds.** A failed or cancelled print never retries the sale; it only reopens the print dialog (E-8). |
| FR-SALE-024 | P0 | `Reprint` re-renders from the stored invoice via `GET /invoices/{id}/print-payload`. **It never calls a finalisation endpoint.** |
| FR-SALE-025 | P0 | Each documented backend error gets a specific UI response — see §6.1. No raw error text or status code is ever shown to a counter user. |
| FR-SALE-026 | P0 | If the response is lost (timeout/network/503), the attempt moves to a **"Not yet confirmed"** state with the same idempotency key retained, and the UI tells the user plainly not to hand over a final bill yet (E-1). |
| FR-SALE-027 | P0 | A new idempotency key is generated **only** when the user changes the bill. Every retry of the same intent reuses the original key. |
| FR-SALE-028 | P0 | The action is refused while offline, with the documented message and an offer to print an un-numbered counter slip (FR-OFFLINE-002). |

#### Action B — `Credit Bill`

> **⚠️ Superseded design — do not reinstate.** An earlier Phase 1 draft required the cashier to pass
> through a **mandatory credit-details page** before the sale was finalised. **The owner replaced
> that workflow on 2026-10-29.** **`Credit Bill`** now **finalises the credit sale immediately**.
> There is no mandatory intermediate page, and the action is **not** a draft-save (that is
> `Save a Draft`, FR-BILL-013). See [OD-21](../../bmbackend/docs/OWNER-DECISIONS.md#od-21).
> **The label is now `Credit Bill`** ([OD-14](../../bmbackend/docs/OWNER-DECISIONS.md#od-14) re-answered); the behaviour is unchanged.

| ID | P | Requirement |
|---|---|---|
| FR-CREDIT-020 | P0 | **`Credit Bill`** **finalises the credit sale immediately**, in one request, with **no mandatory intermediate page or form**. Stock is reduced and an **internal** sale reference is allocated as part of that finalisation — **no customer-visible invoice number is produced or displayed** ([OD-3](../../bmbackend/docs/OWNER-DECISIONS.md#od-3)). It is never a draft-save and is never silently queued for later finalisation. |
| FR-CREDIT-021 | P0 | Before the action is enabled the client requires only: (a) a **persisted customer with a stable `customer_id`**, and (b) a valid, non-empty bill. **No other customer field is mandatory** for a credit sale (FR-CUST-010). |
| FR-CREDIT-022 | P0 | The customer is chosen **inline on the billing screen's existing header field** (FR-BILL-010) — search by name, phone, business name or vehicle. A new customer can be created inline from that field with a **client-generated UUID** and a **name alone** (FR-CUST-003, FR-CUST-010). No navigation away from the bill. |
| FR-CREDIT-023 | P0 | Likely duplicate customers are surfaced for the user to choose from. The client never merges or silently reuses a record (FR-CUST-004). |
| FR-CREDIT-024 | P0 | Submits to the **same** `POST /sales:finalize` endpoint with `sale_type: credit`, using the **same authoritative engine as a cash sale**. There is no separate credit finalisation path, client-side or server-side (C-6, FR-SALE-009). |
| FR-CREDIT-025 | P0 | An initial payment is **optional** and is **not** requested at save time. When supplied it rides in the same finalisation request and commits atomically. When omitted the invoice is simply `unpaid` and payment is collected later from Credit Bills (FR-RPT-024). |
| FR-CREDIT-026 | P0 | **Wording must distinguish four outcomes:** `Clear Draft` = draft discarded, nothing sold · `Save a Draft` = draft kept, nothing sold · **`Credit Bill`** = **credit sale completed, stock reduced, amount receivable** · `Print Bill` = cash sale completed and printed. The credit confirmation states the **customer, outstanding amount, due date** and **"Stock has been updated."** — **not** an invoice number (FR-CREDIT-013). |
| FR-CREDIT-027 | P0 | On success the invoice appears **immediately** under its customer in **Credit Bills** (FR-RPT-028) and in **Daily Bills** for its sale date, with no further cashier action. |
| FR-CREDIT-028 | P0 | A credit sale without an identified customer is impossible: the action stays **disabled** with an inline explanation naming what is missing. The server independently rejects it with `CREDIT_CUSTOMER_REQUIRED` (FR-CUST-002). |
| FR-CREDIT-029 | P0 | **Printing is not required at save time.** No print dialog opens. The finalised credit invoice remains permanently viewable and printable from Credit Bills and Daily Bills. |
| FR-CREDIT-030 | P0 | A credit invoice printed later uses the **same approved bill layout as a cash invoice** (`UI-UX-SPECIFICATION.md §12`). Cash and credit differ only in the payment/outstanding information the payload carries — **never in the design of the document**. |
| FR-CREDIT-031 | P0 | Optional header fields the cashier *did* fill (vehicle, mechanic, phone, business name, notes) are **carried into the finalisation request and preserved on the invoice**; they are never discarded because they were optional. |

### 5.6 Daily Bills and Credit Bills (`FR-RPT` — client side)

| ID | P | Requirement |
|---|---|---|
| FR-RPT-020 | P0 | **Daily Bills** lists invoices for a selected date or range, defaulting to today, with counts and totals, filters by counter and payment method, and a row-expand showing line items. |
| FR-RPT-021 | P0 | **Credit Bills** presents credit invoices **grouped customer-wise** (FR-RPT-028), each showing status (unpaid / partially paid / paid), outstanding amount, due date, ageing bucket and payment history. |
| FR-RPT-028 | P0 | **Credit Bills is a two-level view: customers → that customer's individual invoices.** Grouping is **visual only**, over individual invoice records linked by stable `customer_id`. No per-customer folder, table or physical directory is created. Expanding a customer lists their invoices, each with its own number, date, total, amount paid, outstanding and status. |
| FR-RPT-029 | P0 | Grouping is keyed on **`customer_id`, never on the customer-name string**. Renaming a customer re-labels the group and **breaks no invoice association** (FR-CUST-011). |
| FR-RPT-030 | P0 | The view shows **per-customer outstanding totals** and an **overall outstanding total**, both rendered from server-computed values — never summed client-side as authoritative (ADR-032). |
| FR-RPT-031 | P0 | **Fully paid credit invoices remain visible** in the customer's invoice history, visually distinguished by `payment_status`. A customer with zero outstanding still appears, shown as settled, with their invoices intact. A `Show settled` filter may default to hiding them in the *outstanding* view, but history is never deleted or hidden permanently. |
| FR-RPT-032 | P0 | Each invoice in the list offers **View** and **Print** (same approved layout, FR-CREDIT-030) and, with permission, **Record payment** (FR-RPT-024). |
| FR-RPT-033 | P0 | Each invoice exposes its **payment history**: every payment's amount, method, date/time, recording user and reference, derived from server allocation records (FR-PAY-002). |
| FR-RPT-022 | P0 | Both read the **same invoice API**; they are two views of one dataset. Credit sales appear in Daily Bills for their sale date (FR-RPT-001/003). |
| FR-RPT-023 | P0 | Status is **always rendered from the server's `payment_status`**. There is **no checkbox, toggle or editable field for paid status anywhere in the UI** (FR-CREDIT-003). |
| FR-RPT-024 | P0 | Recording a payment is an explicit action with amount, method, reference and allocation choice, submitted with an idempotency key. |
| FR-RPT-025 | P0 | Every invoice row offers `View` and `Reprint`. `Cancel` appears only for users with the permission and only within the cancellation window. |
| FR-RPT-026 | P1 | Cancelled invoices are visible, visually distinct, and excluded from revenue totals with a separate count. |
| FR-RPT-027 | P1 | Lists are paginated via the API cursor with an infinite-scroll or explicit "load more" affordance — never a full-dataset fetch. |

### 5.7 Other modules (`FR-MOD`)

Designed now, built after billing. Navigation and screen specs in
`docs/UI-UX-SPECIFICATION.md §6–§11`.

| ID | P | Module |
|---|---|---|
| FR-MOD-001 | P1 | **Product catalog** — list, search, create, edit, aliases, deactivate |
| FR-MOD-002 | P1 | **Stock** — position, low-stock list, product ledger, reasoned adjustments |
| FR-MOD-003 | P1 | **Purchases** — suppliers, goods receipt entry, explicit confirm step |
| FR-MOD-004 | P1 | **Customers** — list, detail with ledger, duplicate resolution |
| FR-MOD-005 | P1 | **Credit collection** — payment recording, allocation, ageing |
| FR-MOD-006 | P1 | **Imports** — upload with intent selection, per-row review table, apply, report |
| FR-MOD-007 | P1 | **Reports** — daily sales, credit ageing, stock, item sales, counter reconciliation, CSV export |
| FR-MOD-008 | P1 | **Settings** — business details, counters, users, devices, invoice series, tax configuration |
| FR-MOD-009 | P1 | **Sync & conflicts** — pending operations, conflicted items, resolution UI |
| FR-MOD-010 | P2 | **Returns** — select invoice, choose items and quantities, credit handling |

**None of these appear on the billing screen.** The billing counter stays a single-purpose screen.

### 5.8 Offline behaviour (`FR-OFFLINE` — client side)

Protocol owned by `../../bmbackend/docs/OFFLINE-SYNCHRONIZATION.md`.

| ID | P | Requirement |
|---|---|---|
| FR-OFFLINE-001 | P0 | Offline, the user can: open the app, search the cached catalog, and create/edit/switch/delete draft bills and new customers. |
| FR-OFFLINE-002 | P0 | Offline, the user **cannot** finalise a sale, record a payment, confirm a purchase, create a return or apply an import. Those actions are visibly disabled with the reason stated. |
| FR-OFFLINE-003 | P0 | All drafts and queued operations live in IndexedDB and survive refresh, browser restart and crash (FBO-2). |
| FR-OFFLINE-005 | P0 | The sync panel shows every operation's state — pending, accepted, conflicted, rejected — and conflicted/rejected items remain visible until the user acts. Nothing is dropped silently. |
| FR-OFFLINE-006 | P0 | A draft conflict opens a resolution UI showing both versions with keep-mine / keep-theirs / compare. **No automatic merge.** |
| FR-OFFLINE-009 | P0 | Every cached stock figure and price is labelled with its `as_of` time, and the UI states that stock is confirmed only at finalisation. |
| FR-OFFLINE-010 | P0 | On `DEVICE_REVOKED` the app stops syncing and shows a blocking message, but **never deletes local data**. |
| FR-OFFLINE-012 | P0 | Sync is attempted on reconnect, on focus, on a timer, after each local mutation (debounced), and on explicit user action. Background Sync is only an additional opportunistic trigger. |
| FR-OFFLINE-014 | P0 | The network/sync indicator is always visible and unambiguous: Online · Syncing (n) · Offline (n pending) · Conflicts (n) · Not confirmed (n). |
| FR-OFFLINE-015 | P0 | Offline, the user can print an **un-numbered counter slip** clearly watermarked as not an invoice (E-1). |

### 5.9 Printing (`FR-PRINT` — client side)

| ID | P | Requirement |
|---|---|---|
| FR-PRINT-010 | P0 | The print layout renders `print_payload` from the server **verbatim**. The client adds no business field, computes no total, and invents no header text. |
| FR-PRINT-011 | P0 | The document title comes from `print_payload.document_title`. The string "Tax Invoice" **never appears as a literal in the frontend source** (FR-TAX-004). |
| FR-PRINT-012 | P0 | When `totals.tax` is `null`, **no tax row is rendered** — not a zero. |
| FR-PRINT-013 | P0 | The layout reproduces the **observed** portion of the Excel reference: shop heading, address/contact, the customer / mechanic / vehicle / date block, the `ESTIMATE` label in its observed position, and the **`S R | ITEM | QTY | PRICE | TOTAL`** table. The bill's **lower section remains `[UNSEEN]`** and must not be invented ([OD-5](../../bmbackend/docs/OWNER-DECISIONS.md#od-5)). Spec in `docs/UI-UX-SPECIFICATION.md §12`. |
| FR-PRINT-014 | P0 | Print styling is isolated from application styling: a dedicated print root and `@media print` rules, so changing the app's look cannot change the bill. |
| FR-PRINT-015 | P0 | Reprints render the `DUPLICATE COPY` marking when the payload says so, and log a print event (best-effort; a logging failure never blocks printing). |
| FR-PRINT-016 | P1 | Target paper size is configurable (A5/A4) via `@page`, defaulting to the owner-confirmed value ([OD-6](../../bmbackend/docs/OWNER-DECISIONS.md#od-6)). |
| FR-PRINT-017 | P0 | **Amount display** ([OD-23](../../bmbackend/docs/OWNER-DECISIONS.md#od-23), **amended**): `PRICE` and `GRAND TOTAL` print with **no decimal places** (`240`, `3850`). The line `TOTAL` column follows the same rule *(inference from the original bill, not an owner instruction)*. No thousands separators, no currency symbol. Unused rows print **blank**. **Formatting is presentation only — it never alters a stored value.** ⚠️ **If a stored amount carries paise, zero-decimal display would misstate the bill: raise a validation warning and do NOT silently round** (recorded conflict in OD-23; `BLOCKS-GO-LIVE` until the owner resolves it). |
| FR-PRINT-018 | P0 | **Empty rows print blank** ([OD-23](../../bmbackend/docs/OWNER-DECISIONS.md#od-23)). The reference's `0` in `TOTAL` is **not** reproduced. *(The original's `0`s are hand-typed literals, not formula output — verified 2026-10-30.)* |
| ~~FR-PRINT-019~~ | ❌ **RETIRED** | **No invoice number is printed.** [OD-3](../../bmbackend/docs/OWNER-DECISIONS.md#od-3) is re-answered — *"No need of invoice numbering."* `print_payload` no longer carries one, the client must not render one, and **no substitute visible numbering scheme may be invented**. A structural test asserts no invoice number is rendered. Revives only if [OD-25](../../bmbackend/docs/OWNER-DECISIONS.md#od-25) establishes a statutory requirement. |
| FR-PRINT-020 | P0 | **Credit bills print payment and balance information** ([OD-22](../../bmbackend/docs/OWNER-DECISIONS.md#od-22)), faithfully reflecting the backend's recorded payments and outstanding balance. The client never computes or restates them. **Cash bills do not carry this block** unless the owner later asks for it. Placement is `[PROPOSED]`. |
| FR-PRINT-021 | P0 | **The document label is `ESTIMATE` for cash and credit alike** ([OD-24](../../bmbackend/docs/OWNER-DECISIONS.md#od-24)), rendered from `print_payload.document_title`. `BILL`, `INVOICE` and `TAX INVOICE` are **not** used as substitutes. Final terminology still requires owner/accountant confirmation and remains a go-live blocker. |

### 5.10 Authentication (`FR-AUTH` — client side)

| ID | P | Requirement |
|---|---|---|
| FR-AUTH-010 | P0 | The access token is held **in memory only**. Never `localStorage`, never `sessionStorage`, never a non-`HttpOnly` cookie. |
| FR-AUTH-011 | P0 | Refresh happens transparently via the `HttpOnly` cookie. A single refresh is shared by concurrent 401s (no refresh storm), and the original requests are retried once. |
| FR-AUTH-012 | P0 | On refresh failure the user is prompted to log in, **with all drafts intact**. Re-authenticating returns them to the same bill. |
| FR-AUTH-013 | P0 | Login errors are specific and actionable: wrong credentials, account locked with a countdown, device revoked, user inactive. |
| FR-AUTH-014 | P1 | Quick user switch via PIN on a trusted device, for shift changes, with the acting user always visible in the top bar. |
| FR-AUTH-015 | P0 | A stable `device_id` is generated once per browser profile, persisted locally, and sent on every request. |

---

## 6. Error handling and edge cases

### 6.1 Backend error code → UI behaviour

Every code in `../../bmbackend/docs/API-SPECIFICATION.md §4.2` has a defined presentation. The
non-obvious ones:

| Code | UI behaviour |
|---|---|
| `INSUFFICIENT_STOCK` | Inline panel listing each short line with requested vs available, a "set to available" quick action per line, and — for permitted users — an override path requiring a reason |
| `PRICE_CHANGED` | Panel listing draft price vs current price per line, with `Accept new prices` and `Keep editing`. Never auto-accepts. |
| `DRAFT_VERSION_CONFLICT` | Conflict resolution UI with both versions side by side |
| `DRAFT_ALREADY_FINALIZED` | "This bill was already completed as invoice `<number>`" with View/Reprint. **No retry affordance.** |
| `DRAFT_LIMIT_REACHED` | Explains the limit, lists open bills, offers to finalise or discard one |
| `IDEMPOTENT_REQUEST_IN_PROGRESS` | Keeps the busy state and retries with backoff; the user sees "Still confirming…" |
| `IDEMPOTENCY_KEY_REUSE` | Treated as a client bug: logs to error reporting, shows a generic "Please reload this bill" and refetches server state |
| `TOTAL_MISMATCH` | Refetches the draft and shows "Prices were updated — please check the bill". Never silently resubmits. |
| `PERMISSION_DENIED` / `OVERSELL_NOT_PERMITTED` / `PRICE_OVERRIDE_NOT_PERMITTED` | Explains what is needed and offers supervisor authorisation (FR-UI-PERM-003) |
| `CREDIT_LIMIT_EXCEEDED` | Shows limit, current outstanding and this bill; offers override where permitted |
| `PRODUCT_INACTIVE` | Flags the exact line with a remove action |
| `DEVICE_REVOKED` | Full-screen blocking message with contact guidance. **Local data retained.** |
| `RATE_LIMITED` | Quiet retry with backoff for searches; explicit countdown for login |
| `SERVICE_UNAVAILABLE` / network error on finalise | "Not yet confirmed" state, outbox retry, counter-slip offer |
| `INTERNAL_ERROR` | Friendly message plus the `request_id` in a copyable form, so the owner can read it out when reporting |

### 6.2 Client-side edge cases

| ID | Situation | Behaviour |
|---|---|---|
| FE-E-1 | IndexedDB unavailable or quota exceeded | Blocking warning that offline safety is off; billing continues online-only. Never silently degrade — the user must know drafts are at risk. |
| FE-E-2 | Two browser tabs open on the same counter | A cross-tab lock elects one owner for sync and draft writes; the other tab is read-only with a clear banner. Prevents two tabs fighting over one draft. |
| FE-E-3 | Clock wrong on the counter machine | All displayed business times come from the server; the client never derives an invoice date. |
| FE-E-4 | Stale cached app after a deploy | `GET /api/v1/meta` version check prompts a reload at a safe moment (no bill in flight). |
| FE-E-5 | User closes the tab with a pending finalisation or unsynced drafts | `beforeunload` warning naming the count of at-risk items. |
| FE-E-6 | Print dialog cancelled | Invoice remains; `Reprint` stays available. No resubmission. |
| FE-E-7 | Very long product names | Truncated with ellipsis and a tooltip on screen; **wrapped in full on the printed bill**. |
| FE-E-8 | Slow network (not offline) | Search shows a spinner after 300 ms; finalisation shows progressive messaging and never times out silently. |
| FE-E-9 | Session expires mid-bill | Transparent refresh; if that fails, a login prompt with the draft preserved. |
| FE-E-10 | Browser zoom or small screen | Layout remains usable to 1280×720; the item table scrolls internally rather than breaking the page. |

---

## 7. Non-functional requirements

### 7.1 Performance (`NFR-FE-PERF`)

| ID | Requirement | Measured by |
|---|---|---|
| NFR-FE-PERF-001 | Keystroke to visible search results p95 ≤ 250 ms on the shop LAN (includes the 150 ms server budget) | Playwright timing + RUM |
| NFR-FE-PERF-002 | Adding a line and recalculating totals ≤ 50 ms, no visible lag | Component benchmark |
| NFR-FE-PERF-003 | Switching bill tabs ≤ 100 ms (local state only) | E2E timing |
| NFR-FE-PERF-004 | First contentful paint ≤ 1.5 s on a cold cache, ≤ 500 ms warm | Lighthouse |
| NFR-FE-PERF-005 | Initial JS bundle ≤ 300 KB gzipped; routes beyond billing are lazy-loaded | Bundle size check in CI |
| NFR-FE-PERF-006 | 20 open bills with 20 lines each remain responsive | E2E stress test |
| NFR-FE-PERF-007 | Print preview renders ≤ 500 ms | E2E timing |

### 7.2 Accessibility (`NFR-FE-A11Y`)

| ID | Requirement |
|---|---|
| NFR-FE-A11Y-001 | WCAG 2.2 AA for colour contrast (4.5:1 text, 3:1 UI components and focus indicators) |
| NFR-FE-A11Y-002 | **Every billing task is completable with the keyboard alone** — this is a speed requirement as much as an accessibility one |
| NFR-FE-A11Y-003 | Visible focus indicator on every interactive element; never `outline: none` without a replacement |
| NFR-FE-A11Y-004 | All form controls have programmatically associated labels; placeholders are never the only label |
| NFR-FE-A11Y-005 | Errors are announced via `aria-live` and associated with their field via `aria-describedby` |
| NFR-FE-A11Y-006 | The item table is a real `<table>` with proper headers and scope |
| NFR-FE-A11Y-007 | Base font ≥ 14 px, body text ≥ 15 px; the item table and totals are larger. Nothing important is below 14 px. |
| NFR-FE-A11Y-008 | Interactive targets ≥ 40×40 px |
| NFR-FE-A11Y-009 | Status is never conveyed by colour alone — always colour plus text or icon |
| NFR-FE-A11Y-010 | `prefers-reduced-motion` respected; no animation exceeds 200 ms anywhere |
| NFR-FE-A11Y-011 | Automated axe checks on every screen in CI, with zero serious or critical violations |

### 7.3 Usability (`NFR-FE-UX`)

| ID | Requirement |
|---|---|
| NFR-FE-UX-001 | Plain language. No jargon, no technical terms, no HTTP status codes shown to users. |
| NFR-FE-UX-002 | Every error states what happened **and what to do next**. |
| NFR-FE-UX-003 | Every destructive action is either undoable or confirmed — never both silent and irreversible. |
| NFR-FE-UX-004 | No action requires more than 3 interactions from the billing screen. |
| NFR-FE-UX-005 | Loading states are skeletons or inline spinners, never a blank screen or a layout jump. |
| NFR-FE-UX-006 | Consistent placement across screens: primary action bottom-right of its context, filters top, status top-right. |
| NFR-FE-UX-007 | No gradients, no decorative animation, no oversized imagery, no icon-only primary navigation. |
| NFR-FE-UX-008 | A user can always answer "is this bill saved? synced? finalised?" from what is on screen. |

### 7.4 Security (`NFR-FE-SEC`)

| ID | Requirement |
|---|---|
| NFR-FE-SEC-001 | **No secret, database credential or privileged key exists in this repository or any bundle.** The only configuration is the API base URL and public flags. |
| NFR-FE-SEC-002 | Tokens never in `localStorage`/`sessionStorage`; access token in memory, refresh in an `HttpOnly` cookie. |
| NFR-FE-SEC-003 | A strict Content-Security-Policy with no `unsafe-inline` scripts and no third-party script origins. |
| NFR-FE-SEC-004 | No `dangerouslySetInnerHTML` with server or user data. Any exception needs an ADR and sanitisation. |
| NFR-FE-SEC-005 | Permission-based hiding is UX only; the client assumes the server enforces everything. |
| NFR-FE-SEC-006 | No PII or token in logs, analytics or error reports; a scrubber runs before any report is sent. |
| NFR-FE-SEC-007 | No cost price or margin is ever rendered or derived. |
| NFR-FE-SEC-008 | Dependency audit in CI; high/critical blocks release. |

### 7.5 Compatibility and maintainability

| ID | Requirement |
|---|---|
| NFR-FE-COMP-001 | Chrome and Edge (current and current-1) fully supported; Firefox functional; Safari best-effort. Print fidelity guaranteed on Chrome/Edge only (Q-FE-1). |
| NFR-FE-COMP-002 | Usable from 1280×720 up; optimised for 1920×1080. Tablet layout is P2; phone is out of scope for billing. |
| NFR-FE-MAINT-001 | TypeScript `strict`; no `any` in application code without a justified, commented exception. |
| NFR-FE-MAINT-002 | **API types are generated from the backend OpenAPI document and never hand-written.** |
| NFR-FE-MAINT-003 | Lint, type-check and tests pass in CI with zero errors. |
| NFR-FE-MAINT-004 | All user-facing strings externalised in one place (enables review by the owner and future translation). |

---

## 8. Workflows and state

### 8.1 Draft bill state (client)

```
   new ──► editing ──► submitting ──┬──► finalized   (invoice received, tab closes to confirmation)
            ▲   │                   ├──► conflict    (409 business rule → resolution UI → editing)
            │   │                   └──► unconfirmed  (response lost → retry same key → finalized)
            │   └──► discarded (explicit, confirmed)
            └──── conflict resolved
```

`submitting` is read-only. `unconfirmed` is loud, persistent across reloads, and the only state in
which a counter slip may be printed instead of an invoice.

### 8.2 Sync state (per operation)

```
local ──► queued ──► in_flight ──┬──► accepted (dropped from outbox)
                                  ├──► replayed (dropped, not an error)
                                  ├──► conflicted (visible until resolved)
                                  └──► rejected   (visible until acknowledged)
```

### 8.3 Cash sale happy path

```
focus search → type → ↓/↑ → Enter (line added, focus back to search)
  → repeat → adjust qty if needed → optionally fill customer/vehicle
  → Print Bill → busy → 201 → print dialog → confirmation with invoice number
```

Target: 5 lines in under 60 seconds, keyboard only (FBO-1).

### 8.4 Credit sale path *(revised 2026-10-29 — OD-21 / ADR-033)*

```
...lines entered → customer chosen in the bill header (name search or inline create)
  → Credit Bill  (Ctrl+Shift+Enter)
  → ONE POST /sales:finalize { sale_type: "credit" }      ← no intermediate page
  → 201: stock reduced, invoice number allocated, outstanding recorded
  → confirmation card: invoice no · outstanding · "Stock has been updated."
       [ Print now ]  [ View in Credit Bills ]  [ New bill ]
  → appears immediately in Credit Bills (under that customer) and Daily Bills (today)
```

Payment is collected later from Credit Bills; it is **not** requested at save time. No print dialog
opens. The **superseded** flow — a mandatory credit-details step collecting business name, vehicle,
mechanic, phone, terms, due date and notes before finalising — **must not be reinstated.**

---

## 9. Acceptance criteria

Shared criteria AC-1…AC-12 are in `../../bmbackend/docs/PRD.md §10`. Frontend-specific:

| ID | Criterion |
|---|---|
| AC-FE-1 | A 5-line cash bill is completed and printed using only the keyboard, in under 60 seconds, by someone who has seen the screen once |
| AC-FE-2 | 20 bills are open; the browser is force-closed and reopened; all 20 are present with every line and header field intact |
| AC-FE-3 | With the network disabled, bills can be created and edited; `Print Bill` is disabled with the documented explanation; a counter slip prints |
| AC-FE-4 | A finalisation whose response is dropped shows "Not yet confirmed", survives a reload, and on reconnect yields exactly one invoice |
| AC-FE-5 | Each of `INSUFFICIENT_STOCK`, `PRICE_CHANGED`, `DRAFT_VERSION_CONFLICT`, `DRAFT_ALREADY_FINALIZED` produces its specified UI, verified by E2E tests with a mocked API |
| AC-FE-6 | The printed output matches the owner's Excel invoice on the real printer and paper, signed off by the owner |
| AC-FE-7 | Printing fails or is cancelled; the invoice still exists and reprints correctly; no second sale is created |
| AC-FE-8 | axe reports zero serious/critical violations on every screen; every billing task is keyboard-completable |
| AC-FE-9 | A draft edited offline on one device and online on another produces a conflict UI, and neither version is lost |
| AC-FE-10 | A grep of the source finds **no** `localStorage`/`sessionStorage` token write, **no** literal "Tax Invoice", and **no** paid-status input control |
| AC-FE-11 | Totals are computed with decimal arithmetic: a bill of `0.1 + 0.2`-style values displays exactly, and matches the server to the paisa |
| AC-FE-12 | With the API returning 500 for search, the typed query is preserved and a retry affordance is shown |

---

## 10. Dependencies and priority

```
2A  Shell        auth, routing, API client, error envelope handling, permission gating
2B  Billing      search, bill tabs, item table, totals, draft persistence   ← highest value
2C  Finalise     cash sale, idempotency, error states, print layout         ← needs backend 2D
2D  Credit       credit step, customer create/search, payment capture
2E  Lists        Daily Bills, Credit Bills, invoice detail, reprint
2F  Offline      IndexedDB, outbox, sync panel, conflict UI, counter slip
2G  Stock        stock position, ledger, adjustments
2H  Purchases    supplier, goods receipt
2I  Imports      upload, review table, apply
2J  Reports      reports and exports
2K  Settings     business, users, counters, devices, tax
2L  Polish       a11y audit, performance, print verification on real hardware
```

Backend dependencies: 2B needs `/products/search` and `/drafts`; 2C needs `/sales:finalize` and
`/invoices/{id}/print-payload`; 2F needs `/sync/*`. **The frontend must not stub a business rule to
unblock itself** — it mocks the API at the contract boundary instead.

---

## 11. Out of scope for v1

Offline sale finalisation; a phone-optimised billing layout; customer-facing views; theming or dark
mode; in-app chat or support; client-side report computation; barcode label printing; multi-language
UI; keyboard macros; custom print designer.

## 12. Future enhancements

Tablet-optimised billing; dark mode; configurable print templates; barcode scanning verified on real
hardware; saved search shortcuts for frequently sold parts; owner mobile summary view; WhatsApp bill
sharing; voice-free quick-entry macros for common part sets.

## 13. Release and production-readiness gates

1. **The printed bill is verified against the owner's actual Excel invoice, on the real printer and
   paper, and signed off.**
2. All AC-FE-* criteria pass.
3. axe: zero serious/critical violations on every screen.
4. Performance budgets met on a counter-spec machine, not a developer laptop.
5. A real offline drill: 10 minutes disconnected during a shift, then reconnect — every bill
   finalises exactly once.
6. Staff trained on: reprint vs new sale, the "Not yet confirmed" state and counter slips, and what
   offline does **not** allow.
7. No `localStorage` token, no literal "Tax Invoice", no paid-status control (AC-FE-10).
8. Only `VITE_API_BASE_URL` and public flags in the environment; secret scan clean.
9. No high/critical dependency vulnerabilities.
10. Service worker update strategy verified: a deploy reaches counter machines without a manual
    cache clear.

---

## 14. Related documents

| Document | Contents |
|---|---|
| `docs/ARCHITECTURE.md` | Structure, state boundaries, API client, PWA, draft persistence |
| `docs/UI-UX-SPECIFICATION.md` | Every screen, plus the Excel-based print layout |
| `docs/API-INTEGRATION.md` | Client view of the API contract, idempotency, retries, sync |
| `docs/TESTING-STRATEGY.md` | Component, integration, E2E, offline, a11y, print tests |
| `docs/DECISIONS.md` | ADR-023…032 plus stubs for backend-owned ADRs |
| `../../bmbackend/docs/PRD.md` | **Authoritative** business rules and open questions |
| `../../bmbackend/docs/API-SPECIFICATION.md` | **Authoritative** API contract |
| `../../bmbackend/docs/TRACEABILITY.md` | **The single** traceability matrix |

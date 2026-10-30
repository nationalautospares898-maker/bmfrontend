# UI/UX Specification — `bmfrontend`

> **Current Phase 2 design disposition (2026-10-30):** [Backend Design Completion Addendum](../../bmbackend/docs/PHASE-2-DESIGN-COMPLETION-ADDENDUM-2026-10-30.md) is the current cross-cutting decision record. It resolves superseded open labels and defines the Phase 3 implementation baseline. Historical closure reports/addenda remain unchanged; legal, physical and operational gates remain gates. It does not represent implementation or test completion.


| Field | Value |
|---|---|
| Status | **Phase 1 proposal — no UI exists yet.** §12 updated 2026-10-30 from the owner's workbook |
| Primary user | Counter staff with little computer experience, on a desktop, under time pressure |
| Last updated | 2026-10-30 |

> **§12 (the printed bill) is the only part of this document that follows the Excel reference.**
> Everything else is a modern, restrained application interface. The application must **not** look
> like a spreadsheet.
>
> ## ✅ §12 — LAYOUT VERIFIED FROM THE WORKBOOK (2026-10-30) · PAGE SETUP STILL OPEN
>
> **The owner's original workbook `ANAS_1234_20260606_231456.xlsx` has been supplied and inspected
> part by part.** Every cell value, merged range, column width, row height, font, point size,
> colour, border, number format and embedded image has been **read from the file**. §12.1 is no
> longer a transcription from a screenshot nor a reconstruction from a description.
>
> *(The owner's file was copied, never modified. Full inspection record:
> [PHASE-2-CLOSURE-ADDENDUM-2.md](../../bmbackend/docs/PHASE-2-CLOSURE-ADDENDUM-2.md).)*
>
> **Verified:** `A1:E37` · 12 merged ranges · **25 item rows (9–33)** · `GRAND TOTAL` row 34 ·
> `THANK YOU  VISIT AGAIN` · `Authorised Dealers of :` · ` TATA - LEYLAND SPARE PARTS` ·
> **both logo images** · Calibri throughout · navy `#232852` headers · **zero formulas**.
>
> **The column header is `QTY`** — the screenshot's `QT` was a truncated render of a 3.33-character
> column with `shrinkToFit` set. The earlier instruction to keep `QT` is **withdrawn**.
>
> **🔴 Still unknown — the workbook never set them:** **print area, paper size, orientation and
> scaling** are absent from the file entirely ([OD-6](../../bmbackend/docs/OWNER-DECISIONS.md#od-6)),
> and the date order is now a recorded question
> ([OD-26](../../bmbackend/docs/OWNER-DECISIONS.md#od-26)).
>
> **❌ No invoice number is printed** anywhere on this bill
> ([OD-3](../../bmbackend/docs/OWNER-DECISIONS.md#od-3) re-answered: *"No need of invoice
> numbering."*).
>
> **The LAYOUT may now be described as verified. PRINTING may not.** Elements are classified
> `[VERIFIED]` / `[PROPOSED]` in §12.2a.
> [OD-5](../../bmbackend/docs/OWNER-DECISIONS.md#od-5) is **RESOLVED**; print-fidelity sign-off on a
> real printed sample remains a go-live gate under
> [OD-6](../../bmbackend/docs/OWNER-DECISIONS.md#od-6).

---

## 1. Design principles

1. **The billing counter is the product.** Every other screen is support. If a change makes billing
   slower, it is wrong.
2. **Keyboard first.** A whole bill must be completable without the mouse — this is a speed
   requirement, not only accessibility.
3. **Say what happened and what to do next.** No status codes, no jargon, no dead ends.
4. **Never hide state.** A user can always tell whether a bill is saved, synced, or finalised.
5. **Restraint.** No gradients, no decorative motion, no icon-only navigation, no card soup. Flat
   surfaces, clear borders, generous spacing, readable type.
6. **Inline over modal.** Modals only for: **conflict resolution, destructive confirmation
   (including `Clear Draft`), and supervisor authorisation**. ⚠️ *"Credit details" is deliberately
   NOT on this list* — that step was removed by OD-21/ADR-033 and must not be reinstated (T3-05).
7. **Big enough to read across a counter.** Body text 15 px, the item table and totals larger.
8. **Undo beats confirm.** Prefer a 5-second undo over a dialog, except where the action is truly
   irreversible.

---

## 2. Visual system

### 2.1 Colour

One neutral ramp, one accent, three semantic colours. Nothing else.

| Token | Light value | Use |
|---|---|---|
| `bg` | `#FFFFFF` | Page |
| `surface` | `#F7F8F9` | Panels, table header |
| `border` | `#E2E5E9` | Dividers, inputs |
| `border-strong` | `#C4C9D0` | Focused/active borders |
| `text` | `#1A1D21` | Primary text |
| `text-muted` | `#5B626B` | Labels, secondary |
| `accent` | `#1D4ED8` | Primary actions, focus ring, links |
| `accent-hover` | `#1A43B8` | — |
| `success` | `#107A3D` | Paid, synced, confirmed |
| `warning` | `#9A5B00` | Low stock, pending, unsynced |
| `danger` | `#B3261E` | Errors, destructive, unpaid/overdue |

All text/background pairs meet 4.5:1; borders and focus rings meet 3:1 (NFR-FE-A11Y-001).
**Status is never colour-only** — always a word or icon alongside (NFR-FE-A11Y-009).

Dark mode is out of scope for v1 (`PRD.md §11`).

### 2.2 Typography

System UI stack (`-apple-system, Segoe UI, Roboto, sans-serif`) — no webfont, so nothing blocks
first paint or print.

| Role | Size / weight |
|---|---|
| Page title | 22 px / 600 |
| Section heading | 17 px / 600 |
| Body, labels | 15 px / 400 |
| **Item table cells** | **16 px / 400**, numerics tabular |
| **Grand total** | **28 px / 700** |
| Secondary / meta | 13 px / 400, `text-muted` |
| Smallest permitted | 13 px — nothing below it carries meaning |

Numerics use `font-variant-numeric: tabular-nums` so columns of money align.

### 2.3 Spacing, radius, elevation

4 px base scale (4/8/12/16/24/32/48). Radius 6 px (inputs, buttons), 8 px (panels). Elevation only
on genuinely floating layers (dropdown, dialog) — a single soft shadow, never on static panels.

### 2.4 Motion

≤ 200 ms, ease-out, opacity/transform only. Dropdowns and dialogs fade; nothing slides across the
screen. Disabled entirely under `prefers-reduced-motion` (NFR-FE-A11Y-010).

---

## 3. Application shell

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ NATIONAL AUTO SPARES        Main Shop · Counter 1     ● Online    Ravi  ▾      │  56px
├──────────┬─────────────────────────────────────────────────────────────────────┤
│          │                                                                     │
│ Billing  │                                                                     │
│ Daily    │                    ROUTE CONTENT                                    │
│  Bills   │                                                                     │
│ Credit   │                                                                     │
│  Bills   │                                                                     │
│ Stock    │                                                                     │
│ Purchases│                                                                     │
│ Reports  │                                                                     │
│ Settings │                                                                     │
│          │                                                                     │
│ 200px    │                                                                     │
└──────────┴─────────────────────────────────────────────────────────────────────┘
```

- Sidebar: **text labels with icons**, never icon-only (NFR-FE-UX-007). Items the user cannot access
  are hidden. Collapsible to 56 px on narrow screens, labels then shown on hover and in tooltips.
- Top bar: shop name · branch · counter · **sync status** · user menu.
- `F2` jumps to Billing from anywhere; `F3` or `/` focuses search within Billing.

### 3.1 Sync status indicator — always visible

| State | Display | Meaning |
|---|---|---|
| Online | `● Online` green | Connected, nothing pending |
| Syncing | `◐ Syncing 3` accent | Operations in flight |
| Offline | `● Offline · 7 pending` warning | No connection; drafts safe locally |
| Conflicts | `▲ 2 conflicts` danger | Needs the user to choose |
| Not confirmed | `▲ 1 not confirmed` danger | A finalisation awaits confirmation — **highest priority** |

Clicking opens the Sync panel (§10). When "Not confirmed" is present it is shown in preference to
everything else, because it is the only state where a customer may be waiting for a bill.

---

## 4. Billing counter — the primary screen

Route `/billing`. Default landing for billing users (FR-NAV-001).

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ ┌──────────┐┌─────────────┐┌───────────┐┌──────────┐                     ┌──┐ │
│ │ 1 · Imran││ 2 · Walk-in ││ 3 ▲       ││ 4 ●      │  ◄ ►                │ ＋│ │ tabs
│ └──────────┘└─────────────┘└───────────┘└──────────┘                     └──┘ │
├────────────────────────────────────────────────────────────────────────────────┤
│  Search part name or code                                           [F3]       │
│  ┌──────────────────────────────────────────────────────────────────────────┐ │
│  │ brake sho▌                                                               │ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────────────────┐ │
│  │▸ Brake Shoe Set — Tata 407      TT-407-BS   Allied   SET   ₹1,250  4 in │ │
│  │  Brake Shoe Set — Ashok 1109    AL-1109-BS  Allied   SET   ₹1,420  0 ⚠ │ │
│  │  Brake Shoe Rivet                BR-RV-10    —        PCS   ₹   12  200 │ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────────────────────────┤
│  Customer [Imran            ]  Business [Imran Transport ]                     │
│  Vehicle  [KA 01 AB 1234    ]  Mechanic [Suresh          ]  Phone [98……    ]   │
├────────────────────────────────────────────────────────────────────────────────┤
│  S.No │ Item                            │  Qty │ Unit Price │   Total │        │
│  ─────┼─────────────────────────────────┼──────┼────────────┼─────────┼──────  │
│    1  │ Brake Shoe Set — Tata 407       │   2  │  1,250.00  │ 2,500.00│   ✕    │
│       │ TT-407-BS · 4 in stock          │      │            │         │        │
│    2  │ Engine Oil 15W40 · 5L           │   1  │    1,980.00│ 1,980.00│   ✕    │
│       │ EO-15W40-5 · ⚠ only 1 in stock  │      │            │         │        │
│  ─────┴─────────────────────────────────┴──────┴────────────┴─────────┴──────  │
│                                                                                │
│  (empty state: "Start typing a part name above to add it to this bill.")       │
├────────────────────────────────────────────────────────────────────────────────┤
│  2 items · 3 units                        Total                                │
│  Discount  [ 0.00 ]                    ₹ 4,480.00                              │
│                                        preview — confirmed on completion       │
│                                                                                │
│ [Clear Draft] [Save a Draft]   [ Credit Bill ]   [ Print Bill ]                │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Bill tab strip (FR-BILL-004/005/006/007)

- Label: `<number> · <customer name>`, falling back to `<number> · Walk-in` (Q-FE-6).
- Badges: `●` unsynced · `▲` conflict or not-confirmed · nothing when clean and synced.
- 20+ tabs: horizontal scroll with `◄ ►` buttons; `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle;
  `Ctrl+1…9` jump. **No tab is ever unreachable, and none is ever auto-closed.**
- `＋` creates a new bill and focuses search. At the limit it is disabled with:
  *"20 bills are already open. Complete or discard one to start another."* plus a list of open bills
  (FR-BILL-007).
- Switching is instant and local — never a fetch, never a finalisation (FR-BILL-006).

### 4.2 Product search (FR-CAT-003…015)

- Auto-focused on load and after every line is added (FR-BILL-001) — this single behaviour is what
  makes keyboard-only billing possible.
- Results appear from the **first character**, debounced 120 ms, previous request cancelled.
- Each row: name · SKU · brand · unit · price · stock. Zero stock shows `0 ⚠` but is still
  selectable — the server decides, not the client (ADR-006).
- Keyboard: `↓`/`↑` highlight, `Enter` adds, `Esc` closes and clears, `Tab` moves to the table.
- Offline: a banner inside the dropdown — *"Showing cached products (as of 10:42). Some items may be
  missing."*
- No results: *"No product found for 'xyz'."* plus `+ Add new product` for users with
  `catalog.write` (FR-CAT-012).
- Error: *"Couldn't search just now."* with `Retry` — **the typed text is preserved** (FR-CAT-013).
- Selecting a product already on the bill increments its quantity and briefly highlights that row
  (FR-CAT-015).

### 4.3 Header fields (FR-BILL-010)

Inline on the bill, two rows, never behind a dialog. All optional for a cash sale. `Customer`
offers autocomplete against existing customers but accepts free text. Vehicle number is uppercased
for display while the typed form is preserved for printing.

### 4.4 Item table (FR-BILL-003, FR-ITEM-001…009)

A real `<table>` with `<th scope="col">` (NFR-FE-A11Y-006).

| Column | Width | Behaviour |
|---|---|---|
| S.No | 56 px | Auto-renumbered, contiguous |
| Item | flex | Name, with SKU and stock as a 13 px sub-line |
| Qty | 90 px | Editable, right-aligned, numeric input |
| Unit Price | 120 px | Editable (if permitted), right-aligned |
| Total | 120 px | Computed, right-aligned, tabular |
| ✕ | 44 px | Remove, with 5-second inline undo |

- Edit in place: click or tab into the cell and type. **No edit dialog.**
- `Tab`/`Shift+Tab` traverse editable cells; `Enter` in the last cell returns focus to search
  (FR-ITEM-006).
- Validation inline and immediate: qty > 0 and within the unit's decimals; price ≥ 0. The cell gets a
  danger border and a 13 px message below; `Print Bill` is blocked with a specific reason
  (FR-ITEM-003).
- Price override: cell shows a small `edited` marker and the original catalog price on hover. Without
  `billing.price.override` the cell is read-only with a `Get approval` affordance (§4.8).
- Stock warning: `⚠ only 1 in stock` on the sub-line, **non-blocking** (FR-ITEM-005).
- Inactive product: row tinted, message *"This product is no longer available — remove this line."*
- Above 50 lines the table body virtualises; the header stays fixed.

### 4.5 Totals panel (FR-BILL-008)

Right-aligned, prominent. Grand total 28 px bold. Beneath it, 13 px muted:
*"preview — confirmed on completion"* (FR-DRAFT-011, ADR-032). Discount field appears only for users
permitted to discount; a cashier above the cap sees the cap stated inline before submitting.

### 4.6 Action buttons (FR-BILL-009)

| Button | Style | Behaviour |
|---|---|---|
| `Clear Draft` | Ghost, left | Clears the **editable draft** after a confirmation naming the line count. **Never** touches a finalised sale; **disabled while a finalisation is unconfirmed** |
| `Save a Draft` | Secondary | Saves a draft **only** — nothing is sold (FR-BILL-013) |
| `Credit Bill` | Secondary | **Finalises as a credit sale immediately** (§5) — no intermediate page |
| `Print Bill` | **Primary, largest** | Finalises as a cash sale and prints (§4.7) |

**The owner specifies exactly four primary actions** ([OD-14](../../bmbackend/docs/OWNER-DECISIONS.md#od-14), re-answered). Sub-labels:

- `Print Bill` — **"Complete cash sale and print"**.
- `Credit Bill` — **"Record as credit — payment due later"**.
- `Save a Draft` — **"Saves this bill as a draft — nothing has been sold"**.
- `Clear Draft` — **"Clears this draft — it does not undo a completed sale"**.

The old ambiguity is gone at the label level: `Credit Bill` no longer contains the word "save", and
`Save a Draft` says *draft*. **Do not add a fifth primary action.**

`Save a Draft` is a **primary** action (shortcut `Ctrl+S`) — explicitly *"saves this bill as a draft
without selling anything"* (**FR-BILL-013**, FR-CREDIT-026).

**The three actions are mutually exclusive in effect, and the distinction is the requirement:**

| Action | API call | Stock | Invoice | Payment | Internal reference | Prints? |
|---|---|---|---|---|---|---|
| `Clear Draft` | none (local) + `DELETE /drafts/{id}` | unchanged | none | none | none | no |
| `Save a Draft` | `PUT /drafts/{id}` | unchanged | none | none | none | no |
| `Credit Bill` | `POST /sales:finalize` (`sale_type: credit`) | **reduced** | **issued** | none required — collected later | allocated **internally, never printed** | no (optional) |
| `Print Bill` | `POST /sales:finalize` (`sale_type: cash`) | **reduced** | **issued** | full payment | allocated **internally, never printed** | yes |

Both finalising actions use the **same** endpoint and the same server engine — there is no separate
credit finalisation path (C-6, FR-SALE-009). Only `Save a Draft` and `Clear Draft` leave the sale unmade.

**`Credit Bill` is a completed sale, not a saved draft** (FR-CREDIT-020). It differs from
`Print Bill` only in *who owes the money* and *whether a document prints immediately* — never in
whether the sale happened. The earlier design, which opened a mandatory credit-details page before
finalising, was **replaced by the owner on 2026-10-29**
([OD-21](../../bmbackend/docs/OWNER-DECISIONS.md#od-21)).

### 4.7 Print Bill flow (FR-SALE-020…028)

```
press Print Bill
  → local validation fails? inline errors, focus the first bad cell, nothing sent
  → offline?  blocked panel:
        "No internet connection. This bill is saved and nothing is lost.
         You can print a counter slip now and complete the bill when the
         connection is back."         [ Print counter slip ]  [ OK ]
  → online: button busy ("Completing…"), bill read-only, one idempotency key
      → 201: print dialog opens; tab becomes a confirmation card:
              "Invoice NAS/2026-27/00412 saved."   [ Reprint ]  [ New bill ]
      → 409/422: the specific panel from §9
      → network/timeout/503: NOT-CONFIRMED state (§4.9)
```

Printing is never a precondition for the sale having happened. If the user cancels the print dialog,
the confirmation card and `Reprint` remain (FR-SALE-023, E-8).

### 4.8 Supervisor authorisation (FR-UI-PERM-003)

When an action needs a permission the user lacks, a compact dialog appears rather than a dead end:

```
  Manager approval needed
  Selling 5 when only 4 are in stock requires a manager.

  Manager username  [            ]
  Password / PIN    [            ]
  Reason            [                                  ]   (min 10 characters)

                                 [ Cancel ]  [ Approve and continue ]
```

The action is then performed **and recorded against the approving manager**, not the cashier.

### 4.9 "Not yet confirmed" state (E-1, E-2, FR-SALE-026)

The most dangerous moment in the system gets the loudest treatment.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ▲  This bill is not confirmed yet                                        │
│                                                                          │
│    We sent the bill but didn't get an answer back. It may or may not     │
│    have been saved. We're retrying — do not hand the customer a final    │
│    bill yet.                                                             │
│                                                                          │
│    Retrying… (attempt 3)        [ Retry now ]  [ Print counter slip ]    │
└──────────────────────────────────────────────────────────────────────────┘
```

- The tab shows `▲` and cannot be closed without an explicit warning.
- The state survives reload (persisted in `pending_finalizations`).
- Retries reuse the **same** idempotency key (FR-SALE-027).
- After `sync.finalization_stale_minutes` (default 60) auto-retry stops:
  *"Please check Daily Bills to see whether this bill was saved."*
- The counter slip is clearly watermarked and carries no invoice number.

---

## 5. Credit sale — `Credit Bill` (FR-CREDIT-020…031)

> **⚠️ Superseded design — do not reinstate.** An earlier draft of this section specified a
> **mandatory credit-details dialog** collecting business name, vehicle, mechanic, phone, terms, due
> date, notes and an optional payment **before** the sale was finalised. **The owner replaced that
> workflow on 2026-10-29** ([OD-21](../../bmbackend/docs/OWNER-DECISIONS.md#od-21)).
> `Credit Bill` now **finalises immediately**. There is no mandatory intermediate page.

### 5.1 The flow

```
cashier adds lines, picks the customer in the bill header (FR-BILL-010)
      │
      ├─ no customer chosen?  →  button DISABLED, inline hint beneath it:
      │       "Choose a customer to save this as a credit bill."
      │       [ Choose customer ] focuses the header field
      │
      └─ customer chosen → press Credit Bill (Ctrl+Shift+Enter)
              │
              │   ONE request: POST /sales:finalize { sale_type: "credit" }
              │   — no dialog, no extra form, no print dialog
              ▼
      ┌──────────────────────────────────────────────────────────────┐
      │ ✓ Credit bill saved for ANAS                                 │
      │   NAS/2026-27/00413 · ₹4,480.00 outstanding · due 28 Nov     │
      │   Stock has been updated.                                     │
      │                                                               │
      │   [ Print now ]   [ View in Credit Bills ]   [ New bill ]     │
      └──────────────────────────────────────────────────────────────┘
```

**Rules.**

- **It finalises.** Stock is reduced, an invoice number is allocated, the invoice exists. The
  confirmation says so explicitly — *"Stock has been updated."* (FR-CREDIT-020, FR-CREDIT-026).
- **Only the customer is required.** Nothing else is mandated by the credit path (FR-CREDIT-021).
  The button's disabled hint names exactly what is missing — it never opens a form.
- **No print dialog opens.** `Print now` is offered but optional; the bill is printable forever from
  Credit Bills (FR-CREDIT-029).
- **Optional values the cashier already typed** in the bill header — vehicle, mechanic, phone,
  business name, notes — ride along and are preserved on the invoice (FR-CREDIT-031).
- **Due date** is derived from the customer's `credit_terms_days` (default 30). It is shown in the
  confirmation and is editable later from the invoice, not demanded up front.
- **Initial payment is not requested here.** If the customer pays something immediately, the cashier
  records it from Credit Bills (§7) — or, when `Record payment now` is used from the confirmation
  card, it posts as a normal payment against the new invoice (FR-CREDIT-025).
- Errors use the same inline panels as cash finalisation (§9), including `INSUFFICIENT_STOCK` and
  `PRICE_CHANGED`. A credit bill is a real sale and is validated exactly as strictly.

### 5.2 Choosing the customer inline (FR-CREDIT-022)

The existing header `Customer` field (§4.3) does the work — no separate screen:

```
Customer [ imran▌                                           ]
         ┌───────────────────────────────────────────────────┐
         │ Imran · Imran Transport · 98xxxxxxxx · KA 01 AB…  │
         │ Imran Khan · — · 97xxxxxxxx                       │
         │ ─────────────────────────────────────────────────  │
         │ + Create customer "imran"        (name is enough)  │
         └───────────────────────────────────────────────────┘
```

- Searches name, phone, business name and vehicle.
- `+ Create customer` needs **only a name** and a client-generated UUID (FR-CUST-010). It does not
  open the old additional-information form.
- Likely duplicates are listed for the cashier to choose; nothing merges automatically
  (FR-CREDIT-023).
- A free-text name with no selected record is **valid for cash** but **not for credit** — the button
  stays disabled until a real record is attached (FR-CREDIT-028).
- Additional customer details remain editable any time from the Customers screen (§8). They are
  never demanded mid-sale.

---

## 6. Daily Bills (FR-RPT-020…027)

```
Daily Bills                                              [ Today ▾ ] [ Export ]
┌──────────────────────────────────────────────────────────────────────────────┐
│ 29 Oct 2026    34 bills    ₹1,84,250.00                                       │
│ Cash ₹1,42,100 · UPI ₹18,900 · Credit ₹23,250          Cancelled: 1 (₹2,400) │
└──────────────────────────────────────────────────────────────────────────────┘
 Filters: Counter [All ▾]  Payment [All ▾]  Search [customer / vehicle / number]

 Invoice            Time    Customer          Vehicle         Total    Status
 ───────────────────────────────────────────────────────────────────────────────
 NAS/2026-27/00412  11:05   Imran             KA 01 AB 1234  2,500.00  ● Paid
 NAS/2026-27/00411  10:58   Walk-in           —                420.00  ● Paid
 NAS/2026-27/00410  10:51   Imran Transport   KA 05 CD 9988  4,480.00  ◐ Partly paid
 NAS/2026-27/00409  10:40   Suresh Motors     KA 01 XY 7766  1,180.00  ✕ Cancelled
```

- Date control: Today / Yesterday / This week / This month / custom range; defaults to today.
- A row expands inline to show line items, payment detail, counter and user — no navigation needed
  for a quick check.
- Row actions: `View`, `Reprint`, and `Cancel` only when permitted and in-window (FR-RPT-025).
- Cancelled rows are struck through and excluded from the revenue total, with their own count
  (FR-RPT-026).
- **Credit sales appear here on their sale date** (FR-RPT-022).
- Status is rendered from the server's `payment_status`. **There is no clickable paid control**
  (FR-RPT-023).

---

## 7. Credit Bills — customer-wise (FR-RPT-021, FR-RPT-028…033)

A **two-level view: customers → that customer's invoices.** The grouping is **visual only**, built
over individual invoice records keyed by stable `customer_id`. **No per-customer folder, table or
directory exists anywhere in the system** (FR-RPT-028).

```
Credit Bills                                        [ As of today ] [ Export ]
┌──────────────────────────────────────────────────────────────────────────────┐
│ Outstanding ₹2,84,500   ·   Overdue ₹46,200   ·   32 customers with balance  │
│ Current 1,98,300 │ 1–30d 40,000 │ 31–60d 28,000 │ 61–90d 12,000 │ 90+ 6,200 │
└──────────────────────────────────────────────────────────────────────────────┘
 Filters: Status [All ▾]  Ageing [All ▾]  [ ] Show settled customers
 Search [ customer / vehicle / phone / invoice no ]

 ▾ ANAS · 98xxxxxxxx                                      ₹23,480  ▲ 12d overdue
   ┌──────────────────┬────────┬──────────┬──────────┬───────────┬────────────┐
   │ Invoice          │ Date   │    Total │     Paid │ Outstanding│ Status     │
   ├──────────────────┼────────┼──────────┼──────────┼───────────┼────────────┤
   │ NAS/2026-27/00413│ 29 Oct │  4,480.00│  1,000.00│   3,480.00│ ◐ Part paid│
   │ NAS/2026-27/00388│ 02 Oct │ 20,000.00│      0.00│  20,000.00│ ● Overdue  │
   │ NAS/2026-27/00301│ 18 Sep │  6,200.00│  6,200.00│       0.00│ ✓ Paid     │
   └──────────────────┴────────┴──────────┴──────────┴───────────┴────────────┘
     per-invoice row actions:  [ View ]  [ Print ]  [ Record payment ]
     customer actions:         [ Record payment ]  [ View ledger ]

 ▸ Suresh Motors · 97xxxxxxxx                                          ₹8,900
 ▸ Imran Transport · 98xxxxxxxx                              ✓ settled ₹0.00
```

### 7.1 Rules

| Rule | Detail |
|---|---|
| Grouping key | **`customer_id`, never the name string.** Renaming a customer re-labels the group and breaks no association (FR-RPT-029, FR-CUST-011) |
| Structure | Visual grouping over independent invoice records. **No folder/table/directory per customer** (FR-RPT-028) |
| Multiple invoices | A customer may hold any number; each is independent with its own number, date, total, paid, outstanding and status |
| Totals | Per-customer and overall outstanding come **from the server**; the client never sums them as authoritative (FR-RPT-030, ADR-032) |
| Status | Rendered from the server's derived `payment_status`. **No clickable paid control anywhere** (FR-RPT-023, FR-CREDIT-003) |
| Settled invoices | **Fully paid invoices stay in the customer's history**, marked `✓ Paid`. They are never deleted or permanently hidden (FR-RPT-031) |
| Settled customers | A customer at ₹0.00 still exists. The default **outstanding** view hides them behind `Show settled customers`; their history remains one click away (FR-RPT-031) |
| Per-invoice actions | `View` · `Print` (same approved layout, FR-CREDIT-030) · `Record payment` with permission (FR-RPT-032) |
| Payment history | Each invoice expands to its payments: amount, method, date/time, user, reference — from server allocation records (FR-RPT-033) |
| Ageing | Buckets are clickable filters |
| Overdue | Shown by **colour *and* the word "overdue"** (NFR-FE-A11Y-009) |
| Pagination | Customers and invoices both paginate via the API cursor; never a full-dataset fetch (FR-RPT-027) |

### 7.2 Recording a payment (FR-RPT-024)

Reachable from an invoice row or the customer row. One dialog, no wizard:

```
┌──────────────── Record payment — ANAS ────────────────┐
│  Amount   [ 3,480.00 ]     Method [ Cash ▾ ]          │
│  Reference[                ]  (UPI ref / cheque no)   │
│                                                        │
│  Apply to:  ( ) Oldest invoices first                  │
│             (•) This invoice — NAS/2026-27/00413       │
│                                                        │
│  Outstanding after this payment:  ₹0.00                │
│                                                        │
│                      [ Cancel ]  [ Record payment ]    │
└────────────────────────────────────────────────────────┘
```

- Submitted with an **idempotency key** generated once and reused on retry — a double submit records
  **one** payment (FR-PAY-004).
- The button disables while in flight; no second request can be issued by double-clicking.
- **Recording a payment never touches stock.** It creates payment and allocation rows only
  (FR-CREDIT-010). Sale finalisation and payment collection are separate financial events.
- Over-allocating beyond outstanding is refused by the server (`OVER_ALLOCATION`, FR-PAY-007); the
  dialog shows the remaining allocatable amount rather than letting the cashier guess.
- Any unallocated remainder becomes on-account customer credit (FR-PAY-003).
- A mistake is corrected by an explicit **reversal**, never an edit or delete (FR-PAY-005).
- `View ledger` shows invoices, payments and credit notes with a running balance.

---

## 8. Supporting screens (specified, built after billing)

| Screen | Key behaviour |
|---|---|
| **Stock position** (`/stock`) | Searchable list: product, stock, reorder level, value. `Low stock only` toggle. Row → product ledger. |
| **Product ledger** (`/stock/:id`) | Append-only movement list: date, reason, delta, balance after, document link, user. Read-only — this is the audit view. |
| **Stock adjustment** | Dialog: product, new quantity or delta, reason from a list **plus mandatory free text**, preview of the resulting balance. |
| **Products** (`/products`) | List, create, edit, aliases (add/remove), deactivate. Cost fields render only with permission. |
| **Purchases** (`/purchases`) | Supplier, document number/date, lines with quantity and cost. Saved as a draft; a separate, explicit `Confirm receipt` states *"this will add stock"*. Duplicate supplier document is blocked with a link to the existing receipt. |
| **Customers** (`/customers`) | List with search by name/phone/vehicle; detail with ledger, outstanding, vehicles, phones; duplicate resolution surfaced, never automatic. |
| **Imports** (`/imports`) | Upload with an explicit **intent** choice (*price list — does not change stock* / *stock receipt — adds stock*), supplier required for receipts. Then a review table: one row per parsed row with its raw values, interpretation, match status and a decision control. `Apply` is disabled while any required row is undecided, with the count shown. Then a report. |
| **Reports** (`/reports/*`) | Daily sales, credit ageing, stock position, item sales, counter reconciliation. Every report shows its `as_of` and filters, and offers CSV export. |
| **Settings** (`/settings/*`) | Business details, branches, counters (incl. `max_open_drafts`), users and roles, devices (with revoke), invoice series, tax configuration. |
| **Tax settings** | Shows the current mode plainly: *"Documents are printed as ESTIMATE. Tax invoicing is not enabled."* Enabling GST shows a **checklist of what is still missing** from the server, not a generic error (FR-TAX-003). |
| **Audit log** (`/settings/audit`) | Filter by entity, actor, date. Shows before/after for sensitive changes. Read-only. |

---

## 9. Error presentation

### 9.1 Pattern by severity

| Kind | Pattern |
|---|---|
| Field validation | Inline below the field, 13 px danger, `aria-describedby` |
| **Business conflict blocking a sale** | **Inline panel above the action buttons** — never a toast, because a toast can be missed while a customer waits |
| Background failure (sync, print log) | Status indicator + Sync panel |
| Session/device problem | Full-screen blocking message |
| Unexpected error | Error boundary with a reload option and a copyable `request_id` |

### 9.2 Insufficient stock panel

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ▲  Not enough stock for 2 items                                          │
│                                                                          │
│   Engine Oil 15W40 · 5L      you entered 3   ·  1 available  [ Use 1 ]   │
│   Brake Shoe Set — Tata 407  you entered 5   ·  4 available  [ Use 4 ]   │
│                                                                          │
│   [ Use available quantities ]      [ Sell anyway (manager) ]            │
└──────────────────────────────────────────────────────────────────────────┘
```

`Sell anyway` appears only when the user has the permission or can get supervisor approval, and
always requires a reason of at least 10 characters.

### 9.3 Price changed panel

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ▲  Prices changed while this bill was open                               │
│                                                                          │
│   Engine Oil 15W40 · 5L     was 1,980.00   now 2,040.00                  │
│                                                                          │
│   New total would be ₹4,540.00 (was ₹4,480.00)                           │
│                                                                          │
│   [ Accept new prices ]              [ Keep editing ]                    │
└──────────────────────────────────────────────────────────────────────────┘
```

Never auto-accepted (FR-SALE-006).

### 9.4 Draft conflict dialog (FR-OFFLINE-006)

```
┌──────────────── This bill was changed somewhere else ────────────────────┐
│                                                                          │
│   Your version (this device)          │   Saved version (server)         │
│   ─────────────────────────────────── │ ───────────────────────────────── │
│   1  Brake Shoe Set      2 × 1,250    │ 1  Brake Shoe Set   2 × 1,250     │
│   2  Engine Oil 5L       1 × 1,980    │ 2  Engine Oil 5L    2 × 1,980     │
│                                       │ 3  Oil Filter       1 ×   240     │
│   Total 4,480.00                      │ Total 6,700.00                    │
│                                                                          │
│   [ Keep my version ]  [ Keep saved version ]  [ Compare side by side ]  │
└──────────────────────────────────────────────────────────────────────────┘
```

Both totals are shown so the user can see the money difference at a glance. **No automatic merge**
(ADR-007).

### 9.5 Message tone

| Instead of | Write |
|---|---|
| `409 CONFLICT` | "This bill was already completed as invoice NAS/2026-27/00412." |
| `Validation error` | "Quantity must be more than 0." |
| `Network request failed` | "No internet connection. Your bill is saved — nothing is lost." |
| `Unauthorized` | "Your session ended. Sign in again — your bills are safe." |
| `Internal server error` | "Something went wrong at our end. Nothing was charged. Code: 01JBQ8…" |

---

## 10. Sync panel (FR-OFFLINE-005)

Opened from the status indicator.

```
┌──────────────────────────── Sync ────────────────────────────┐
│  ● Offline — last synced 10:42 (18 minutes ago)              │
│  [ Try now ]                                                 │
│                                                              │
│  Not confirmed (1)                                      ▲    │
│    Bill 3 · ₹4,480 · started 11:05 · retrying                │
│    [ Retry now ]  [ Print counter slip ]                     │
│                                                              │
│  Waiting to sync (7)                                         │
│    Bill 1 · edited 11:02                                     │
│    Bill 2 · edited 11:03                        … 5 more     │
│                                                              │
│  Needs your attention (2)                               ▲    │
│    Bill 5 · changed on another device    [ Resolve ]         │
│    Customer "Imran Khan" · rejected: phone already used      │
│                                   [ View ]  [ Dismiss ]      │
│                                                              │
│  Cached products: 4,812 (as of 10:42)                        │
└──────────────────────────────────────────────────────────────┘
```

Conflicted and rejected items **stay listed until the user acts** — nothing disappears on its own.

---

## 11. Keyboard reference

| Key | Action |
|---|---|
| `F2` | Go to Billing |
| `F3` or `/` | Focus product search |
| `↓` `↑` | Move through search results |
| `Enter` | Add highlighted product (search) / commit cell (table) |
| `Esc` | Close dropdown or dialog |
| `Tab` / `Shift+Tab` | Next / previous editable cell |
| `Ctrl+N` | New bill |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous bill |
| `Ctrl+1…9` | Jump to bill 1–9 |
| `Ctrl+Enter` | `Print Bill` (cash) |
| `Ctrl+Shift+Enter` | `Credit Bill` |
| `Ctrl+S` | `Save a Draft` — draft only, nothing is sold (FR-BILL-013) |
| `Ctrl+Shift+Backspace` | `Clear Draft` — confirmation required; disabled while a finalisation is unconfirmed |
| `Ctrl+P` | Reprint the last invoice from the confirmation card |
| `Delete` on a focused row | Remove line (with undo) |

Every shortcut is also reachable by mouse. A `?` overlay lists them (NFR-FE-A11Y-002).

---

## 12. Printed bill layout — **the Excel reference**

> **This is the only Excel-derived part of the product.** As of **2026-10-30 the owner's original
> workbook `ANAS_1234_20260606_231456.xlsx` has been supplied and inspected part by part** — every
> cell, merge, font, border, column width, row height, number format and embedded image. §12.1 is
> **read from the file**, not transcribed from a screenshot and not reconstructed from a
> description. The layout is **`[VERIFIED]`**.
>
> ⚠️ **"Verified layout" is not "verified print."** The workbook contains **no page setup at all** —
> no paper size, no orientation, no scaling, no print area (§12.1b). A printed sample on the shop's
> own printer remains a go-live gate
> ([OD-6](../../bmbackend/docs/OWNER-DECISIONS.md#od-6)), along with the date order
> ([OD-26](../../bmbackend/docs/OWNER-DECISIONS.md#od-26)) and the credit block's placement
> ([OD-22](../../bmbackend/docs/OWNER-DECISIONS.md#od-22)).
>
> *Previously (2026-10-29) only a screenshot existed and the lower section was `[UNSEEN]`. That
> status is superseded; the full record of what changed is in
> [PHASE-2-CLOSURE-ADDENDUM-2.md](../../bmbackend/docs/PHASE-2-CLOSURE-ADDENDUM-2.md).
> Earlier still, Phase 2 closure corrected this preamble for audit finding CF-6.*

### 12.1 Layout — read from the owner's workbook

**Source: `ANAS_1234_20260606_231456.xlsx`, sheet `Table 1`, inspected 2026-10-30.**
Used range **`A1:E37`**. No hidden rows or columns. The owner's file was **copied, never modified**.

```
   A      B                          C     D         E
┌──────┬──────────────────────────┬─────┬─────────┬──────────┐
│                                                            │
│ 1          NATIONAL  AUTO  SPARES                          │  merged A1:E1, bold italic, centred
│                                                            │
├────────────────────────────────────────────────────────────┤
│ 2            AUTO NAGAR ,HYDERABAD                         │  centred
│ 3          Mob:9948207903,9848136564                       │  centred, underlined, smaller
├──────┴──────────────────────────┬─────┬─────────┬──────────┤
│ 4  Customer Name:        ANAS                              │  label col A; value centred ~col C
│ 5  Mechanic Name :                                         │  label col A, bold; value blank here
│ 6                         Vehicle no:              1234    │  label ~col C/D; value right, col E
│ 7  ESTIMATE                      DATE:       06-06-2026    │  label col A; DATE col D; value col E
├──────┬──────────────────────────┬─────┬─────────┬──────────┤
│ 8  │ S R │ ITEM                 │ QTY │ PRICE   │ TOTAL    │  ← column header row (navy #232852)
├────┼─────┼──────────────────────┼─────┼─────────┼──────────┤
│ 9  │  1  │ 1/2L CLUTCH OIL      │  1  │     240 │      240 │
│10  │  2  │ 1/2R 5mm WIRE        │  1  │     280 │      280 │
│11  │  3  │ 11L LE MAX           │  1  │    3850 │     3850 │
│12  │  4  │ 1250 FANBELT         │  1  │     450 │      450 │
│13  │  5  │                      │     │         │        0 │  ← pre-numbered empty row
│ …  │  …  │                      │     │         │        0 │
│33  │ 25  │                      │     │         │        0 │  ← last item row (25 total)
├────┴─────┴──────────────────────┴─────┴─────────┼──────────┤
│34       GRAND TOTAL                             │     4820 │  ← label A34:D34, value E34, 11pt bold
├─────────────────────────────────────────────────┴──────────┤
│35            THANK YOU  VISIT AGAIN                        │
│36            Authorised Dealers of :                       │  ← 6pt, centred
│37  [TATA]     TATA - LEYLAND SPARE PARTS        [LEYLAND]  │  ← logos in col A and col E
└────────────────────────────────────────────────────────────┘
```

**Verified facts — read from the file:**

| Property | Value |
|---|---|
| Heading | `NATIONAL  AUTO SPARES` — **two spaces after `NATIONAL`**; 13 pt Calibri bold *italic*; merged `A1:E1` |
| Address line | `AUTO NAGAR ,HYDERABAD` — 8.5 pt bold; **space before the comma, as typed**; merged `A2:E2` |
| Contact line | `Mob:9948207903,9848136564` — 7.5 pt bold **underlined**; no space after `Mob:`; merged `A3:E3` |
| Customer field | Label `Customer Name:` in `A4:B4` (8.5 pt, **not** bold); **value `ANAS` in `C4:D4`**, 9 pt bold |
| Mechanic field | `Mechanic Name :` — **space before the colon**; 8.5 pt bold; `A5:E5` merged across the **whole row**, so there is **no separate value cell** — the value is typed after the label |
| Vehicle field | Label `Vehicle no:` in `C6:D6`; **value `1234` in `E6`**, right-aligned |
| Document label | `ESTIMATE` in `A7:B7` — **left-aligned, on the same row as DATE.** Not a centred banner |
| Date | `DATE:` in `D7`; value in `E7` as a **date serial** (`46179` = 6 June 2026), right-aligned. ⚠️ Number format is **`mm-dd-yyyy`** — see [OD-26](../../bmbackend/docs/OWNER-DECISIONS.md#od-26) |
| Column headers | **`S R` · `ITEM` · **`QTY`** · `PRICE` · `TOTAL`** — 9 pt bold, colour **`#232852`** (dark navy) |
| Column widths | A `4.664` · B `19.777` · C `3.332` · D `8.000` · E `10.441` characters |
| Alignment | `S R` centre · `ITEM` left · `QTY` right · `PRICE` right · `TOTAL` right. All numerics `shrinkToFit` |
| Number formats | `QTY`, `PRICE`, `TOTAL`, `GRAND TOTAL` all use Excel built-in format **`0`** — **zero decimal places** |
| Item rows | **25**, worksheet rows 9–33, pre-numbered `1`…`25` in column A |
| Empty rows | Blank item and **`0` in TOTAL** — a **hand-typed literal**, not a formula result |
| `GRAND TOTAL` | Label `A34:D34` at 7.5 pt bold navy; **value in `E34` at 11 pt bold** — the largest number on the page |
| Footer | `THANK YOU  VISIT AGAIN` (7.5 pt bold italic, two spaces) · `Authorised Dealers of :` (6 pt bold, **centred**) · ` TATA - LEYLAND SPARE PARTS` (7.5 pt bold italic **underlined**, leading space) |
| Logos | **TATA** 55×57 px in column A, **Ashok Leyland** 58×64 px in column E — both anchored in row 35, printing at ≈ 20×21 pt and 21×23 pt |
| Borders | Thin outer rectangle around `A1:E37` · thin rule under row 7 · **full thin grid on `A8:E33`** · `GRAND TOTAL` row boxed · **no internal grid in the customer block** |
| Fills | **None.** No shading anywhere — the header row is white with navy text |
| Font | **Calibri throughout** |
| Formulas | **None. Zero `<f>` elements in the sheet** — every value, including `GRAND TOTAL`, is typed by hand |
| Sheets | Two. `Table 1` is the bill; `Sheet1` holds only the stray string `inhone oage ` and is **excluded** |

**Verified absent from the entire sheet** — not merely absent from a visible region:

- **No invoice/bill number field** — corroborates [OD-3](../../bmbackend/docs/OWNER-DECISIONS.md#od-3).
- **No customer business-name, phone or address field.**
- No tax, GST, GSTIN or HSN column or line.
- No "Paid / Balance / Due" block.
- No discount column or line.
- **No signature block.**
- **No amount in words.**

**Do not invent any of these.** Their absence is now evidence, not an unknown.

### 12.1a Row map and merged ranges

The exact worksheet structure, for anyone reproducing it in HTML/CSS:

| Row | Height (pt) | Content | Merge |
|---|---|---|---|
| 1 | 19.5 | `NATIONAL  AUTO SPARES` | `A1:E1` |
| 2 | 12.75 | `AUTO NAGAR ,HYDERABAD` | `A2:E2` |
| 3 | 10.05 | `Mob:9948207903,9848136564` | `A3:E3` |
| 4 | 13.5 | `Customer Name:` + value | `A4:B4`, `C4:D4` |
| 5 | 12.75 | `Mechanic Name :` | `A5:E5` |
| 6 | 12.75 | `Vehicle no:` + value in `E6` | `C6:D6` |
| 7 | 12.75 | `ESTIMATE` · `DATE:` · date in `E7` | `A7:B7` |
| 8 | 13.5 | Column headers | — |
| 9–33 | 13.5 each | **25 item rows** | — |
| 34 | 16.5 | `GRAND TOTAL` + value in `E34` | `A34:D34` |
| 35 | 10.95 | `THANK YOU  VISIT AGAIN` *(+ both logos anchor here)* | `A35:E35` |
| 36 | 8.25 | `Authorised Dealers of :` | `A36:E36` |
| 37 | 18.75 | ` TATA - LEYLAND SPARE PARTS` | `A37:E37` |

**Twelve merged ranges, exactly:** `A1:E1` · `A2:E2` · `A3:E3` · `A4:B4` · `C4:D4` · `A5:E5` ·
`C6:D6` · `A7:B7` · `A34:D34` · `A35:E35` · `A36:E36` · `A37:E37`.

**Derived geometry** — summing the measured widths and heights:

| | Value |
|---|---|
| Content width | 46.21 chars ≈ 348 px ≈ **92 mm** |
| Content height | 499.5 pt ≈ **176 mm** |

At the proposed `@page { size: A5 portrait; margin: 8mm }` the printable area is 132 × 194 mm, so
the bill **fits with ≈ 18 mm to spare**. At the workbook's own default margins (0.7/0.75 in) A5
would **overflow by ≈ 4 mm**. This supports the existing A5/8 mm default; it does not approve it.

### 12.1b What the workbook does **not** answer

The layout is settled. **Printing is not.** `sheet1.xml` contains **no `<pageSetup>` element, no
`<headerFooter>` element and no defined print area**; its `pageMargins` are Excel's untouched
defaults. The owner never configured page setup at all — Excel would have used whatever the printer
offered.

| Still open | Why the file cannot answer it |
|---|---|
| **Paper size** | Never set in the workbook |
| **Orientation** | Never set |
| **Scaling / fit-to-page** | Never set |
| **Print area** | Never defined |
| **Page header / footer text** | No `headerFooter` element |
| **Date order** — `dd-mm-yyyy` vs the file's `mm-dd-yyyy` | The only example date is 6 June, identical in both orders → [OD-26](../../bmbackend/docs/OWNER-DECISIONS.md#od-26) |
| **Whether the shop's printer and paper actually fit it** | Not a property of the file → [OD-6](../../bmbackend/docs/OWNER-DECISIONS.md#od-6) |
| **Placement of the credit payment block** | The verified footer has **no slot for it** → [OD-22](../../bmbackend/docs/OWNER-DECISIONS.md#od-22) |

**A printed sample on the shop's own printer remains the only sufficient evidence** for print
fidelity, and is a go-live gate.

### 12.2 Rules

| Rule | Detail |
|---|---|
| Source of content | **`print_payload` from the server, verbatim.** The client adds no field, computes no total, invents no text (FR-PRINT-010). |
| Document title | From `print_payload.document_title`. **The literal "Tax Invoice" must not exist in the frontend source** (FR-PRINT-011, AC-FE-10). |
| Tax row | Rendered **only** when `totals.tax !== null`. A `null` renders nothing — never a zero row (FR-PRINT-012). |
| Columns | Exactly **`S R · ITEM · QTY · PRICE · TOTAL`**, in that order, with those exact labels **as they appear in the owner's sheet** (C-9, §12.1). Earlier drafts said `S.No · Item · Qty · Price · Total` — that was a reconstruction and is **superseded**. |
| Header fields | Only those present in the payload. An empty field prints nothing — never a placeholder. |
| Mechanic / vehicle | Printed when present; in the reference the labels appear even with an empty value (`Mechanic Name :` is shown blank), so the **label row is retained** and only the value is blank. |
| Credit block | `Paid / Balance / Due` — **`[PROPOSED]`, not in the reference.** Credit invoices use the same layout; the payment block is an addition requiring owner approval ([OD-22](../../bmbackend/docs/OWNER-DECISIONS.md#od-22)). |
| Amount in words | **`[PROPOSED]`, not visible in the reference.** From the payload if enabled. |
| **Amount formatting** | 🟡 **AMENDED** ([OD-23](../../bmbackend/docs/OWNER-DECISIONS.md#od-23)): `PRICE` and `GRAND TOTAL` print with **no decimal places** (`240`, `3850`). Line `TOTAL` follows the same rule *(inference from the original bill)*. No separators, no currency symbol. **Display only — stored values stay exact decimals and are NEVER rounded or truncated to satisfy a display rule.** ⚠️ **If a stored amount carries paise, zero decimals would misstate the bill — raise a validation warning, do not silently round.** Recorded conflict in OD-23; calculation precision remains [OD-7](../../bmbackend/docs/OWNER-DECISIONS.md#od-7) |
| **Empty rows** | ✅ **Settled** ([OD-23](../../bmbackend/docs/OWNER-DECISIONS.md#od-23)): unused item rows print **blank**. The original's `0` in `TOTAL` is a **hand-typed literal** (the sheet has no formulas) and is **not reproduced**. |
| **Invoice number** | ❌ **NOT PRINTED.** [OD-3](../../bmbackend/docs/OWNER-DECISIONS.md#od-3) is re-answered — *"No need of invoice numbering."* `print_payload` carries none, the client renders none, and **no substitute visible numbering scheme may be invented**. A structural test asserts this. Revives only under [OD-25](../../bmbackend/docs/OWNER-DECISIONS.md#od-25) |
| **Payment / balance block** | ✅ **Inclusion selected for credit bills only** ([OD-22](../../bmbackend/docs/OWNER-DECISIONS.md#od-22)). Figures must faithfully reflect recorded payments and the outstanding balance from the backend — never computed or restated client-side. ⚠️ Placement `[PROPOSED]`. **Do not assume it belongs on cash bills.** |
| Long item names | **Wrap in full** — never truncated on paper (FE-E-7). |
| Filler rows | Blank rows pad the table to a consistent height so bills look uniform, as in the Excel template. |
| Reprints | `DUPLICATE COPY` watermark when `is_duplicate` is true (FR-PRINT-015, Q-BIZ-6). |
| Multi-page | Repeat the heading and column header; print `Page n of m`; the total appears only on the last page. |
| Styling | `print.css` only. Black on white, no shading beyond a light table header, no webfont, no images (FR-PRINT-014). |
| Paper | `@page { size: A5 portrait; margin: 8mm }`, configurable to A4 (FR-PRINT-016, [OD-6](../../bmbackend/docs/OWNER-DECISIONS.md#od-6)). ✅ **Supported by measurement:** the verified content block is ≈ 92 × 176 mm, which fits A5 at 8 mm margins with ≈ 18 mm to spare. Still needs a printed sample. |

### 12.2a Evidence classification — what is verified vs proposed

Two statuses remain, assigned by **evidence**, not preference. *(`[OBSERVED]` and `[UNSEEN]` are
retired: the workbook was inspected on 2026-10-30, so nothing in the bill is unseen any more.)*

- **`[VERIFIED]`** — read directly from the owner's workbook. Reproduce faithfully.
- **`[PROPOSED]`** — the system needs it; the original does **not** contain it. Requires owner
  approval and must be switchable off.

> ⚠️ **`[VERIFIED]` applies to the layout, not to printing.** Paper size, orientation and scaling
> were never set in the workbook and remain open ([OD-6](../../bmbackend/docs/OWNER-DECISIONS.md#od-6)).

| Element | Status | Note |
|---|---|---|
| Heading `NATIONAL  AUTO  SPARES`, bold italic, centred, boxed | **`[VERIFIED]`** | Merged across A:E |
| Address `AUTO NAGAR ,HYDERABAD` | **`[VERIFIED]`** | Reproduce the typed spacing; confirm the legal/full address separately ([OD-4](../../bmbackend/docs/OWNER-DECISIONS.md#od-4)) |
| Contact `Mob:9948207903,9848136564` | **`[VERIFIED]`** | Underlined, centred |
| `Customer Name:` label + value | **`[VERIFIED]`** | Value sits toward the middle, not beside the label |
| `Mechanic Name :` label + value | **`[VERIFIED]`** | Label retained even when the value is blank |
| `Vehicle no:` label + value | **`[VERIFIED]`** | Label mid-right, value right-aligned |
| `DATE:` label + date value | **`[VERIFIED]`** | ⚠️ Stored as a date serial with number format **`mm-dd-yyyy`**. The previously recorded `DD-MM-YYYY` was an **inference** — the sole example (6 June) reads the same both ways. Order is now [OD-26](../../bmbackend/docs/OWNER-DECISIONS.md#od-26) |
| `ESTIMATE` label, **left-aligned in col A, on the DATE row** | **`[VERIFIED]`** | **Not** a centred banner — the earlier reconstruction was wrong |
| Columns `S R · ITEM · QTY · PRICE · TOTAL` | **`[VERIFIED]`** | Exact labels and order; 9 pt bold, navy `#232852` |
| Pre-numbered rows with `0` in `TOTAL` | **`[VERIFIED]`** | **25 rows.** The `0`s are **hand-typed literals, not formula output** — the sheet has no formulas at all. Still **deliberately not reproduced**: [OD-23](../../bmbackend/docs/OWNER-DECISIONS.md#od-23) settled that empty rows print blank |
| Full table grid borders | **`[VERIFIED]`** | |
| Integer amounts, no decimals/separators/symbol | **`[VERIFIED]`** | Display rule now settled by [OD-23](../../bmbackend/docs/OWNER-DECISIONS.md#od-23): minimum exact decimals; empty rows blank |
| **Grand total** | **`[VERIFIED]`** | Row 34; label `A34:D34` at 7.5 pt bold navy; **value in `E34` at 11 pt bold**, format `0`. Typed by hand in the original — **our system computes it** |
| `THANK YOU  VISIT AGAIN` footer | **`[VERIFIED]`** | Row 35, 7.5 pt bold italic. **Two spaces** between `YOU` and `VISIT` |
| `Authorised Dealers of :` + ` TATA - LEYLAND SPARE PARTS` | **`[VERIFIED]`** | Rows 36–37. Note the **space before the colon** and the **leading space** before `TATA`, both as typed |
| Logos | **`[VERIFIED]`** | **TATA** (55×57 px) column A, **Ashok Leyland** (58×64 px) column E, both anchored row 35. Extraction into print assets is task **T3-12** |
| Signature / `For NATIONAL AUTO SPARES` | ❌ **VERIFIED ABSENT** | Not present anywhere in `A1:E37`. **Do not invent one** |
| Terms / declaration footer | ❌ **VERIFIED ABSENT** | Not present anywhere in `A1:E37` |
| Total row count | **`[VERIFIED]`** | **25 item rows**, worksheet rows 9–33 |
| Page size, orientation, scaling, print area | 🔴 **NEVER SET** | The workbook contains **no `pageSetup` element and no print area**; its margins are Excel's defaults. Not recoverable from the file — [OD-6](../../bmbackend/docs/OWNER-DECISIONS.md#od-6) |
| **Invoice number** | ❌ **NOT USED** | [OD-3](../../bmbackend/docs/OWNER-DECISIONS.md#od-3) re-answered — no customer-visible invoice numbering. Absent from the reference **and** not wanted |
| Document label beyond `ESTIMATE` (e.g. `TAX INVOICE`) | **not used** | ✅ [OD-24](../../bmbackend/docs/OWNER-DECISIONS.md#od-24): **`ESTIMATE` retained for cash *and* credit.** `BILL`/`INVOICE`/`TAX INVOICE` are **not** introduced. Still `BLOCKS-GO-LIVE` — a wording preference is not a tax-terminology approval |
| Customer business name | **`[PROPOSED]`** | Captured for credit; **not in the reference** |
| Customer phone | **`[PROPOSED]`** | Captured for credit; **not in the reference** |
| `Paid / Balance / Due` block | **`[PROPOSED]`** | Needed for credit bills ([OD-22](../../bmbackend/docs/OWNER-DECISIONS.md#od-22)) |
| Amount in words | **`[PROPOSED]`** | ❌ **Verified absent** from the original |
| `DUPLICATE COPY` watermark | **`[PROPOSED]`** | ([OD-16](../../bmbackend/docs/OWNER-DECISIONS.md#od-16)) |
| `Page n of m` | **`[PROPOSED]`** | Multi-page only |

**Rule for implementation:** render every `[PROPOSED]` element so it can be **switched off by
configuration without altering the original layout**. If the owner rejects one, the bill must still
look correct — a proposed field may not be load-bearing for the design.

### 12.3 Counter slip (offline fallback, FR-OFFLINE-015)

Same table, but: title **`COUNTER SLIP — NOT AN INVOICE`**, a diagonal watermark, **no invoice
number**, no due date, and a footer line: *"A proper bill will be issued once our system is back
online."* It must be impossible to mistake for the real document.

---

## 13. Responsive behaviour

| Width | Layout |
|---|---|
| ≥ 1600 px | Full layout; wider Item column |
| 1366–1599 px | **Primary target.** Full layout, sidebar 200 px |
| 1280–1365 px | Sidebar collapses to icons with tooltips; table scrolls internally |
| 1024–1279 px | Header fields stack; tab strip scrolls; still fully usable (NFR-FE-COMP-002) |
| < 1024 px | Billing shows a notice recommending a larger screen; Daily/Credit Bills remain usable as read-only lookups. **Billing on a phone is out of scope for v1.** |

The page body never scrolls horizontally; wide content scrolls inside its own container.

---

## 14. Accessibility checklist (per screen)

- [ ] Every control reachable and operable by keyboard, in a logical order
- [ ] Visible focus indicator, ≥ 3:1 contrast, never removed
- [ ] Labels programmatically associated; placeholder is never the only label
- [ ] Errors announced via `aria-live="polite"` and linked with `aria-describedby`
- [ ] Tables use `<th scope>`; the item table is a real table
- [ ] Colour never the sole carrier of meaning
- [ ] Text ≥ 15 px body, ≥ 13 px minimum; targets ≥ 40 px
- [ ] Dialogs trap focus, close on `Esc`, restore focus on close
- [ ] `prefers-reduced-motion` respected
- [ ] axe: zero serious/critical violations (NFR-FE-A11Y-011)

---

## 15. Empty, loading and error states

| Screen | Empty | Loading | Error |
|---|---|---|---|
| Billing table | "Start typing a part name above to add it to this bill." | — (local) | — |
| Search | "No product found for 'xyz'." + add-new | Spinner in the field after 300 ms | "Couldn't search just now." + Retry, **query preserved** |
| Daily Bills | "No bills for 29 Oct 2026." | Row skeletons | "Couldn't load bills." + Retry |
| Credit Bills | "No outstanding credit. 🎉" | Row skeletons | Retry |
| Stock | "No products yet." + add | Skeletons | Retry |
| Imports | "No imports yet." + upload | Progress with stage name | Per-row errors in the report |
| Sync panel | "Everything is synced." | — | — |

No blank screens, no layout shift when content arrives (NFR-FE-UX-005).

---

## 16. Related documents

`docs/PRD.md` · `docs/ARCHITECTURE.md` · `docs/API-INTEGRATION.md` · `docs/TESTING-STRATEGY.md` ·
`docs/DECISIONS.md` · `../../bmbackend/docs/API-SPECIFICATION.md` *(print payload, error codes)* ·
`../../bmbackend/docs/PRD.md` *(authoritative business rules and open questions)*

# Testing Strategy — `bmfrontend`

| Field | Value |
|---|---|
| Status | **Phase 1 proposal — no tests exist, none have been run** |
| Last updated | 2026-10-29 |

> **No test has been written or executed during Phase 1.** Everything below is a requirement for
> Phase 2, not a result.

---

## 1. Principles

1. **Test the billing counter hardest.** It is the product. Coverage is deliberately uneven.
2. **Mock at the API contract boundary, not inside the app.** MSW handlers are written from
   `../../bmbackend/docs/API-SPECIFICATION.md`, so a test passing against a mock means the client
   honours the real contract.
3. **Every documented error code gets a test.** `PRD.md §6.1` lists the behaviours; each is
   verified.
4. **Keyboard-only paths are tested as first-class flows**, because keyboard speed is a requirement
   (NFR-FE-A11Y-002, FBO-1).
5. **Offline is tested with the network genuinely blocked**, not by calling a sync function directly.
6. **Money is property-tested.** Display and arithmetic must match the server to the paisa.
7. **Structural tests enforce rules that are easy to erode** — no token in storage, no literal "Tax
   Invoice", no paid-status control, no hand-edited generated types.

---

## 2. Test layers

| Layer | Tool | Directory | Covers | Target runtime |
|---|---|---|---|---|
| Unit | Vitest | `src/**/*.test.ts` | `lib/money`, `normalize`, `format`, store reducers, sync scheduler logic, keyboard helpers | < 15 s |
| Component | Vitest + RTL | `src/**/*.test.tsx` | Single components with mocked hooks | < 60 s |
| Integration | Vitest + RTL + MSW | `src/features/**/*.integration.test.tsx` | A feature against mocked API responses, including every error code | < 120 s |
| Local persistence | Vitest + fake-indexeddb | `src/db/*.test.ts` | Dexie schema, migrations, outbox, coalescing, quota failure | < 30 s |
| E2E | Playwright + MSW/stub API | `e2e/*.spec.ts` | Full flows in a real browser | < 5 min |
| Offline E2E | Playwright (`context.setOffline`) | `e2e/offline/*.spec.ts` | Offline drafts, sync, conflicts, counter slip | < 3 min |
| Print | Playwright (PDF snapshot) | `e2e/print/*.spec.ts` | Layout, pagination, duplicate watermark, no tax row | < 60 s |
| Accessibility | Playwright + axe-core | `e2e/a11y/*.spec.ts` | Zero serious/critical per screen | < 60 s |
| Structural | Vitest | `tests/structural/*.test.ts` | Rules that must never regress (§8) | < 10 s |
| Performance | Playwright timings | `e2e/perf/*.spec.ts` | `NFR-FE-PERF-*` budgets | nightly |

PR-blocking suite target: **under 10 minutes**.

---

## 3. MSW handlers as the contract

```
src/test/msw/
├── handlers/
│   ├── auth.ts          login, refresh, me, bootstrap
│   ├── catalog.ts       search (with ranking fixtures), product CRUD
│   ├── drafts.ts        upsert with version tracking, 409 conflict
│   ├── sales.ts         finalize: 201, and EVERY documented 409/422
│   ├── invoices.ts      list, detail, print-payload (estimate + gst variants)
│   ├── credit.ts        outstanding, payments, ageing
│   ├── sync.ts          operations batch with per-op outcomes, catalog delta
│   └── errors.ts        helper to produce the exact error envelope shape
└── fixtures/
    ├── products.ts      incl. separator variants (JK-123 / jk 123 / jk123)
    ├── invoices.ts      cash, credit-partial, cancelled, multi-page
    └── print-payloads.ts  estimate (tax: null) and gst_enabled (tax: "...")
```

Rules:
- Handlers produce the **exact** error envelope from `API-SPECIFICATION.md §4`. A test that passes
  against a sloppy mock proves nothing.
- The `drafts` handler maintains real version state so conflict tests are genuine.
- The `sales` handler can be driven into each error on demand, so every branch in `PRD.md §6.1` is
  reachable.
- A CI check asserts every code in the generated `ErrorCode` union appears in at least one handler or
  test — so a new backend code cannot be silently unhandled.

---

## 4. What must be proved per area

### 4.1 Money (`lib/money.ts`) — unit + property

- `lineTotal` for integer, fractional and discounted quantities.
- `sumAmounts` over 50 lines with no drift.
- **Property:** for random bills, the client preview equals a reference decimal computation exactly.
- **Property:** rounding matches the server's documented policy (half-up at line level, then sum) —
  the test encodes the same rule as `../../bmbackend/docs/ARCHITECTURE.md §6.5`.
- `0.1 + 0.2` style cases display exactly (AC-FE-11).
- `parseUserAmount` rejects `1.2.3`, `abc`, `-5`, and excess decimal places for the unit.
- `formatAmount` for 0, large values, and Indian grouping if confirmed.
- **Structural:** no `parseFloat`/`Number()`/arithmetic on money outside `lib/money.ts` (§8).

### 4.2 Product search

| Test | Assertion |
|---|---|
| First character queries | A request fires on one character (FR-CAT-003) |
| Debounce | Fast typing produces one request, not one per key |
| Cancellation | A superseded request is aborted and its late response ignored |
| Keyboard | `↓`/`↑`/`Enter`/`Esc` behave per spec; focus returns to search after add |
| Add existing product | Quantity increments, no duplicate line (FR-CAT-015) |
| Zero stock | Selectable, shows `0 ⚠` (ADR-006) |
| No results | Message + add-new affordance for permitted users |
| Error | **Typed query preserved**, retry offered (AC-FE-12) |
| Offline | Cached results with an `as_of` banner |
| Barcode burst | Fast keystrokes + Enter routes to barcode lookup (FR-CAT-007) |
| Cost price | Never rendered, even if a malformed response contained it |

### 4.3 Billing counter — the heaviest area

**Tabs**
- Create 20 bills; all reachable; `Ctrl+Tab` and `Ctrl+1…9` work; 21st shows the limit message and
  **no existing bill is closed** (FR-BILL-007).
- Switching preserves every line, header field and scroll position; fires no network request
  (FR-BILL-006).
- Badges reflect unsynced / conflict / not-confirmed.

**Item table**
- Add, edit quantity, edit price, remove, undo-remove within 5 s.
- Inline validation: qty 0, negative, too many decimals; price negative. Submit blocked with the
  specific reason.
- `Tab` order through editable cells; `Enter` in the last cell returns to search.
- Price override marks the line; read-only without permission; supervisor path offered.
- Stock warning is **non-blocking** (FR-ITEM-005).
- Inactive product row flagged with a remove action.
- 20 lines × 20 bills remains responsive (NFR-FE-PERF-006).

**Totals**
- Recalculate on every change; labelled as a preview; discount respected; cap enforced in the UI for
  cashiers.

**Draft persistence (FBO-2 — the highest-value frontend tests)**
- Reload mid-edit → content intact.
- `fake-indexeddb` crash/reopen → intact.
- E2E: 20 bills, force-close the browser, reopen → all 20 intact (AC-FE-2).
- IndexedDB unavailable → **blocking warning**, online-only mode, never silent (FE-E-1).
- Two tabs → one owner tab, the other read-only with a banner (FE-E-2).

### 4.4 Finalisation — every documented outcome

| Scenario | Assertion |
|---|---|
| Happy cash sale | One POST, correct body, print dialog invoked, confirmation card with the invoice number |
| Double-click submit | **Exactly one request** (FR-SALE-021) |
| Idempotency key stability | Three retries → **same** `Idempotency-Key`, three different `X-Request-Id` |
| Key rotation | Editing the bill after a failure → a **new** key (FR-SALE-027) |
| Key persisted before send | Key exists in Dexie before the request resolves (E-2) |
| `INSUFFICIENT_STOCK` | Shortfall panel; "use available" sets quantities; no auto-retry |
| `PRICE_CHANGED` | Diff panel; `Accept new prices` resubmits with the flag; **never auto-accepts** |
| `DRAFT_VERSION_CONFLICT` | Conflict dialog with both versions and both totals |
| `DRAFT_ALREADY_FINALIZED` | Existing invoice shown; **no retry control rendered** |
| `TOTAL_MISMATCH` | Draft refetched, warning shown, **no automatic resubmit** |
| `PERMISSION_DENIED` | Supervisor authorisation dialog; action recorded against the approver |
| `CREDIT_LIMIT_EXCEEDED` | Figures shown; override only where permitted |
| Network error / 503 | **Not-confirmed state**, persisted, survives reload, retries same key (AC-FE-4) |
| Offline | Blocked with the documented message + counter slip offer (AC-FE-3) |
| Stale finalisation | After the threshold, auto-retry stops with the "check Daily Bills" message |
| Print cancelled | Invoice remains, `Reprint` available, **no resubmission** (AC-FE-7) |
| Reprint | Calls only `GET /print-payload`; **never** a finalisation endpoint (FR-SALE-024) |

### 4.5 Credit sale

- `Credit Bill` **disabled** without an identified customer, with an inline hint naming what
  is missing (FR-CREDIT-028). It must **not** open a form.
- Pressing it with a customer selected issues **exactly one** `POST /sales:finalize`
  (`sale_type: credit`) and **no intermediate dialog is rendered** (FR-CREDIT-020).
- **No print dialog opens** on success; the confirmation card appears instead (FR-CREDIT-029).
- Finalisation succeeds with a customer created from a **name alone** — no other field required
  (FR-CUST-010).
- Optional header values typed on the bill are present in the request body and on the stored invoice
  (FR-CREDIT-031).
- Offline: the action is refused and creates **nothing** — no key, no `pending_finalizations` row,
  no queued operation (`offline-credit-refused.spec.ts`).
- Customer search by name, phone, business, vehicle.
- Inline customer creation sends a client-generated UUID.
- Duplicate candidates listed; nothing merges automatically.
- Terms prefill the due date; both editable.
- Part payment updates the outstanding preview live.
- Submits to the **same** `/sales:finalize` with `sale_type: credit` and the payment inline — a
  structural test asserts there is no second finalisation code path (C-6).
- Wording test: the confirmation card states the invoice number, the outstanding amount and
  **"Stock has been updated."** (FR-CREDIT-026) — the safeguard that replaced the old dialog's
  consequence sentence.

### 4.6 Lists and reprint

- Daily Bills: date filters, totals, expand-row, counter/payment filters, cancelled rows struck
  through and excluded from revenue.
- Credit Bills: grouping by customer, ageing buckets as filters, payment recording with an
  idempotency key, ledger view.
- **Structural: no paid-status input control exists anywhere** (AC-FE-10, FR-RPT-023).
- Pagination uses the API cursor; no full-dataset fetch (FR-RPT-027).

### 4.7 Offline and sync (Playwright, real offline)

| Test | Assertion |
|---|---|
| Create and edit drafts offline | Works; stored locally (AC-FE-3) |
| Reconnect | Outbox drains; each operation reports an explicit outcome |
| Replay | Re-sending an acknowledged batch changes nothing (`replayed` handled, not an error) |
| Coalescing | 60 s of typing on one draft → one queued operation |
| Conflict | Offline edit + server edit → conflict dialog; neither version lost (AC-FE-9) |
| Rejected operation | Stays visible in the Sync panel until acknowledged |
| `DEVICE_REVOKED` | Blocking screen; **local data retained** |
| `SYNC_CURSOR_EXPIRED` | Cache cleared and re-pulled with no duplicates |
| Finalisation offline | Refused; counter slip prints with no invoice number |
| Triggers | Sync fires on reconnect, focus, timer, post-mutation and manual — each verified independently |
| Owner tab | Only one tab syncs |
| Service worker | **No API response is served from cache** (ADR-031) |

### 4.8 Print (Playwright PDF snapshots)

- A5 layout snapshot vs an approved baseline; A4 variant.
- Column headers exactly **`S R · ITEM · QTY · PRICE · TOTAL`**, in that order, matching the owner's
  reference sheet verbatim (C-9, `UI-UX-SPECIFICATION.md §12.1`). Earlier drafts asserted
  `S.No · Item · Qty · Price · Total` — **that was a reconstruction and is superseded.**
- `ESTIMATE` renders **left-aligned on the DATE row**, not as a centred banner.
- **Cash and credit invoices render byte-identical layouts** for the same data — asserted by
  snapshotting both and diffing (FR-CREDIT-030).
- **Amount formatting** (FR-PRINT-017, OD-23): `240.00` → `240`; `240.50` → `240.50`;
  `240.05` → `240.05`; `3850.00` → `3850`. **Never** `240.00`, never a truncated `240.5`. No
  thousands separator, no currency symbol.
- **Formatting never mutates a value**: a property test asserts that parsing the printed string back
  yields exactly the backend decimal it came from.
- **Empty rows render blank** (FR-PRINT-018) — asserted by checking that no `0` appears in the
  `TOTAL` column of an unused row.
- **The invoice number is present** on every printed bill (FR-PRINT-019), and renders without
  breaking the layout when its placement slot is toggled.
- **Payment/balance block appears on credit bills only** (FR-PRINT-020): present for a credit
  invoice, **absent for a cash invoice** — both asserted. Its figures equal the payload's
  `payment.amount_paid` / `payment.outstanding` exactly, with no client-side arithmetic.
- **`ESTIMATE` is the label on cash *and* credit bills** (FR-PRINT-021); a structural test asserts
  `BILL`, `INVOICE` and `Tax Invoice` appear nowhere as source literals.
- `totals.tax === null` → **no tax row rendered** (FR-PRINT-012).
- `document_title` rendered from the payload; **grep asserts "Tax Invoice" is not a source literal**
  (FR-PRINT-011).
- Credit block present only for credit invoices.
- Long item names **wrap fully**, never truncated (FE-E-7).
- Multi-page: heading and column header repeat, `Page n of m`, total only on the last page.
- `is_duplicate` → `DUPLICATE COPY` watermark.
- Counter slip: watermark, no invoice number, "not an invoice" text.
- App chrome is absent from print output.
- Missing optional business fields print nothing — **never a placeholder**.

### 4.9 Authentication

- Login success/failure, locked account countdown, inactive user, revoked device.
- Transparent refresh on 401 with one retry.
- Concurrent 401s → **one** refresh request (not 20).
- Refresh failure → login prompt with **drafts intact** (FR-AUTH-012).
- `device_id` generated once and stable across reloads.
- PIN switch rate limiting surfaced correctly.
- Logout prompts on unsynced drafts and does **not** clear Dexie.
- **Structural: no token written to `localStorage`/`sessionStorage`** (AC-FE-10).

### 4.10 Accessibility

- axe on every route: zero serious/critical (NFR-FE-A11Y-011).
- **A complete 5-line bill, keyboard only, as an E2E test** (AC-FE-8) — this is a speed test as much
  as an a11y test.
- Focus visible on every interactive element; dialogs trap and restore focus; `Esc` closes.
- Errors announced via `aria-live` and linked by `aria-describedby`.
- Item table uses `<th scope>`.
- Contrast assertions on the token palette.
- `prefers-reduced-motion` honoured.

---

## 5. Performance tests (nightly)

| ID | Scenario | Budget |
|---|---|---|
| NFR-FE-PERF-001 | Keystroke → results visible | p95 ≤ 250 ms (150 ms mocked server latency) |
| NFR-FE-PERF-002 | Add line + recalc | ≤ 50 ms |
| NFR-FE-PERF-003 | Tab switch | ≤ 100 ms |
| NFR-FE-PERF-004 | FCP cold / warm | ≤ 1.5 s / ≤ 500 ms |
| NFR-FE-PERF-005 | Initial bundle | ≤ 300 KB gzipped (**PR-blocking**) |
| NFR-FE-PERF-006 | 20 bills × 20 lines | Interaction stays under budget |
| NFR-FE-PERF-007 | Print render | ≤ 500 ms |

Bundle size is the one performance gate that blocks a PR, because it regresses silently and is
painful to claw back later.

---

## 6. Test data factories

```ts
makeProduct({ name, sku, price, stock })
makeDraft({ lines: 3, header: {...} })
makeInvoice({ type: 'cash' | 'credit_partial' | 'cancelled' })
makePrintPayload({ taxMode: 'estimate_only' | 'gst_enabled', duplicate: false })
makeErrorEnvelope('INSUFFICIENT_STOCK', { lines: [...] })
```

All money values in factories are **strings**, matching the API, so no test can accidentally pass
with a JavaScript number and hide a real bug.

---

## 7. Coverage gates

| Target | Threshold |
|---|---|
| `src/lib/money.ts` | **100% branch** |
| `src/features/billing/**` | ≥ 95% |
| `src/features/sync/**`, `src/db/**` | ≥ 95% |
| `src/api/client.ts`, `src/api/errors.ts` | ≥ 95% |
| `src/features/print/**` | ≥ 90% + snapshot tests |
| Overall | ≥ 85% |

Coverage alone is not the gate: structural, a11y and E2E billing suites must pass regardless of the
number.

---

## 8. Structural tests — rules that must never regress

`tests/structural/` asserts, by scanning source:

1. No `localStorage.setItem` / `sessionStorage.setItem` with a token-shaped key (AC-FE-10).
2. The literal `"Tax Invoice"` appears **nowhere** in `src/` (FR-PRINT-011).
3. No checkbox, switch or input bound to a paid/payment-status field (FR-CREDIT-003).
4. `parseFloat`, `Number(`, and `+`/`-`/`*` on money or quantity values appear only in
   `src/lib/money.ts`.
5. `src/api/generated/` matches a fresh generation from the OpenAPI document (CI regenerates and
   diffs).
6. Every `ErrorCode` union member is handled in some exhaustive switch and exercised by some test.
7. No `dangerouslySetInnerHTML` outside an allow-list (currently empty).
8. Only approved `VITE_` environment variables are referenced (NFR-FE-SEC-001).
9. No `fetch`/`axios` call outside `src/api/` — every request goes through the client with its auth,
   idempotency and error handling.
10. No business-rule constant hardcoded where bootstrap provides it (`max_open_drafts`, discount
    caps, rounding, tax mode).
11. The service worker config does not cache any `/api/` route (ADR-031).
12. No route beyond `/billing` is in the initial bundle (checked via the build manifest).

These are cheap tests that defend expensive invariants. Each one maps to a rule in `CLAUDE.md §5`.

---

## 9. CI pipeline

```
on: push, pull_request
  1  install (npm ci)
  2  lint (eslint) + format check + tsc --noEmit
  3  structural tests
  4  unit + component + integration (Vitest, coverage)
  5  Dexie/persistence tests (fake-indexeddb)
  6  build  → bundle-size gate
  7  regenerate API types from staging OpenAPI → fail on diff
  8  Playwright: E2E + offline + print + a11y (against MSW)
  9  coverage gate
 10  dependency audit (high/critical blocks) + secret scan

nightly:
  performance suite, extended property tests, full axe sweep
```

---

## 10. Manual test checklist (pre-go-live)

Cannot be automated:

1. **Print the bill on the shop's real printer and paper and compare side by side with the owner's
   Excel invoice. Owner sign-off required** (AC-FE-6, go-live gate 1).
2. A new staff member completes a 5-line cash bill unaided after one walkthrough (FBO-3).
3. Keyboard-only billing timed on the counter machine — target under 60 s for 5 lines (FBO-1).
4. Unplug the internet for 10 minutes during a real shift; keep billing; reconnect; verify every bill
   finalised exactly once (go-live gate 5).
5. Unplug the printer, complete a sale, verify the invoice exists and reprints.
6. Revoke the device from the owner's phone; verify the counter stops syncing and keeps its drafts.
7. Barcode scanner on real hardware, if one is used (Q-FE-3).
8. Deploy a new build and confirm counter machines pick it up without a manual cache clear (go-live
   gate 10).
9. Readability check across the counter at normal standing distance.
10. Confirm staff can articulate the difference between a reprint and a new sale, and what
    "Not yet confirmed" means.

---

## 11. Related documents

`docs/PRD.md` (AC-FE-*) · `docs/ARCHITECTURE.md` · `docs/UI-UX-SPECIFICATION.md` ·
`docs/API-INTEGRATION.md` · `docs/DECISIONS.md` ·
`../../bmbackend/docs/TESTING-STRATEGY.md` · `../../bmbackend/docs/TRACEABILITY.md` ·
`../../bmbackend/docs/API-SPECIFICATION.md`

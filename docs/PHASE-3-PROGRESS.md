# Phase 3 Progress — client view

> **The master tracker is [`../../bmbackend/docs/PHASE-3-PROGRESS.md`](../../bmbackend/docs/PHASE-3-PROGRESS.md).**
> It carries the full milestone table, the implementation decisions, the verified
> evidence and the external gates for **both** repositories. This file is the client
> slice of it and must not disagree; if it does, the backend record is authoritative.

| Field | Value |
|---|---|
| Status | Living record. Update it in the same commit as the work it describes |
| Last updated | 2026-10-30 |

---

## 1. What exists in this repository

**Implemented & verified** -- code exists, tests were executed, gates passed.

| Area | Files | Note |
|---|---|---|
| Toolchain | `package.json`, `vite.config.ts`, `tsconfig.{json,app,node,test}.json`, `eslint.config.js`, `vitest.config.ts`, `playwright.config.ts`, `.prettierrc.json` | React 19, TypeScript `strict` with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`, Vite 6, Tailwind v4, the approved dependency set and nothing beyond it. The eslint config bans MUI/AntD/axios/moment/lodash directly, so an unapproved dependency fails the build rather than being caught in review |
| Money | `src/lib/money.ts` | **100% coverage** on statements, branches, functions and lines. Mirrors the backend engine: same strict parsing, same discount ordering, same refusal to round for display. It also re-exports the `Decimal` type, so no other file names the decimal package at all |
| Normalisation | `src/lib/normalize.ts` | Offline search keys, using the **same rules as the server**, with a **shared fixture list** run by both suites (`src/lib/normalize.test.ts` and `bmbackend/tests/unit/test_normalize.py`) |
| API layer | `src/api/{client,errors,endpoints,types,session}.ts`, `src/api/generated/schema.d.ts` | One client; the single shared refresh promise; the exhaustive 53-code `ErrorCode` switch; the access token in a module variable and nowhere else. Response **and** request types are generated from the backend's OpenAPI document (ADR-029) |
| Local persistence | `src/db/{schema,meta,drafts,outbox,pendingFinalizations,catalogCache}.ts` | Dexie. **Two queues, not one** (ADR-010): the outbox is always safe to replay, a pending finalisation may already have charged a customer |
| Billing | `src/features/billing/{draftStore.ts,BillingCounter,ItemTable,ProductSearch}.tsx`, `finalize.ts` | The four primary actions and nothing else; Dexie-first writes; derived totals; the idempotency-key lifecycle |
| Print | `src/features/print/{InvoicePrintLayout,PrintRoot}.tsx`, `src/styles/print.css` | Renders `print_payload` and nothing else. A stylesheet with its own tokens, isolated from the application (ADR-028) |
| Reports | `src/features/reports/DailyBills.tsx` | Daily Bills and Credit Bills -- one dataset, two views |
| Sync | `src/features/sync/{scheduler.ts,SyncPanel.tsx}` | Six triggers, owner-tab election, and a panel where nothing disappears quietly |
| Shell | `index.html`, `src/main.tsx`, `src/app/{bootstrap,AppShell}.tsx`, `src/components/primitives.tsx` | Strict CSP, the dedicated `#print-root`, lazy routes beyond billing, visible focus, reduced-motion support |
| Structural rules | `tests/structural/rules.test.ts` | 20 assertions enforcing `CLAUDE.md §5` by reading the source |
| CI | `.github/workflows/ci.yml` | Format, lint, types, tests with coverage, build, secret scan, dependency audit |

### Verified

```
tsc -b (3 projects)                  -> clean
eslint .                              -> clean
prettier --check src tests configs   -> All matched files use Prettier code style
vitest run                            -> 224 passed (10 files)
playwright test                       -> 6 passed (chromium, against the built app)
vite build                            -> built; initial chunk 410.95 kB raw / 130.88 kB gzip
vitest run --coverage                 -> src/lib/money.ts 100%, src/lib/normalize.ts 100%
```

The per-suite breakdown, including what each one proves, is in
[`../../bmbackend/docs/PHASE-3-PROGRESS.md`](../../bmbackend/docs/PHASE-3-PROGRESS.md) §6.

---

## 2. Client milestones

| Milestone | Status |
|---|---|
| **M1** scaffold, tooling, structural rules | **Implemented & verified** |
| **M16** shell, API client, auth | **Implemented & verified** |
| **M17** billing counter and draft persistence | **Implemented & verified** |
| **M18** cash finalisation | **Implemented & verified** |
| **M19** credit finalisation | **Implemented & verified** |
| **M20** print layout and counter slip | **Implemented & verified** -- the physical sample is M27, an external gate |
| **M21** Daily Bills and Credit Bills | **Implemented & verified** |
| **M22** offline layer | **Implemented & verified** |
| **M25** P1 screens | **Not completed** -- Stock, Purchases, Customers, Imports, and reports beyond Daily/Credit Bills |

---

## 3. What a counter can actually do

Everything below was exercised by a test, not by inspection.

| Flow | Behaviour |
|---|---|
| Find a part | From the first character, by any spelling of its code, online or from the Dexie cache -- and the cache says so, with the age of the data |
| Build a bill | Keyboard only: type, arrow, Enter. The total is always labelled a **preview** |
| `Print Bill` | Finalises a cash sale through `POST /sales:finalize`, then prints `print_payload` verbatim |
| `Credit Bill` | The **same** endpoint and engine with `sale_type: 'credit'`. No print dialog opens; the confirmation says "Stock has been updated." |
| `Save a Draft` | Works offline. The bill is already on disk; the outbox carries it up |
| `Clear Draft` | Asks first, names how many items will go, and **refuses** while a finalisation is unconfirmed |
| Offline | Both finalisations disabled with the reason stated; a counter slip offered, clearly **not a bill**; a bill typed offline survives a reload |
| An unconfirmed sale | The loudest state in the app. **No bare retry is offered anywhere** -- the only affordances are "check Daily Bills" and, offline, a counter slip |
| Reprint | Creates nothing, and is marked `DUPLICATE COPY` when the server says so |

---

## 4. Client rules already enforced by a test

Each is in `tests/structural/rules.test.ts` and must keep passing rather than be
weakened (§13).

- No token in `localStorage` or `sessionStorage`.
- No money arithmetic outside `src/lib/money.ts`; no direct `decimal.js` import elsewhere.
- Only the four allow-listed `VITE_` variables; no secret-shaped value anywhere.
- No `fetch` or `axios` outside `src/api/`.
- No invented document title — no `Tax Invoice`, `BILL` or `INVOICE` literal.
- No paid/unpaid control of any kind (ADR-022).
- No invoice number rendered from the print payload (OD-3, T3-06).
- No `/api/` route in the service-worker cache; `skipWaiting` and `clientsClaim` both
  off; update by prompt (ADR-031).
- The rejected `CreditDetailsForm` design is not reinstated (OD-21, ADR-033).
- No HTTP status code or stack-trace wording in user-facing strings.
- `dangerouslySetInnerHTML` appears nowhere.

---

## 5. Notes for whoever continues

- **`prettier --write .` must not touch `docs/` or any `*.md`.** It reformatted the
  authoritative Phase 2 specifications on the first run; that was reverted and both are
  now in `.prettierignore`. Specifications are records, not source to reflow.
- `vite` is pinned through an `overrides` entry so `vitest` cannot resolve its own
  nested copy. Removing it reintroduces a `PluginOption` type conflict that breaks
  `tsc -b`.
- `formatForScreen` deliberately takes **no policy argument**: the screen always shows
  paise when a value has them, so the cashier can see exactly what the server will
  refuse. Showing `240` for a stored `240.50` would hide the problem they need to fix.
- The illustrative `onDraftEdited()` in [`API-INTEGRATION.md §5`](API-INTEGRATION.md)
  was **not** implemented as written, and must not be: it deletes the
  `pending_finalizations` row unconditionally, which discards the idempotency key of a
  sale that may already have committed. `features/billing/finalize.ts` releases the key
  only on a **definitive** refusal, and keeps it on an unknown outcome. The recovery
  rules it follows are
  [`../../bmbackend/docs/PHASE-2-IMPLEMENTATION-BLUEPRINT.md`](../../bmbackend/docs/PHASE-2-IMPLEMENTATION-BLUEPRINT.md)
  **§5.4** (`P2-D-08`, AC-REC-1…11).
- `normalize.ts` duplicates the server's rules because offline search has no server.
  The **shared fixture list** in both suites is the only thing keeping them honest — it
  caught a real divergence in `normalizePhone`, where the client kept every digit and
  the server kept the last ten, which would have filed one customer twice.
- Coverage uses the **istanbul** provider, not v8. The v8 provider attributes an
  unreachable artifact to line 1 of every module whose source starts with a comment,
  which made the `money.ts` 100% threshold impossible to satisfy however complete the
  tests were.

---

## 6. External gates

Unchanged by any client work, and listed in full in the master tracker: OD-4 business
identity, OD-6/M27 printer and paper, OD-22 credit-block placement, OD-24 document
label, OD-25/R-36 numbering and tax legality, OD-26 date interpretation, OD-8 staff
training, and the M28 go-live checklist.

**No client-side change can clear any of them.**

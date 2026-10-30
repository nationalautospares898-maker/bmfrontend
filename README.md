# bmfrontend

Counter application for the **National Auto Spares** shop management system — a desktop-first,
offline-capable PWA for billing, stock, credit and reporting at an automobile spare-parts shop.

> ## ⚠️ Project status: Phase 1 (documentation) complete — **no application code exists**
>
> Verified on 2026-10-29: this directory contained **nothing** before Phase 1. It is not yet a Git
> repository and has no source, `package.json`, configuration or build setup. Everything below
> describes the **agreed design for Phase 3 implementation**, not something that runs today.
>
> Commands in §4 are the intended interface and **will not work yet**.

---

## 1. What this application is

The screen the shop's staff use all day. Its job is to make billing faster than writing on paper,
never lose a bill, and print a document the shop's customers already recognise.

- **Billing counter** — product search from the first keystroke, 20+ concurrent bill tabs, inline
  item editing, instant totals, cash and credit completion
- **Printed bill** — reproduces the shop's existing Excel invoice layout
- **Daily Bills / Credit Bills** — two views of one dataset, with payment recording and ageing
- Stock, purchases, customers, imports, reports, settings
- **Offline** — drafts keep working with no internet; sales do not (see §5)

**Not** responsible for: business rules, money arithmetic, stock decisions, permissions. Those are
enforced by `bmbackend` and this client never second-guesses them.

---

## 2. Proposed stack

Everything here is a Phase 1 **recommendation** (`docs/DECISIONS.md` ADR-023…032):

React 19 · TypeScript (strict) · Vite 6 · React Router · TanStack Query · Zustand ·
Dexie (IndexedDB) · `vite-plugin-pwa` (Workbox) · Tailwind CSS v4 · a minimal owned shadcn/ui
subset · react-hook-form + Zod · `decimal.js-light` · Vitest + React Testing Library + Playwright +
axe + MSW

Verified present on the development machine: Node 24.11.0, npm 11.6.1, Git 2.47.1.

---

## 3. Documentation — read in this order

| # | Document | What it answers |
|---|---|---|
| 1 | [docs/PRD.md](docs/PRD.md) | What the client must do, with requirement IDs and acceptance criteria |
| 2 | [docs/UI-UX-SPECIFICATION.md](docs/UI-UX-SPECIFICATION.md) | Every screen — **and the printed bill layout (§12)** |
| 3 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Structure, state boundaries, persistence, PWA, printing |
| 4 | [docs/API-INTEGRATION.md](docs/API-INTEGRATION.md) | How the client consumes the API: idempotency, retries, errors, sync |
| 5 | [docs/TESTING-STRATEGY.md](docs/TESTING-STRATEGY.md) | Component, integration, E2E, offline, a11y, print tests |
| 6 | [docs/DECISIONS.md](docs/DECISIONS.md) | ADR-023…032 plus stubs for backend-owned ADRs |
| 7 | [docs/PHASE-2-INDEX.md](docs/PHASE-2-INDEX.md) | **Pointer to the Phase 2 planning set** — milestones, blueprint, fidelity audit, risks, owner decisions |
| — | [CLAUDE.md](CLAUDE.md) | Persistent engineering rules for AI-assisted work |

**Authoritative elsewhere** (do not duplicate):

| Topic | Lives in |
|---|---|
| Business rules, confirmed requirements, open questions | `../bmbackend/docs/PRD.md §4–§5` |
| The API contract and error code registry | `../bmbackend/docs/API-SPECIFICATION.md` |
| The sync protocol | `../bmbackend/docs/OFFLINE-SYNCHRONIZATION.md` |
| The traceability matrix | `../bmbackend/docs/TRACEABILITY.md` |

---

## 4. Local development (Phase 3 — not yet runnable)

```bash
cp .env.example .env            # VITE_API_BASE_URL=http://localhost:8000
npm install
npm run api:types               # generate src/api/generated/schema.d.ts from the backend OpenAPI
npm run dev                     # http://localhost:5173

npm test                        # Vitest: unit, component, integration
npm run test:e2e                # Playwright: E2E, offline, print, a11y
npm run lint && npm run typecheck
npm run build && npm run preview
```

The backend must be running (or MSW enabled) for `npm run api:types` and for most E2E flows.

---

## 5. What offline does — and does not — do

This is the most commonly misunderstood part of the system, so it is stated plainly here.
Full rationale in `../bmbackend/docs/OFFLINE-SYNCHRONIZATION.md §1` and ADR-011.

| With no internet you **can** | You **cannot** |
|---|---|
| Open the app | Finalise a sale or print an invoice |
| Search the cached product list | Record a payment |
| Create, edit, switch and delete bills | Confirm a purchase receipt |
| Create a new customer | Create a return or stock adjustment |
| Print an un-numbered **counter slip** | Apply an import |

Nothing is lost: every draft is stored locally and syncs when the connection returns. But an invoice
number can only come from the server, so a numbered bill cannot be issued offline. **Staff training
on this is a go-live gate.**

---

## 6. Rules that are not negotiable

Full rationale in `CLAUDE.md` and `docs/DECISIONS.md`.

1. **No secrets in this repository.** Only `VITE_API_BASE_URL` and public flags — anything `VITE_`
   is readable in the shipped bundle.
2. **Tokens live in memory.** Never `localStorage`, never `sessionStorage`.
3. **The server owns all money, stock and permission decisions.** The client shows previews.
4. **No `parseFloat` on money.** All decimal arithmetic in `src/lib/money.ts`.
5. **One idempotency key per user intent**, reused on every retry, persisted before the first send.
6. **Never print an invoice for an unconfirmed sale** — counter slip only.
7. **No edit UI for invoices, payments or stock movements.** Corrections are cancellations, returns
   and reversals.
8. **No paid/unpaid control anywhere** — payment status is derived by the server.
9. **The literal string "Tax Invoice" must not appear in the source.** The document title comes from
   the server's print payload.
10. **API types are generated, never hand-written.**

Structural tests enforce 1, 2, 4, 8, 9 and 10 (`docs/TESTING-STRATEGY.md §8`).

---

## 7. Open questions

Business questions (tax, legal shop identity, paper size, rounding) are authoritative in
`../bmbackend/docs/PRD.md §5.1`. Frontend-specific ones are in `docs/PRD.md §4`:

| ID | Question | Default |
|---|---|---|
| Q-FE-1 | Which browser on counter machines? | Chrome/Edge (print fidelity guaranteed there only) |
| Q-FE-2 | Counter screen size | 1366×768 minimum, 1920×1080 target |
| Q-FE-3 | Barcode scanner at launch? | No — supported by design, untested without hardware |
| Q-FE-4 | Touchscreen anywhere? | No — keyboard and mouse assumed |
| Q-FE-5 | UI language | English only; strings externalised for a future second language |
| Q-FE-6 | Bill tab label | Number + customer name |

**Bill reference — ✅ resolved from the owner's workbook (2026-10-30).** The original
`ANAS_1234_20260606_231456.xlsx` was supplied and **inspected part by part**;
`docs/UI-UX-SPECIFICATION.md §12.1` is read from the file. Verified: used range `A1:E37`, 12 merged
ranges, **25 item rows**, all column widths and row heights, Calibri typography, navy `#232852`
headers, the full border grid, zero-decimal number formats, the `GRAND TOTAL` row, the three footer
lines and **both logo images** (TATA and Ashok Leyland). The column header is **`QTY`** — the
screenshot's `QT` was a truncated render. A signature block, amount in words, tax lines, a
paid/balance block and any invoice number are **verified absent**.

⚠️ **Verified layout is not verified print.** The workbook sets **no page setup, no print area, no
paper size, no orientation and no scaling** — so paper choice stays open
([OD-6](../bmbackend/docs/OWNER-DECISIONS.md#od-6)) and a **printed sample remains a go-live gate**.
The **date order** is newly open: the file formats dates `mm-dd-yyyy` where the project had assumed
`dd-mm-yyyy` ([OD-26](../bmbackend/docs/OWNER-DECISIONS.md#od-26)).

**Print rules (updated by the owner's fourth answer set):** `PRICE` and `GRAND TOTAL` print with
**no decimal places** (`240`, `3850`); **empty rows print blank**, not `0`; ❌ **no invoice number is
printed** ([OD-3](../bmbackend/docs/OWNER-DECISIONS.md#od-3)); **credit bills carry payment/balance
information**, cash bills do not; the document label is **`ESTIMATE`** for both.
⚠️ If a stored amount carries paise, zero-decimal display would misstate the bill — a validation
warning is raised and **nothing is silently rounded** (recorded conflict in
[OD-23](../bmbackend/docs/OWNER-DECISIONS.md#od-23)).

**Credit workflow.** **`Credit Bill`** **finalises the credit sale
immediately** — no mandatory credit-details page. It is a completed sale that reduces stock, not a
draft-save. Credit Bills groups invoices customer-wise. See
[OD-21](../bmbackend/docs/OWNER-DECISIONS.md#od-21) and ADR-033.

✅ **Phase 2 closure corrected a stale traceability entry** that still named `CreditDetailsForm` for
FR-CREDIT-001 — the superseded design (audit finding CF-4). Any surviving mention of that component
denotes a **rejected** option, never an implementation instruction. The remaining modal-list and test-plan cleanup is tracked as T3-05, due before M19/M25 exit but not blocking either start. Details in
[docs/PHASE-2-INDEX.md](docs/PHASE-2-INDEX.md).

---

## 8. Repository conventions

- This repository is **independent** of `bmbackend`: separate history, branches, CI and deploys.
- Branches: `main` protected; work on `feat/*`, `fix/*`, `chore/*`; PR review required.
- Conventional commit messages.
- CI must pass lint, type-check, structural tests, unit/integration, E2E, a11y, the bundle-size gate,
  dependency audit and secret scan before merge.
- A change to a **shared** ADR or requirement ID requires a matching commit in `bmbackend`
  (ADR-021).
- `.env` is never committed; only `.env.example`.

---

## 9. Phase status

| Phase | State |
|---|---|
| **1 — Discovery and documentation** | ✅ **CLOSED** 2026-10-29 — all 19 exit criteria met ([../bmbackend/docs/PHASE-1-EXIT-CRITERIA.md](../bmbackend/docs/PHASE-1-EXIT-CRITERIA.md)) |
| **2 — Investigation and implementation planning** | ✅ **CLOSED** — see [docs/PHASE-2-INDEX.md](docs/PHASE-2-INDEX.md) and the [closure report](../bmbackend/docs/PHASE-2-CLOSURE-REPORT.md). Documentation only |
| 3 — Implementation | ⏸ **Not started.** Frontend milestones **M16–M22** and **M25** are **ready**. **M27** moved blocked → **conditionally ready** — the workbook was inspected, so the layout is buildable; its exit gate still needs a printed sample (OD-6) and the date order (OD-26) |

**Neither Phase 1 nor Phase 2 means the application exists, works or has been tested — no code or
test exists.**

Nothing in Phase 1 or Phase 2 modified source code, dependencies, Git history or deployment
configuration — there was none to modify.

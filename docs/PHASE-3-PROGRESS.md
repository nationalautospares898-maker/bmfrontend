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

**Implemented & verified** — code exists, tests were executed, gates passed.

| Area | Files | Note |
|---|---|---|
| Toolchain | `package.json`, `vite.config.ts`, `tsconfig.{json,app,node,test}.json`, `eslint.config.js`, `vitest.config.ts`, `.prettierrc.json` | React 19, TypeScript `strict`, Vite 6, Tailwind v4, the approved dependency set and nothing beyond it. The eslint config bans MUI/AntD/axios/moment/lodash directly, so an unapproved dependency fails the build rather than being caught in review |
| Money | `src/lib/money.ts` | **100% branch coverage**, as §12 requires. Mirrors the backend engine: same strict parsing, same discount ordering, same refusal to round for display |
| Strings | `src/lib/strings.ts` | Every user-facing string in one file the owner can review. The four owner-decided action labels, and every error message says what to do next |
| Shell | `index.html`, `src/main.tsx`, `src/App.tsx`, `src/styles/app.css` | Strict CSP, the dedicated `#print-root` (ADR-028), visible focus, reduced-motion support |
| Structural rules | `tests/structural/rules.test.ts` | 20 assertions enforcing `CLAUDE.md §5` by reading the source |
| CI | `.github/workflows/ci.yml` | Format, lint, types, tests with coverage, build, secret scan, dependency audit. The contract-diff and E2E jobs are wired but inert until M16/M17 land |

### Verified

```
npm run typecheck    → clean
npm run lint         → clean
npm run format:check → All matched files use Prettier code style
npm test             → 62 passed
npm run build        → built; PWA precache 5 entries
test:coverage        → src/lib/money.ts 100% statements/branches/functions/lines
```

---

## 2. Client milestones

| Milestone | Status |
|---|---|
| **M1** scaffold, tooling, structural rules | **Implemented & verified** |
| **M16** shell, API client, auth | **Partially implemented** — see §3 |
| **M17** billing counter and draft persistence | Not started |
| **M18** cash finalisation | Not started |
| **M19** credit finalisation | Not started |
| **M20** print layout (top) and counter slip | Not started |
| **M21** Daily Bills and Credit Bills | Not started |
| **M22** offline layer | Not started |
| **M25** P1 screens | Not started |

---

## 3. M16 — what remains

Done: strict TypeScript, the four allow-listed `VITE_` variables with a structural
assertion, strict CSP, the print root, `lib/money.ts`, `lib/strings.ts`, the structural
suite, CI.

Not done:

- `src/api/client.ts` — auth header, `X-Device-Id`, `X-Counter-Id`, a fresh
  `X-Request-Id` per attempt, the idempotency-key lifecycle, retry policy, timeouts
  (10 s reads, **30 s finalisation** because a slow commit is still a commit, 60 s
  uploads).
- **One shared refresh promise.** Concurrent `401`s await the same refresh; twenty
  parallel refreshes would trip the server's reuse detection and sign the user out
  mid-sale. A test asserts one refresh, not twenty.
- `src/api/errors.ts` — the exhaustive `ErrorCode` switch over all **53** codes.
  `CORRUPT_VERSION` and `SKIPPED_AFTER_EARLIER_FAILURE` arrive as per-operation
  outcomes inside a `200` sync batch, not HTTP errors, and are branched on identically.
- `src/api/generated/schema.d.ts` — generated with `npm run api:types`, **never**
  hand-edited (ADR-029). CI regenerates and fails on a diff.
- Routing, protected routes, permission-aware rendering, the in-memory session module
  (the access token is **never** persisted), `db/meta.ts` for a stable `device_id`.
- Component primitives — the minimal owned shadcn/ui subset.

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
- Before M18 or M22, read
  [`../../bmbackend/docs/PHASE-2-IMPLEMENTATION-BLUEPRINT.md`](../../bmbackend/docs/PHASE-2-IMPLEMENTATION-BLUEPRINT.md)
  **§5.4** — the 12-case recovery state machine (`P2-D-08`, AC-REC-1…11). The
  illustrative `onDraftEdited()` in `docs/API-INTEGRATION.md §5` **must not** be
  implemented as written: it deletes the `pending_finalizations` row and so discards the
  idempotency key of a sale that may already have committed.

---

## 6. External gates

Unchanged by any client work, and listed in full in the master tracker: OD-4 business
identity, OD-6/M27 printer and paper, OD-22 credit-block placement, OD-24 document
label, OD-25/R-36 numbering and tax legality, OD-26 date interpretation, OD-8 staff
training, and the M28 go-live checklist.

**No client-side change can clear any of them.**

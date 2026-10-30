# Phase 2 artifacts — index


| Field | Value |
|---|---|
| Status | **Pointer file. Not authoritative.** It contains **links, not facts** |
| Why it exists | The Phase 2 planning artifacts are cross-cutting, so under ADR-021 they live in the repository that owns business rules and the single traceability matrix — `bmbackend`. This file makes them reachable from here |
| Decision | [`P2-D-01`](../../bmbackend/docs/PHASE-2-DECISION-REGISTER.md#p2-d-01) |
| Maintenance rule | Keep it to links and one-line descriptions. Anything that could go stale belongs in the authoritative document instead. **If this file ever disagrees with one of them, they win** |

---

## The authoritative Phase 2 set

| # | Document | What it answers |
|---|---|---|
| **00A** | [**PHASE-2-DESIGN-COMPLETION-ADDENDUM-2026-10-30.md**](../../bmbackend/docs/PHASE-2-DESIGN-COMPLETION-ADDENDUM-2026-10-30.md) | Current design dispositions, money policy, print/date decisions, implementation and external gates |
| **00** | [**PHASE-2-CLOSURE-ADDENDUM-1.md**](../../bmbackend/docs/PHASE-2-CLOSURE-ADDENDUM-1.md) | ★ **READ FIRST.** The owner's fourth answer set — **no invoice numbering**, the **four** primary actions, **no decimals** on `PRICE`/`GRAND TOTAL`, the full bill layout, and GitHub repository verification |
| 0 | [PHASE-2-CLOSURE-REPORT.md](../../bmbackend/docs/PHASE-2-CLOSURE-REPORT.md) | Closure verdict, all 11 findings and their corrections, the four finalised designs, risk status, milestone readiness |
| 1 | [PHASE-2-REQUIREMENTS-FIDELITY-AUDIT.md](../../bmbackend/docs/PHASE-2-REQUIREMENTS-FIDELITY-AUDIT.md) | Which requirements are **owner-confirmed** vs defaults, recommendations or still open — and the 11 findings (**CF-1…CF-11**), all now **RESOLVED** |
| 2 | [PHASE-2-INVESTIGATION-REPORT.md](../../bmbackend/docs/PHASE-2-INVESTIGATION-REPORT.md) | Feature inventory, architecture review, alternatives, failure modes, security review, database and API findings |
| 3 | [PHASE-2-IMPLEMENTATION-BLUEPRINT.md](../../bmbackend/docs/PHASE-2-IMPLEMENTATION-BLUEPRINT.md) | The target design, the **source-of-truth hierarchy**, diagrams, transaction and idempotency design, print architecture |
| 4 | [PHASE-2-IMPLEMENTATION-PLAN.md](../../bmbackend/docs/PHASE-2-IMPLEMENTATION-PLAN.md) | Milestones **M1…M28** with prerequisites, acceptance criteria, exit gates and *"must not build yet"* |
| 5 | [PHASE-2-DECISION-REGISTER.md](../../bmbackend/docs/PHASE-2-DECISION-REGISTER.md) | Phase 2 technical decisions **`P2-D-01…P2-D-10`** |
| 6 | [PHASE-2-RISK-REGISTER.md](../../bmbackend/docs/PHASE-2-RISK-REGISTER.md) | Risks **R-01…R-37** with prevention, detection, recovery and residual risk |
| 7 | [PHASE-2-OWNER-DECISIONS-REQUIRED.md](../../bmbackend/docs/PHASE-2-OWNER-DECISIONS-REQUIRED.md) | The short list of decisions that genuinely need the owner |
| 8 | [PHASE-2-TRACEABILITY-MATRIX.md](../../bmbackend/docs/PHASE-2-TRACEABILITY-MATRIX.md) | Requirement → decision → milestone → test → release gate |

---

## What this means for work in `bmfrontend`

Read these before implementing anything in this repository:

| Before you build | Read |
|---|---|
| **Anything** | Plan §2 for your milestone's *"must not build yet"* column |
| Billing counter, money preview | `P2-D-03` — the rounding policy comes from `GET /sync/bootstrap`, **never hardcoded**. **Four** primary actions only: `Print Bill` · `Credit Bill` · `Save a Draft` · `Clear Draft` (T3-09) |
| Cash finalisation | **[Blueprint §5.4](../../bmbackend/docs/PHASE-2-IMPLEMENTATION-BLUEPRINT.md)** — the 12-case recovery state machine (`P2-D-08`), and **§5.2** canonicalisation (`P2-D-07`). **Editing is blocked while a sale is unconfirmed** |
| Credit UI (**M19**) | ✅ Unblocked — `TRACEABILITY.md §5` corrected. Any surviving mention of `CreditDetailsForm` denotes a **rejected** design, never an instruction. Build the one-request flow (OD-21, ADR-033) |
| Offline layer (**M14/M22**) | ✅ Unblocked — the four sync codes are registered (`API-SPECIFICATION.md §4.2a`); the union now has **53** codes |
| Print layout (**M20**) | Blueprint §10 + `UI-UX-SPECIFICATION.md §12`. **The full bill content is now known** and buildable: header, field block, 25-row item table, `GRAND TOTAL`, `THANK YOU VISIT AGAIN`, dealer credits. ❌ **No invoice number is printed** (OD-3). `PRICE`/`GRAND TOTAL` print **no decimals** (OD-23, T3-08). ✅ **Layout, geometry, typography, borders, number formats and both logos are VERIFIED from the workbook** (2026-10-30); the header is **`QTY`**. 🔴 **Paper, orientation and scaling were never set in the file** (OD-6), and the **date order** is open (OD-26, T3-11) |

### Frontend milestones

**M16** shell · **M17** billing counter + Dexie drafts · **M18** cash finalisation · **M19** credit ·
**M20** print (top) + counter slip · **M21** Daily + Credit Bills · **M22** offline layer ·
**M25** P1 screens · **M27** workbook-faithful print profile (physical sign-off in Phase 3).

Frontend milestones depend on the **contract**, not the backend module: MSW handlers are written from
[`API-SPECIFICATION.md`](../../bmbackend/docs/API-SPECIFICATION.md), so M16–M22 run in parallel with
the backend. **Never stub a business rule to unblock this repository** — mock the API at the contract
boundary instead.

---

## Related

[`CLAUDE.md`](../CLAUDE.md) *(session rules)* · [`README.md`](../README.md) ·
[`../../bmbackend/docs/OWNER-DECISIONS.md`](../../bmbackend/docs/OWNER-DECISIONS.md)
*(authoritative business decisions)* ·
[`../../bmbackend/docs/TRACEABILITY.md`](../../bmbackend/docs/TRACEABILITY.md)
*(the single matrix)*

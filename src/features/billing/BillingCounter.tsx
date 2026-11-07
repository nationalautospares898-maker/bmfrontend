/**
 * The billing counter. The screen that matters.
 *
 * **Exactly four primary actions** (OD-14), and there is no fifth:
 *
 * | Action | What it does |
 * |---|---|
 * | `Print Bill` | Finalises a **cash** sale, then prints |
 * | `Credit Bill` | Finalises a **credit** sale. Same endpoint, same engine (ADR-033) |
 * | `Save a Draft` | Queues the draft. Works offline; the bill is already on disk |
 * | `Clear Draft` | Discards a draft the user explicitly cleared. Never a completed bill |
 *
 * Both finalisation buttons are refused offline, for the same reason: since ADR-033
 * `Credit Bill` finalises a sale. "Credit" is about who owes money, never about whether
 * the sale happened — so offering it offline would be offering to sell stock the server
 * has not agreed to move.
 *
 * Every business conflict renders as an **inline panel above the buttons**, never a
 * toast (PRD §6.1). A toast can be missed while looking at a customer, and these block
 * a sale.
 *
 * ## What the post-demo redesign changed, and what it did not
 *
 * The owner asked for this workspace to look like their own Excel bill: a bordered grid
 * with `S.No · Item · Qty · Price · Total`, fifteen numbered rows always on screen, the
 * header fields across the top, and `GRAND TOTAL` at the foot. Bill tabs behave like
 * browser tabs — each with a close control, each renamed to its first product.
 *
 * **Nothing about the engine moved.** The same `draftStore`, the same `finalizeSale`, the
 * same single `POST /sales:finalize`, the same idempotency discipline, the same derived
 * totals. The layout is a different arrangement of the identical state; there is no
 * second billing path, and a grid that computed its own money would eventually disagree
 * with the bill it previews.
 *
 * Two earlier decisions were reversed by the owner and are recorded as reversed in
 * `docs/UI-UX-SPECIFICATION.md §4a`: the application may now look like a spreadsheet
 * *on this screen*, and the primary navigation is a right-hand column. The **printed**
 * bill is untouched — its own headers, its own stylesheet, its own isolation (ADR-028).
 *
 * `window` keeps exactly one keyboard listener and it still returns immediately unless
 * `ctrlKey` is held, which is what lets the grid own `Tab`, `Enter`, the arrows and
 * `Space` without ever reaching `Print Bill`.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { ApiError, describeError, fieldErrors, type ErrorCode } from '@/api/errors';
import { customers as customersApi, invoices } from '@/api/endpoints';
import type {
  Bootstrap,
  DirectoryCustomer,
  FinalizeResponse,
  PrintPayload,
} from '@/api/types';
import type { LocalDraft, LocalDraftLine } from '@/db/schema';
import { asText } from '@/lib/format';
import { uuidv7 } from '@/lib/ids';
import {
  formatForScreen,
  parseMoney,
  tryParseMoney,
  type MoneyPolicy,
} from '@/lib/money';
import {
  ACTIONS,
  ACTION_SHORTCUTS,
  BILLING,
  CREDIT,
  ERRORS,
  OFFLINE,
} from '@/lib/strings';
import { Busy, Button, Dialog, Field, Panel } from '@/components/primitives';
import { focusOnNextFrame, isUserTyping } from '@/lib/keyboard';
import {
  CounterSlipRoot,
  PrintRoot,
  type CounterSlipData,
} from '@/features/print/PrintRoot';
import {
  blockingMoneyProblem,
  counterSlipData,
  finalizeSale,
  OfflineFinalizationRefused,
  type FinalizeOutcome,
} from './finalize';
import { canFinalize, draftTotal, useBillingStore } from './draftStore';
import { BillGrid } from './BillGrid';
import { MechanicPicker } from './MechanicPicker';
import type { SearchHit } from './ItemCell';

export interface BillingCounterProps {
  policy: MoneyPolicy;
  online: boolean;
  /** Whether the user may finalise at all; the UI explains rather than silently failing. */
  canBill: boolean;
  /** `billing.price.override`. Without it the Price cell is read-only, never hidden. */
  canOverridePrice: boolean;
  /** `inventory.oversell.override`. Cashiers do not receive it by default. */
  canOverrideOversell?: boolean | undefined;
  /**
   * `catalog.write`. Gates "Add New Item to Stock" in the Item cell.
   *
   * Offered rather than hidden-and-failing: the server refuses `POST /products` without
   * it, and a button that is sometimes a 403 is worse than no button — the same rule the
   * correction action follows in Daily Bills.
   */
  canCreateProduct?: boolean | undefined;
  /**
   * `catalog.write` **and** `inventory.adjust` — the pair the Stock screen needs.
   *
   * With them, "Add New Item to Stock" can also record how many are on the shelf, which
   * is what lets a newly added part be sold on the same bill. Without them the dialog
   * creates the catalogue entry only and says who to ask.
   */
  /**
   * The shop's own heading, **as configured**.
   *
   * From `/sync/bootstrap`, which reads the same `businesses` row the printed bill's
   * payload does. Empty fields render as nothing: the owner has supplied only the
   * trading name (OD-4 is a go-live gate for the legal name, address and phone) and
   * inventing them — or copying them out of the reference workbook — is forbidden
   * (FR-PRINT-016, Q-LEGAL-1).
   */
  business?: Bootstrap['business'] | undefined;
  /** Today, in the **business's** timezone. Never derived from the browser (FE-E-3). */
  businessDate?: string | undefined;
  onSynced?: (() => void) | undefined;
  /**
   * Switch the shell to Daily Bills.
   *
   * Passed in rather than navigated to, because this application has no router: the
   * screen is state in `AppShell`. A `location.assign` here reloaded the whole app.
   */
  onOpenDailyBills?: (() => void) | undefined;
}

type Conflict =
  | { kind: 'error'; code: ErrorCode; details: Record<string, unknown> }
  | { kind: 'money'; message: string }
  | { kind: 'unconfirmed'; stale: boolean }
  | null;

export function BillingCounter({
  policy,
  online,
  canBill,
  canOverridePrice,
  canOverrideOversell = false,
  canCreateProduct = false,
  business,
  businessDate,
  onSynced,
  onOpenDailyBills,
}: BillingCounterProps) {
  const store = useBillingStore();
  const active = store.drafts.find((draft) => draft.id === store.activeDraftId);

  const [busy, setBusy] = useState(false);
  const [oversellApproved, setOversellApproved] = useState(false);
  const [oversellReason, setOversellReason] = useState('');
  const [conflict, setConflict] = useState<Conflict>(null);
  const [completed, setCompleted] = useState<FinalizeResponse | null>(null);
  const [printPayload, setPrintPayload] = useState<PrintPayload | null>(null);
  const [slip, setSlip] = useState<CounterSlipData | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  // An exception approval belongs to one bill only. Never carry it across bill tabs.
  useEffect(() => {
    setOversellApproved(false);
    setOversellReason('');
  }, [active?.id]);
  /**
   * The optional advance taken when a credit bill is created (owner request,
   * 2026-11-07).
   *
   * A **string**, like every amount in this application (ADR-013), and empty by
   * default — an empty or zero advance makes `Credit Bill` behave exactly as it did
   * before, with no `payment` in the request at all.
   *
   * It does **not** reduce the bill. The total comes from the lines; this becomes a real
   * payment against the invoice the same transaction creates, so the outstanding figure
   * the server derives is total minus advance (FR-PAY-003's allocation, ADR-022's
   * derivation). ₹10,000 with ₹2,000 advance is a ₹10,000 bill showing ₹8,000 due, not
   * an ₹8,000 bill.
   */
  const [advance, setAdvance] = useState('');
  const [advanceMethod, setAdvanceMethod] = useState('cash');
  const [closing, setClosing] = useState<LocalDraft | null>(null);

  const total = draftTotal(active);
  /**
   * The advance as a number, or `null` when there is none to send.
   *
   * `null` for empty, unparseable, zero or negative — all of which mean "no advance"
   * rather than "an advance of nothing", and the request must then omit `payment`
   * entirely. An advance **above** the total is left non-null on purpose so the server
   * refuses it with its own message ("That is more than the bill total"), which is the
   * authoritative check; a client that silently clamped it would hide a typo.
   */
  const advanceAmount = (() => {
    const parsed = tryParseMoney(advance);
    if (parsed === null || !parsed.greaterThan(0)) return null;
    return parsed;
  })();
  const ready = canFinalize(active) && canBill;

  /**
   * Focus the Item cell of a given row on the next paint.
   *
   * This is FR-BILL-001 in its new form. The requirement — *search is focused on load
   * and after every added line* — is what makes keyboard-only billing possible, and
   * `CLAUDE.md §6` says never to break it. The search box became a cell, so "focus the
   * search" became "focus the next row's Item cell". Same behaviour, same hands.
   *
   * `yieldToTyping` is the difference between a convenience and a defect. This runs on a
   * `requestAnimationFrame`, and the effect below runs when `store.ready` flips — which
   * happens after Dexie has loaded the open bills, so it can be a long way after the
   * screen became usable. A cashier who clicked `Customer Name` and started typing in
   * that window had the caret yanked into the grid mid-word and the customer's name went
   * into the product search. Found by three component tests that failed intermittently
   * and in a different place each run; the diagnostic showed `rakesh` sitting in the item
   * cell with the customer field empty.
   *
   * So the automatic focus now yields: if the user is already typing somewhere, it does
   * nothing. The explicit hand-off from `addProduct` passes `yieldToTyping: false`,
   * because moving from the cell just filled to the next row **is** the keyboard
   * workflow and the focus it takes is its own.
   */
  const focusItemCell = useCallback(
    (row: number, { yieldToTyping = false }: { yieldToTyping?: boolean } = {}) => {
      requestAnimationFrame(() => {
        if (yieldToTyping && isUserTyping()) return;
        const cell = document.querySelector<HTMLElement>(`[data-cell="${row}-item"]`);
        cell?.focus();
      });
    },
    [],
  );

  // On mount, and whenever the cashier switches tabs, the cursor starts where they would
  // put it: the first empty Item cell — unless they have already started typing
  // elsewhere, in which case their hands win.
  useEffect(() => {
    if (!store.ready || !active) return;
    focusItemCell(active.lines.length, { yieldToTyping: true });
    // Keyed on the tab, not on the line count — re-focusing after every add is done by
    // `addProduct`, which knows which row it filled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.ready, store.activeDraftId]);

  // --- adding and editing lines ---------------------------------------------

  const addProduct = useCallback(
    async (hit: SearchHit, row: number) => {
      if (!active) return;
      const line: Omit<LocalDraftLine, 'id' | 'line_no'> = {
        product_id: hit.productId,
        product_name: hit.name,
        sku: hit.sku,
        unit_code: hit.unitCode,
        quantity: '1.000',
        unit_price: hit.unitPrice,
        // Kept so the server can tell a manual override from a catalog price, and so a
        // `PRICE_CHANGED` panel can show what it was when the line was added.
        catalog_price_at_add: hit.unitPrice,
        price_source: 'catalog',
        discount_percent: '0.000',
        known_stock: hit.stock,
        stock_as_of: hit.stockAsOf,
      };
      await store.addLine(active.id, line);
      // Straight to the next row's Item cell, so the next part can be typed without the
      // mouse. `row + 1` rather than `lines.length` because a product picked into an
      // earlier row should still hand over to the row beneath it.
      focusItemCell(row + 1);
    },
    [active, store, focusItemCell],
  );

  // --- the four actions ------------------------------------------------------

  const runFinalize = useCallback(
    async (saleType: 'cash' | 'credit') => {
      if (!active || busy) return;
      if (oversellApproved && (!canOverrideOversell || oversellReason.trim().length < 10))
        return;
      setConflict(null);

      // Credit needs a persisted customer, not a typed name (FR-CREDIT-009). Checked
      // here so the cashier is told before the request rather than by a 409.
      if (saleType === 'credit' && !active.header.customer_id) {
        setConflict({ kind: 'error', code: 'CREDIT_CUSTOMER_REQUIRED', details: {} });
        return;
      }

      const moneyProblem = blockingMoneyProblem(active, policy);
      if (moneyProblem) {
        setConflict({ kind: 'money', message: moneyProblem });
        return;
      }

      // An authorised oversell is a deliberate, reasoned exception. The checkbox is
      // offered only after the server has returned a stock shortfall; it cannot turn a
      // stale catalogue figure into an automatic approval.
      setBusy(true);
      let outcome: FinalizeOutcome;
      try {
        // The server resolves `draft_id` against its own `draft_bills` row and refuses
        // with NOT_FOUND if it has never seen it. Pushed here, before the sale, and
        // awaited: no sale is attempted against a draft the server does not have.
        const version = await store.ensureOnServer(active.id);

        outcome = await finalizeSale({
          draft: version === null ? active : { ...active, version },
          saleType,
          policy,
          online,
          ...(canOverrideOversell && oversellApproved
            ? { oversellReason: oversellReason.trim() }
            : {}),
          // Cash must cover the total. Credit takes the **optional** advance, and only
          // when one was actually entered — `payment: null` is what the server expects
          // for a credit bill with nothing paid up front, and sending
          // `{amount: "0"}` would be refused ("must be greater than zero").
          //
          // One request, one transaction, one idempotency key: the sale and the advance
          // are committed together by `record_sale_payment`, which participates in the
          // finalisation transaction and never commits on its own. So a retry cannot
          // produce a sale without its advance, an advance without its sale, or two of
          // either.
          ...(saleType === 'cash'
            ? { payment: { method: 'cash', amount: total.toFixed(policy.amount_scale) } }
            : advanceAmount !== null
              ? {
                  payment: {
                    method: advanceMethod,
                    amount: advanceAmount.toFixed(policy.amount_scale),
                  },
                }
              : {}),
        });
      } catch (error) {
        setBusy(false);
        if (error instanceof OfflineFinalizationRefused) {
          // Nothing was created. The bill is safe on disk and a counter slip is offered.
          setConflict({ kind: 'error', code: 'SERVICE_UNAVAILABLE', details: {} });
          return;
        }
        // Everything else is shown, never rethrown. `ensureOnServer` is a plain
        // `PUT /drafts/{id}` and a `NetworkError`, a 428 or a `DRAFT_VERSION_CONFLICT`
        // all arrive here as exceptions; both callers invoke this as `void
        // runFinalize(...)`, so rethrowing produced an unhandled rejection and the
        // cashier saw a flicker and nothing else.
        setConflict(
          error instanceof ApiError
            ? { kind: 'error', code: error.code, details: error.details }
            : { kind: 'money', message: ERRORS.unexpected },
        );
        return;
      }
      setBusy(false);
      await store.reload();

      switch (outcome.kind) {
        case 'completed':
        case 'already_completed': {
          if (outcome.response) {
            setCompleted(outcome.response);
            // Cash prints immediately; credit does **not** open a print dialog
            // (OD-21). The confirmation card offers "Print now" instead, because a
            // credit bill is often filed rather than handed over.
            if (saleType === 'cash') setPrintPayload(outcome.response.print_payload);
          } else if (active.invoice_id) {
            // `DRAFT_ALREADY_FINALIZED` with no body: the sale exists, so load it
            // rather than offering a retry.
            const invoice = await invoices.get(active.invoice_id);
            setConflict({
              kind: 'error',
              code: 'DRAFT_ALREADY_FINALIZED',
              details: { internal_reference: invoice.internal_reference },
            });
          } else {
            setConflict({ kind: 'error', code: 'DRAFT_ALREADY_FINALIZED', details: {} });
          }
          onSynced?.();
          return;
        }
        case 'refused': {
          setConflict({
            kind: 'error',
            code: outcome.code ?? 'INTERNAL_ERROR',
            details: outcome.error instanceof ApiError ? outcome.error.details : {},
          });
          return;
        }
        case 'unknown':
          // No bare retry is offered anywhere in this branch: the customer may
          // already have been charged.
          setConflict({ kind: 'unconfirmed', stale: false });
          return;
      }
    },
    [
      active,
      busy,
      online,
      policy,
      store,
      total,
      onSynced,
      advanceAmount,
      advanceMethod,
      canOverrideOversell,
      oversellApproved,
      oversellReason,
    ],
  );

  const saveDraft = useCallback(async () => {
    if (!active) return;
    await store.saveDraftToServer(active.id);
    onSynced?.();
  }, [active, store, onSynced]);

  const clearDraft = useCallback(async () => {
    if (!active) return;
    const outcome = await store.clearDraft(active.id);
    setConfirmClear(false);
    if (outcome === 'refused_unconfirmed') {
      setConflict({ kind: 'unconfirmed', stale: false });
    } else if (outcome === 'refused_finalized') {
      setConflict({ kind: 'error', code: 'DRAFT_ALREADY_FINALIZED', details: {} });
    }
  }, [active, store]);

  /**
   * Close a tab, like closing a browser tab — but never silently.
   *
   * An empty bill closes straight away. One with items asks first and offers to save it
   * as a draft instead, because `No draft is ever auto-closed, auto-finalised or
   * silently discarded` (§5 rule 18) and a cashier who loses a half-typed bill to a
   * stray click stops trusting the system.
   */
  const closeTab = useCallback(
    async (draft: LocalDraft) => {
      if (draft.lines.length === 0) {
        await store.clearDraft(draft.id);
        return;
      }
      setClosing(draft);
    },
    [store],
  );

  const discardClosing = useCallback(async () => {
    if (!closing) return;
    const outcome = await store.clearDraft(closing.id);
    setClosing(null);
    if (outcome === 'refused_unconfirmed')
      setConflict({ kind: 'unconfirmed', stale: false });
  }, [closing, store]);

  const saveClosing = useCallback(async () => {
    if (!closing) return;
    await store.saveDraftToServer(closing.id);
    setClosing(null);
    onSynced?.();
  }, [closing, store, onSynced]);

  // --- keyboard shortcuts ----------------------------------------------------

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // The guard that makes the spreadsheet grid possible: without `Ctrl` held, nothing
      // here runs, so `Tab`, `Enter`, the arrows and `Space` belong entirely to whatever
      // cell has focus and can never trigger a sale.
      if (!event.ctrlKey) return;
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (ready && online) void runFinalize('cash');
      } else if (event.key === 'Enter' && event.shiftKey) {
        event.preventDefault();
        if (ready && online) void runFinalize('credit');
      } else if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveDraft();
      } else if (event.key === 'Backspace' && event.shiftKey) {
        event.preventDefault();
        setConfirmClear(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ready, online, runFinalize, saveDraft]);

  if (!store.ready) return <Busy label="Opening your bills" />;

  return (
    // `min-h-0` all the way down is what lets the grid be the only scrolling region, so
    // the header, the grand total and the four buttons stay on screen (R5.1).
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <BillTabs
        drafts={store.drafts}
        activeId={store.activeDraftId}
        onSelect={(id) => store.selectDraft(id)}
        onClose={(draft) => void closeTab(draft)}
        onNew={() => void store.newDraft()}
      />

      {store.limitMessage ? (
        <Panel tone="warning" title={store.limitMessage}>
          {BILLING.tabLimitReached(store.maxOpenDrafts)}
        </Panel>
      ) : null}

      {!online ? <Panel tone="warning">{OFFLINE.banner}</Panel> : null}

      {active ? (
        <div className="flex min-h-0 flex-1 flex-col border border-nas-navy bg-white">
          <BillHeader
            business={business}
            businessDate={businessDate}
            draft={active}
            onChange={(patch) => void store.updateHeader(active.id, patch)}
          />

          <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
            <BillGrid
              lines={active.lines}
              readOnly={active.status === 'finalized' || busy}
              online={online}
              canOverridePrice={canOverridePrice}
              canCreateProduct={canCreateProduct}
              onAddProduct={(hit, row) => void addProduct(hit, row)}
              onChangeLine={(lineId, patch) =>
                void store.updateLine(active.id, lineId, patch)
              }
              onRemoveLine={(lineId) => void store.removeLine(active.id, lineId)}
            />

            {/* GRAND TOTAL, in the owner's own words and prominent. Still labelled a
                preview: the server confirms it on completion and answers
                `TOTAL_MISMATCH` if it disagrees (ADR-032). */}
            <div className="mt-2 flex items-baseline justify-end gap-4 border-t-2 border-nas-navy pt-2">
              <span className="text-base font-semibold tracking-wide text-nas-navy">
                {BILLING.grandTotal}
              </span>
              <span className="min-w-36 text-right text-2xl font-bold tabular-nums">
                {formatForScreen(total)}
              </span>
            </div>
            <p className="text-right text-xs text-slate-500">
              {BILLING.totalPreviewLabel}
            </p>
          </div>
        </div>
      ) : null}

      {active ? (
        <>
          {conflict ? (
            <ConflictPanel
              conflict={conflict}
              draft={active}
              policy={policy}
              online={online}
              canOverrideOversell={canOverrideOversell}
              oversellApproved={oversellApproved}
              oversellReason={oversellReason}
              onOversellApprovedChange={(approved) => {
                setOversellApproved(approved);
                if (!approved) setOversellReason('');
              }}
              onOversellReasonChange={setOversellReason}
              onPrintSlip={setSlip}
              onOpenDailyBills={onOpenDailyBills}
            />
          ) : null}

          {/*
            The optional advance on a credit bill (owner request, 2026-11-07).
            Placed above the actions, because it has to be filled *before* pressing
            `Credit Bill` — the sale and the advance are one transaction and there is
            deliberately no "add the advance afterwards" step here. Afterwards is what
            Receive Payment in Credit Bills is for.

            Not a fifth action, and not a dialog: OD-14 settles the four primary actions
            and says there is no fifth. This is a field.
          */}
          <div className="flex flex-wrap items-end gap-3 rounded border border-slate-300 p-3">
            <Field
              label={ACTIONS.advanceLabel}
              hint={ACTIONS.advanceHint}
              inputMode="decimal"
              value={advance}
              data-bill-field="advance"
              onChange={(event) => setAdvance(event.target.value)}
            />
            {/* Shown only once there is an advance to attribute to a method. */}
            {advanceAmount !== null ? (
              <label className="flex flex-col gap-1 text-sm">
                {ACTIONS.advanceMethod}
                <select
                  value={advanceMethod}
                  onChange={(event) => setAdvanceMethod(event.target.value)}
                  className="min-h-11 rounded border border-slate-300 px-2"
                >
                  <option value="cash">Cash</option>
                  <option value="upi">UPI</option>
                  <option value="card">Card</option>
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="cheque">Cheque</option>
                </select>
              </label>
            ) : null}
            {/* The arithmetic spelled out, so nobody reads the advance as a discount.
                Advisory only — the server derives the real outstanding (ADR-022). */}
            {advanceAmount !== null ? (
              <p className="text-xs text-slate-600">
                {ACTIONS.advancePreview(
                  formatForScreen(total),
                  formatForScreen(advanceAmount),
                  formatForScreen(total.minus(advanceAmount)),
                )}
              </p>
            ) : null}
          </div>

          {/* The four actions. In this order, with their shortcuts shown. */}
          <div className="flex flex-wrap gap-3">
            <Button
              variant="primary"
              busy={busy}
              disabled={!ready || !online}
              shortcut={ACTION_SHORTCUTS.printBill}
              onClick={() => void runFinalize('cash')}
            >
              {ACTIONS.printBill}
            </Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={!ready || !online}
              shortcut={ACTION_SHORTCUTS.creditBill}
              onClick={() => void runFinalize('credit')}
            >
              {ACTIONS.creditBill}
            </Button>
            <Button
              variant="secondary"
              shortcut={ACTION_SHORTCUTS.saveDraft}
              onClick={() => void saveDraft()}
            >
              {ACTIONS.saveDraft}
            </Button>
            <Button
              variant="danger"
              shortcut={ACTION_SHORTCUTS.clearDraft}
              onClick={() => setConfirmClear(true)}
            >
              {ACTIONS.clearDraft}
            </Button>
          </div>

          {!online ? (
            <p className="text-sm text-amber-800">{OFFLINE.finalisationDisabled}</p>
          ) : null}
          {!canBill ? (
            <p className="text-sm text-red-800">{ERRORS.permissionDenied}</p>
          ) : null}
        </>
      ) : null}

      {completed ? (
        <CompletionCard
          response={completed}
          policy={policy}
          onPrint={() => setPrintPayload(completed.print_payload)}
          onDismiss={() => setCompleted(null)}
        />
      ) : null}

      <Dialog
        open={confirmClear}
        title={ACTIONS.clearDraft}
        onDismiss={() => setConfirmClear(false)}
        actions={
          <>
            <Button variant="quiet" onClick={() => setConfirmClear(false)}>
              Keep this bill
            </Button>
            <Button variant="danger" onClick={() => void clearDraft()}>
              {ACTIONS.clearDraft}
            </Button>
          </>
        }
      >
        {BILLING.clearDraftConfirm(active?.lines.length ?? 0)}
      </Dialog>

      <Dialog
        open={closing !== null}
        title={BILLING.closeTabTitle}
        onDismiss={() => setClosing(null)}
        actions={
          <>
            <Button variant="quiet" onClick={() => setClosing(null)}>
              {BILLING.closeTabKeep}
            </Button>
            <Button variant="secondary" onClick={() => void saveClosing()}>
              {BILLING.closeTabSaveFirst}
            </Button>
            <Button variant="danger" onClick={() => void discardClosing()}>
              {BILLING.closeTabDiscard}
            </Button>
          </>
        }
      >
        {BILLING.closeTabHasWork(closing?.lines.length ?? 0)}
      </Dialog>

      <PrintRoot
        payload={printPayload}
        policy={policy}
        invoiceId={completed?.invoice.id ?? null}
        onAfterPrint={() => setPrintPayload(null)}
      />
      <CounterSlipRoot data={slip} policy={policy} onAfterPrint={() => setSlip(null)} />
    </div>
  );
}

// --- the tab strip ------------------------------------------------------------

/**
 * Bill tabs that behave like browser tabs.
 *
 * Each has a close control and the name of its first product. The strip scrolls
 * horizontally rather than wrapping or collapsing, because `No tab is ever unreachable`
 * (UI-UX §4) and twenty open bills must all stay clickable — a hidden tab is a bill
 * somebody cannot finish.
 *
 * Switching is local-only and instant: never a fetch, never a finalisation.
 *
 * ## A labelled list, deliberately **not** `role="tablist"`
 *
 * These look like tabs and are called tabs, but they are not the WAI-ARIA tab widget.
 * That pattern requires each tab to own a `tabpanel` via `aria-controls` *and* to move
 * between tabs with the arrow keys — and the arrows belong to the invoice grid here, which
 * is the whole point of the redesign. Declaring `tablist` while honouring neither is a
 * promise to a screen reader that the keyboard then breaks, and axe caught exactly that:
 * `aria-required-children`, because each tab is wrapped with its own close button.
 *
 * So it is a list of buttons with a name, and the current bill is marked with
 * `aria-current` — the same way the section navigation marks the current screen. Honest
 * about what it is, and reachable with `Tab` like every other control.
 */
function BillTabs({
  drafts,
  activeId,
  onSelect,
  onClose,
  onNew,
}: {
  drafts: readonly LocalDraft[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (draft: LocalDraft) => void;
  onNew: () => void;
}) {
  return (
    <nav aria-label="Open bills" className="shrink-0 border-b border-slate-300 pb-1">
      <ul className="flex items-center gap-1 overflow-x-auto">
        {drafts.map((draft) => {
          const current = draft.id === activeId;
          return (
            <li
              key={draft.id}
              className={`flex shrink-0 items-center rounded-t border border-b-0 ${
                current
                  ? 'border-nas-navy bg-nas-navy text-white'
                  : 'border-slate-300 bg-slate-50 text-slate-700'
              }`}
            >
              <button
                type="button"
                aria-current={current ? 'true' : undefined}
                onClick={() => onSelect(draft.id)}
                className="max-w-56 truncate px-3 py-2 text-sm font-medium"
                title={draft.label}
              >
                {draft.label}
                {/* A mark **in addition to** the status word in the panels below, never
                    colour or a glyph alone (NFR-FE-UX-007). */}
                {draft.status === 'conflict' ? ' ⚠' : ''}
                {draft.status === 'unconfirmed' ? ' …' : ''}
                {draft.status === 'finalized' ? ' ✓' : ''}
              </button>
              <button
                type="button"
                onClick={() => onClose(draft)}
                aria-label={BILLING.closeTab(draft.label)}
                className={`px-2 py-2 text-sm ${
                  current ? 'hover:bg-white/20' : 'hover:bg-slate-200'
                }`}
              >
                ×
              </button>
            </li>
          );
        })}
        <li className="shrink-0">
          <Button variant="quiet" onClick={onNew} aria-label={BILLING.newTabAction}>
            {/* The `+` is decoration. The accessible name is "Start a new bill" — not
                "New bill" — because a tab is *called* `New bill` until its first product
                renames it, and two controls sharing one name is ambiguous both to a
                screen reader and to anyone saying "click New bill". The visible text is
                contained in the accessible name, so WCAG 2.5.3 still holds. */}
            <span aria-hidden="true">+ </span>
            {BILLING.newTab}
          </Button>
        </li>
      </ul>
    </nav>
  );
}

// --- the Excel bill header ----------------------------------------------------

/**
 * The top of the owner's bill: the shop, then the four header fields, then `ESTIMATE`.
 *
 * Every business value is **configured, never invented**. `business` comes from
 * `/sync/bootstrap`, which reads the same `businesses` row the printed bill's payload
 * does, and an empty address or phone renders as nothing at all — not a placeholder, and
 * not the address printed in the reference workbook (FR-PRINT-016, OD-4 is still a
 * go-live gate).
 *
 * `ESTIMATE` is the document's own label for cash and credit alike (OD-24, FR-PRINT-021).
 * `BILL`, `INVOICE` and `Tax Invoice` are not permitted as literals anywhere.
 *
 * The four fields are editable **inline**, which FR-BILL-010 requires explicitly — never
 * behind a dialog, and never as part of a credit-details form (that design was removed
 * by OD-21/ADR-033 and must not come back).
 */
function BillHeader({
  business,
  businessDate,
  draft,
  onChange,
}: {
  business: Bootstrap['business'] | undefined;
  businessDate: string | undefined;
  draft: LocalDraft;
  onChange: (patch: Partial<LocalDraft['header']>) => void;
}) {
  const address = (business?.address_lines ?? []).filter((line) => line.trim() !== '');
  const phones = (business?.phone_numbers ?? []).filter((line) => line.trim() !== '');

  /**
   * `Enter` in a header field means "done with this one", and moves to the next.
   *
   * The screen already works this way everywhere else — the grid's `Enter` moves down a
   * row — so a header where `Enter` did nothing was the odd one out, and it is half of
   * what the cashier reported. `Tab` is unchanged and still does the same thing; this
   * adds a second way rather than replacing the first.
   *
   * Only `Enter` is intercepted, and only to move focus. The arrows are left alone so
   * they keep moving the caret inside the text, which is what they are for in a field
   * holding a mechanic's name or a registration number.
   *
   * The last field hands over to the first free Item cell, so the whole header can be
   * filled and the first part typed without reaching for the mouse.
   *
   * Only Vehicle Number uses this now. Customer and Mechanic are comboboxes that own
   * `Enter` while their suggestion list is open, so each handles its own hand-off — see
   * `CustomerPicker.onSearchKeyDown` and `MechanicPicker.onKeyDown`.
   */
  function headerKeys() {
    return (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      // Moving focus fires `onBlur`, which is what persists the field (§4.1 rule 4).
      focusOnNextFrame(`[data-cell="${draft.lines.length}-item"]`);
    };
  }

  return (
    <header className="shrink-0 border-b border-nas-navy px-3 py-2">
      <div className="text-center">
        {/* `h2`, not `h1`. The shell's application title is the screen's one `h1`, and
            "one h1 per screen with no level skipped" is asserted in
            `tests/e2e/accessibility.spec.ts`. Visually unchanged — the size comes from
            the classes, not the level.

            The shop's name comes from the server and **has no client-side fallback**.
            This used to read `business?.display_name ?? 'NATIONAL AUTO SPARES'`, which
            is a business-identity literal in the client — the thing rule 15 forbids. It
            was wrong in two directions at once: a tenant whose profile had not loaded
            would be told it was National Auto Spares, and any *other* shop running this
            software would see the wrong name on its own bills. Empty renders nothing,
            which is the same rule the address and phone lines already follow (OD-4,
            FR-PRINT-016): never a placeholder where a real value belongs. */}
        <h2 className="text-xl font-bold tracking-wide text-nas-navy">
          {business?.display_name ?? ''}
        </h2>
        {/* Rendered only when set. Nothing is printed in place of an empty field. */}
        {address.length > 0 ? (
          <p className="text-xs text-slate-600">{address.join(', ')}</p>
        ) : null}
        {phones.length > 0 ? (
          <p className="text-xs text-slate-600">{phones.join(', ')}</p>
        ) : null}
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <CustomerPicker draft={draft} onChange={onChange} />
        {/* Free text with suggestions from the saved list. The bill still stores a
            **name**, not an id — `mechanic_name_snapshot` is free text and nothing
            downstream needs a mechanic record, which is what keeps correcting the
            suggestion list from ever rewriting a past bill. See `MechanicPicker`. */}
        <MechanicPicker
          value={draft.header.mechanic_name}
          onChange={(mechanic_name) => onChange({ mechanic_name })}
          onDone={() => focusOnNextFrame('[data-bill-field="vehicle"]')}
          resetKey={draft.id}
        />
        <Field
          label={BILLING.headerVehicle}
          key={`veh-${draft.id}-${draft.header.vehicle_number}`}
          defaultValue={draft.header.vehicle_number}
          data-bill-field="vehicle"
          onBlur={(event) => onChange({ vehicle_number: event.target.value })}
          onKeyDown={headerKeys()}
        />
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">{BILLING.headerDate}</span>
          {/* The **business's** date, from bootstrap. Never `new Date()`: a counter PC set
              to UTC is on yesterday's business date for the first five and a half hours of
              every Asia/Kolkata day (FE-E-3). */}
          <span className="min-h-11 content-center text-base">{businessDate ?? '—'}</span>
        </div>
      </div>

      <p className="mt-1 text-sm font-semibold tracking-widest text-nas-navy">
        {BILLING.estimate}
      </p>
    </header>
  );
}

// --- the conflict panel -------------------------------------------------------

/**
 * Business conflicts, inline and above the buttons.
 *
 * The `PRICE_CHANGED` and `INSUFFICIENT_STOCK` branches deliberately offer **no**
 * "accept and continue" shortcut: `accept_price_changes` is only ever set after the user
 * has seen the difference and chosen (E-5), and a one-click accept is indistinguishable
 * from automatic acceptance in practice.
 */
function ConflictPanel({
  conflict,
  draft,
  policy,
  online,
  canOverrideOversell,
  oversellApproved,
  oversellReason,
  onOversellApprovedChange,
  onOversellReasonChange,
  onPrintSlip,
  onOpenDailyBills,
}: {
  conflict: NonNullable<Conflict>;
  draft: LocalDraft;
  policy: MoneyPolicy;
  online: boolean;
  canOverrideOversell: boolean;
  oversellApproved: boolean;
  oversellReason: string;
  onOversellApprovedChange: (approved: boolean) => void;
  onOversellReasonChange: (reason: string) => void;
  onPrintSlip: (data: CounterSlipData) => void;
  onOpenDailyBills?: (() => void) | undefined;
}) {
  if (conflict.kind === 'money') {
    return (
      <Panel tone="danger" title="This total cannot be printed">
        {conflict.message} {ERRORS.wholeRupeeRequired('')}
      </Panel>
    );
  }

  if (conflict.kind === 'unconfirmed') {
    return (
      <Panel
        tone="danger"
        title="This bill is not confirmed"
        actions={
          // The only affordances are "look it up" and "print a slip". There is
          // deliberately no "try again" button: the customer may already have been
          // charged (E-2).
          <>
            <Button
              variant="secondary"
              onClick={() => onOpenDailyBills?.()}
              disabled={!onOpenDailyBills}
            >
              Check Daily Bills
            </Button>
            {!online ? (
              <Button
                variant="secondary"
                onClick={() => onPrintSlip(counterSlipData(draft, policy))}
              >
                {OFFLINE.counterSlip}
              </Button>
            ) : null}
          </>
        }
      >
        {conflict.stale ? OFFLINE.notConfirmedStale : OFFLINE.notConfirmed}
      </Panel>
    );
  }

  const presentation = describeError(conflict.code);
  const fields = conflict.details.fields
    ? fieldErrors(
        new ApiError(422, {
          error: {
            code: 'VALIDATION_ERROR',
            message: '',
            details: conflict.details,
            request_id: '',
            retryable: false,
          },
        }),
      )
    : {};

  return (
    <Panel
      tone={presentation.needsResolution ? 'danger' : 'warning'}
      title={presentation.message}
      actions={
        conflict.code === 'SERVICE_UNAVAILABLE' && !online ? (
          <Button
            variant="secondary"
            onClick={() => onPrintSlip(counterSlipData(draft, policy))}
          >
            {OFFLINE.counterSlip}
          </Button>
        ) : null
      }
    >
      {/* Per-line detail, so "not enough stock" says which item and how much. */}
      {Array.isArray(conflict.details.shortfalls) ? (
        <ul className="list-inside list-disc">
          {(conflict.details.shortfalls as Array<Record<string, string>>).map(
            (shortfall) => (
              <li key={shortfall.product_id}>
                {ERRORS.insufficientStockLine(
                  shortfall.product_name ?? '',
                  shortfall.requested ?? '',
                  shortfall.available ?? '',
                )}
              </li>
            ),
          )}
        </ul>
      ) : null}
      {conflict.code === 'INSUFFICIENT_STOCK' && canOverrideOversell ? (
        <div className="mt-3 rounded border border-amber-400 bg-amber-50 p-3">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={oversellApproved}
              onChange={(event) => onOversellApprovedChange(event.target.checked)}
              className="mt-1"
            />
            <span>{BILLING.oversellApprovalLabel}</span>
          </label>
          {oversellApproved ? (
            <div className="mt-3 flex flex-col gap-2">
              <p className="text-sm">{BILLING.oversellApprovalWarning}</p>
              <label className="flex flex-col gap-1 text-sm">
                {BILLING.oversellReasonLabel}
                <textarea
                  value={oversellReason}
                  onChange={(event) => onOversellReasonChange(event.target.value)}
                  minLength={10}
                  maxLength={500}
                  rows={2}
                  aria-describedby="oversell-reason-hint"
                  className="min-h-20 rounded border border-slate-300 p-2"
                />
              </label>
              <p id="oversell-reason-hint" className="text-xs text-slate-700">
                {oversellReason.trim().length < 10
                  ? BILLING.oversellReasonRequired
                  : BILLING.oversellRetryHint}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
      {Array.isArray(conflict.details.price_changes) ? (
        <ul className="list-inside list-disc">
          {(conflict.details.price_changes as Array<Record<string, string>>).map(
            (change) => (
              <li key={change.product_id}>
                {ERRORS.priceChangedLine(
                  change.product_name ?? '',
                  change.was ?? '',
                  change.now ?? '',
                )}
              </li>
            ),
          )}
        </ul>
      ) : null}
      {Object.entries(fields).map(([field, message]) => (
        <p key={field}>
          {field}: {message}
        </p>
      ))}
      {conflict.details.internal_reference ? (
        <p className="mt-2 text-xs">
          Internal reference {asText(conflict.details.internal_reference)} — for the
          owner, not for the customer.
        </p>
      ) : null}
    </Panel>
  );
}

// --- the confirmation card ----------------------------------------------------

/**
 * Shown after a sale commits.
 *
 * For credit it must say **"Stock has been updated."** (FR-CREDIT-013/026). That exact
 * sentence is the one thing that stops a cashier reading "saved" as "not sold yet" and
 * letting the customer leave with the goods while the stock figure is wrong.
 */
function CompletionCard({
  response,
  policy,
  onPrint,
  onDismiss,
}: {
  response: FinalizeResponse;
  policy: MoneyPolicy;
  onPrint: () => void;
  onDismiss: () => void;
}) {
  const invoice = response.invoice;
  const isCredit = invoice.is_credit;

  return (
    <Panel
      tone="success"
      title={isCredit ? CREDIT.confirmationTitle : 'Bill completed'}
      actions={
        <>
          {isCredit ? (
            <Button variant="primary" onClick={onPrint}>
              {CREDIT.printNow}
            </Button>
          ) : null}
          <Button variant="quiet" onClick={onDismiss}>
            Start the next bill
          </Button>
        </>
      }
    >
      <p>{CREDIT.stockUpdated}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4">
        <dt>Total</dt>
        <dd>{formatForScreen(parseMoney(String(invoice.total)))}</dd>
        {isCredit ? (
          <>
            <dt>{CREDIT.outstandingLabel}</dt>
            <dd>{formatForScreen(parseMoney(String(invoice.outstanding)))}</dd>
            {invoice.due_date ? (
              <>
                <dt>{CREDIT.dueDateLabel}</dt>
                <dd>{invoice.due_date}</dd>
              </>
            ) : null}
          </>
        ) : null}
      </dl>
      {isCredit ? <p className="mt-2 text-xs">{CREDIT.printLater}</p> : null}
      {response.warnings.map((warning) => (
        // Warnings are rendered from their `message` and never block: the sale
        // committed, and an unknown warning code must not break a completed sale.
        <p key={warning.code} className="mt-2 text-xs text-amber-800">
          {warning.message}
        </p>
      ))}
      {/*
        No invoice number is shown. There is none to show (OD-3): the internal
        reference stays on the invoice resource for the owner and support.
      */}
      <p className="sr-only">{policy.currency}</p>
    </Panel>
  );
}

// --- the customer picker ------------------------------------------------------

/**
 * Attach a **saved** customer to the bill.
 *
 * `draft.header.customer_id` is the association; the typed name, vehicle and phone are
 * this bill's *snapshot* of it (FR-CREDIT-012) and are not a customer record. Credit
 * requires the id, not the text (FR-CREDIT-009).
 *
 * Creating from here uses `PUT /customers/{id}` with a **client-generated** id, which is
 * the documented creation contract and is naturally idempotent — so a double click or a
 * retry is an upsert, not a second customer. That is preferred over `customer.mode:
 * "new"` on finalisation for one reason that matters at the counter: the server's
 * `CUSTOMER_DUPLICATE_SUSPECTED` warning then arrives **before** the sale is committed,
 * while the cashier can still pick the existing customer instead. Nothing is ever merged
 * automatically (FR-CUST-004).
 */
function CustomerPicker({
  draft,
  onChange,
}: {
  draft: LocalDraft;
  onChange: (patch: Partial<LocalDraft['header']>) => void;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<DirectoryCustomer[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<string[] | null>(null);
  /**
   * Which match the keyboard is standing on.
   *
   * The same model `ItemCell` uses for products, because the cashier should not have to
   * learn two different autocompletes on one screen. Reset whenever the matches change —
   * otherwise a highlight left at index 4 points into a shorter list and `Enter` picks
   * nothing, which reads as "Enter is broken".
   */
  const [highlighted, setHighlighted] = useState(0);
  const listId = useId();

  /**
   * Where focus should go once this component has been rebuilt, or `null` for nowhere.
   *
   * Choosing a customer and pressing `Change` both **replace** this component's controls:
   * the search box becomes a name plus a `Change` button, and back again. React unmounts
   * the focused node either way, and a browser whose focused element is removed puts
   * focus on `<body>` — so the next `Tab` restarts from the top of the document. That is
   * the defect the cashier reported as "after picking a customer, Tab does nothing".
   *
   * The hand-off is recorded here and performed in the effect below rather than in the
   * handler, because the handler runs *before* React has committed the replacement and
   * cannot focus something that does not exist yet. An earlier attempt polled for the
   * element on animation frames; it worked four times in five and is why this is now
   * done the way React actually offers — after the commit, when the element is certain
   * to be there.
   *
   * A ref, not state: it must not cause a render of its own, and it is read exactly once.
   */
  const handOff = useRef<'mechanic' | 'customer' | null>(null);

  useEffect(() => {
    // The arrows move a highlight rather than focus, and a browser only auto-scrolls for
    // real focus — so without this the highlight walks out of sight in a long list and
    // `Enter` appears to pick something at random.
    document
      .getElementById(`${listId}-${highlighted}`)
      // Optional call: scrolling the highlight into view is a nicety, and jsdom (which
      // the component tests run in) does not implement `scrollIntoView` at all.
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [highlighted, listId]);

  useEffect(() => {
    const target = handOff.current;
    if (!target) return;
    handOff.current = null;
    if (target === 'mechanic') {
      // A sibling that was never unmounted, so it is already there.
      document.querySelector<HTMLElement>('[data-bill-field="mechanic"]')?.focus();
      return;
    }
    searchBox.current?.focus();
    // Keyed on the association, because that is exactly what swaps the controls over.
  }, [draft.header.customer_id]);

  /** The search box, so the hand-off needs no lookup when it comes back. */
  const searchBox = useRef<HTMLInputElement | null>(null);

  /**
   * Set by `attach`, read and cleared by the box's `onBlur`.
   *
   * **Why this exists.** Picking a suggestion with `Tab` moves focus, which fires the
   * search box's `blur` — and `blur` persists *the typed text* as the bill's customer
   * name. So `Tab` attached customer `c-2` and then immediately overwrote their name
   * with `rakesh`: the right customer id against the wrong name, on a real bill.
   * `Enter` never showed it because it calls `preventDefault`, so focus does not move
   * and no blur happens. The mouse never showed it because `onMouseDown` is cancelled.
   *
   * Found by a test that failed roughly one run in four looking for the attached
   * customer's name — a genuine defect wearing a flake's clothes.
   */
  const justAttached = useRef(false);

  // Debounced, and late replies are discarded: typing fires a search per keystroke and
  // without the guard the slowest reply wins, showing matches for a prefix the box no
  // longer holds.
  const latest = useRef(0);
  useEffect(() => {
    const text = term.trim();
    if (text.length < 2) {
      setResults(null);
      return;
    }
    const sequence = latest.current + 1;
    latest.current = sequence;
    const timer = setTimeout(() => {
      void customersApi
        .search(text)
        .then((response) => {
          if (sequence === latest.current) {
            setResults(response.items);
            setHighlighted(0);
          }
        })
        .catch(() => {
          if (sequence === latest.current) setResults([]);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [term]);

  function attach(customer: DirectoryCustomer): void {
    onChange({
      customer_id: customer.id,
      customer_name: customer.name,
      customer_business_name: customer.business_name ?? '',
      phone: customer.primary_phone ?? '',
      ...(customer.default_mechanic_name
        ? { mechanic_name: customer.default_mechanic_name }
        : {}),
      ...(customer.vehicles[0] ? { vehicle_number: customer.vehicles[0] } : {}),
    });
    setTerm('');
    setResults(null);
    setDuplicates(null);
    setProblem(null);
    // Mechanic Name is the next field in the header's own reading order, so continuing
    // there is the sequence the screen already implies rather than a new workflow.
    handOff.current = 'mechanic';
    // The blur that `Tab` is about to fire must not write the typed text over the name
    // just set from the chosen customer.
    justAttached.current = true;
  }

  /**
   * The customer box's keys, mirroring `ItemCell` so the screen has one grammar.
   *
   * While the list is open it owns `↓ ↑`, `Enter` and `Escape`. With the list closed,
   * `Enter` moves on to the next field — the same "Enter means next" the grid uses, and
   * the answer to "I press Enter and nothing happens".
   *
   * `Escape` closes the list and keeps what was typed: the cashier may be mid-word, and a
   * key that discarded their typing would be worse than one that did nothing. It never
   * clears the bill.
   */
  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    const matches = results ?? [];
    const listOpen = results !== null && matches.length > 0;

    if (listOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlighted((current) => Math.min(current + 1, matches.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlighted((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const chosen = matches[highlighted];
        if (!chosen) return;
        // `Tab` picks as well as `Enter` — the owner asked for both, and `MechanicPicker`
        // does the same so the two header comboboxes behave alike. `Tab` keeps its
        // native "move on" afterwards, which is why it is not prevented: the highlight
        // is taken *and* focus advances, which is what Tab on a highlighted option
        // should feel like. `attach` then redirects the hand-off to Mechanic Name.
        if (event.key === 'Enter') event.preventDefault();
        attach(chosen);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setResults(null);
        return;
      }
    }

    if (event.key === 'Enter') {
      // No list to choose from, so Enter means "I have finished with this field".
      // `preventDefault` so it can never reach a form submission or a default action.
      event.preventDefault();
      // The typed name is this bill's snapshot even without a saved customer
      // (FR-CREDIT-012); `onBlur` persists it, and moving focus fires that blur.
      // Mechanic Name is mounted either way here, so a single frame is enough.
      focusOnNextFrame('[data-bill-field="mechanic"]');
    }
  }

  async function createAndAttach(): Promise<void> {
    const name = term.trim();
    if (!name) return;
    setCreating(true);
    setProblem(null);
    try {
      const id = uuidv7();
      const result = await customersApi.upsert(id, { name });
      // The **persisted** id, read back from the response rather than assumed.
      attach({
        id: result.customer?.id ?? id,
        name: result.customer?.name ?? name,
        business_name: null,
        primary_phone: null,
        phones: [],
        vehicles: [],
        address_lines: [],
        default_mechanic_name: null,
        credit_terms_days: null,
        credit_limit: null,
        is_active: true,
      });
      // Surfaced, never blocking, and never merged (FR-CUST-004).
      const suspected = (result.warnings ?? []).filter(
        (warning) => warning.code === 'CUSTOMER_DUPLICATE_SUSPECTED',
      );
      if (suspected.length > 0) setDuplicates(suspected.map((w) => asText(w.message)));
    } catch (caught) {
      setProblem(
        caught instanceof ApiError
          ? describeError(caught.code).message
          : ERRORS.unexpected,
      );
    } finally {
      setCreating(false);
    }
  }

  if (draft.header.customer_id) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-slate-700">
          {BILLING.headerCustomer}
        </span>
        <div className="flex min-h-11 items-center justify-between gap-2 rounded border border-nas-navy bg-[#f3f4fb] px-2">
          <span
            className="truncate text-base font-semibold"
            title={draft.header.customer_name}
          >
            {draft.header.customer_name}
          </span>
          <Button
            variant="quiet"
            className="min-h-0 px-2 text-xs"
            onClick={() => {
              // Clears the association but keeps the typed snapshot: the goods were
              // still sold to whoever is standing there, and a cash bill needs no
              // customer record.
              onChange({ customer_id: null });
              setProblem(null);
              setDuplicates(null);
              // This button is itself unmounted by that change, so focus would land on
              // `<body>` — the same trap as choosing a customer, in the other direction.
              // Put the cashier in the search box they just asked for.
              handOff.current = 'customer';
            }}
          >
            {BILLING.changeCustomer}
          </Button>
        </div>
        {duplicates ? (
          <p className="text-xs text-amber-800">{duplicates.join(' ')}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="relative flex flex-col gap-1">
      <Field
        label={BILLING.headerCustomer}
        value={term}
        autoComplete="off"
        placeholder={BILLING.findCustomerHint}
        ref={searchBox}
        data-bill-field="customer"
        // The combobox contract, so a screen reader announces the matches and which one
        // the arrows are standing on. `aria-activedescendant` is how a listbox reports
        // the highlighted option while focus stays in the input — which is what lets the
        // options stay out of the tab order below.
        role="combobox"
        aria-expanded={results !== null && results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        {...(results !== null && results.length > 0
          ? { 'aria-activedescendant': `${listId}-${highlighted}` }
          : {})}
        onKeyDown={onSearchKeyDown}
        onChange={(event) => setTerm(event.target.value)}
        // Persisted on **blur**, not per keystroke.
        //
        // The typed name is still kept on the bill without a saved customer — a name on
        // a cash bill is persisted on the invoice snapshot (FR-CREDIT-012) — but writing
        // it on every keystroke meant a Dexie transaction and a store re-publish per
        // character. That breaks `ARCHITECTURE.md §4.1` rule 4 (text is debounced
        // ~300 ms; only add/remove-line is immediate) and it made this component
        // genuinely flaky: each write re-read and re-published the draft, racing the
        // debounced customer search and intermittently discarding its results.
        onBlur={(event) => {
          // A suggestion was just taken, so the authoritative name is the customer's
          // and has already been written. Persisting the typed fragment here would
          // replace `Rakesh Transport` with `rakesh`.
          if (justAttached.current) {
            justAttached.current = false;
            return;
          }
          onChange({ customer_name: event.target.value });
        }}
      />
      {problem ? (
        <p role="alert" className="text-xs text-red-700">
          {problem}
        </p>
      ) : null}
      {results ? (
        <div className="absolute left-0 top-full z-30 w-72 rounded border border-nas-navy bg-white p-1 shadow-lg">
          {/*
            Rendered only when there is something in it. A search that found nothing used
            to leave an empty `<ul role="listbox">` behind — announced by a screen reader
            as a list with no items, and inconsistent with `aria-expanded`, which is
            already false in that case. The "save as a new customer" block below is what
            an empty result has to offer, and it stays.
          */}
          {results.length > 0 ? (
            <ul
              id={listId}
              role="listbox"
              /**
               * **Not a tab stop, even though it scrolls.**
               *
               * Chromium makes a scrollable container keyboard-focusable so it can be
               * scrolled with the arrows — which is helpful for a page region and wrong
               * for a listbox, where focus belongs in the input and `aria-activedescendant`
               * reports the highlight. Without this, `Tab` out of the customer box landed
               * on the list itself: a stop with no label, no action, and nothing to do.
               * Found in the browser, not in jsdom, which does not implement the rule.
               */
              tabIndex={-1}
              className="max-h-48 overflow-y-auto"
            >
              {results.map((customer, index) => (
                <li
                  key={customer.id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === highlighted}
                >
                  <button
                    type="button"
                    /**
                     * **Not a tab stop.** Focus stays in the search box and the arrows walk
                     * the list, which is the combobox pattern and the one `ItemCell`
                     * already uses. Without this, `Tab` out of a box showing ten matches
                     * went through ten buttons before reaching Mechanic Name — and each of
                     * those buttons did nothing when pressed, because the handler below
                     * was `onMouseDown` only and a keyboard press fires `click`.
                     */
                    tabIndex={-1}
                    // `onMouseDown` cancels the default *only* to stop the input's blur
                    // closing the list before the click lands. The selection itself is on
                    // `onClick`, which both a mouse and a keyboard produce — the earlier
                    // arrangement was reachable by mouse alone.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => attach(customer)}
                    /**
                     * `Space` selects **here**, on a focused option, and nowhere else.
                     *
                     * The owner asked for Space to select. It must never do so from the
                     * search box: a customer is called `Kumar Transports`, and a field
                     * that ate the space would make most names untypeable — the same
                     * reasoning `ItemCell` records for `AXEL PACKING`. A `<button>`
                     * already activates on Space natively, so this only stops the page
                     * scrolling underneath.
                     */
                    onKeyDown={(event) => {
                      if (event.key === ' ') event.preventDefault();
                    }}
                    className={`w-full px-2 py-1 text-left text-sm hover:bg-slate-100 ${
                      index === highlighted ? 'bg-slate-100' : ''
                    }`}
                  >
                    {customer.name}
                    {customer.primary_phone ? ` · ${customer.primary_phone}` : ''}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {/*
            Offered whenever a name has been typed, **not** only when nothing matched. A
            near-match used to block the action entirely: a shop that already has a
            "Ramesh Kumar" could not add a second, different one from the billing screen
            at all. Two customers may genuinely share a name, so the decision belongs to
            the cashier who can see the person in front of them.
          */}
          <div className="border-t border-slate-200 p-1">
            <span className="text-xs text-slate-600">
              {results.length === 0
                ? BILLING.customerNotFound
                : BILLING.notTheRightCustomer}
            </span>
            {/*
              Reachable by `Tab` from the search box, and activated by `Enter` or
              `Space` like any button — it was previously `onMouseDown` only, so a
              keyboard user could focus it and press Enter to no effect at all.
              `busy` disables it while the request is in flight, so neither a double
              press nor a double click can create two customers.
            */}
            <Button
              variant="secondary"
              busy={creating}
              className="mt-1 min-h-9 w-full text-xs"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void createAndAttach()}
            >
              {BILLING.saveAsNewCustomer}
            </Button>
          </div>
        </div>
      ) : null}
      {!draft.header.customer_id ? (
        <p className="text-xs text-slate-500">{BILLING.creditNeedsCustomer}</p>
      ) : null}
    </div>
  );
}

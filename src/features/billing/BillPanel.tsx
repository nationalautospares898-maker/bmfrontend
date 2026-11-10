/**
 * One bill, as a column of the three-bill workspace.
 *
 * ## What this is
 *
 * Everything that used to be *the* billing screen — the header fields, the spreadsheet
 * grid, `GRAND TOTAL`, the conflict panel, the confirmation card and the four primary
 * actions — now lives here, and `BillingCounter` renders up to three of them side by
 * side. Splitting the file is the whole of the change: a counter hand who is part-way
 * through three customers can see all three bills at once instead of switching tabs.
 *
 * ## Nothing about the engine moved, again
 *
 * The same `draftStore` actions, the same `finalizeSale`, the same single
 * `POST /sales:finalize`, the same idempotency discipline, the same derived totals. A
 * panel is a *view of one `LocalDraft`*; it owns no money arithmetic and no second
 * billing path. Three panels are three views of three drafts, which is why they cannot
 * interfere with one another: each addresses its own draft by id, as every mutation in
 * this feature already did.
 *
 * ## Per-bill state, deliberately
 *
 * `busy`, the conflict, the completion card, the advance and the oversell approval are
 * **this bill's**, and they are state inside this component rather than a map keyed by
 * draft id in the parent. An approval or a `PRICE_CHANGED` panel belonging to one bill
 * must never appear over another, and the cheapest way to guarantee that is to give
 * each bill its own component instance. React unmounts it with the tab, which also
 * disposes of the exception approval — the behaviour the old effect keyed on
 * `active?.id` had to reproduce by hand.
 *
 * ## Why three bills need scoped focus
 *
 * Every panel has a `[data-cell="0-item"]` and a `[data-bill-field="vehicle"]`. A
 * document-wide `querySelector` therefore returns whichever bill is leftmost, so the
 * hand-offs that make keyboard-only billing work — customer to mechanic to vehicle to
 * the first item cell, and item to next row — were all one bill wide. Each one now
 * looks inside `panel`, this column's own element. `BillGrid` was already scoped to its
 * own `<tbody>` and needed no change.
 *
 * ## The keyboard shortcuts belong to the bill with focus
 *
 * There is still exactly one `window` listener for `Ctrl+Enter` and friends, and it is
 * registered by the **active** panel only. Clicking or tabbing into a column makes it
 * active, so `Ctrl+Enter` always finalises the bill the cashier is looking at — and
 * three listeners racing to finalise three bills is not a state this can reach. The
 * listener still returns immediately unless `ctrlKey` is held, which is what lets the
 * grid keep `Tab`, `Enter`, the arrows and `Space`.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { ApiError, describeError, fieldErrors } from '@/api/errors';
import { customers as customersApi, invoices } from '@/api/endpoints';
import type { DirectoryCustomer, FinalizeResponse, PrintPayload } from '@/api/types';
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
import { Button, Dialog, Field, Panel } from '@/components/primitives';
import { focusOnNextFrame } from '@/lib/keyboard';
import type { CounterSlipData } from '@/features/print/PrintRoot';
import { type BillUiState, type Conflict } from './billUiState';
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

/** What a finished sale hands back to the workspace, which owns the one print root. */
export interface PrintRequest {
  payload: PrintPayload;
  invoiceId: string | null;
}

export interface BillPanelProps {
  draft: LocalDraft;
  /** Where this bill sits in the open tabs. Shown on the column, never on an invoice. */
  position: number;
  /** Whether this is the column the keyboard shortcuts act on. */
  active: boolean;
  /** Called when the cashier clicks or tabs into this column. */
  onActivate: () => void;
  policy: MoneyPolicy;
  online: boolean;
  canBill: boolean;
  canOverridePrice: boolean;
  canOverrideOversell: boolean;
  canCreateProduct: boolean;
  businessDate: string | undefined;
  onSynced?: (() => void) | undefined;
  onOpenDailyBills?: (() => void) | undefined;
  /** The workspace owns the single print root (ADR-028); a panel only asks. */
  onPrint: (request: PrintRequest) => void;
  onPrintSlip: (data: CounterSlipData) => void;
  /**
   * A sale committed. The **workspace** shows the confirmation, not this column.
   *
   * It has to outlive the column. `store.reload()` after a finalisation drops the
   * finished bill from the open drafts, which unmounts this panel — and while the
   * confirmation was state in here, it went with it: the cashier pressed `Print Bill`,
   * the bill disappeared and nothing ever said **"Stock has been updated."**, which
   * FR-CREDIT-013/026 requires in those words. Caught by the keyboard-only browser run.
   */
  onCompleted: (response: FinalizeResponse) => void;
  /** This bill's screen state, held by the workspace so it outlives this column. */
  ui: BillUiState;
  /** Patch this bill's screen state. Addressed by draft id, never by column. */
  onUiChange: (draftId: string, patch: Partial<BillUiState>) => void;
}

export function BillPanel({
  draft,
  position,
  active,
  onActivate,
  policy,
  online,
  canBill,
  canOverridePrice,
  canOverrideOversell,
  canCreateProduct,
  businessDate,
  onSynced,
  onOpenDailyBills,
  onPrint,
  onPrintSlip,
  onCompleted,
  ui,
  onUiChange,
}: BillPanelProps) {
  const store = useBillingStore();

  const { advance, advanceMethod, busy, conflict, oversellApproved, oversellReason } = ui;

  /** Patch *this* bill's screen state. Bound to the id so it cannot address another. */
  const setUi = useCallback(
    (patch: Partial<BillUiState>) => onUiChange(draft.id, patch),
    [onUiChange, draft.id],
  );

  /**
   * Whether the clear-this-bill dialog is open.
   *
   * Stays here, unlike everything above: a dialog is a question being asked of the
   * person looking at the screen, and a question they walked away from should not be
   * waiting for them when they come back to the bill.
   */
  const [confirmClear, setConfirmClear] = useState(false);

  /**
   * This column's own element.
   *
   * Every focus hand-off is scoped to it. Three bills share every selector this screen
   * uses, so a document-wide lookup is a lookup in the leftmost bill.
   */
  const panel = useRef<HTMLElement | null>(null);

  const total = draftTotal(draft);
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
  const ready = canFinalize(draft) && canBill;

  /**
   * Focus a row's Item cell on the next paint, **in this bill**.
   *
   * This is FR-BILL-001 in its current form. The requirement — *search is focused on
   * load and after every added line* — is what makes keyboard-only billing possible, and
   * `CLAUDE.md` §6 says never to break it. The search box became a cell, so "focus the
   * search" became "focus the next row's Item cell". Same behaviour, same hands; the
   * only thing the workspace added is that the cell has to be one of *this* bill's.
   */
  const focusItemCell = useCallback((row: number) => {
    focusOnNextFrame(`[data-cell="${row}-item"]`, panel.current);
  }, []);

  // --- adding and editing lines ---------------------------------------------

  const addProduct = useCallback(
    async (hit: SearchHit, row: number, opts?: { stayInRow?: boolean }) => {
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
      await store.addLine(draft.id, line);
      // `stayInRow` (Tab, owner request) keeps the cashier on this row — the caller
      // (`BillGrid`) moves focus to this same row's Quantity cell itself. Everywhere
      // else (Enter, a click) keeps FR-BILL-001: straight to the next row's Item cell,
      // so the next part can be typed without the mouse. `row + 1` rather than
      // `lines.length` because a product picked into an earlier row should still hand
      // over to the row beneath it.
      if (!opts?.stayInRow) focusItemCell(row + 1);
    },
    [draft.id, store, focusItemCell],
  );

  // --- the four actions ------------------------------------------------------

  const runFinalize = useCallback(
    async (saleType: 'cash' | 'credit') => {
      if (busy) return;
      if (oversellApproved && (!canOverrideOversell || oversellReason.trim().length < 10))
        return;
      setUi({ conflict: null });

      // Credit needs a persisted customer, not a typed name (FR-CREDIT-009). Checked
      // here so the cashier is told before the request rather than by a 409.
      if (saleType === 'credit' && !draft.header.customer_id) {
        setUi({
          conflict: { kind: 'error', code: 'CREDIT_CUSTOMER_REQUIRED', details: {} },
        });
        return;
      }

      const moneyProblem = blockingMoneyProblem(draft, policy);
      if (moneyProblem) {
        setUi({ conflict: { kind: 'money', message: moneyProblem } });
        return;
      }

      // An authorised oversell is a deliberate, reasoned exception. The checkbox is
      // offered only after the server has returned a stock shortfall; it cannot turn a
      // stale catalogue figure into an automatic approval.
      setUi({ busy: true });
      let outcome: FinalizeOutcome;
      try {
        // The server resolves `draft_id` against its own `draft_bills` row and refuses
        // with NOT_FOUND if it has never seen it. Pushed here, before the sale, and
        // awaited: no sale is attempted against a draft the server does not have.
        const version = await store.ensureOnServer(draft.id);

        outcome = await finalizeSale({
          draft: version === null ? draft : { ...draft, version },
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
        setUi({ busy: false });
        if (error instanceof OfflineFinalizationRefused) {
          // Nothing was created. The bill is safe on disk and a counter slip is offered.
          setUi({
            conflict: { kind: 'error', code: 'SERVICE_UNAVAILABLE', details: {} },
          });
          return;
        }
        // Everything else is shown, never rethrown. `ensureOnServer` is a plain
        // `PUT /drafts/{id}` and a `NetworkError`, a 428 or a `DRAFT_VERSION_CONFLICT`
        // all arrive here as exceptions; both callers invoke this as `void
        // runFinalize(...)`, so rethrowing produced an unhandled rejection and the
        // cashier saw a flicker and nothing else.
        setUi({
          conflict:
            error instanceof ApiError
              ? { kind: 'error', code: error.code, details: error.details }
              : { kind: 'money', message: ERRORS.unexpected },
        });
        return;
      }
      setUi({ busy: false });
      await store.reload();

      switch (outcome.kind) {
        case 'completed':
        case 'already_completed': {
          if (outcome.response) {
            onCompleted(outcome.response);
            // Cash prints immediately; credit does **not** open a print dialog
            // (OD-21). The confirmation card offers "Print now" instead, because a
            // credit bill is often filed rather than handed over.
            if (saleType === 'cash')
              onPrint({
                payload: outcome.response.print_payload,
                invoiceId: outcome.response.invoice.id,
              });
          } else if (draft.invoice_id) {
            // `DRAFT_ALREADY_FINALIZED` with no body: the sale exists, so load it
            // rather than offering a retry.
            const invoice = await invoices.get(draft.invoice_id);
            setUi({
              conflict: {
                kind: 'error',
                code: 'DRAFT_ALREADY_FINALIZED',
                details: { internal_reference: invoice.internal_reference },
              },
            });
          } else {
            setUi({
              conflict: { kind: 'error', code: 'DRAFT_ALREADY_FINALIZED', details: {} },
            });
          }
          onSynced?.();
          return;
        }
        case 'refused': {
          setUi({
            conflict: {
              kind: 'error',
              code: outcome.code ?? 'INTERNAL_ERROR',
              details: outcome.error instanceof ApiError ? outcome.error.details : {},
            },
          });
          return;
        }
        case 'unknown':
          // No bare retry is offered anywhere in this branch: the customer may
          // already have been charged.
          setUi({ conflict: { kind: 'unconfirmed', stale: false } });
          return;
      }
    },
    [
      draft,
      busy,
      online,
      policy,
      store,
      total,
      onSynced,
      onPrint,
      onCompleted,
      setUi,
      advanceAmount,
      advanceMethod,
      canOverrideOversell,
      oversellApproved,
      oversellReason,
    ],
  );

  const saveDraft = useCallback(async () => {
    await store.saveDraftToServer(draft.id);
    onSynced?.();
  }, [draft.id, store, onSynced]);

  const clearDraft = useCallback(async () => {
    const outcome = await store.clearDraft(draft.id);
    setConfirmClear(false);
    if (outcome === 'refused_unconfirmed') {
      setUi({ conflict: { kind: 'unconfirmed', stale: false } });
    } else if (outcome === 'refused_finalized') {
      setUi({
        conflict: { kind: 'error', code: 'DRAFT_ALREADY_FINALIZED', details: {} },
      });
    }
  }, [draft.id, store, setUi]);

  // --- keyboard shortcuts ----------------------------------------------------

  /**
   * Registered by the **active** column only, so there is still exactly one listener
   * however many bills are on screen.
   *
   * The guard that makes the spreadsheet grid possible is unchanged: without `Ctrl`
   * held, nothing here runs, so `Tab`, `Enter`, the arrows and `Space` belong entirely
   * to whatever cell has focus and can never trigger a sale.
   */
  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent): void {
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
  }, [active, ready, online, runFinalize, saveDraft]);

  const name = draft.header.customer_name.trim() || draft.label;

  return (
    <section
      ref={panel}
      data-bill-panel={draft.id}
      aria-label={BILLING.panelLabel(position, name)}
      /*
       * Tabbing or clicking into a column is what makes it the one `Ctrl+Enter` acts
       * on. Capture, because focus lands on a descendant and `focus` does not bubble;
       * `mousedown` as well, so pressing a button in another column switches *before*
       * the click runs rather than after it.
       *
       * It deliberately does **not** move the three-column window. A cashier who clicks
       * the middle bill expects to keep looking at the same three bills, not to have
       * them scroll out from under their hand.
       */
      onFocusCapture={() => {
        if (!active) onActivate();
      }}
      onMouseDown={() => {
        if (!active) onActivate();
      }}
      /*
       * A **named containment context**, so the grid's columns can ask how wide this
       * bill is rather than how wide the window is. Three bills sharing a monitor and
       * one bill filling it want different column widths, and the viewport cannot tell
       * those apart — the same 1600px screen is both. `inline-size` only: the panel's
       * width comes from the flex row above it and never from its contents, so nothing
       * about its height or its layout changes.
       */
      style={{ containerType: 'inline-size', containerName: 'bill' }}
      className={`flex min-h-0 min-w-0 flex-1 flex-col border bg-white ${
        active
          ? 'border-nas-navy shadow-[0_0_0_2px_rgba(35,40,82,0.18)]'
          : 'border-slate-300'
      }`}
    >
      <BillHeader
        draft={draft}
        businessDate={businessDate}
        root={panel}
        advance={advance}
        onAdvanceChange={(value) => setUi({ advance: value })}
        onChange={(patch) => void store.updateHeader(draft.id, patch)}
      />

      <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
        <BillGrid
          billId={draft.id}
          lines={draft.lines}
          readOnly={draft.status === 'finalized' || busy}
          online={online}
          canOverridePrice={canOverridePrice}
          canCreateProduct={canCreateProduct}
          // Said once under all three columns instead of three times over.
          hints={false}
          onAddProduct={(hit, row, opts) => void addProduct(hit, row, opts)}
          onChangeLine={(lineId, patch) => void store.updateLine(draft.id, lineId, patch)}
          onRemoveLine={(lineId) => void store.removeLine(draft.id, lineId)}
        />

        {/* GRAND TOTAL, in the owner's own words and prominent. Still labelled a
            preview: the server confirms it on completion and answers `TOTAL_MISMATCH`
            if it disagrees (ADR-032). The sentence that says so is now the field's
            description rather than a third line of text under every column. */}
        <div className="mt-1 flex items-baseline justify-between gap-2 border-t-2 border-nas-navy pt-1">
          <span className="text-sm font-semibold tracking-wide text-nas-navy">
            {BILLING.grandTotal}
          </span>
          <span
            title={BILLING.totalPreviewLabel}
            className="truncate text-right text-xl font-bold tabular-nums"
          >
            {formatForScreen(total)}
          </span>
        </div>
        <p className="sr-only">{BILLING.totalPreviewLabel}</p>

        {/*
          The advance, beside the total it is paid against.

          Both of these appear only once an amount has been entered, so they belong
          below the grid rather than in the header — a header that changes height pushes
          one bill's grid out of line with the two beside it. Below the grid the
          flexible grid absorbs them instead, and `GRAND TOTAL` and the four actions
          stay on the same lines across all three columns.

          It reads better here too: the arithmetic is **about** the grand total, and
          spelling it out is what stops the advance being read as a discount. Advisory
          only — the server derives the real outstanding (ADR-022), and the bill total
          sent is still the one the lines add up to.
        */}
        {advanceAmount !== null ? (
          <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2">
            <label className="flex items-center gap-1">
              {ACTIONS.advanceMethod}
              <select
                value={advanceMethod}
                onChange={(event) => setUi({ advanceMethod: event.target.value })}
                className="rounded border border-slate-300 px-1"
              >
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="card">Card</option>
                <option value="bank_transfer">Bank transfer</option>
                <option value="cheque">Cheque</option>
              </select>
            </label>
            <p className="text-xs text-slate-600">
              {ACTIONS.advancePreview(
                formatForScreen(total),
                formatForScreen(advanceAmount),
                formatForScreen(total.minus(advanceAmount)),
              )}
            </p>
          </div>
        ) : null}

        {conflict ? (
          <div className="mt-2">
            <ConflictPanel
              conflict={conflict}
              draft={draft}
              policy={policy}
              online={online}
              canOverrideOversell={canOverrideOversell}
              oversellApproved={oversellApproved}
              oversellReason={oversellReason}
              onOversellApprovedChange={(approved) =>
                setUi({
                  oversellApproved: approved,
                  // Dropping the approval drops its reason with it: a reason left
                  // behind would be attached to the next approval nobody wrote it for.
                  ...(approved ? {} : { oversellReason: '' }),
                })
              }
              onOversellReasonChange={(reason) => setUi({ oversellReason: reason })}
              onPrintSlip={onPrintSlip}
              onOpenDailyBills={onOpenDailyBills}
            />
          </div>
        ) : null}

        {/* The four actions, in their order, with their shortcuts shown. Two by two
            rather than in one row: a third of the screen is not wide enough for four
            buttons carrying their shortcut chips, and letting them wrap left the last
            one alone on a line of its own. Nothing about the order or the set changed —
            OD-14 settles that there are exactly four and there is no fifth. */}
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          <Button
            variant="primary"
            className="bill-action"
            busy={busy}
            disabled={!ready || !online}
            shortcut={ACTION_SHORTCUTS.printBill}
            onClick={() => void runFinalize('cash')}
          >
            {ACTIONS.printBill}
          </Button>
          <Button
            variant="primary"
            className="bill-action"
            busy={busy}
            disabled={!ready || !online}
            shortcut={ACTION_SHORTCUTS.creditBill}
            onClick={() => void runFinalize('credit')}
          >
            {ACTIONS.creditBill}
          </Button>
          <Button
            variant="secondary"
            className="bill-action"
            shortcut={ACTION_SHORTCUTS.saveDraft}
            onClick={() => void saveDraft()}
          >
            {ACTIONS.saveDraft}
          </Button>
          <Button
            variant="danger"
            className="bill-action"
            shortcut={ACTION_SHORTCUTS.clearDraft}
            onClick={() => setConfirmClear(true)}
          >
            {ACTIONS.clearDraft}
          </Button>
        </div>

        {!online ? (
          <p className="mt-1 text-xs text-amber-800">{OFFLINE.finalisationDisabled}</p>
        ) : null}
        {!canBill ? (
          <p className="mt-1 text-xs text-red-800">{ERRORS.permissionDenied}</p>
        ) : null}
      </div>

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
        {BILLING.clearDraftConfirm(draft.lines.length)}
      </Dialog>
    </section>
  );
}

// --- the bill header ----------------------------------------------------------

/**
 * The top of one bill column: the header fields, then `ESTIMATE`.
 *
 * ## What the owner rearranged, and what did not move
 *
 * The shop's name, address and phone used to sit here, centred, above the fields. In a
 * three-column workspace that is three copies of the application's own heading, and it
 * cost the row the owner wanted for `Advance Received` — so the heading is drawn once,
 * above the columns, and this is where the advance now lives. **Nothing about the field
 * changed**: same optional amount, same method, same arithmetic spelled out, same
 * single transaction (see `BillPanel`'s `advance`).
 *
 * The **printed** bill is untouched. It has its own headers, its own stylesheet and its
 * own isolation (ADR-028), and it still prints the shop block in full from the server's
 * `businesses` row. Rearranging the screen can never move anything on paper.
 *
 * `ESTIMATE` is the document's own label for cash and credit alike (OD-24,
 * FR-PRINT-021). `BILL`, `INVOICE` and `Tax Invoice` are not permitted as literals
 * anywhere.
 *
 * The fields are editable **inline**, which FR-BILL-010 requires explicitly — never
 * behind a dialog, and never as part of a credit-details form (that design was removed
 * by OD-21/ADR-033 and must not come back).
 */
function BillHeader({
  draft,
  businessDate,
  root,
  advance,
  onAdvanceChange,
  onChange,
}: {
  draft: LocalDraft;
  businessDate: string | undefined;
  /** This column's element, so a hand-off cannot land in the bill next door. */
  root: React.RefObject<HTMLElement | null>;
  advance: string;
  onAdvanceChange: (value: string) => void;
  onChange: (patch: Partial<LocalDraft['header']>) => void;
}) {
  /**
   * `Enter` in a header field means "done with this one", and moves to the next.
   *
   * The screen already works this way everywhere else — the grid's `Enter` moves down a
   * row — so a header where `Enter` did nothing was the odd one out. `Tab` is unchanged
   * and still does the same thing; this adds a second way rather than replacing the
   * first.
   *
   * Only `Enter` is intercepted, and only to move focus. The arrows are left alone so
   * they keep moving the caret inside the text, which is what they are for in a field
   * holding a mechanic's name or a registration number.
   *
   * The last field hands over to the first free Item cell **of this bill**, so the whole
   * header can be filled and the first part typed without reaching for the mouse.
   *
   * Only Vehicle Number uses this. Customer and Mechanic are comboboxes that own `Enter`
   * while their suggestion list is open, so each handles its own hand-off — see
   * `CustomerPicker.onSearchKeyDown` and `MechanicPicker.onKeyDown`.
   */
  function headerKeys() {
    return (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      // Moving focus fires `onBlur`, which is what persists the field (§4.1 rule 4).
      focusOnNextFrame(`[data-cell="${draft.lines.length}-item"]`, root.current);
    };
  }

  return (
    <header className="bill-header shrink-0 border-b border-nas-navy px-2 py-1.5">
      {/* Customer and the advance share the top row: the two things a cashier decides
          about the *person* rather than about the parts. */}
      <div className="grid grid-cols-2 gap-2">
        <CustomerPicker draft={draft} root={root} onChange={onChange} />
        {/*
          The amount, and **only** the amount.

          What is paid by, and the arithmetic that stops the advance being read as a
          discount, now sit under `GRAND TOTAL` — see `BillPanel`. Both of them appear
          the moment an amount is typed, and here that grew the header by a row: one
          bill's `ESTIMATE` and grid then sat lower than the two beside it, which is the
          ragged look the owner asked to have fixed. The header is a fixed height now,
          whatever is on the bill, so the three grids always start on the same line.
        */}
        <Field
          label={ACTIONS.advanceLabel}
          inputMode="decimal"
          value={advance}
          data-bill-field="advance"
          onChange={(event) => onAdvanceChange(event.target.value)}
        />
      </div>

      <div className="mt-1.5 grid grid-cols-[1fr_1fr_auto] gap-2">
        {/* Free text with suggestions from the saved list. The bill still stores a
            **name**, not an id — `mechanic_name_snapshot` is free text and nothing
            downstream needs a mechanic record, which is what keeps correcting the
            suggestion list from ever rewriting a past bill. See `MechanicPicker`. */}
        <MechanicPicker
          value={draft.header.mechanic_name}
          onChange={(mechanic_name) => onChange({ mechanic_name })}
          onDone={() => focusOnNextFrame('[data-bill-field="vehicle"]', root.current)}
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
        <div className="flex min-w-0 flex-col gap-1">
          <span className="bill-label">{BILLING.headerDate}</span>
          {/* The **business's** date, from bootstrap. Never `new Date()`: a counter PC
              set to UTC is on yesterday's business date for the first five and a half
              hours of every Asia/Kolkata day (FE-E-3). */}
          <span className="content-center whitespace-nowrap font-medium">
            {businessDate ?? '—'}
          </span>
        </div>
      </div>

      <p className="mt-1 text-xs font-semibold tracking-widest text-nas-navy">
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
export function CompletionCard({
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
  root,
  onChange,
}: {
  draft: LocalDraft;
  /** This column's element. Every hand-off below is scoped to it. */
  root: React.RefObject<HTMLElement | null>;
  onChange: (patch: Partial<LocalDraft['header']>) => void;
}) {
  /**
   * What is in the box: this bill's customer name, or what is being typed to find one.
   *
   * **Initialised from the bill, not from nothing.** The box is both the search and the
   * field that holds the name — `onBlur` writes whatever is in it to
   * `header.customer_name`, which is this bill's snapshot of the customer
   * (FR-CREDIT-012) and is what a cash bill prints. Starting it empty meant the name
   * was written to the draft and then never shown again: every remount of this column
   * came back blank.
   *
   * That was invisible while one bill was on screen, because the component stayed
   * mounted from one tab to the next — which was its own, worse defect in the other
   * direction: bill 2 inherited bill 1's typed text. The three-bill workspace unmounts
   * a column when it scrolls out of the window, so the cashier saw a bill they had
   * filled in come back empty. Reading the bill fixes both: the box shows what the bill
   * holds, whichever bill this column is showing.
   */
  const [term, setTerm] = useState(draft.header.customer_name);
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
   * cannot focus something that does not exist yet.
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
      // A sibling that was never unmounted, so it is already there — but there are three
      // of it on screen, one per bill, so the lookup is scoped to this column.
      root.current?.querySelector<HTMLElement>('[data-bill-field="mechanic"]')?.focus();
      return;
    }
    searchBox.current?.focus();
    // Keyed on the association, because that is exactly what swaps the controls over.
  }, [draft.header.customer_id, root]);

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
      // Mechanic Name is mounted either way here, so a single frame is enough — and the
      // one that gets focus is this bill's, not the bill next door's.
      focusOnNextFrame('[data-bill-field="mechanic"]', root.current);
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
      <div className="relative flex min-w-0 flex-col gap-1">
        <span className="bill-label">{BILLING.headerCustomer}</span>
        {/* `bill-static-field`: exactly the height of the input this replaces. Choosing
            a customer swaps a text box for a name and a `Change` button, and a block
            six pixels shorter than the box moved everything below it — this bill's
            `ESTIMATE` and grid then sat higher than the two columns beside it. */}
        <div className="bill-static-field flex items-center justify-between gap-1 rounded border border-nas-navy bg-[#f3f4fb] px-2">
          <span className="truncate font-semibold" title={draft.header.customer_name}>
            {draft.header.customer_name}
          </span>
          <Button
            variant="quiet"
            className="min-h-0 shrink-0 px-2 text-xs"
            onClick={() => {
              // Clears the association but keeps the typed snapshot: the goods were
              // still sold to whoever is standing there, and a cash bill needs no
              // customer record.
              onChange({ customer_id: null });
              setProblem(null);
              setDuplicates(null);
              // Back to an editable box holding the name the bill already has — the
              // goods were still sold to whoever is standing there, so clearing the
              // text as well would make `Change` a delete.
              setTerm(draft.header.customer_name);
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
          <p className="bill-floating-note text-amber-800">{duplicates.join(' ')}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="relative flex min-w-0 flex-col gap-1">
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
        <p role="alert" className="bill-floating-note text-red-700">
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
                     * already uses.
                     */
                    tabIndex={-1}
                    // `onMouseDown` cancels the default *only* to stop the input's blur
                    // closing the list before the click lands. The selection itself is on
                    // `onClick`, which both a mouse and a keyboard produce.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => attach(customer)}
                    /**
                     * `Space` selects **here**, on a focused option, and nowhere else.
                     *
                     * The owner asked for Space to select. It must never do so from the
                     * search box: a customer is called `Kumar Transports`, and a field
                     * that ate the space would make most names untypeable — the same
                     * reasoning `ItemCell` records for `AXEL PACKING`.
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
    </div>
  );
}

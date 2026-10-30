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
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, describeError, fieldErrors, type ErrorCode } from '@/api/errors';
import { invoices } from '@/api/endpoints';
import type { FinalizeResponse, PrintPayload } from '@/api/types';
import type { LocalDraft, LocalDraftLine } from '@/db/schema';
import { asText } from '@/lib/format';
import { formatForScreen, parseMoney, type MoneyPolicy } from '@/lib/money';
import {
  ACTIONS,
  ACTION_SHORTCUTS,
  BILLING,
  CREDIT,
  ERRORS,
  OFFLINE,
} from '@/lib/strings';
import { Busy, Button, Dialog, Field, Panel } from '@/components/primitives';
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
import { ItemTable } from './ItemTable';
import { ProductSearch, type SearchHit } from './ProductSearch';

export interface BillingCounterProps {
  policy: MoneyPolicy;
  online: boolean;
  /** Whether the user may finalise at all; the UI explains rather than silently failing. */
  canBill: boolean;
  onSynced?: (() => void) | undefined;
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
  onSynced,
}: BillingCounterProps) {
  const store = useBillingStore();
  const active = store.drafts.find((draft) => draft.id === store.activeDraftId);

  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<Conflict>(null);
  const [completed, setCompleted] = useState<FinalizeResponse | null>(null);
  const [printPayload, setPrintPayload] = useState<PrintPayload | null>(null);
  const [slip, setSlip] = useState<CounterSlipData | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const total = draftTotal(active);
  const ready = canFinalize(active) && canBill;

  // --- adding and editing lines ---------------------------------------------

  const addHit = useCallback(
    async (hit: SearchHit) => {
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
      // Focus back to search so the next part can be typed without the mouse.
      searchRef.current?.focus();
    },
    [active, store],
  );

  // --- the four actions ------------------------------------------------------

  const runFinalize = useCallback(
    async (saleType: 'cash' | 'credit') => {
      if (!active || busy) return;
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

      setBusy(true);
      let outcome: FinalizeOutcome;
      try {
        outcome = await finalizeSale({
          draft: active,
          saleType,
          policy,
          online,
          ...(saleType === 'cash'
            ? { payment: { method: 'cash', amount: total.toFixed(policy.amount_scale) } }
            : {}),
        });
      } catch (error) {
        setBusy(false);
        if (error instanceof OfflineFinalizationRefused) {
          // Nothing was created. The bill is safe on disk and a counter slip is offered.
          setConflict({ kind: 'error', code: 'SERVICE_UNAVAILABLE', details: {} });
          return;
        }
        throw error;
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
          } else {
            // `DRAFT_ALREADY_FINALIZED` with no body: the sale exists, so load it
            // rather than offering a retry.
            if (active.invoice_id) {
              const invoice = await invoices.get(active.invoice_id);
              setConflict({
                kind: 'error',
                code: 'DRAFT_ALREADY_FINALIZED',
                details: { internal_reference: invoice.internal_reference },
              });
            } else {
              setConflict({
                kind: 'error',
                code: 'DRAFT_ALREADY_FINALIZED',
                details: {},
              });
            }
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
    [active, busy, online, policy, store, total, onSynced],
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

  // --- keyboard shortcuts ----------------------------------------------------

  useEffect(() => {
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
  }, [ready, online, runFinalize, saveDraft]);

  if (!store.ready) return <Busy label="Opening your bills" />;

  return (
    <div className="flex flex-col gap-4">
      {/* Tab strip. The limit refuses rather than closing anything (FR-DRAFT-003). */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-300 pb-2">
        {store.drafts.map((draft) => (
          <Button
            key={draft.id}
            variant={draft.id === store.activeDraftId ? 'primary' : 'secondary'}
            onClick={() => store.selectDraft(draft.id)}
            aria-current={draft.id === store.activeDraftId ? 'true' : undefined}
          >
            {draft.label}
            {draft.status === 'conflict' ? ' ⚠' : ''}
            {draft.status === 'unconfirmed' ? ' …' : ''}
          </Button>
        ))}
        <Button variant="quiet" onClick={() => void store.newDraft()}>
          {BILLING.newTab}
        </Button>
      </div>

      {store.limitMessage ? (
        <Panel tone="warning" title={store.limitMessage}>
          {BILLING.tabLimitReached(store.maxOpenDrafts)}
        </Panel>
      ) : null}

      {!online ? <Panel tone="warning">{OFFLINE.banner}</Panel> : null}

      {active ? (
        <>
          <ProductSearch
            online={online}
            onPick={(hit) => void addHit(hit)}
            inputRef={searchRef}
          />

          <ItemTable
            lines={active.lines}
            readOnly={active.status === 'finalized' || busy}
            onChangeLine={(lineId, patch) =>
              void store.updateLine(active.id, lineId, patch)
            }
            onRemoveLine={(lineId) => void store.removeLine(active.id, lineId)}
            onRestoreLine={(line) =>
              void store.addLine(active.id, {
                product_id: line.product_id,
                product_name: line.product_name,
                sku: line.sku,
                unit_code: line.unit_code,
                quantity: line.quantity,
                unit_price: line.unit_price,
                catalog_price_at_add: line.catalog_price_at_add,
                price_source: line.price_source,
                discount_percent: line.discount_percent,
                known_stock: line.known_stock,
                stock_as_of: line.stock_as_of,
              })
            }
          />

          <CustomerFields
            draft={active}
            onChange={(patch) => void store.updateHeader(active.id, patch)}
          />

          <div className="flex items-baseline justify-end gap-3 border-t border-slate-300 pt-3">
            {/* Labelled a preview, every time. The server confirms it on completion
                and answers `TOTAL_MISMATCH` if it disagrees (ADR-032). */}
            <span className="text-sm text-slate-600">{BILLING.totalPreviewLabel}</span>
            <span className="text-2xl font-semibold">{formatForScreen(total)}</span>
          </div>

          {conflict ? (
            <ConflictPanel
              conflict={conflict}
              draft={active}
              policy={policy}
              online={online}
              onPrintSlip={setSlip}
            />
          ) : null}

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
  onPrintSlip,
}: {
  conflict: NonNullable<Conflict>;
  draft: LocalDraft;
  policy: MoneyPolicy;
  online: boolean;
  onPrintSlip: (data: CounterSlipData) => void;
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
              onClick={() => window.location.assign('/daily-bills')}
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

// --- customer fields ----------------------------------------------------------

/**
 * Header fields, optional for **both** sale types and persisted whenever present
 * (FR-CREDIT-012). A vehicle number typed on a cash bill is still what the customer
 * will quote next time they come in.
 */
function CustomerFields({
  draft,
  onChange,
}: {
  draft: LocalDraft;
  onChange: (patch: Partial<LocalDraft['header']>) => void;
}) {
  return (
    <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <legend className="text-sm font-medium text-slate-700">Customer (optional)</legend>
      {/*
        Through the `Field` primitive rather than hand-rolled markup, so every input in
        the application is labelled the same way — `<label for>` tied to the input's id,
        not an implicit wrapper and never a placeholder standing in for a label.
      */}
      <Field
        label="Name"
        defaultValue={draft.header.customer_name}
        onBlur={(event) => onChange({ customer_name: event.target.value })}
      />
      <Field
        label="Vehicle number"
        defaultValue={draft.header.vehicle_number}
        onBlur={(event) => onChange({ vehicle_number: event.target.value })}
      />
      <Field
        label="Phone"
        inputMode="tel"
        defaultValue={draft.header.phone}
        onBlur={(event) => onChange({ phone: event.target.value })}
      />
      {!draft.header.customer_id ? (
        <p className="text-xs text-slate-500 sm:col-span-3">
          {BILLING.creditNeedsCustomer}
        </p>
      ) : null}
    </fieldset>
  );
}

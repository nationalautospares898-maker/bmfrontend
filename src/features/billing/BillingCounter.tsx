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
import { customers as customersApi, invoices } from '@/api/endpoints';
import type { DirectoryCustomer, FinalizeResponse, PrintPayload } from '@/api/types';
import type { LocalDraft, LocalDraftLine } from '@/db/schema';
import { asText } from '@/lib/format';
import { uuidv7 } from '@/lib/ids';
import { formatForScreen, parseMoney, type MoneyPolicy } from '@/lib/money';
import {
  ACTIONS,
  ACTION_SHORTCUTS,
  BILLING,
  COMMON,
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
  onSynced,
  onOpenDailyBills,
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
        // The server resolves `draft_id` against its own `draft_bills` row and refuses
        // with NOT_FOUND if it has never seen it. Nothing used to push a draft except
        // the `Save a Draft` button, so typing a bill and pressing `Print Bill` — the
        // ordinary way to use this screen — failed every time with "This bill is not
        // confirmed". Pushed here, before the sale, and awaited: no sale is attempted
        // against a draft the server does not have.
        const version = await store.ensureOnServer(active.id);

        outcome = await finalizeSale({
          // The draft carries the version the server just confirmed, so
          // `draft_version` matches and the optimistic-concurrency check still does its
          // job rather than being bypassed.
          draft: version === null ? active : { ...active, version },
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
        // Everything else is shown, never rethrown.
        //
        // `finalizeSale` never throws for a business outcome, but `ensureOnServer` above
        // does — it is a plain `PUT /drafts/{id}` and a `NetworkError`, a 428 or a
        // `DRAFT_VERSION_CONFLICT` all come out of it as exceptions. Both callers invoke
        // this function as `void runFinalize(...)`, so rethrowing produced an unhandled
        // rejection: `setBusy(false)` had already run, the button returned to normal,
        // and **nothing at all happened**. A cashier pressed Print Bill, saw a flicker,
        // and had no bill, no error and nothing to retry — the exact failure shape the
        // draft-push fix above was meant to end, reintroduced by the push itself.
        //
        // An unknown failure is still reported as unknown; what it must not do is
        // vanish.
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
              onOpenDailyBills={onOpenDailyBills}
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
  onOpenDailyBills,
}: {
  conflict: NonNullable<Conflict>;
  draft: LocalDraft;
  policy: MoneyPolicy;
  online: boolean;
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
    <fieldset className="flex flex-col gap-3">
      <legend className="text-sm font-medium text-slate-700">Customer (optional)</legend>

      <CustomerPicker draft={draft} onChange={onChange} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {/*
          Through the `Field` primitive rather than hand-rolled markup, so every input in
          the application is labelled the same way — `<label for>` tied to the input's id,
          not an implicit wrapper and never a placeholder standing in for a label.

          Still free text, and still sent for **both** sale types (FR-CREDIT-012): a
          vehicle number typed on a cash bill is what the customer will quote next time.
          Selecting a saved customer fills them in; they stay editable because the
          snapshot on this bill is allowed to differ from the customer record — a
          different vehicle came in today.
        */}
        <Field
          label="Name"
          key={`name-${draft.header.customer_id ?? 'none'}-${draft.header.customer_name}`}
          defaultValue={draft.header.customer_name}
          onBlur={(event) => onChange({ customer_name: event.target.value })}
        />
        <Field
          label="Vehicle number"
          key={`veh-${draft.header.customer_id ?? 'none'}-${draft.header.vehicle_number}`}
          defaultValue={draft.header.vehicle_number}
          onBlur={(event) => onChange({ vehicle_number: event.target.value })}
        />
        <Field
          label="Phone"
          inputMode="tel"
          key={`ph-${draft.header.customer_id ?? 'none'}-${draft.header.phone}`}
          defaultValue={draft.header.phone}
          onBlur={(event) => onChange({ phone: event.target.value })}
        />
      </div>

      {!draft.header.customer_id ? (
        <p className="text-xs text-slate-500">{BILLING.creditNeedsCustomer}</p>
      ) : null}
    </fieldset>
  );
}

/**
 * Attach a **saved** customer to the bill.
 *
 * Why this exists: `draft.header.customer_id` was only ever *read* — at five places,
 * including the credit guard — and never written anywhere in the application. So
 * `saleType === 'credit' && !customer_id` was always true and the `Credit Bill` button
 * could never succeed. A cashier typing a name, vehicle and phone got
 * "A credit bill needs a saved customer, not just a typed name" with no way to satisfy
 * it. The three fields below are invoice *snapshots* (FR-CREDIT-012); they are not a
 * customer record and were never meant to be one.
 *
 * Creating from here uses `PUT /customers/{id}` with a **client-generated** id, which is
 * the documented creation contract and is "naturally idempotent via the client-generated
 * id" (`API-SPECIFICATION.md §5`) — so a double click or a retry is an upsert, not a
 * second customer. That is preferred over `customer.mode: "new"` on finalisation for one
 * reason that matters at the counter: the server's `CUSTOMER_DUPLICATE_SUSPECTED`
 * warning then arrives **before** the sale is committed, while the cashier can still
 * pick the existing customer instead. Through `mode: "new"` the warning would come back
 * attached to a completed invoice, too late to act on. Nothing is ever merged
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
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<string[] | null>(null);

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
      setSearching(true);
      void customersApi
        .search(text)
        .then((response) => {
          if (sequence === latest.current) setResults(response.items);
        })
        .catch(() => {
          if (sequence === latest.current) setResults([]);
        })
        .finally(() => {
          if (sequence === latest.current) setSearching(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [term]);

  function attach(customer: DirectoryCustomer): void {
    // The id is the association; the rest are this bill's snapshot of it.
    onChange({
      customer_id: customer.id,
      customer_name: customer.name,
      customer_business_name: customer.business_name ?? '',
      phone: customer.primary_phone ?? '',
      ...(customer.vehicles[0] ? { vehicle_number: customer.vehicles[0] } : {}),
    });
    setTerm('');
    setResults(null);
    setDuplicates(null);
    setProblem(null);
  }

  function detach(): void {
    // Clears the association but keeps the typed snapshot: the goods were still sold to
    // whoever is standing there, and a cash bill does not need a customer record.
    onChange({ customer_id: null });
    setProblem(null);
    setDuplicates(null);
  }

  async function createAndAttach(): Promise<void> {
    const name = term.trim();
    if (!name) return;
    setCreating(true);
    setProblem(null);
    try {
      const id = uuidv7();
      const result = await customersApi.upsert(id, { name });
      // The **persisted** id, read back from the response rather than assumed, so the
      // bill is linked to what the server actually stored.
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
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3 rounded border border-[#232852] bg-[#f3f4fb] px-3 py-2">
          <span className="text-sm">
            <span className="text-slate-600">{BILLING.billingTo} </span>
            <span className="font-semibold">{draft.header.customer_name}</span>
            {draft.header.phone ? (
              <span className="text-slate-600"> · {draft.header.phone}</span>
            ) : null}
            {draft.header.vehicle_number ? (
              <span className="text-slate-600"> · {draft.header.vehicle_number}</span>
            ) : null}
          </span>
          <Button variant="quiet" onClick={detach}>
            {BILLING.changeCustomer}
          </Button>
        </div>
        {duplicates ? (
          <Panel tone="warning" title={BILLING.duplicateSuspected}>
            {duplicates.join(' ')}
          </Panel>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field
          label={BILLING.findCustomer}
          hint={BILLING.findCustomerHint}
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          className="w-72"
        />
        {searching ? (
          <span className="text-xs text-slate-500">{COMMON.loading}</span>
        ) : null}
      </div>

      {problem ? <Panel tone="danger">{problem}</Panel> : null}

      {results && results.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {results.map((customer) => (
            <li key={customer.id}>
              <Button variant="secondary" onClick={() => attach(customer)}>
                {customer.name}
                {customer.primary_phone ? ` · ${customer.primary_phone}` : ''}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {/*
        Offered whenever a name has been typed, **not** only when nothing matched.

        It used to appear only on an empty result set, which meant a near-match blocked
        the action entirely: a shop that already has a "Ramesh Kumar" could not add a
        second, different Ramesh Kumar from the billing screen at all — the matches
        showed, none was the right person, and there was no way forward except
        abandoning the bill and going to the Customers screen. Two customers may
        genuinely share a name, so the decision belongs to the cashier who can see the
        person in front of them. The server still warns on a suspected duplicate and
        still merges nothing (FR-CUST-004), which is what makes offering this safe.
      */}
      {results ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-600">
            {results.length === 0
              ? BILLING.customerNotFound
              : BILLING.notTheRightCustomer}
          </span>
          <Button
            variant="secondary"
            busy={creating}
            onClick={() => void createAndAttach()}
          >
            {BILLING.saveAsNewCustomer}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

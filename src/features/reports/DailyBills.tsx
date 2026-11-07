/**
 * Daily Bills, and Credit Bills.
 *
 * **One dataset, two views** (FR-RPT-003). Both read `GET /invoices`; Credit Bills adds
 * `is_credit=true` and groups by customer. There is no second endpoint and no
 * client-side reinterpretation of the same rows, because two code paths over one dataset
 * is how two screens start disagreeing about the same day's takings.
 *
 * Every figure here is rendered **from the server's response verbatim**. Nothing is
 * summed client-side — `collected` is not `net`, and only the server knows the
 * difference (FR-RPT-002, ADR-032).
 */

import { Fragment, useEffect, useRef, useState } from 'react';

import { credit, invoices, reports } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import type {
  CreditCustomer,
  DailySales,
  Invoice,
  InvoiceSummary,
  PrintPayload,
} from '@/api/types';
import { asText, humanizeKey } from '@/lib/format';
import { formatForScreen, parseMoney } from '@/lib/money';
import { getBusinessToday } from '@/api/session';
import { AMEND, COMMON, CREDIT_BILLS, EDIT_BILL } from '@/lib/strings';
import { Busy, Button, Panel } from '@/components/primitives';
import { PrintRoot } from '@/features/print/PrintRoot';
import { AmendBill, type RebuildLine } from './AmendBill';
import { EditBill, RevisionHistory } from './EditBill';
import {
  FullBillView,
  InvoicePaymentHistory,
  ReceiveInvoicePayment,
} from './CreditInvoiceDetail';
import type { MoneyPolicy } from '@/lib/money';

function money(value: string | number): string {
  return formatForScreen(parseMoney(String(value)));
}

/**
 * The day Daily Bills opens on: **the business's** today, from bootstrap.
 *
 * It was `new Date().toISOString().slice(0, 10)` — the browser's calendar date in UTC —
 * and the server filters on `(issued_at AT TIME ZONE :timezone)::date` in the shop's
 * timezone. Those two disagree for five and a half hours of every `Asia/Kolkata` day, so
 * a counter PC set to UTC opened Daily Bills on *yesterday's* business date between
 * 00:00 and 05:30 local and showed an empty list — with the day's takings sitting in the
 * database and the owner cashing up against nothing. The server fixed the same defect in
 * its own report defaults (`reports._today`); the client was still deriving a business
 * date, which FE-E-3 forbids precisely because of this.
 *
 * The fallback only applies before bootstrap has answered, which is also before this
 * screen can be reached.
 */
function openingDay(): string {
  return getBusinessToday() ?? new Date().toISOString().slice(0, 10);
}

// --- Daily Bills --------------------------------------------------------------

export interface DailyBillsProps {
  policy: MoneyPolicy;
  /**
   * `billing.sale.edit`. Without it the Edit Bill action is not offered, because the
   * server would refuse — the same rule the cancellation action follows.
   *
   * Deliberately independent of whether the bill was printed (F11): printing is an
   * output operation, not a criterion for whether a bill may be corrected.
   */
  canEdit?: boolean | undefined;
  /**
   * `billing.sale.cancel`. Without it the correction action is not offered, because
   * cancellation is the only mechanism behind it and the server would refuse.
   */
  canCancel?: boolean | undefined;
  /** Start a replacement bill from the cancelled one's lines and show Billing. */
  onRebuild?: ((lines: RebuildLine[]) => Promise<void>) | undefined;
}

export function DailyBills({
  policy,
  canCancel = false,
  canEdit = false,
  onRebuild,
}: DailyBillsProps) {
  const [day, setDay] = useState(openingDay);
  const [rows, setRows] = useState<InvoiceSummary[]>([]);
  const [summary, setSummary] = useState<DailySales | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [printing, setPrinting] = useState<{
    payload: PrintPayload;
    invoiceId: string;
  } | null>(null);
  /** The bill whose correction dialog is open. */
  const [amending, setAmending] = useState<InvoiceSummary | null>(null);
  /** The bill open in the in-place editor (F7: straight in, no interstitial). */
  const [editing, setEditing] = useState<InvoiceSummary | null>(null);
  /** Bumped after a cancellation, to refetch the list and the day's totals. */
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const [list, report] = await Promise.all([
          invoices.list({ from: day, to: day, limit: 200 }),
          reports.dailySales({ from: day, to: day }),
        ]);
        if (cancelled) return;
        setRows(list.items);
        setSummary(report);
      } catch (caught) {
        if (cancelled) return;
        setError(
          caught instanceof ApiError ? describeError(caught.code).message : COMMON.retry,
        );
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `reloadToken` so a cancellation refetches: the row's status and the day's net,
    // collected and credit figures all change, and all of them are the server's to
    // compute. Adjusting them locally would mean the screen disagreeing with the till.
  }, [day, reloadToken]);

  /**
   * Reprint an existing bill.
   *
   * **Creates nothing** — no sale, no number, no stock movement (FR-PRINT-004). The
   * server marks the payload `is_duplicate` when it has been printed before, which is
   * why `is_duplicate` is not decided here.
   */
  async function reprint(invoiceId: string): Promise<void> {
    const payload = await invoices.printPayload(invoiceId, true);
    setPrinting({ payload, invoiceId });
  }

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end gap-3">
        <h1 className="text-xl font-semibold text-[#232852]">Daily Bills</h1>
        <label className="flex flex-col gap-1 text-sm">
          Day
          <input
            type="date"
            value={day}
            onChange={(event) => setDay(event.target.value)}
            className="min-h-11 rounded border border-slate-300 px-3"
          />
        </label>
      </header>

      {error ? <Panel tone="danger">{error}</Panel> : null}
      {busy ? <Busy label={COMMON.loading} /> : null}

      {summary ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 rounded border border-slate-300 p-4 text-sm sm:grid-cols-4">
          {/* Read straight off the response. `collected` and `net` are different
              figures and the screen never derives one from the other. */}
          <dt className="text-slate-500">Bills</dt>
          <dd>{String(summary.bill_count ?? 0)}</dd>
          <dt className="text-slate-500">Net sales</dt>
          <dd>{money(String(summary.net ?? '0'))}</dd>
          <dt className="text-slate-500">Cash collected</dt>
          <dd>{money(String(summary.collected ?? '0'))}</dd>
          <dt className="text-slate-500">Credit sales</dt>
          <dd>{money(String(summary.credit_sales ?? '0'))}</dd>
        </dl>
      ) : null}

      {summary?.excluded ? (
        // Stated, not silently applied: a day's total that quietly omits cancelled
        // bills is a total nobody can reconcile against the till.
        <p className="text-xs text-slate-500">
          Excludes{' '}
          {Object.entries(summary.excluded)
            .map(([key, value]) => `${humanizeKey(key)}: ${asText(value)}`)
            .join(' · ')}
        </p>
      ) : null}

      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Bills issued on {day}</caption>
        <thead>
          <tr className="border-b border-slate-300 text-left">
            <th scope="col" className="px-2 py-2">
              Time
            </th>
            <th scope="col" className="px-2 py-2">
              Customer
            </th>
            <th scope="col" className="px-2 py-2">
              Counter
            </th>
            <th scope="col" className="px-2 py-2">
              Type
            </th>
            <th scope="col" className="px-2 py-2 text-right">
              Total
            </th>
            <th scope="col" className="px-2 py-2 text-right">
              Outstanding
            </th>
            <th scope="col" className="px-2 py-2">
              Status
            </th>
            <th scope="col" className="px-2 py-2">
              <span className="sr-only">Reprint and correct</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && !busy ? (
            <tr>
              <td colSpan={8} className="px-2 py-6 text-center text-slate-500">
                {COMMON.emptyList}
              </td>
            </tr>
          ) : null}
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-slate-200">
              <td className="px-2 py-2">
                {new Date(row.issued_at).toLocaleTimeString()}
              </td>
              <td className="px-2 py-2">{row.customer_name ?? '—'}</td>
              <td className="px-2 py-2">{row.counter}</td>
              <td className="px-2 py-2">{row.is_credit ? 'Credit' : 'Cash'}</td>
              <td className="px-2 py-2 text-right">{money(row.total)}</td>
              <td className="px-2 py-2 text-right">{money(row.outstanding)}</td>
              <td className="px-2 py-2">
                {/* Derived server-side and displayed as given. There is no control
                    anywhere in this application that sets it (ADR-022). */}
                {row.status === 'cancelled' ? 'Cancelled' : row.payment_status}
              </td>
              <td className="px-2 py-2">
                <div className="flex gap-1">
                  <Button variant="quiet" onClick={() => void reprint(row.id)}>
                    Reprint
                  </Button>
                  {/* F7/F10/F11: one editor, reached from here and from Credit Bills,
                      offered on persisted status and permission — never on whether the
                      bill happens to have been printed. */}
                  {canEdit && row.status !== 'cancelled' ? (
                    <Button variant="quiet" onClick={() => setEditing(row)}>
                      {EDIT_BILL.action}
                    </Button>
                  ) : null}
                  {/* Offered only where it can actually work: a cancelled bill cannot be
                      cancelled again, and without `billing.sale.cancel` the server would
                      refuse. A button that is sometimes a 403 is worse than no button. */}
                  {canCancel && row.status !== 'cancelled' ? (
                    <Button variant="quiet" onClick={() => setAmending(row)}>
                      {AMEND.action}
                    </Button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {amending ? (
        <AmendBill
          summary={amending}
          onClose={() => setAmending(null)}
          onCancelled={() => setReloadToken((token) => token + 1)}
          onRebuild={onRebuild}
        />
      ) : null}

      {editing ? (
        <EditBill
          summary={editing}
          onClose={() => setEditing(null)}
          // The row's total, status and the day's figures all change, and every one of
          // them is the server's to compute.
          onSaved={() => setReloadToken((token) => token + 1)}
        />
      ) : null}

      <PrintRoot
        payload={printing?.payload ?? null}
        policy={policy}
        invoiceId={printing?.invoiceId ?? null}
        onAfterPrint={() => setPrinting(null)}
      />
    </section>
  );
}

// --- Credit Bills -------------------------------------------------------------

/**
 * Credit Bills: customer-wise, two levels, and a **permanent record**.
 *
 * Level 1 is `GET /credit/customers`, whose aggregates are **server-computed**. Level 2
 * reuses `GET /invoices?customer_id=…&is_credit=true` — no new contract was introduced
 * for per-customer invoices.
 *
 * Grouping keys on `customer_id`; the name is a display label only, so a customer who is
 * renamed keeps one row with their whole history rather than splitting into two
 * (FR-RPT-029).
 *
 * ## Why settled customers are shown by default
 *
 * The owner's complaint after the first demo: a credit bill **disappeared** once it was
 * paid in full. It was never deleted — `GET /credit/customers` drops a customer whose
 * outstanding sums to zero unless `include_settled` is set, and this screen defaulted
 * that flag to `false`. So the customer vanished from the list and their paid bills went
 * with them.
 *
 * The flag now defaults to **`true`**: Credit Bills is an enduring record of everyone who
 * has ever had a credit bill, not a list of who currently owes. The toggle survives
 * inverted — *"Only customers who still owe"* — because narrowing to the debtors is a
 * genuinely useful second view, and it is now the thing you opt *into*.
 *
 * Nothing about retention changed on the server. FR-RPT-031 already required that
 * "fully paid invoices stay in the customer's history… never deleted or permanently
 * hidden", the per-customer invoice list was already unfiltered by payment status, and
 * `GET /invoices/{id}` already carried the items. The defect was one default on one
 * screen.
 */
export interface CreditBillsProps {
  /** Needed by `PrintRoot` for a reprint. */
  policy: MoneyPolicy;
  /**
   * `credit.payment.record`. Without it the Receive Payment action is not offered,
   * because the server would refuse — the same rule the correction action follows.
   */
  canRecordPayment?: boolean | undefined;
  /** `billing.sale.edit`. Gates the Edit Bill action inside the customer folder. */
  canEdit?: boolean | undefined;
}

export function CreditBills({
  policy,
  canRecordPayment = false,
  canEdit = false,
}: CreditBillsProps) {
  const [customers, setCustomers] = useState<CreditCustomer[]>([]);
  const [overall, setOverall] = useState<Record<string, unknown> | null>(null);
  const [includeSettled, setIncludeSettled] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [customerInvoices, setCustomerInvoices] = useState<InvoiceSummary[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Which invoice's items are on screen, and the items themselves once fetched. */
  const [openInvoice, setOpenInvoice] = useState<string | null>(null);
  const [itemsByInvoice, setItemsByInvoice] = useState<Record<string, Invoice>>({});
  const [itemsBusy, setItemsBusy] = useState<string | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  /**
   * Invoices already fetched or in flight.
   *
   * A ref rather than the `itemsByInvoice` state, so that the guard is read and written
   * synchronously inside the handler. Two presses in quick succession would otherwise
   * both see an empty cache — a state update is not visible to the handler that
   * scheduled it — and start two identical requests for the same bill.
   */
  const fetchedItems = useRef<Set<string>>(new Set());
  /** Which invoice is open, mirrored out of state for the same synchronous reason. */
  const openInvoiceRef = useRef<string | null>(null);

  // Discards a reply a newer expansion has superseded. The invoice list was a single
  // shared array with no guard, so opening customer B while A's request was in flight
  // could render A's bills under B's name. That is a wrong answer, not a slow one.
  const latestExpand = useRef(0);

  /**
   * Which panel is showing under the open invoice.
   *
   * One at a time, and `null` for none. A row that opened every panel at once would
   * push the next bill off the screen on a laptop, which is what the counter runs.
   */
  const [panel, setPanel] = useState<'bill' | 'payment' | 'history' | 'versions' | null>(
    null,
  );
  /** The bill open in the in-place editor, reached from inside the folder (F10). */
  const [editing, setEditing] = useState<InvoiceSummary | null>(null);
  /** Bumped after a payment, so the row, the folder totals and the history all refetch. */
  const [paymentsToken, setPaymentsToken] = useState(0);
  /** The bill being reprinted, and its payload. */
  const [printing, setPrinting] = useState<{
    payload: PrintPayload;
    invoiceId: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void (async () => {
      try {
        const result = await credit.customers({
          include_settled: includeSettled,
          limit: 200,
        });
        if (cancelled) return;
        setCustomers(result.items);
        setOverall(result.summary);
        setError(null);
      } catch (caught) {
        if (!cancelled) {
          setError(
            caught instanceof ApiError
              ? describeError(caught.code).message
              : COMMON.retry,
          );
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [includeSettled]);

  async function expand(customerId: string): Promise<void> {
    if (expanded === customerId) {
      setExpanded(null);
      openInvoiceRef.current = null;
      setOpenInvoice(null);
      return;
    }
    const sequence = latestExpand.current + 1;
    latestExpand.current = sequence;
    setExpanded(customerId);
    openInvoiceRef.current = null;
    setOpenInvoice(null);
    setCustomerInvoices([]);
    try {
      const list = await invoices.list({
        customer_id: customerId,
        is_credit: true,
        limit: 200,
      });
      if (sequence !== latestExpand.current) return;
      setCustomerInvoices(list.items);
    } catch (caught) {
      if (sequence !== latestExpand.current) return;
      setError(
        caught instanceof ApiError ? describeError(caught.code).message : COMMON.retry,
      );
    }
  }

  /**
   * Open one bill and show what was bought on it.
   *
   * Fetched per invoice, on demand, and cached: a customer with forty open bills would
   * otherwise cost forty requests to render a list nobody has asked to see in detail.
   * `GET /invoices/{id}` already carries the items, so there is no new contract here.
   */
  async function toggleInvoice(invoiceId: string): Promise<void> {
    if (openInvoiceRef.current === invoiceId) {
      openInvoiceRef.current = null;
      setOpenInvoice(null);
      setPanel(null);
      return;
    }
    openInvoiceRef.current = invoiceId;
    setOpenInvoice(invoiceId);
    // Opening a bill shows the bill. The owner's complaint was that opening an invoice
    // gave a summary, so the full bill is the default panel rather than something to
    // go and ask for.
    setPanel('bill');
    setItemsError(null);
    if (fetchedItems.current.has(invoiceId)) return;
    fetchedItems.current.add(invoiceId);

    setItemsBusy(invoiceId);
    try {
      const invoice = await invoices.get(invoiceId);
      setItemsByInvoice((current) => ({ ...current, [invoiceId]: invoice }));
    } catch (caught) {
      // Surfaced rather than swallowed: an empty item list and a failed request look
      // identical on screen, and one of them means "this bill has no products", which
      // would be alarming and wrong.
      // Forgotten again, so reopening retries rather than showing an empty bill for
      // ever.
      fetchedItems.current.delete(invoiceId);
      setItemsError(
        caught instanceof ApiError ? describeError(caught.code).message : COMMON.retry,
      );
    } finally {
      setItemsBusy((current) => (current === invoiceId ? null : current));
    }
  }

  /**
   * Reprint an existing bill. **Creates nothing** — no sale, no number, no movement
   * (FR-PRINT-004). Identical to Daily Bills' own reprint, deliberately: one bill has
   * one printed form wherever it is reached from.
   */
  async function reprint(invoiceId: string): Promise<void> {
    const payload = await invoices.printPayload(invoiceId, true);
    setPrinting({ payload, invoiceId });
  }

  /** Refetch everything a payment changes: the folder aggregates and this bill's row. */
  function afterPayment(customerId: string): void {
    setPaymentsToken((token) => token + 1);
    void refreshCustomerInvoices(customerId);
  }

  async function refreshCustomerInvoices(customerId: string): Promise<void> {
    try {
      const list = await invoices.list({
        customer_id: customerId,
        is_credit: true,
        limit: 200,
      });
      setCustomerInvoices(list.items);
      // The bill's own detail is now stale — `amount_paid` and `payment_status` moved.
      // Dropped from the cache so reopening refetches rather than showing the old
      // figures, which is how a screen comes to disagree with the ledger.
      fetchedItems.current.clear();
      setItemsByInvoice({});
      const refreshed = await credit.customers({
        include_settled: includeSettled,
        limit: 200,
      });
      setCustomers(refreshed.items);
      setOverall(refreshed.summary);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? describeError(caught.code).message : COMMON.retry,
      );
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-4">
        <h1 className="text-xl font-semibold text-[#232852]">Credit Bills</h1>
        {/* Inverted from "include settled", because the full history is now the default
            view and narrowing to the debtors is the deliberate act (FR-RPT-031). */}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!includeSettled}
            onChange={(event) => setIncludeSettled(!event.target.checked)}
          />
          Only customers who still owe
        </label>
      </header>

      <p className="text-sm text-slate-600">{CREDIT_BILLS.permanentRecord}</p>

      {error ? <Panel tone="danger">{error}</Panel> : null}
      {busy ? <Busy label={COMMON.loading} /> : null}

      {overall ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 rounded border border-slate-300 p-4 text-sm sm:grid-cols-4">
          <dt className="text-slate-500">Customers owing</dt>
          <dd>{asText(overall.customer_count ?? customers.length)}</dd>
          <dt className="text-slate-500">Total outstanding</dt>
          <dd>{money(asText(overall.outstanding ?? '0'))}</dd>
        </dl>
      ) : null}

      <ul className="divide-y divide-slate-200 rounded border border-slate-300">
        {customers.map((entry) => (
          <li key={entry.customer.id}>
            <button
              type="button"
              onClick={() => void expand(entry.customer.id)}
              aria-expanded={expanded === entry.customer.id}
              className="flex w-full flex-wrap items-baseline justify-between gap-4 px-4 py-3 text-left"
            >
              <span>
                <span className="font-medium">{entry.customer.name}</span>
                {entry.customer.primary_phone ? (
                  <span className="ml-2 text-xs text-slate-500">
                    {entry.customer.primary_phone}
                  </span>
                ) : null}
              </span>
              <span className="flex gap-6 text-sm">
                <span>
                  {entry.open_invoice_count} open of {entry.invoice_count}
                </span>
                <span className="font-semibold">{money(entry.outstanding)}</span>
                {entry.days_overdue !== null && entry.days_overdue > 0 ? (
                  <span className="text-red-700">{entry.days_overdue} days overdue</span>
                ) : null}
              </span>
            </button>

            {expanded === entry.customer.id ? (
              <div className="bg-slate-50 px-4 py-3">
                {/* Ageing buckets, server-computed. The client never buckets dates. */}
                <dl className="mb-3 flex flex-wrap gap-4 text-xs">
                  {Object.entries(entry.ageing).map(([bucket, amount]) => (
                    <span key={bucket}>
                      <dt className="inline text-slate-500">
                        {bucket.replace(/_/g, '–')}:{' '}
                      </dt>
                      <dd className="inline">{money(amount)}</dd>
                    </span>
                  ))}
                </dl>
                <table className="w-full border-collapse text-sm">
                  <caption className="sr-only">
                    Credit bills for {entry.customer.name}. Open a bill to see what was
                    bought on it.
                  </caption>
                  <thead>
                    <tr className="border-b border-slate-300 text-left">
                      <th scope="col" className="px-2 py-1">
                        Bill
                      </th>
                      <th scope="col" className="px-2 py-1">
                        When
                      </th>
                      <th scope="col" className="px-2 py-1 text-right">
                        Total
                      </th>
                      <th scope="col" className="px-2 py-1 text-right">
                        Paid
                      </th>
                      <th scope="col" className="px-2 py-1 text-right">
                        Outstanding
                      </th>
                      <th scope="col" className="px-2 py-1">
                        Due
                      </th>
                      <th scope="col" className="px-2 py-1">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {customerInvoices.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-2 py-3 text-slate-500">
                          {CREDIT_BILLS.noOpenBills}
                        </td>
                      </tr>
                    ) : null}
                    {customerInvoices.map((invoice) => {
                      const isOpen = openInvoice === invoice.id;
                      const detail = itemsByInvoice[invoice.id];
                      return (
                        <Fragment key={invoice.id}>
                          <tr className="border-b border-slate-200">
                            <td className="px-2 py-1">
                              {/* The whole row is the control, so the products are one
                                  press away rather than hidden behind an icon nobody
                                  finds. */}
                              <button
                                type="button"
                                onClick={() => void toggleInvoice(invoice.id)}
                                aria-expanded={isOpen}
                                className="text-left font-medium text-[#232852] underline"
                              >
                                {invoice.internal_reference ?? CREDIT_BILLS.openBill}
                              </button>
                            </td>
                            <td className="px-2 py-1">
                              {new Date(invoice.issued_at).toLocaleString()}
                            </td>
                            <td className="px-2 py-1 text-right">
                              {money(invoice.total)}
                            </td>
                            <td className="px-2 py-1 text-right">
                              {money(invoice.amount_paid)}
                            </td>
                            <td className="px-2 py-1 text-right">
                              {money(invoice.outstanding)}
                            </td>
                            <td className="px-2 py-1">{invoice.due_date ?? '—'}</td>
                            <td className="px-2 py-1">
                              {/* Server-derived, displayed verbatim (ADR-022). */}
                              {invoice.status === 'cancelled'
                                ? 'Cancelled'
                                : invoice.payment_status}
                            </td>
                          </tr>

                          {isOpen ? (
                            <tr>
                              <td colSpan={7} className="bg-white px-2 pb-3">
                                {/*
                                  The per-invoice actions (owner request, 2026-11-07).
                                  Every one of them acts on **this** invoice id, and each
                                  is offered only where it can actually work — Receive
                                  Payment needs `credit.payment.record` and something
                                  still outstanding, or the server would refuse.
                                */}
                                <div className="flex flex-wrap gap-2 py-2">
                                  <Button
                                    variant={panel === 'bill' ? 'primary' : 'quiet'}
                                    onClick={() =>
                                      setPanel(panel === 'bill' ? null : 'bill')
                                    }
                                  >
                                    {panel === 'bill'
                                      ? CREDIT_BILLS.hideFullBill
                                      : CREDIT_BILLS.viewFullBill}
                                  </Button>
                                  {canRecordPayment &&
                                  parseMoney(invoice.outstanding).greaterThan(0) &&
                                  invoice.status !== 'cancelled' ? (
                                    <Button
                                      variant={panel === 'payment' ? 'primary' : 'quiet'}
                                      onClick={() =>
                                        setPanel(panel === 'payment' ? null : 'payment')
                                      }
                                    >
                                      {CREDIT_BILLS.receivePayment}
                                    </Button>
                                  ) : null}
                                  <Button
                                    variant={panel === 'history' ? 'primary' : 'quiet'}
                                    onClick={() =>
                                      setPanel(panel === 'history' ? null : 'history')
                                    }
                                  >
                                    {CREDIT_BILLS.paymentHistory}
                                  </Button>
                                  <Button
                                    variant={panel === 'versions' ? 'primary' : 'quiet'}
                                    onClick={() =>
                                      setPanel(panel === 'versions' ? null : 'versions')
                                    }
                                  >
                                    {EDIT_BILL.historyTitle}
                                  </Button>
                                  {/* F10: the same editor Daily Bills opens. One
                                      implementation, two entry points. */}
                                  {canEdit && invoice.status !== 'cancelled' ? (
                                    <Button
                                      variant="quiet"
                                      onClick={() => setEditing(invoice)}
                                    >
                                      {EDIT_BILL.action}
                                    </Button>
                                  ) : null}
                                  <Button
                                    variant="quiet"
                                    onClick={() => void reprint(invoice.id)}
                                  >
                                    {CREDIT_BILLS.reprint}
                                  </Button>
                                </div>

                                {itemsBusy === invoice.id ? (
                                  <Busy label={COMMON.loading} />
                                ) : null}
                                {itemsError && !detail ? (
                                  <Panel tone="danger">{itemsError}</Panel>
                                ) : null}

                                {/* The whole bill as issued, not a summary of it — which
                                    was the owner's complaint about this screen. */}
                                {panel === 'bill' && detail ? (
                                  <FullBillView invoice={detail} />
                                ) : null}

                                {panel === 'payment' ? (
                                  <ReceiveInvoicePayment
                                    invoiceId={invoice.id}
                                    customerId={entry.customer.id}
                                    outstanding={invoice.outstanding}
                                    onRecorded={() => afterPayment(entry.customer.id)}
                                  />
                                ) : null}

                                {panel === 'history' ? (
                                  <InvoicePaymentHistory
                                    invoiceId={invoice.id}
                                    reloadToken={paymentsToken}
                                  />
                                ) : null}

                                {panel === 'versions' ? (
                                  <RevisionHistory
                                    invoiceId={invoice.id}
                                    reloadToken={paymentsToken}
                                  />
                                ) : null}
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {editing ? (
        <EditBill
          summary={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            // The folder's aggregates, the row's total and the bill's own detail all
            // change — and all of them are the server's to recompute.
            setPaymentsToken((token) => token + 1);
            void refreshCustomerInvoices(expanded ?? '');
          }}
        />
      ) : null}

      {/* The same print root Daily Bills uses, so one bill has one printed form
          wherever it is reached from. A reprint creates nothing (FR-PRINT-004). */}
      <PrintRoot
        payload={printing?.payload ?? null}
        policy={policy}
        invoiceId={printing?.invoiceId ?? null}
        onAfterPrint={() => setPrinting(null)}
      />
    </section>
  );
}

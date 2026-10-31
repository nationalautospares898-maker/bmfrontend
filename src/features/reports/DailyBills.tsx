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
import { AMEND, COMMON, CREDIT_BILLS } from '@/lib/strings';
import { Busy, Button, Panel } from '@/components/primitives';
import { PrintRoot } from '@/features/print/PrintRoot';
import { AmendBill, type RebuildLine } from './AmendBill';
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
   * `billing.sale.cancel`. Without it the correction action is not offered, because
   * cancellation is the only mechanism behind it and the server would refuse.
   */
  canCancel?: boolean | undefined;
  /** Start a replacement bill from the cancelled one's lines and show Billing. */
  onRebuild?: ((lines: RebuildLine[]) => Promise<void>) | undefined;
}

export function DailyBills({ policy, canCancel = false, onRebuild }: DailyBillsProps) {
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
 * Credit Bills: customer-wise, two levels.
 *
 * Level 1 is `GET /credit/customers`, whose aggregates are **server-computed**. Level 2
 * reuses `GET /invoices?customer_id=…&is_credit=true` — no new contract was introduced
 * for per-customer invoices.
 *
 * Grouping keys on `customer_id`; the name is a display label only, so a customer who is
 * renamed keeps one row with their whole history rather than splitting into two
 * (FR-RPT-029).
 */
export function CreditBills() {
  const [customers, setCustomers] = useState<CreditCustomer[]>([]);
  const [overall, setOverall] = useState<Record<string, unknown> | null>(null);
  const [includeSettled, setIncludeSettled] = useState(false);
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
      return;
    }
    openInvoiceRef.current = invoiceId;
    setOpenInvoice(invoiceId);
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

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-4">
        <h1 className="text-xl font-semibold text-[#232852]">Credit Bills</h1>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeSettled}
            onChange={(event) => setIncludeSettled(event.target.checked)}
          />
          {/* A settled customer's history is never hidden permanently (FR-RPT-031). */}
          Include customers at zero balance
        </label>
      </header>

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
                                {itemsBusy === invoice.id ? (
                                  <Busy label={COMMON.loading} />
                                ) : null}
                                {itemsError && !detail ? (
                                  <Panel tone="danger">{itemsError}</Panel>
                                ) : null}
                                {detail ? (
                                  <table className="w-full border-collapse text-sm">
                                    <caption className="px-2 py-1 text-left text-xs text-slate-500">
                                      {CREDIT_BILLS.whatWasBought}
                                    </caption>
                                    <thead>
                                      <tr className="border-b border-slate-200 text-left">
                                        <th scope="col" className="px-2 py-1">
                                          Item
                                        </th>
                                        <th scope="col" className="px-2 py-1">
                                          Code
                                        </th>
                                        <th scope="col" className="px-2 py-1 text-right">
                                          Qty
                                        </th>
                                        <th scope="col" className="px-2 py-1 text-right">
                                          Unit price
                                        </th>
                                        <th scope="col" className="px-2 py-1 text-right">
                                          Line total
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {detail.items.map((item) => (
                                        <tr
                                          key={item.id}
                                          className="border-b border-slate-100"
                                        >
                                          {/* The snapshots, not the catalogue: this is
                                              what the bill said when it was issued, and a
                                              product renamed since must not rewrite
                                              history (FR-SALE-012). */}
                                          <td className="px-2 py-1">
                                            {item.product_name_snapshot}
                                          </td>
                                          <td className="px-2 py-1 text-slate-600">
                                            {item.sku_snapshot ?? '—'}
                                          </td>
                                          <td className="px-2 py-1 text-right">
                                            {item.quantity}
                                            <span className="ml-1 text-xs text-slate-500">
                                              {item.unit_code_snapshot}
                                            </span>
                                          </td>
                                          <td className="px-2 py-1 text-right">
                                            {money(item.unit_price)}
                                          </td>
                                          <td className="px-2 py-1 text-right">
                                            {money(item.line_total)}
                                          </td>
                                        </tr>
                                      ))}
                                      <tr>
                                        <td
                                          colSpan={4}
                                          className="px-2 py-1 text-right font-medium"
                                        >
                                          {CREDIT_BILLS.billTotal}
                                        </td>
                                        <td className="px-2 py-1 text-right font-semibold">
                                          {money(detail.total)}
                                        </td>
                                      </tr>
                                    </tbody>
                                  </table>
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
    </section>
  );
}

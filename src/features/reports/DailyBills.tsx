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

import { useEffect, useState } from 'react';

import { credit, invoices, reports } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import type {
  CreditCustomer,
  DailySales,
  InvoiceSummary,
  PrintPayload,
} from '@/api/types';
import { asText, humanizeKey } from '@/lib/format';
import { formatForScreen, parseMoney } from '@/lib/money';
import { COMMON } from '@/lib/strings';
import { Busy, Button, Panel } from '@/components/primitives';
import { PrintRoot } from '@/features/print/PrintRoot';
import type { MoneyPolicy } from '@/lib/money';

function money(value: string | number): string {
  return formatForScreen(parseMoney(String(value)));
}

/** `yyyy-mm-dd` in the user's locale day. Used only as a filter the server interprets. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// --- Daily Bills --------------------------------------------------------------

export function DailyBills({ policy }: { policy: MoneyPolicy }) {
  const [day, setDay] = useState(() => isoDate(new Date()));
  const [rows, setRows] = useState<InvoiceSummary[]>([]);
  const [summary, setSummary] = useState<DailySales | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [printing, setPrinting] = useState<{
    payload: PrintPayload;
    invoiceId: string;
  } | null>(null);

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
  }, [day]);

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
              <span className="sr-only">Reprint</span>
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
                <Button variant="quiet" onClick={() => void reprint(row.id)}>
                  Reprint
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

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
      return;
    }
    setExpanded(customerId);
    const list = await invoices.list({
      customer_id: customerId,
      is_credit: true,
      limit: 200,
    });
    setCustomerInvoices(list.items);
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
                    Credit bills for {entry.customer.name}
                  </caption>
                  <thead>
                    <tr className="border-b border-slate-300 text-left">
                      <th scope="col" className="px-2 py-1">
                        Date
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
                    </tr>
                  </thead>
                  <tbody>
                    {customerInvoices.map((invoice) => (
                      <tr key={invoice.id} className="border-b border-slate-200">
                        <td className="px-2 py-1">
                          {new Date(invoice.issued_at).toLocaleDateString()}
                        </td>
                        <td className="px-2 py-1 text-right">{money(invoice.total)}</td>
                        <td className="px-2 py-1 text-right">
                          {money(invoice.amount_paid)}
                        </td>
                        <td className="px-2 py-1 text-right">
                          {money(invoice.outstanding)}
                        </td>
                        <td className="px-2 py-1">{invoice.due_date ?? '—'}</td>
                      </tr>
                    ))}
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

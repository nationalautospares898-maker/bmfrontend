/**
 * What one credit invoice looks like when you open it, and what you can do to it.
 *
 * Three pieces, all keyed to a **single invoice id**:
 *
 * * `FullBillView` — the whole bill as issued, not a summary of it.
 * * `ReceiveInvoicePayment` — a payment against *this* bill.
 * * `InvoicePaymentHistory` — the payments already on it.
 *
 * ## Why the figures here are never recomputed
 *
 * Every value comes from `GET /invoices/{id}` and is rendered verbatim. The item rows
 * read `product_name_snapshot`, `unit_price` and `line_total` — the bill's own saved
 * copy — and never the catalogue. A product repriced or renamed since must not change
 * what a bill issued in March says (FR-SALE-012), and a client that multiplied
 * `quantity × today's price` would silently rewrite history on screen while the database
 * held the truth.
 *
 * The totals are the same story: `subtotal`, `discount_total`, `tax_total`,
 * `rounding_adjustment` and `total` are all server-computed and shown as given
 * (ADR-032, OD-7). Nothing on this screen adds up a column.
 *
 * ## Why this payment path is not the Customers screen's payment path
 *
 * Both call `POST /payments`, and that is deliberate — there is one payment engine. They
 * differ in **allocation**, which is the whole point:
 *
 * | | Customers screen | here |
 * |---|---|---|
 * | `allocation` | `{strategy: 'oldest_first'}` | `{allocations: [{invoice_id, amount}]}` |
 * | answers | "the customer handed me ₹5,000" | "the customer is paying *this* bill" |
 *
 * The owner asked for the second without losing the first, so the first is untouched
 * (FR-PAY-003's on-account remainder behaviour included) and this adds the explicit
 * form alongside it. Neither is a special case of the other: a shop genuinely needs both.
 *
 * ## The invoice reference
 *
 * `internal_reference` is shown, labelled **internal**, because this is a staff screen
 * and it is how the shop and support talk about a specific bill. It is never rendered to
 * a customer and never appears in `print_payload` — OD-3 withdrew customer-visible
 * invoice numbering, and that remains true: the printed bill carries no number at all.
 */

import { useEffect, useRef, useState } from 'react';

import { credit } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import type { Invoice, PaymentHistoryList } from '@/api/types';
import { Busy, Button, Field, Panel } from '@/components/primitives';
import { uuidv7 } from '@/lib/ids';
import { formatForScreen, parseMoney, tryParseMoney, ZERO } from '@/lib/money';
import { COMMON, CREDIT_BILLS, ERRORS } from '@/lib/strings';

function money(value: string | number): string {
  return formatForScreen(parseMoney(String(value)));
}

/** A labelled value, rendered only when there is something to show. */
function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  // Never a placeholder where a real value belongs (FR-PRINT-016's rule, applied on
  // screen): an empty vehicle number renders as nothing, not as a dash pretending to
  // be data.
  if (!value || value.trim() === '') return null;
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </>
  );
}

// --- the full bill ------------------------------------------------------------

export interface FullBillViewProps {
  invoice: Invoice;
}

/**
 * The complete bill, laid out the way the Billing Counter lays one out: the header
 * fields, then the numbered item table, then the totals, then the credit block.
 *
 * `ESTIMATE` appears here for the same reason it appears on the counter and on the
 * printed document — it is the document's own label, for cash and credit alike, until
 * the FR-TAX-003 gate passes (OD-24, FR-PRINT-021). Showing a different word on the
 * review screen than on the paper would be worse than showing none.
 */
export function FullBillView({ invoice }: FullBillViewProps) {
  const cancelled = invoice.status === 'cancelled';

  return (
    <section className="rounded border border-nas-navy bg-white p-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-nas-navy pb-2">
        <h4 className="text-sm font-semibold text-[#232852]">
          {CREDIT_BILLS.fullBillTitle}
        </h4>
        {/* The document's own label, not a status. */}
        <span className="text-sm font-semibold tracking-widest text-nas-navy">
          ESTIMATE
        </span>
      </header>

      <p className="mt-2 text-xs text-slate-500">{CREDIT_BILLS.fullBillHistoricalNote}</p>

      {cancelled ? (
        <Panel tone="warning" title={CREDIT_BILLS.cancelled}>
          {invoice.cancellation_reason ?? ''}
        </Panel>
      ) : null}

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr_auto_1fr]">
        {/* Labelled internal, and never shown to a customer (OD-3). */}
        <Detail label={CREDIT_BILLS.fieldReference} value={invoice.internal_reference} />
        <Detail
          label={CREDIT_BILLS.fieldDate}
          value={new Date(invoice.issued_at).toLocaleString()}
        />
        <Detail
          label={CREDIT_BILLS.fieldCustomer}
          value={invoice.customer.name_snapshot}
        />
        <Detail
          label={CREDIT_BILLS.fieldBusinessName}
          value={invoice.customer.business_name_snapshot}
        />
        <Detail
          label={CREDIT_BILLS.fieldMechanic}
          value={invoice.customer.mechanic_name_snapshot}
        />
        <Detail
          label={CREDIT_BILLS.fieldVehicle}
          value={invoice.customer.vehicle_number_snapshot}
        />
        <Detail label={CREDIT_BILLS.fieldPhone} value={invoice.customer.phone_snapshot} />
        <Detail label={CREDIT_BILLS.fieldDueDate} value={invoice.due_date} />
      </dl>

      <table className="mt-3 w-full border-collapse text-sm">
        <caption className="sr-only">{CREDIT_BILLS.fullBillTitle}</caption>
        <thead>
          <tr className="border-b border-nas-navy text-left">
            <th scope="col" className="px-2 py-1 text-center">
              {CREDIT_BILLS.colSerial}
            </th>
            <th scope="col" className="px-2 py-1">
              {CREDIT_BILLS.colItem}
            </th>
            <th scope="col" className="px-2 py-1">
              {CREDIT_BILLS.colCode}
            </th>
            <th scope="col" className="px-2 py-1 text-right">
              {CREDIT_BILLS.colQuantity}
            </th>
            <th scope="col" className="px-2 py-1 text-right">
              {CREDIT_BILLS.colPrice}
            </th>
            <th scope="col" className="px-2 py-1 text-right">
              {CREDIT_BILLS.colLineTotal}
            </th>
          </tr>
        </thead>
        <tbody>
          {invoice.items.map((item) => (
            <tr key={item.id} className="border-b border-slate-100">
              {/* The bill's own line number, so the serial numbers match the paper
                  rather than this list's render order. */}
              <td className="px-2 py-1 text-center text-slate-600">{item.line_no}</td>
              <td className="px-2 py-1">{item.product_name_snapshot}</td>
              <td className="px-2 py-1 text-slate-600">{item.sku_snapshot ?? ''}</td>
              <td className="px-2 py-1 text-right">
                {item.quantity}
                <span className="ml-1 text-xs text-slate-500">
                  {item.unit_code_snapshot}
                </span>
              </td>
              <td className="px-2 py-1 text-right">{money(item.unit_price)}</td>
              <td className="px-2 py-1 text-right">{money(item.line_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="mt-3 ml-auto grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        <dt className="text-slate-500">{CREDIT_BILLS.subtotal}</dt>
        <dd className="text-right">{money(invoice.subtotal)}</dd>
        {/* Rendered only when non-zero: a zero discount row on every bill is noise, and
            a zero tax row would be actively misleading while tax is estimate-only
            (ADR-020). */}
        {parseMoney(invoice.discount_total).greaterThan(0) ? (
          <>
            <dt className="text-slate-500">{CREDIT_BILLS.discount}</dt>
            <dd className="text-right">{money(invoice.discount_total)}</dd>
          </>
        ) : null}
        {parseMoney(invoice.tax_total).greaterThan(0) ? (
          <>
            <dt className="text-slate-500">{CREDIT_BILLS.tax}</dt>
            <dd className="text-right">{money(invoice.tax_total)}</dd>
          </>
        ) : null}
        {!parseMoney(invoice.rounding_adjustment).equals(ZERO) ? (
          <>
            <dt className="text-slate-500">{CREDIT_BILLS.rounding}</dt>
            <dd className="text-right">{money(invoice.rounding_adjustment)}</dd>
          </>
        ) : null}
        <dt className="border-t border-nas-navy pt-1 font-semibold tracking-wide">
          {CREDIT_BILLS.grandTotal}
        </dt>
        <dd className="border-t border-nas-navy pt-1 text-right font-bold">
          {money(invoice.total)}
        </dd>
      </dl>

      {/* The credit block (OD-22). Shown for a credit bill, where the customer needs to
          know what is still owed. */}
      {invoice.is_credit ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 rounded bg-[#f3f4fb] p-3 text-sm sm:grid-cols-4">
          <dt className="text-slate-500">{CREDIT_BILLS.creditAmount}</dt>
          <dd className="font-medium">{money(invoice.total)}</dd>
          <dt className="text-slate-500">{CREDIT_BILLS.paidAmount}</dt>
          <dd className="font-medium">{money(invoice.amount_paid)}</dd>
          <dt className="text-slate-500">{CREDIT_BILLS.outstanding}</dt>
          <dd className="font-semibold">{money(invoice.outstanding)}</dd>
          <dt className="text-slate-500">{CREDIT_BILLS.paymentStatus}</dt>
          {/* Server-derived and displayed verbatim. There is no control anywhere in
              this application that sets it (ADR-022). */}
          <dd className="font-medium">
            {cancelled ? CREDIT_BILLS.cancelled : invoice.payment_status}
          </dd>
        </dl>
      ) : null}

      {invoice.notes ? (
        <p className="mt-3 text-sm">
          <span className="text-slate-500">{CREDIT_BILLS.fieldNotes}: </span>
          {invoice.notes}
        </p>
      ) : null}
    </section>
  );
}

// --- receiving a payment on this bill ----------------------------------------

export interface ReceiveInvoicePaymentProps {
  invoiceId: string;
  customerId: string;
  /** The bill's current outstanding, from the server. Prefills the amount. */
  outstanding: string;
  /** Refresh the caller's lists: the row, the folder total and the history all change. */
  onRecorded: () => void;
}

/**
 * A payment allocated **explicitly** to one invoice.
 *
 * The `Idempotency-Key` is generated once per attempt and reused across retries of that
 * attempt, which is what makes a double press or a dropped response record one payment
 * rather than two (FR-PAY-004, invariant 9). A fresh key is minted only after a
 * *successful* submission, so the next genuine payment is a new event.
 *
 * Overpayment is refused client-side **and** by the server. The client check exists to
 * explain the number rather than to enforce it: "that is more than the ₹800 outstanding"
 * is actionable at the counter, where a 422 is not.
 */
export function ReceiveInvoicePayment({
  invoiceId,
  customerId,
  outstanding,
  onRecorded,
}: ReceiveInvoicePaymentProps) {
  const due = parseMoney(outstanding);
  const [amount, setAmount] = useState(() => formatForScreen(due));
  const [method, setMethod] = useState('cash');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  /** One key per attempt, so a retry of *this* payment cannot double-record it. */
  const key = useRef(uuidv7());
  const submitting = useRef(false);

  if (!due.greaterThan(0)) {
    return <Panel tone="info">{CREDIT_BILLS.settled}</Panel>;
  }

  async function submit(): Promise<void> {
    const parsed = tryParseMoney(amount);
    if (!parsed || !parsed.greaterThan(0)) {
      setError(CREDIT_BILLS.receiveNeedsAmount);
      return;
    }
    if (parsed.greaterThan(due)) {
      setError(CREDIT_BILLS.receiveOverpay(formatForScreen(due)));
      return;
    }
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await credit.recordPayment(
        {
          customer_id: customerId,
          amount: parsed.toFixed(2),
          method,
          // The explicit form: this money pays *this* bill. `invoice_specific` is the
          // server's name for it, and it does three things `oldest_first` does not —
          // locks the named invoice's row, refuses an amount above its outstanding, and
          // refuses allocations summing above the payment. Deliberately not
          // `oldest_first`, which is the Customers screen's workflow and is untouched.
          allocation: {
            strategy: 'invoice_specific',
            allocations: [{ invoice_id: invoiceId, amount: parsed.toFixed(2) }],
          },
          ...(reference.trim() ? { reference: reference.trim() } : {}),
        },
        key.current,
      );
      setDone(true);
      setReference('');
      // A new event needs a new key; the old one now identifies a payment that exists.
      key.current = uuidv7();
      onRecorded();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? describeError(caught.code).message
          : ERRORS.unexpected,
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="rounded border border-[#232852] bg-[#f3f4fb] p-3">
      <h4 className="text-sm font-semibold text-slate-700">
        {CREDIT_BILLS.receiveTitle}
      </h4>
      {/* The distinction from the Customers screen, so the two cannot be confused. */}
      <p className="mt-1 text-xs text-slate-600">{CREDIT_BILLS.receiveHint}</p>

      {error ? (
        <div className="mt-2">
          <Panel tone="danger">{error}</Panel>
        </div>
      ) : null}
      {done && !error ? (
        <p role="status" className="mt-2 text-xs font-medium text-green-800">
          {CREDIT_BILLS.receiveDone}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Field
          label={CREDIT_BILLS.receiveAmount}
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
        <label className="flex flex-col gap-1 text-sm">
          {CREDIT_BILLS.receiveMethod}
          <select
            value={method}
            onChange={(event) => setMethod(event.target.value)}
            className="min-h-11 rounded border border-slate-300 px-2"
          >
            {/* The server's own `payment_method` enum, and the same five the Customers
                screen offers. No instrument data is ever collected — a method and an
                optional free-text reference such as a cheque number, nothing more. */}
            <option value="cash">Cash</option>
            <option value="upi">UPI</option>
            <option value="card">Card</option>
            <option value="bank_transfer">Bank transfer</option>
            <option value="cheque">Cheque</option>
          </select>
        </label>
        <Field
          label={CREDIT_BILLS.receiveReference}
          value={reference}
          onChange={(event) => setReference(event.target.value)}
        />
        <Button variant="primary" busy={busy} onClick={() => void submit()}>
          {CREDIT_BILLS.receiveSubmit}
        </Button>
      </div>
    </section>
  );
}

// --- the payments already on this bill ---------------------------------------

export interface InvoicePaymentHistoryProps {
  invoiceId: string;
  /** Bumped by the caller after a payment, to refetch. */
  reloadToken: number;
}

/**
 * The payments recorded against one invoice.
 *
 * Read from `GET /payments?invoice_id=…`, which is the allocation history — so a payment
 * the shop collected at customer level and the server allocated here appears too. That
 * matters: the two payment workflows write to one ledger, and a history that only showed
 * payments made *through this screen* would look like money had gone missing.
 */
export function InvoicePaymentHistory({
  invoiceId,
  reloadToken,
}: InvoicePaymentHistoryProps) {
  const [rows, setRows] = useState<PaymentHistoryList['items']>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void (async () => {
      try {
        const result = await credit.payments({ invoice_id: invoiceId });
        if (!cancelled) {
          setRows(result.items);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          // Surfaced rather than swallowed: an empty history and a failed request look
          // identical on screen, and one of them means "no money has been received",
          // which would be alarming and wrong.
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
  }, [invoiceId, reloadToken]);

  return (
    <section className="rounded border border-slate-300 p-3">
      <h4 className="text-sm font-semibold text-slate-700">
        {CREDIT_BILLS.historyTitle}
      </h4>
      {busy ? <Busy label={COMMON.loading} /> : null}
      {error ? <Panel tone="danger">{error}</Panel> : null}
      {!busy && !error && rows.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">{CREDIT_BILLS.historyEmpty}</p>
      ) : null}
      {rows.length > 0 ? (
        <table className="mt-2 w-full border-collapse text-sm">
          <caption className="sr-only">{CREDIT_BILLS.historyTitle}</caption>
          <thead>
            <tr className="border-b border-slate-300 text-left">
              <th scope="col" className="px-2 py-1">
                {CREDIT_BILLS.historyWhen}
              </th>
              <th scope="col" className="px-2 py-1 text-right">
                {CREDIT_BILLS.historyAmount}
              </th>
              <th scope="col" className="px-2 py-1">
                {CREDIT_BILLS.historyMethod}
              </th>
              <th scope="col" className="px-2 py-1">
                {CREDIT_BILLS.historyReference}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={String(row.id)} className="border-b border-slate-100">
                <td className="px-2 py-1">
                  {new Date(String(row.received_at)).toLocaleString()}
                </td>
                <td className="px-2 py-1 text-right font-medium">
                  {money(String(row.amount))}
                </td>
                <td className="px-2 py-1">{String(row.method)}</td>
                <td className="px-2 py-1 text-slate-600">
                  {row.reference ? String(row.reference) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

/**
 * The print portal and the counter slip.
 *
 * `PrintRoot` renders into `#print-root`, which sits **outside** the application layout
 * in `index.html`. That is what lets `@media print` hide the whole app with one rule and
 * leave only the bill — no hunting for chrome that forgot to hide itself.
 *
 * Both roots arm their dialog through `usePrintRequest`, which is where the one rule
 * that governs this file is written down and explained: **one dialog per print request,
 * and a re-render is not a request.**
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { invoices } from '@/api/endpoints';
import type { PrintPayload } from '@/api/types';
import { formatForPrint, parseMoney, type MoneyPolicy } from '@/lib/money';
import { PRINT, OFFLINE } from '@/lib/strings';
import { InvoicePrintLayout } from './InvoicePrintLayout';

function printTarget(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById('print-root');
}

/**
 * Arm exactly one print dialog per print request.
 *
 * A *request* is the object the caller has mounted — a bill payload or a counter slip —
 * and it is identified by **object identity**. Only the identity is used, never the
 * contents, and that distinction is the whole point:
 *
 * - a **re-render** hands over the same object again, so nothing is re-armed. The effect
 *   depends on the request and the portal target alone, so the caller's inline
 *   `onAfterPrint` — both real callers pass one — no longer re-runs it at all;
 * - a **deliberate second press** hands over either a different object, or the same
 *   object again after the caller cleared it on `afterprint`. Either is a new request,
 *   and it prints.
 *
 * 🔴 The guard this replaces was keyed on `${issued_at}:${is_duplicate}` — a description
 * of the *document*, not of the request — and was assigned once and never cleared. Both
 * halves of that key are stable across repeat reprints of one bill: `issued_at` is
 * immutable, and `is_duplicate` is the server's answer and is true for every reprint once
 * `print_log` has a row. So **the third press of Reprint, and every press after it, did
 * nothing at all** — no dialog, no error, nothing to retry, with a customer standing at
 * the counter waiting for their copy. With `print.mark_reprints_duplicate` off the key
 * never changed at all, so only the first press of a mount ever printed; and the credit
 * confirmation card's "Print now", which hands over the very same payload object on every
 * press, printed exactly once however many times it was pressed (FR-PRINT-004).
 *
 * The property that guard existed for is kept, and kept more strongly: a parent state
 * change mid-print cannot open a second dialog, because a re-render no longer re-runs
 * this effect at all rather than being caught by an early return after the fact.
 */
function usePrintRequest(
  request: object | null,
  target: HTMLElement | null,
  onDialogClosed: () => void,
): void {
  /** The request already armed, or `null` while the caller has nothing mounted. */
  const armed = useRef<object | null>(null);

  /**
   * The close handler, read when the dialog closes rather than when it is armed, which
   * is what keeps the caller's inline closure out of the dependency list below.
   *
   * Declared **before** the arming effect deliberately: effects run in declaration
   * order, so this one has already refreshed the ref by the time the arming effect
   * reads it.
   */
  const closed = useRef(onDialogClosed);
  useEffect(() => {
    closed.current = onDialogClosed;
  });

  useEffect(() => {
    if (request === null || !target) {
      // The caller has taken the payload away — it does that on `afterprint` — so the
      // request being served is finished, and the next one is a new request even when it
      // is the same object for the same bill.
      armed.current = null;
      return;
    }
    if (armed.current === request) return;
    armed.current = request;

    let opened = false;
    const handleAfterPrint = (): void => {
      closed.current();
    };

    window.addEventListener('afterprint', handleAfterPrint, { once: true });
    // A frame, so the portal's children are in the DOM before the dialog opens.
    const timer = setTimeout(() => {
      opened = true;
      window.print();
    }, 50);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('afterprint', handleAfterPrint);
      // Torn down before the dialog ever opened — a remount, or the request replaced
      // inside that 50 ms. Forget it, so it can be armed again: a marker that outlives
      // the request it was protecting is precisely how the defect above silenced the
      // third press.
      if (!opened) armed.current = null;
    };
  }, [request, target]);
}

export interface PrintRootProps {
  payload: PrintPayload | null;
  policy: MoneyPolicy;
  /** Called after the print dialog closes, so the caller can clear the payload. */
  onAfterPrint?: () => void;
  /** Logged best-effort once the dialog has been opened. */
  invoiceId?: string | null;
}

/**
 * Mount a payload into the print root and open the dialog.
 *
 * Every press the operator makes is a print request and opens a dialog — a reprint is a
 * `GET` of the payload and creates nothing, so there is no reason to swallow the third
 * one (FR-PRINT-004). `usePrintRequest` carries the full account of why that needed
 * saying.
 *
 * The print event is logged **after** `window.print()` returns and failures are
 * swallowed inside `recordPrintEvent`: a customer waiting for their bill is not the
 * moment to fail on an audit nicety (FR-PRINT-004).
 */
export function PrintRoot({ payload, policy, onAfterPrint, invoiceId }: PrintRootProps) {
  const target = printTarget();

  usePrintRequest(payload, target, () => {
    onAfterPrint?.();
    // `payload` and `invoiceId` come from the latest render and still describe the bill
    // that just printed: this handler is only subscribed while that request is armed,
    // and both callers set the payload and the invoice id together.
    if (invoiceId && payload) {
      void invoices.recordPrintEvent(invoiceId, payload.is_duplicate);
    }
  });

  if (!payload || !target) return null;
  return createPortal(<InvoicePrintLayout payload={payload} policy={policy} />, target);
}

// --- the counter slip ---------------------------------------------------------

export interface CounterSlipData {
  printedAt: string;
  lines: Array<{ sl_no: number; item: string; quantity: string; price: string }>;
  total: string;
  customerName: string;
  vehicleNumber: string;
}

/**
 * The counter slip. **Not a bill**, and it says so twice.
 *
 * Offered only in the offline/unconfirmed case (FR-OFFLINE-015). It carries no invoice
 * number because there is none to carry, no document title that could be mistaken for
 * one, and a watermark plus a sentence stating plainly that the sale is not complete.
 *
 * It is built from local draft data, which is the one place in this client where a
 * printed figure is not server-confirmed — hence the wording. Handing a customer
 * something that looks like a bill for a sale that has not been recorded is the exact
 * failure this layout exists to prevent.
 */
export function CounterSlipLayout({
  data,
  policy,
}: {
  data: CounterSlipData;
  policy: MoneyPolicy;
}) {
  return (
    <article className="slip">
      <div className="slip__watermark">{PRINT.counterSlipWatermark}</div>
      <div className="bill__title">{PRINT.counterSlipTitle}</div>

      <section className="bill__customer">
        <div className="bill__customer-row">Time</div>
        <div className="bill__customer-row">
          {new Date(data.printedAt).toLocaleString()}
        </div>
        {data.customerName ? (
          <>
            <div className="bill__customer-row">Name</div>
            <div className="bill__customer-row">{data.customerName}</div>
          </>
        ) : null}
        {data.vehicleNumber ? (
          <>
            <div className="bill__customer-row">Vehicle</div>
            <div className="bill__customer-row">{data.vehicleNumber}</div>
          </>
        ) : null}
      </section>

      <table className="bill__items">
        <thead>
          <tr>
            <th scope="col">{PRINT.columnSerial}</th>
            <th scope="col">{PRINT.columnItem}</th>
            <th scope="col">{PRINT.columnQuantity}</th>
            <th scope="col">{PRINT.columnPrice}</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((line) => (
            <tr key={line.sl_no}>
              <td>{line.sl_no}</td>
              <td>{line.item}</td>
              <td>{parseMoney(line.quantity).toString()}</td>
              <td>{formatForPrint(parseMoney(line.price), policy)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="bill__totals">
        <tbody>
          <tr className="bill__grand-total">
            <td>{PRINT.grandTotal}</td>
            <td>{formatForPrint(parseMoney(data.total), policy)}</td>
          </tr>
        </tbody>
      </table>

      <p className="slip__note">{OFFLINE.counterSlipNote}</p>
    </article>
  );
}

/**
 * Portal and print a counter slip. Same lifecycle as the bill, different layout.
 *
 * 🔴 This used to arm itself with an `armed` state flag that was both set inside the
 * effect and listed in its dependencies. Setting it re-rendered, the re-render re-ran
 * the effect, the cleanup cancelled the pending `window.print()` timer, and the flag
 * then sent the re-run straight down the early return — so the dialog was armed, torn
 * down and never reopened. **No counter slip ever printed**, which is the one thing a
 * cashier can offer a customer when a sale cannot be finalised offline (FR-OFFLINE-015).
 * `usePrintRequest` keys on the slip the caller mounted and keeps nothing in state, so
 * arming no longer triggers the render that cancelled it.
 */
export function CounterSlipRoot({
  data,
  policy,
  onAfterPrint,
}: {
  data: CounterSlipData | null;
  policy: MoneyPolicy;
  onAfterPrint?: () => void;
}) {
  const target = printTarget();

  usePrintRequest(data, target, () => {
    onAfterPrint?.();
  });

  if (!data || !target) return null;
  return createPortal(<CounterSlipLayout data={data} policy={policy} />, target);
}

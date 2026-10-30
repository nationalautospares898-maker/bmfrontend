/**
 * The print portal and the counter slip.
 *
 * `PrintRoot` renders into `#print-root`, which sits **outside** the application layout
 * in `index.html`. That is what lets `@media print` hide the whole app with one rule and
 * leave only the bill — no hunting for chrome that forgot to hide itself.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { invoices } from '@/api/endpoints';
import type { PrintPayload } from '@/api/types';
import { formatForPrint, parseMoney, type MoneyPolicy } from '@/lib/money';
import { PRINT, OFFLINE } from '@/lib/strings';
import { InvoicePrintLayout } from './InvoicePrintLayout';

function printTarget(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById('print-root');
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
 * The print event is logged **after** `window.print()` returns and failures are
 * swallowed inside `recordPrintEvent`: a customer waiting for their bill is not the
 * moment to fail on an audit nicety (FR-PRINT-004).
 */
export function PrintRoot({ payload, policy, onAfterPrint, invoiceId }: PrintRootProps) {
  const target = printTarget();
  const printed = useRef<string | null>(null);

  useEffect(() => {
    if (!payload || !target) return;

    // Keyed on the payload identity so a re-render cannot reopen the dialog. Without
    // this, a parent state change mid-print produces a second print dialog.
    const key = `${payload.issued_at}:${payload.is_duplicate}`;
    if (printed.current === key) return;
    printed.current = key;

    const handleAfterPrint = () => {
      onAfterPrint?.();
      if (invoiceId) void invoices.recordPrintEvent(invoiceId, payload.is_duplicate);
    };

    window.addEventListener('afterprint', handleAfterPrint, { once: true });
    // A frame, so the portal's children are in the DOM before the dialog opens.
    const timer = setTimeout(() => window.print(), 50);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('afterprint', handleAfterPrint);
    };
  }, [payload, target, onAfterPrint, invoiceId]);

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

/** Portal and print a counter slip. Same lifecycle as the bill, different layout. */
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
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!data || !target || armed) return;
    setArmed(true);
    const handleAfterPrint = () => {
      setArmed(false);
      onAfterPrint?.();
    };
    window.addEventListener('afterprint', handleAfterPrint, { once: true });
    const timer = setTimeout(() => window.print(), 50);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('afterprint', handleAfterPrint);
    };
  }, [data, target, armed, onAfterPrint]);

  if (!data || !target) return null;
  return createPortal(<CounterSlipLayout data={data} policy={policy} />, target);
}

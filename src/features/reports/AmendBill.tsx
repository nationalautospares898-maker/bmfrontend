/**
 * Correcting a bill that has already been finalised and printed.
 *
 * ## Why this is not an edit
 *
 * The obvious implementation — open the invoice, change the lines, save — is not
 * available, and not because nobody got round to it. A finalised invoice is immutable,
 * and that decision is recorded at every level of this project:
 *
 * * `OWNER-DECISIONS.md` OD-10: "Issued invoices are **immutable**; cancellation reverses
 *   stock and issues a full credit note, keeps the invoice number, and is audited.
 *   **There is no edit path, ever.**"
 * * `PRD.md` FR-SALE-010 (P0): "A finalised invoice is **immutable**."
 * * `CLAUDE.md`: "Do not add an endpoint that mutates a finalised financial record."
 * * ADR-015: corrections are **cancellation, return, credit note or reversal**.
 *
 * And it is enforced below the application: migration 0011 revokes `UPDATE`/`DELETE` on
 * `invoices` and `invoice_items` from the application role, re-granting column-level
 * `UPDATE` on seven cancellation and derived-cache columns and, on `invoice_items`,
 * exactly one — `returned_quantity`. An in-place edit is not merely undesigned; the
 * database refuses it. Working around that would mean dismantling a deliberate
 * data-integrity control, which is the one thing a correction feature must not do.
 *
 * ## So what this screen does
 *
 * It implements the sanctioned correction for the case that actually comes up — "the
 * customer wants one more item on the bill I just printed" — which ADR-015 names in its
 * consequences: **cancel, then re-bill**. The cancellation is a real, audited, implemented
 * operation that reverses the stock exactly (read from the movement ledger, so a partial
 * return already taken is not double-counted) and issues a full-value credit note for a
 * credit sale. The invoice number is retained and the row stays listed as cancelled, so
 * the day's takings can still be reconciled.
 *
 * The rebuild then starts an ordinary new bill, pre-loaded with the original lines, so
 * the cashier adds the extra item and prints. Two invoices exist afterwards and that is
 * correct: one cancelled, one issued. Nothing has been rewritten.
 *
 * ## What it refuses, and says so
 *
 * * **Outside the cancellation window** the server refuses with "Use a return instead."
 *   That is right — an old day's takings should not be rewritten — and the message is
 *   surfaced verbatim rather than translated into something vaguer.
 * * **A paid cash bill** can be cancelled, but the system has no record of money going
 *   back. There is no refund entity anywhere in the schema: a cash refund is genuinely
 *   undecided policy, not a missing screen. So the cancellation is allowed — it is
 *   sanctioned and the stock reversal is real — but the operator has to acknowledge in
 *   so many words that the cash is theirs to reconcile and the system will not show it.
 *   Hiding that would produce a till that silently does not balance.
 */

import { useEffect, useState } from 'react';

import { invoices } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import type { Invoice, InvoiceSummary } from '@/api/types';
import { Busy, Button, Dialog, Field, Panel } from '@/components/primitives';
import { uuidv7 } from '@/lib/ids';
import { formatForScreen, parseMoney, tryParseMoney, ZERO } from '@/lib/money';
import { AMEND, COMMON } from '@/lib/strings';

function money(value: string | number): string {
  return formatForScreen(parseMoney(String(value)));
}

/** A line of the original bill, in the shape the billing screen needs to re-add it. */
export interface RebuildLine {
  product_id: string;
  product_name: string;
  sku: string | null;
  unit_code: string;
  quantity: string;
  unit_price: string;
}

export interface AmendBillProps {
  /** The row the user pressed, so the dialog can open before the detail arrives. */
  summary: InvoiceSummary;
  onClose: () => void;
  /** Refresh the day's list; the cancelled row and the day's totals both change. */
  onCancelled: () => void;
  /**
   * Start a new bill from these lines and switch to Billing.
   *
   * Passed in because this screen must not reach into the billing store: the draft
   * belongs to the counter, and `AppShell` owns which screen is showing.
   */
  onRebuild?: ((lines: RebuildLine[]) => Promise<void>) | undefined;
}

export function AmendBill({ summary, onClose, onCancelled, onRebuild }: AmendBillProps) {
  const [detail, setDetail] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);

  useEffect(() => {
    let dropped = false;
    void (async () => {
      try {
        const invoice = await invoices.get(summary.id);
        if (!dropped) setDetail(invoice);
      } catch (caught) {
        if (!dropped) {
          setError(
            caught instanceof ApiError
              ? describeError(caught.code).message
              : COMMON.retry,
          );
        }
      } finally {
        if (!dropped) setLoading(false);
      }
    })();
    return () => {
      dropped = true;
    };
  }, [summary.id]);

  // A cash bill with money against it. Cancelling reverses the goods; it does not record
  // the cash going back, because no refund record exists in the schema at all.
  const paid = tryParseMoney(summary.amount_paid) ?? ZERO;
  const cashRefundUnrecorded = !summary.is_credit && paid.greaterThan(0);
  const needsAcknowledgement = cashRefundUnrecorded && !acknowledged;

  const reasonLongEnough = reason.trim().length >= 10;

  async function cancelBill(): Promise<string | null> {
    setBusy(true);
    setError(null);
    try {
      // A client-generated key, so a double press or a retried request cancels once.
      await invoices.cancel(summary.id, reason.trim(), uuidv7());
      setCancelled(true);
      onCancelled();
      return null;
    } catch (caught) {
      // The server's own words. `CANCEL_WINDOW_EXPIRED` says "Use a return instead",
      // which is both correct and actionable, and must not be flattened into
      // "something went wrong".
      const message =
        caught instanceof ApiError ? describeError(caught.code).message : COMMON.retry;
      setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  }

  async function cancelAndRebuild(): Promise<void> {
    if (!detail || !onRebuild) return;
    const failure = await cancelBill();
    // Only rebuild if the cancellation actually happened. Starting a replacement bill
    // for an invoice that is still live would put the same goods on two bills.
    if (failure !== null) return;
    await onRebuild(
      detail.items.map((item) => ({
        product_id: item.product_id,
        product_name: item.product_name_snapshot,
        sku: item.sku_snapshot,
        unit_code: item.unit_code_snapshot,
        quantity: item.quantity,
        unit_price: item.unit_price,
      })),
    );
    onClose();
  }

  if (cancelled && !onRebuild) {
    return (
      <Dialog
        open
        title={AMEND.cancelledTitle}
        onDismiss={onClose}
        actions={<Button onClick={onClose}>{COMMON.close}</Button>}
      >
        <Panel tone="info">{AMEND.cancelledBody}</Panel>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      title={`${AMEND.title} — ${summary.internal_reference ?? ''}`}
      onDismiss={onClose}
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>
            {COMMON.cancel}
          </Button>
          {onRebuild ? (
            <Button
              variant="primary"
              busy={busy}
              disabled={!detail || !reasonLongEnough || needsAcknowledgement}
              onClick={() => void cancelAndRebuild()}
            >
              {AMEND.cancelAndRebuild}
            </Button>
          ) : null}
          <Button
            variant="danger"
            busy={busy}
            disabled={!reasonLongEnough || needsAcknowledgement}
            onClick={() => void cancelBill()}
          >
            {AMEND.cancelOnly}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Stated first and plainly. A cashier pressing "Edit Bill" expects to change
            the bill; they need to know immediately that what will happen instead is a
            cancellation and a replacement, and that both will be on the record. */}
        <Panel tone="warning" title={AMEND.howItWorksTitle}>
          {AMEND.howItWorks}
        </Panel>

        {error ? <Panel tone="danger">{error}</Panel> : null}

        {loading ? <Busy label={COMMON.loading} /> : null}

        {detail ? (
          <section>
            <h3 className="text-sm font-semibold text-slate-700">{AMEND.originalBill}</h3>
            <table className="mt-2 w-full border-collapse text-sm">
              <caption className="sr-only">{AMEND.originalBill}</caption>
              <thead>
                <tr className="border-b border-slate-300 text-left">
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
                  <tr key={item.id} className="border-b border-slate-100">
                    <td className="px-2 py-1">{item.product_name_snapshot}</td>
                    <td className="px-2 py-1 text-slate-600">
                      {item.sku_snapshot ?? '—'}
                    </td>
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
                <tr>
                  <td colSpan={4} className="px-2 py-1 text-right font-medium">
                    {AMEND.billTotal}
                  </td>
                  <td className="px-2 py-1 text-right font-semibold">
                    {money(detail.total)}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="mt-2 text-xs text-slate-600">
              {summary.is_credit ? AMEND.creditNoteNote : AMEND.cashNote}
            </p>
          </section>
        ) : null}

        {cashRefundUnrecorded ? (
          // The one genuinely undecided thing here, surfaced rather than hidden. See the
          // module docstring: there is no refund record in the schema, so the money
          // leaving the till will not appear anywhere in this system.
          <Panel tone="danger" title={AMEND.cashRefundTitle}>
            <p>{AMEND.cashRefundBody(money(summary.amount_paid))}</p>
            <label className="mt-2 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="mt-1"
              />
              <span>{AMEND.cashRefundAcknowledge}</span>
            </label>
          </Panel>
        ) : null}

        <Field
          label={AMEND.reason}
          hint={AMEND.reasonHint}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
    </Dialog>
  );
}

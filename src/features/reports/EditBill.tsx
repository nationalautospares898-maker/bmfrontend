/**
 * Editing a finalised bill, in place (F7–F10; owner Decision A, 2026-11-07).
 *
 * ## What replaced the old dialog
 *
 * `AmendBill` used to open with a warning panel explaining that "Edit Bill" would
 * actually **cancel** the bill and start a replacement, because a finalised invoice was
 * immutable (OD-10). The owner reversed that decision. So:
 *
 * * **F7** — this opens straight into the editor. No confirmation popup, no
 *   informational notice to dismiss first.
 * * **F8** — every field arrives prefilled from `GET /invoices/{id}`: customer, mechanic,
 *   vehicle, notes, due date, and every line with its own saved quantity and price.
 * * **F9** — saving calls `POST /invoices/{id}:amend`, which keeps the invoice's id and
 *   internal reference. There is no second invoice and no new number.
 * * **F10** — the same component is opened from Daily Bills and from Credit Bills, so
 *   there is one editing implementation rather than two that drift.
 *
 * Cancellation has **not** gone away (Decision C): it is still the right answer when a
 * sale should not have happened at all, and it still lives behind its own action.
 *
 * ## The three refusals this screen has to explain well
 *
 * The server owns all three; this screen's job is to say what happened in words a
 * counter hand can act on.
 *
 * | Server | What the operator is told |
 * |---|---|
 * | `EDIT_BELOW_PAID_TOTAL` | the bill is paid more than the new total — use a return or credit note |
 * | `INVOICE_VERSION_CONFLICT` | somebody else changed it; reload and redo the edit |
 * | `INSUFFICIENT_STOCK` | there is not enough stock for the increase |
 *
 * ## Why the idempotency key is minted once per *attempt*
 *
 * Held in a ref and reused while the same edit is being retried, regenerated only after
 * a success. A fresh key per click would let a double-press write two revisions and two
 * sets of stock movements; a permanently fixed key would make the operator's *second,
 * genuine* edit replay the first and appear to do nothing.
 */

import { useEffect, useRef, useState } from 'react';

import { catalog, invoices } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import type { Invoice, InvoiceSummary, Product } from '@/api/types';
import { Busy, Button, Dialog, Field, Panel } from '@/components/primitives';
import { uuidv7 } from '@/lib/ids';
import { formatForScreen, parseMoney, tryParseMoney, ZERO } from '@/lib/money';
import { COMMON, EDIT_BILL, ERRORS } from '@/lib/strings';

/** One line being edited. Strings end to end, as every amount is (ADR-013). */
interface EditLine {
  /** Local row key only. The server identifies lines by position in the new set. */
  key: string;
  product_id: string;
  product_name: string;
  sku: string | null;
  unit_code: string;
  quantity: string;
  unit_price: string;
}

function toEditLines(invoice: Invoice): EditLine[] {
  return invoice.items.map((item) => ({
    key: item.id,
    product_id: item.product_id,
    // The **snapshot**, not the catalogue: the bill is edited from what it says, not
    // from what the product is called today (FR-SALE-012).
    product_name: item.product_name_snapshot,
    sku: item.sku_snapshot,
    unit_code: item.unit_code_snapshot,
    quantity: String(item.quantity),
    unit_price: String(item.unit_price),
  }));
}

/** Advisory only — the server recomputes and is authoritative (ADR-032, OD-7). */
function previewTotal(lines: EditLine[]): string {
  let total = ZERO;
  for (const line of lines) {
    const quantity = tryParseMoney(line.quantity);
    const price = tryParseMoney(line.unit_price);
    if (quantity === null || price === null) continue;
    total = total.plus(quantity.times(price));
  }
  return formatForScreen(total);
}

export interface EditBillProps {
  /** The row the user pressed, so the editor can open before the detail arrives. */
  summary: InvoiceSummary;
  onClose: () => void;
  /** Refresh the caller's list: the total, status and outstanding all change. */
  onSaved: () => void;
}

export function EditBill({ summary, onClose, onSaved }: EditBillProps) {
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [lines, setLines] = useState<EditLine[]>([]);
  const [mechanic, setMechanic] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /** Product search for adding a line. */
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<Product[]>([]);

  /** One key per attempt. See the module docstring. */
  const key = useRef(uuidv7());
  const submitting = useRef(false);

  useEffect(() => {
    let dropped = false;
    void (async () => {
      try {
        const detail = await invoices.get(summary.id);
        if (dropped) return;
        setInvoice(detail);
        // F8: everything prefilled, including the fields that are not line items.
        setLines(toEditLines(detail));
        setMechanic(detail.customer.mechanic_name_snapshot ?? '');
        setVehicle(detail.customer.vehicle_number_snapshot ?? '');
        setNotes(detail.notes ?? '');
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

  // Debounced product search, late replies discarded — the same contract the billing
  // cell uses, so the two behave alike.
  const latest = useRef(0);
  useEffect(() => {
    const text = term.trim();
    if (text.length < 1) {
      setHits([]);
      return;
    }
    const sequence = latest.current + 1;
    latest.current = sequence;
    const timer = setTimeout(() => {
      void catalog
        .search(text, { limit: 8 })
        .then((response) => {
          if (sequence === latest.current) setHits(response.items);
        })
        .catch(() => {
          if (sequence === latest.current) setHits([]);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [term]);

  function addLine(product: Product): void {
    setLines((current) => [
      ...current,
      {
        key: uuidv7(),
        product_id: product.id,
        product_name: product.name,
        sku: product.sku,
        unit_code: product.unit.code,
        quantity: '1',
        unit_price: String(product.default_selling_price),
      },
    ]);
    setTerm('');
    setHits([]);
  }

  function patchLine(lineKey: string, patch: Partial<EditLine>): void {
    setLines((current) =>
      current.map((line) => (line.key === lineKey ? { ...line, ...patch } : line)),
    );
  }

  function removeLine(lineKey: string): void {
    setLines((current) => current.filter((line) => line.key !== lineKey));
  }

  async function save(): Promise<void> {
    if (!invoice) return;
    if (reason.trim().length < 5) {
      setError(EDIT_BILL.needReason);
      return;
    }
    if (lines.length === 0) {
      // A bill with no items is a cancellation, which has its own action and its own
      // audited reversal (ADR-015). Saying so is better than letting the server 422.
      setError(EDIT_BILL.needLines);
      return;
    }
    for (const line of lines) {
      if (tryParseMoney(line.quantity) === null || parseMoney(line.quantity).lte(0)) {
        setError(EDIT_BILL.badQuantity(line.product_name));
        return;
      }
      if (tryParseMoney(line.unit_price) === null) {
        setError(EDIT_BILL.badPrice(line.product_name));
        return;
      }
    }

    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await invoices.amend(
        invoice.id,
        {
          // The version read when the editor opened. The server compares it under a row
          // lock and refuses a stale edit rather than overwriting a concurrent change.
          expected_version: invoice.version,
          reason: reason.trim(),
          lines: lines.map((line) => ({
            product_id: line.product_id,
            quantity: line.quantity,
            unit_price: line.unit_price,
          })),
          header: {
            mechanic_name: mechanic.trim() || null,
            vehicle_number: vehicle.trim() || null,
            notes: notes.trim() || null,
          },
        },
        key.current,
      );
      setSaved(true);
      // A new edit is a new event and needs a new key.
      key.current = uuidv7();
      onSaved();
    } catch (caught) {
      // The server's own words, which are actionable: `EDIT_BELOW_PAID_TOTAL` says to
      // use a return or a credit note, and flattening that into "something went wrong"
      // would leave the operator with no idea what to do next.
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

  if (saved) {
    return (
      <Dialog
        open
        title={EDIT_BILL.savedTitle}
        onDismiss={onClose}
        actions={<Button onClick={onClose}>{COMMON.close}</Button>}
      >
        <Panel tone="info">{EDIT_BILL.savedBody}</Panel>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      // The invoice's own reference, unchanged by the edit — which is the point of F9.
      title={`${EDIT_BILL.title} — ${summary.internal_reference ?? ''}`}
      onDismiss={onClose}
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>
            {EDIT_BILL.discard}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!invoice || loading}
            onClick={() => void save()}
          >
            {EDIT_BILL.save}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* No "this will cancel your bill" warning any more: it would be untrue. What
            replaces it is a statement of what *is* kept, which the operator needs to
            trust the action. */}
        <p className="text-xs text-slate-600">{EDIT_BILL.whatIsKept}</p>

        {error ? <Panel tone="danger">{error}</Panel> : null}
        {loading ? <Busy label={COMMON.loading} /> : null}

        {invoice ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label={EDIT_BILL.mechanic}
                value={mechanic}
                onChange={(event) => setMechanic(event.target.value)}
              />
              <Field
                label={EDIT_BILL.vehicle}
                value={vehicle}
                onChange={(event) => setVehicle(event.target.value)}
              />
            </div>
            <Field
              label={EDIT_BILL.notes}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />

            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">{EDIT_BILL.itemsCaption}</caption>
              <thead>
                <tr className="border-b border-slate-300 text-left">
                  <th scope="col" className="px-2 py-1">
                    {EDIT_BILL.colItem}
                  </th>
                  <th scope="col" className="px-2 py-1 text-right">
                    {EDIT_BILL.colQuantity}
                  </th>
                  <th scope="col" className="px-2 py-1 text-right">
                    {EDIT_BILL.colPrice}
                  </th>
                  <th scope="col" className="px-1 py-1">
                    <span className="sr-only">{EDIT_BILL.colRemove}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.key} className="border-b border-slate-100">
                    <td className="px-2 py-1">
                      {line.product_name}
                      {line.sku ? (
                        <span className="ml-2 text-xs text-slate-500">{line.sku}</span>
                      ) : null}
                    </td>
                    <td className="px-2 py-1 text-right">
                      <input
                        value={line.quantity}
                        inputMode="decimal"
                        aria-label={EDIT_BILL.quantityLabel(line.product_name)}
                        className="w-20 rounded border border-slate-300 px-2 py-1 text-right"
                        onChange={(event) =>
                          patchLine(line.key, { quantity: event.target.value })
                        }
                      />
                    </td>
                    <td className="px-2 py-1 text-right">
                      <input
                        value={line.unit_price}
                        inputMode="decimal"
                        aria-label={EDIT_BILL.priceLabel(line.product_name)}
                        className="w-24 rounded border border-slate-300 px-2 py-1 text-right"
                        onChange={(event) =>
                          patchLine(line.key, { unit_price: event.target.value })
                        }
                      />
                    </td>
                    <td className="px-1 py-1 text-center">
                      <button
                        type="button"
                        aria-label={EDIT_BILL.removeLabel(line.product_name)}
                        className="px-1 text-slate-500 hover:text-red-700"
                        onClick={() => removeLine(line.key)}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Adding a line. Uses the ordinary catalogue search, so an edit cannot put
                a product on a bill that the counter could not have sold. */}
            <div className="relative">
              <Field
                label={EDIT_BILL.addItem}
                value={term}
                autoComplete="off"
                onChange={(event) => setTerm(event.target.value)}
              />
              {hits.length > 0 ? (
                <ul
                  role="listbox"
                  aria-label={EDIT_BILL.addItem}
                  className="absolute left-0 top-full z-30 max-h-56 w-full divide-y divide-slate-200 overflow-y-auto rounded border border-nas-navy bg-white shadow-lg"
                >
                  {hits.map((product) => (
                    <li key={product.id} role="option" aria-selected={false}>
                      <button
                        type="button"
                        onClick={() => addLine(product)}
                        className="flex w-full justify-between gap-3 px-3 py-2 text-left"
                      >
                        <span>{product.name}</span>
                        <span className="text-xs text-slate-500">
                          {formatForScreen(
                            parseMoney(String(product.default_selling_price)),
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            {/* Advisory, and labelled as such. The server recomputes on save and its
                figure is the one that lands on the bill (OD-7, ADR-032). */}
            <dl className="ml-auto grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-4 text-sm">
              <dt className="text-slate-500">{EDIT_BILL.previewTotal}</dt>
              <dd className="text-right font-semibold">{previewTotal(lines)}</dd>
              <dt className="text-slate-500">{EDIT_BILL.alreadyPaid}</dt>
              <dd className="text-right">
                {formatForScreen(parseMoney(invoice.amount_paid))}
              </dd>
            </dl>

            {/* Said before the operator discovers it as an error: this is the owner's
                paid-total rule, and the way out is a return or a credit note. */}
            {parseMoney(invoice.amount_paid).greaterThan(0) ? (
              <p className="text-xs text-amber-700">
                {EDIT_BILL.paidRule(formatForScreen(parseMoney(invoice.amount_paid)))}
              </p>
            ) : null}

            <Field
              label={EDIT_BILL.reason}
              hint={EDIT_BILL.reasonHint}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

// --- the revision history -----------------------------------------------------

export interface RevisionHistoryProps {
  invoiceId: string;
  /** Bumped by the caller after an edit, to refetch. */
  reloadToken: number;
}

/**
 * Every previous state of one bill (F9's audit requirement, made visible).
 *
 * Read-only by construction as well as by intent: `invoice_revisions` is `SELECT,
 * INSERT` only at the database level, so there is no "edit a revision" path to offer
 * and no risk of this screen implying one.
 */
export function RevisionHistory({ invoiceId, reloadToken }: RevisionHistoryProps) {
  const [items, setItems] = useState<
    Awaited<ReturnType<typeof invoices.revisions>>['items']
  >([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void (async () => {
      try {
        const response = await invoices.revisions(invoiceId);
        if (!cancelled) {
          setItems(response.items);
          setError(null);
        }
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
  }, [invoiceId, reloadToken]);

  return (
    <section className="rounded border border-slate-300 p-3">
      <h4 className="text-sm font-semibold text-slate-700">{EDIT_BILL.historyTitle}</h4>
      <p className="mt-1 text-xs text-slate-500">{EDIT_BILL.historyNote}</p>
      {busy ? <Busy label={COMMON.loading} /> : null}
      {error ? <Panel tone="danger">{error}</Panel> : null}
      {!busy && !error && items.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">{EDIT_BILL.historyEmpty}</p>
      ) : null}
      {items.map((revision) => (
        <article
          key={revision.revision_number}
          className="mt-3 border-t border-slate-200 pt-2 text-sm"
        >
          <header className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium">
              {EDIT_BILL.revisionLabel(revision.revision_number)}
            </span>
            <span className="text-xs text-slate-500">
              {new Date(revision.created_at).toLocaleString()}
              {revision.edited_by ? ` · ${revision.edited_by}` : ''}
            </span>
          </header>
          <p className="text-xs text-slate-600">{revision.reason}</p>
          <dl className="mt-1 flex flex-wrap gap-4 text-xs">
            <span>
              <dt className="inline text-slate-500">{EDIT_BILL.wasTotal}: </dt>
              <dd className="inline">{formatForScreen(parseMoney(revision.total))}</dd>
            </span>
            <span>
              <dt className="inline text-slate-500">{EDIT_BILL.wasPaid}: </dt>
              <dd className="inline">
                {formatForScreen(parseMoney(revision.amount_paid))}
              </dd>
            </span>
          </dl>
          <ul className="mt-1 text-xs text-slate-600">
            {revision.items.map((item) => (
              <li key={`${revision.revision_number}-${item.line_no}`}>
                {item.line_no}. {item.product_name} — {item.quantity} ×{' '}
                {formatForScreen(parseMoney(item.unit_price))} ={' '}
                {formatForScreen(parseMoney(item.line_total))}
              </li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  );
}

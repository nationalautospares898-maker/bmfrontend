/**
 * Editing a Credit Bill through the real Billing Grid (NAS-NEW-02, owner request,
 * 2026-11-14).
 *
 * ## What this replaces, and what it does not touch
 *
 * Credit Bills' own "Edit Bill" used to open `EditBill.tsx` — a plain HTML table in a
 * dialog, shared with Daily Bills. The owner asked specifically for Credit Bills to
 * open the familiar billing grid instead: the same keyboard navigation, product
 * autocomplete and per-cell validation a cashier already knows from creating a new
 * bill. **Daily Bills keeps `EditBill` untouched** — the brief scoped this to Credit
 * Bills, and `EditBill` is still exactly what it was for that screen.
 *
 * ## Why this is not `BillPanel` over a `LocalDraft`
 *
 * `LocalDraft` (`db/schema.ts`) is Dexie-backed, pre-finalisation state: the outbox
 * sync queue, the `maxOpenDrafts` tab limit and `draftStore`'s own finalise-once
 * guards all assume a draft that has never been a real invoice yet. An already-issued
 * credit bill is categorically different — editing it must go through
 * `POST /invoices/{id}:amend`, not `POST /sales:finalize`, and must never be mistaken
 * for a fourteenth open tab. So this component drives `BillGrid` (the actual
 * spreadsheet — keyboard nav, `ItemCell`'s product search, per-row validation; it has
 * no Dexie dependency of its own, only `lines`/`onChangeLine`/`onRemoveLine`/
 * `onAddProduct` props) from a **plain, local** `LocalDraftLine[]` array seeded from
 * `GET /invoices/{id}`, and saves through `amend` exactly as `EditBill.tsx` already
 * does — same `expected_version`, same mandatory `reason`, same idempotency-key
 * discipline, same three refusals (`EDIT_BELOW_PAID_TOTAL`, `INVOICE_VERSION_CONFLICT`,
 * `INSUFFICIENT_STOCK`). No backend change was needed: `amend.py` is already
 * bill-type-agnostic and already diffs stock per product rather than reversing and
 * reapplying the whole line set (see its own module doc).
 *
 * ## What is, and is not, editable
 *
 * `AmendHeaderIn` (`api/v1/invoices.py`) accepts `customer_name` too, but that would
 * only rewrite the **snapshot text** on the bill — it cannot repoint `customer_id` to
 * a different customer, which is the actual identity an outstanding balance is tracked
 * against. Offering a customer-name field that looks editable but cannot change who
 * owes the money would be worse than not offering it, so — matching `EditBill.tsx`'s
 * own existing choice — the customer is shown read-only here. Mechanic, vehicle,
 * phone and notes are genuinely safe to change (they are free-text snapshots with no
 * identity behind them) and are editable, mechanic through the same `MechanicPicker`
 * normal billing uses.
 *
 * ## Oversell, on an edit
 *
 * `AmendRequest.oversell_reason` exists for exactly this: increasing a line's quantity
 * during an edit can oversell a product the same way finalising a new bill can. The
 * checkbox-then-reason flow below is the same UI `BillPanel` already shows after an
 * `INSUFFICIENT_STOCK` refusal on a new bill — one behaviour, reused, not reinvented.
 */

import { useEffect, useRef, useState } from 'react';

import { invoices } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import type { Invoice } from '@/api/types';
import type { LocalDraftLine } from '@/db/schema';
import { uuidv7 } from '@/lib/ids';
import { formatForScreen, parseMoney, previewTotal, tryParseMoney } from '@/lib/money';
import { BILLING, COMMON, CREDIT, EDIT_BILL, ERRORS } from '@/lib/strings';
import { Busy, Button, Field, Panel } from '@/components/primitives';
import { BillGrid } from './BillGrid';
import { lineTotal } from './draftStore';
import { MechanicPicker } from './MechanicPicker';
import type { SearchHit } from './ItemCell';

function toLines(invoice: Invoice): LocalDraftLine[] {
  return invoice.items.map((item) => ({
    id: item.id,
    line_no: item.line_no,
    product_id: item.product_id,
    // The bill's own snapshot, not today's catalogue (the task's own requirement:
    // "Do not load today's catalog values in place of historical bill values").
    product_name: item.product_name_snapshot,
    sku: item.sku_snapshot,
    unit_code: item.unit_code_snapshot,
    quantity: String(item.quantity),
    unit_price: String(item.unit_price),
    catalog_price_at_add: String(item.unit_price),
    price_source: 'manual_override',
    discount_percent: '0.000',
    known_stock: null,
    stock_as_of: null,
  }));
}

export interface EditCreditBillGridProps {
  invoiceId: string;
  online: boolean;
  canOverridePrice: boolean;
  canOverrideOversell: boolean;
  canCreateProduct: boolean;
  onClose: () => void;
  /** Refresh the caller's list: the total, version and outstanding all change. */
  onSaved: () => void;
}

export function EditCreditBillGrid({
  invoiceId,
  online,
  canOverridePrice,
  canOverrideOversell,
  canCreateProduct,
  onClose,
  onSaved,
}: EditCreditBillGridProps) {
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [lines, setLines] = useState<LocalDraftLine[]>([]);
  const [mechanic, setMechanic] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [oversellApproved, setOversellApproved] = useState(false);
  const [oversellReason, setOversellReason] = useState('');

  /** One key per attempt — regenerated only after a success. Same reasoning as
   *  `EditBill.tsx`: a retried click must not write two revisions. */
  const key = useRef(uuidv7());
  const submitting = useRef(false);

  useEffect(() => {
    let dropped = false;
    void (async () => {
      try {
        const detail = await invoices.get(invoiceId);
        if (dropped) return;
        setInvoice(detail);
        setLines(toLines(detail));
        setMechanic(detail.customer.mechanic_name_snapshot ?? '');
        setVehicle(detail.customer.vehicle_number_snapshot ?? '');
        setPhone(detail.customer.phone_snapshot ?? '');
        setNotes(detail.notes ?? '');
      } catch (caught) {
        if (!dropped) {
          setError(
            caught instanceof ApiError
              ? { code: caught.code, message: describeError(caught.code).message }
              : { code: 'UNKNOWN', message: COMMON.retry },
          );
        }
      } finally {
        if (!dropped) setLoading(false);
      }
    })();
    return () => {
      dropped = true;
    };
  }, [invoiceId]);

  function addProduct(hit: SearchHit, _rowIndex: number): void {
    setLines((current) => [
      ...current,
      {
        id: uuidv7(),
        line_no: current.length + 1,
        product_id: hit.productId,
        product_name: hit.name,
        sku: hit.sku,
        unit_code: hit.unitCode,
        quantity: '1.000',
        unit_price: hit.unitPrice,
        catalog_price_at_add: hit.unitPrice,
        price_source: 'catalog',
        discount_percent: '0.000',
        known_stock: hit.stock,
        stock_as_of: hit.stockAsOf,
      },
    ]);
  }

  function changeLine(lineId: string, patch: Partial<LocalDraftLine>): void {
    setLines((current) =>
      current.map((line) => (line.id === lineId ? { ...line, ...patch } : line)),
    );
  }

  function removeLine(lineId: string): void {
    setLines((current) => current.filter((line) => line.id !== lineId));
  }

  async function save(): Promise<void> {
    if (!invoice) return;
    // Optional (owner correction, 2026-11-14): a blank reason saves the edit with none
    // recorded, rather than being refused. A reason that *is* typed still has to say
    // something — one or two characters is rejected the same way the server rejects it.
    if (reason.trim().length > 0 && reason.trim().length < 5) {
      setError({ code: 'VALIDATION', message: EDIT_BILL.reasonTooShort });
      return;
    }
    if (lines.length === 0) {
      setError({ code: 'VALIDATION', message: EDIT_BILL.needLines });
      return;
    }
    for (const line of lines) {
      if (tryParseMoney(line.quantity) === null || parseMoney(line.quantity).lte(0)) {
        setError({
          code: 'VALIDATION',
          message: EDIT_BILL.badQuantity(line.product_name),
        });
        return;
      }
      if (tryParseMoney(line.unit_price) === null) {
        setError({ code: 'VALIDATION', message: EDIT_BILL.badPrice(line.product_name) });
        return;
      }
    }
    if (oversellApproved && (!canOverrideOversell || oversellReason.trim().length < 10)) {
      return;
    }

    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await invoices.amend(
        invoice.id,
        {
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
            phone: phone.trim() || null,
            notes: notes.trim() || null,
          },
          ...(canOverrideOversell && oversellApproved
            ? { oversell_reason: oversellReason.trim() }
            : {}),
        },
        key.current,
      );
      key.current = uuidv7();
      onSaved();
      onClose();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError({ code: caught.code, message: describeError(caught.code).message });
      } else {
        setError({ code: 'UNKNOWN', message: ERRORS.unexpected });
      }
    } finally {
      submitting.current = false;
      setBusy(false);
      setOversellApproved(false);
      setOversellReason('');
    }
  }

  const total = previewTotal(lines.map(lineTotal));

  return (
    // Plain `flex flex-col`, deliberately not `min-h-0 flex-1`: `BillGrid` wants a
    // *content-driven* minimum height (its own doc: "fifteen rows always visible"),
    // not a share of a `flex-1` parent's box. Inside the three-bill workspace that
    // sizing comes from a `h-dvh`-rooted ancestor chain built for exactly one fixed
    // viewport; this screen is a single one-off edit, not that workspace, and asking
    // for the same `flex-1` squeeze here left the grid's own rows overflowing a box
    // shorter than their content — the totals, the reason field and the Save button
    // rendered at the height a near-zero-height flex child left for them, with the
    // grid's actual rows drawn over them instead of above. Letting this take its
    // natural height and scroll with `<main>` (which already does) is what's correct
    // for this one page's shape.
    <div className="flex flex-col gap-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold text-[#232852]">
          {EDIT_BILL.title}
          {invoice ? ` — ${invoice.internal_reference}` : ''}
        </h1>
        <Button variant="quiet" onClick={onClose}>
          {EDIT_BILL.discard}
        </Button>
      </header>

      <p className="text-xs text-slate-600">{EDIT_BILL.whatIsKept}</p>

      {error ? <Panel tone="danger">{error.message}</Panel> : null}
      {loading ? <Busy label={COMMON.loading} /> : null}

      {invoice ? (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="Customer"
              value={
                invoice.customer.name_snapshot ??
                invoice.customer.business_name_snapshot ??
                ''
              }
              readOnly
              disabled
              hint="Who owes this bill cannot be changed here."
            />
            <MechanicPicker
              value={mechanic}
              onChange={setMechanic}
              onDone={() => undefined}
              resetKey={invoice.id}
            />
            <Field
              label="Vehicle Number"
              value={vehicle}
              onChange={(e) => setVehicle(e.target.value)}
            />
            <Field
              label="Phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <Field label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />

          <div>
            <BillGrid
              billId={invoice.id}
              lines={lines}
              readOnly={false}
              online={online}
              canOverridePrice={canOverridePrice}
              canCreateProduct={canCreateProduct}
              onAddProduct={addProduct}
              onChangeLine={changeLine}
              onRemoveLine={removeLine}
              hints={false}
            />
          </div>

          <dl className="ml-auto grid w-full max-w-xs grid-cols-[1fr_auto] gap-x-4 text-sm">
            <dt className="text-slate-500">{EDIT_BILL.previewTotal}</dt>
            <dd className="text-right font-semibold">{formatForScreen(total)}</dd>
            <dt className="text-slate-500">{EDIT_BILL.alreadyPaid}</dt>
            <dd className="text-right">
              {formatForScreen(parseMoney(invoice.amount_paid))}
            </dd>
            <dt className="text-slate-500">{CREDIT.outstandingLabel}</dt>
            <dd className="text-right">
              {formatForScreen(parseMoney(invoice.outstanding))}
            </dd>
          </dl>

          {parseMoney(invoice.amount_paid).greaterThan(0) ? (
            <p className="text-xs text-amber-700">
              {EDIT_BILL.paidRule(formatForScreen(parseMoney(invoice.amount_paid)))}
            </p>
          ) : null}

          {error?.code === 'INSUFFICIENT_STOCK' && canOverrideOversell ? (
            <div className="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 p-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={oversellApproved}
                  onChange={(e) => {
                    setOversellApproved(e.target.checked);
                    if (!e.target.checked) setOversellReason('');
                  }}
                />
                <span>{BILLING.oversellApprovalLabel}</span>
              </label>
              {oversellApproved ? (
                <>
                  <p className="text-sm">{BILLING.oversellApprovalWarning}</p>
                  <Field
                    label={BILLING.oversellReasonLabel}
                    value={oversellReason}
                    onChange={(e) => setOversellReason(e.target.value)}
                  />
                  <p className="text-xs text-slate-700">
                    {oversellReason.trim().length < 10
                      ? BILLING.oversellReasonRequired
                      : BILLING.oversellRetryHint}
                  </p>
                </>
              ) : null}
            </div>
          ) : null}

          <Field
            label={EDIT_BILL.reason}
            hint={EDIT_BILL.reasonHintOptional}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />

          <div className="flex gap-2">
            <Button variant="quiet" onClick={onClose}>
              {EDIT_BILL.discard}
            </Button>
            <Button variant="primary" busy={busy} onClick={() => void save()}>
              {EDIT_BILL.save}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

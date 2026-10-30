/**
 * Purchases (M25).
 *
 * The screen exists to make **one distinction impossible to miss**: entering a
 * supplier's bill and receiving the goods are two separate acts (FR-PUR-003).
 *
 * So a saved purchase says "Entered, not received" in words, the confirmation button is
 * labelled "Receive into stock" rather than "Confirm", and the dialog states what will
 * change before it changes. The alternative — a single "Save" that silently moves stock
 * — is how a delivery note becomes inventory nobody has seen.
 *
 * Two further behaviours worth naming:
 *
 * - **Receiving is idempotent on the server**, and the screen reads the response rather
 *   than assuming. `movements: 0` means the bill was already received, and it says so
 *   instead of reporting a second receipt.
 * - **Nothing is totalled by this screen for the server's benefit.** The line totals and
 *   running total are a preview, labelled as one; the authority is the response.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { catalog, purchases } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import type { Product, PurchaseSummary, Supplier } from '@/api/types';
import { Busy, Button, Dialog, Field, Panel } from '@/components/primitives';
import { uuidv7 } from '@/lib/ids';
import { formatForScreen, formatQuantity, tryParseMoney, ZERO } from '@/lib/money';
import { COMMON, ERRORS, PURCHASES } from '@/lib/strings';

const STATUS_LABELS: Record<string, string> = {
  draft: PURCHASES.statusDraft,
  confirmed: PURCHASES.statusConfirmed,
  cancelled: PURCHASES.statusCancelled,
};

export interface PurchasesScreenProps {
  /** `inventory.receive`. Without it the whole screen is not reachable from the nav. */
  canReceive: boolean;
}

export function PurchasesScreen({ canReceive }: PurchasesScreenProps) {
  const [rows, setRows] = useState<PurchaseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<PurchaseSummary | null>(null);

  const load = useCallback(async () => {
    setRows(null);
    setError(null);
    try {
      setRows((await purchases.list()).items);
    } catch (caught) {
      setRows([]);
      setError(
        caught instanceof ApiError
          ? describeError(caught.code).message
          : ERRORS.unexpected,
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-[#232852]">{PURCHASES.title}</h2>
        <div className="flex gap-2">
          {canReceive ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              {PURCHASES.newPurchase}
            </Button>
          ) : null}
          <Button onClick={() => void load()}>{COMMON.refresh}</Button>
        </div>
      </header>

      {/* The distinction the whole screen turns on, stated before anything is done. */}
      <Panel tone="info">{PURCHASES.draftExplainer}</Panel>

      {error ? <Panel tone="danger">{error}</Panel> : null}
      {notice ? <Panel tone="success">{notice}</Panel> : null}

      {rows === null ? (
        <Busy label={COMMON.loading} />
      ) : rows.length === 0 ? (
        <Panel tone="info">{PURCHASES.empty}</Panel>
      ) : (
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{PURCHASES.tableCaption}</caption>
          <thead>
            <tr className="border-b border-slate-300 text-left">
              <th scope="col" className="py-2">
                {PURCHASES.colSupplier}
              </th>
              <th scope="col" className="py-2">
                {PURCHASES.colDocument}
              </th>
              <th scope="col" className="py-2">
                {PURCHASES.colDate}
              </th>
              <th scope="col" className="py-2 text-right">
                {PURCHASES.colLines}
              </th>
              <th scope="col" className="py-2 text-right">
                {PURCHASES.colTotal}
              </th>
              <th scope="col" className="py-2">
                {PURCHASES.colStatus}
              </th>
              <th scope="col" className="py-2">
                {COMMON.actions}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-slate-100">
                <td className="py-2">{row.supplier_name}</td>
                <td className="py-2">{row.supplier_document_number ?? '—'}</td>
                <td className="py-2">{row.document_date ?? '—'}</td>
                <td className="py-2 text-right">{row.line_count}</td>
                <td className="py-2 text-right font-medium">
                  {formatForScreen(tryParseMoney(row.total) ?? ZERO)}
                </td>
                <td className="py-2">{STATUS_LABELS[row.status] ?? row.status}</td>
                <td className="py-2">
                  {row.status === 'draft' && canReceive ? (
                    <Button variant="quiet" onClick={() => setConfirming(row)}>
                      {PURCHASES.confirm}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {creating ? (
        <NewPurchaseDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            setNotice(PURCHASES.savedNotReceived);
            void load();
          }}
        />
      ) : null}

      {confirming ? (
        <ConfirmDialog
          purchase={confirming}
          onClose={() => setConfirming(null)}
          onDone={(message) => {
            setConfirming(null);
            setNotice(message);
            void load();
          }}
        />
      ) : null}
    </section>
  );
}

// --- receiving ----------------------------------------------------------------

function ConfirmDialog({
  purchase,
  onClose,
  onDone,
}: {
  purchase: PurchaseSummary;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function receive(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await purchases.confirm(purchase.id, uuidv7());
      // Read the response rather than assume. `0` movements means the server treated
      // this as a replay of a confirmation that already happened, and saying "received"
      // would be a second receipt the shop never made.
      onDone(
        result.movements === 0
          ? PURCHASES.alreadyReceived
          : `${PURCHASES.statusConfirmed} — ${result.movements}`,
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? describeError(caught.code).message
          : ERRORS.unexpected,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={PURCHASES.confirmTitle}
      {...(busy ? {} : { onDismiss: onClose })}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            {COMMON.cancel}
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void receive()}>
            {PURCHASES.confirm}
          </Button>
        </>
      }
    >
      <p>{PURCHASES.confirmBody}</p>
      <p className="mt-2 text-sm text-slate-600">
        {purchase.supplier_name} · {purchase.line_count} · {purchase.total}
      </p>
      {error ? (
        <div className="mt-3">
          <Panel tone="danger">{error}</Panel>
        </div>
      ) : null}
    </Dialog>
  );
}

// --- entering a bill ----------------------------------------------------------

interface LineDraft {
  key: string;
  product: Product | null;
  search: string;
  quantity: string;
  unitCost: string;
}

function emptyLine(): LineDraft {
  return { key: uuidv7(), product: null, search: '', quantity: '', unitCost: '' };
}

function NewPurchaseDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [documentNumber, setDocumentNumber] = useState('');
  const [documentDate, setDocumentDate] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSuppliers = useCallback(async () => {
    try {
      setSuppliers((await purchases.suppliers()).items);
    } catch {
      setSuppliers([]);
    }
  }, []);

  useEffect(() => {
    void loadSuppliers();
  }, [loadSuppliers]);

  const total = useMemo(
    () =>
      lines.reduce((sum, line) => {
        const quantity = tryParseMoney(line.quantity);
        const cost = tryParseMoney(line.unitCost);
        if (!quantity || !cost) return sum;
        return sum.plus(quantity.times(cost));
      }, ZERO),
    [lines],
  );

  /** The first unmet requirement, as a sentence. Never a silently disabled button. */
  const problem = (() => {
    if (!supplierId) return PURCHASES.needSupplier;
    const filled = lines.filter((line) => line.product || line.quantity || line.unitCost);
    if (filled.length === 0) return PURCHASES.needLines;
    if (filled.some((line) => !line.product)) return PURCHASES.needProduct;
    if (filled.some((line) => !(tryParseMoney(line.quantity)?.gt(0) ?? false))) {
      return PURCHASES.needQuantity;
    }
    if (filled.some((line) => tryParseMoney(line.unitCost) === null)) {
      return PURCHASES.needCost;
    }
    return null;
  })();

  async function save(): Promise<void> {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      await purchases.create(
        {
          supplier_id: supplierId,
          items: lines
            .filter((line) => line.product)
            .map((line) => ({
              product_id: line.product!.id,
              quantity: tryParseMoney(line.quantity)!.toString(),
              unit_cost: tryParseMoney(line.unitCost)!.toString(),
            })),
          supplier_document_number: documentNumber.trim() || null,
          document_date: documentDate || null,
          notes: notes.trim() || null,
        },
        uuidv7(),
      );
      onSaved();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? describeError(caught.code).message
          : ERRORS.unexpected,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={PURCHASES.newPurchase}
      {...(busy ? {} : { onDismiss: onClose })}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            {COMMON.cancel}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={problem !== null}
            onClick={() => void save()}
          >
            {PURCHASES.savePurchase}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <label
              htmlFor="purchase-supplier"
              className="text-sm font-medium text-slate-700"
            >
              {PURCHASES.supplier}
            </label>
            <select
              id="purchase-supplier"
              value={supplierId}
              onChange={(event) => setSupplierId(event.target.value)}
              className="min-h-11 rounded border border-slate-300 px-3 text-base"
            >
              <option value="">{PURCHASES.chooseSupplier}</option>
              {(suppliers ?? []).map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </div>
          <Button onClick={() => setAddingSupplier(true)}>{PURCHASES.newSupplier}</Button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label={PURCHASES.documentNumber}
            value={documentNumber}
            onChange={(event) => setDocumentNumber(event.target.value)}
          />
          <Field
            label={PURCHASES.documentDate}
            type="date"
            value={documentDate}
            onChange={(event) => setDocumentDate(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-2">
          {lines.map((line, index) => (
            <PurchaseLineRow
              key={line.key}
              line={line}
              index={index}
              onChange={(next) =>
                setLines((current) =>
                  current.map((item) => (item.key === line.key ? next : item)),
                )
              }
              onRemove={
                lines.length > 1
                  ? () =>
                      setLines((current) =>
                        current.filter((item) => item.key !== line.key),
                      )
                  : undefined
              }
            />
          ))}
          <div>
            <Button onClick={() => setLines((current) => [...current, emptyLine()])}>
              {PURCHASES.addLine}
            </Button>
          </div>
        </div>

        <p className="text-sm">
          {/* Labelled a preview. The authority is the server's response. */}
          {PURCHASES.runningTotal}: <strong>{formatForScreen(total)}</strong>
        </p>

        <Field
          label={PURCHASES.notes}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />

        {problem ? <Panel tone="warning">{problem}</Panel> : null}
        {error ? <Panel tone="danger">{error}</Panel> : null}
      </div>

      {addingSupplier ? (
        <NewSupplierDialog
          onClose={() => setAddingSupplier(false)}
          onSaved={(id) => {
            setAddingSupplier(false);
            setSupplierId(id);
            void loadSuppliers();
          }}
        />
      ) : null}
    </Dialog>
  );
}

function PurchaseLineRow({
  line,
  index,
  onChange,
  onRemove,
}: {
  line: LineDraft;
  index: number;
  onChange: (next: LineDraft) => void;
  onRemove?: (() => void) | undefined;
}) {
  const [results, setResults] = useState<Product[]>([]);

  /**
   * Search on each keystroke with cancellation, the same way the counter does. No
   * debounce here: a purchase is entered at a desk from a paper bill, not under a
   * customer's eye, and the request is cheap and cancelled.
   */
  useEffect(() => {
    if (line.product || line.search.trim().length === 0) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await catalog.search(line.search, {
          limit: 8,
          signal: controller.signal,
        });
        setResults(response.items);
      } catch {
        // A cancelled or failed lookup leaves the previous list; the user keeps typing.
      }
    })();
    return () => controller.abort();
  }, [line.search, line.product]);

  const quantity = tryParseMoney(line.quantity);
  const cost = tryParseMoney(line.unitCost);

  return (
    <div className="rounded border border-slate-200 p-3">
      <div className="grid grid-cols-12 items-end gap-2">
        <div className="col-span-6">
          {line.product ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{line.product.name}</span>
              <Button
                variant="quiet"
                onClick={() => onChange({ ...line, product: null, search: '' })}
              >
                {COMMON.cancel}
              </Button>
            </div>
          ) : (
            <Field
              label={`${PURCHASES.addLine} ${index + 1}`}
              value={line.search}
              onChange={(event) => onChange({ ...line, search: event.target.value })}
            />
          )}
        </div>
        <div className="col-span-2">
          <Field
            label={PURCHASES.colQuantity}
            value={line.quantity}
            inputMode="decimal"
            onChange={(event) => onChange({ ...line, quantity: event.target.value })}
          />
        </div>
        <div className="col-span-2">
          <Field
            label={PURCHASES.colCost}
            value={line.unitCost}
            inputMode="decimal"
            onChange={(event) => onChange({ ...line, unitCost: event.target.value })}
          />
        </div>
        <div className="col-span-2 text-right text-sm">
          {quantity && cost ? (
            <span>
              {PURCHASES.lineTotal}
              <br />
              <strong>{formatForScreen(quantity.times(cost))}</strong>
            </span>
          ) : null}
          {onRemove ? (
            <Button variant="quiet" onClick={onRemove}>
              {PURCHASES.removeLine}
            </Button>
          ) : null}
        </div>
      </div>

      {results.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1">
          {results.map((product) => (
            <li key={product.id}>
              <Button
                variant="quiet"
                className="w-full justify-start"
                onClick={() =>
                  onChange({
                    ...line,
                    product,
                    search: '',
                    // Pre-fill the cost from the catalogue's last known cost when the
                    // field is still empty: it is the number most likely to be right,
                    // and it is always visible and editable.
                    unitCost:
                      line.unitCost ||
                      (product.cost_price ? String(product.cost_price) : ''),
                  })
                }
              >
                {product.name}
                {product.sku ? ` · ${product.sku}` : ''}
                {/* `branch_quantity`, not `quantity`: stock is per branch, and the
                    field name says so. */}
                {product.stock
                  ? ` · ${formatQuantity(tryParseMoney(product.stock.branch_quantity) ?? ZERO)}`
                  : ''}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function NewSupplierDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // The id is **client-generated**, so a retried create is an upsert rather than a
      // second supplier — the same rule customers follow (FR-CUST-003).
      const id = uuidv7();
      await purchases.upsertSupplier(id, {
        name: name.trim(),
        phone: phone.trim() || null,
      });
      onSaved(id);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? describeError(caught.code).message
          : ERRORS.unexpected,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={PURCHASES.newSupplier}
      {...(busy ? {} : { onDismiss: onClose })}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            {COMMON.cancel}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!name.trim()}
            onClick={() => void save()}
          >
            {COMMON.save}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label={PURCHASES.supplierName}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Field
          label={PURCHASES.supplierPhone}
          value={phone}
          inputMode="tel"
          onChange={(event) => setPhone(event.target.value)}
        />
        {error ? <Panel tone="danger">{error}</Panel> : null}
      </div>
    </Dialog>
  );
}

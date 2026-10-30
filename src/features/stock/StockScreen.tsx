/**
 * Stock management (M25).
 *
 * The screen a shopkeeper opens to answer one of three questions: what do I have, what
 * is running out, and why is this number what it is. So it is a list, a low-stock
 * filter, and a movement history — nothing else.
 *
 * **There is no way to set a quantity here, by design.** FR-INV-002 makes the ledger the
 * only writer and every change a reasoned movement, so the control is "Adjust", it asks
 * for a signed change and a reason, and it refuses an empty reason. A screen with a
 * quantity box would let someone type over a discrepancy instead of recording it, and
 * the discrepancy is the thing worth keeping.
 *
 * The adjustment dialog also shows the resulting balance before committing, because
 * "decrease by 3" and "set to 3" are easy to confuse and only one of them is on offer.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { inventory } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import type { StockBalance, StockMovement } from '@/api/types';
import { Busy, Button, Dialog, Field, Panel } from '@/components/primitives';
import { uuidv7 } from '@/lib/ids';
import { formatQuantity, parseMoney, tryParseMoney } from '@/lib/money';
import { normalizeName, normalizeSku } from '@/lib/normalize';
import { COMMON, ERRORS, STOCK } from '@/lib/strings';

/** Adjustment reasons, matching the server's closed set (`MovementReason`). */
const REASONS = [
  { code: 'adjustment_decrease', label: STOCK.reasonDecrease },
  { code: 'adjustment_increase', label: STOCK.reasonIncrease },
  { code: 'scrap', label: STOCK.reasonScrap },
] as const;

/** How a movement's reason reads to a shopkeeper. */
const MOVEMENT_LABELS: Record<string, string> = {
  opening: 'Opening stock',
  purchase_receipt: 'Received from supplier',
  sale: 'Sold',
  sale_cancellation: 'Bill cancelled',
  customer_return: 'Customer returned',
  supplier_return: 'Returned to supplier',
  adjustment_increase: 'Correction (increase)',
  adjustment_decrease: 'Correction (decrease)',
  transfer_out: 'Sent to another branch',
  transfer_in: 'Received from another branch',
  import_apply: 'Applied from an import',
  scrap: 'Scrapped',
};

export interface StockScreenProps {
  /** `inventory.adjust` is gated on `inventory.adjust`; without it the button is absent. */
  canAdjust: boolean;
}

export function StockScreen({ canAdjust }: StockScreenProps) {
  const [rows, setRows] = useState<StockBalance[] | null>(null);
  const [lowOnly, setLowOnly] = useState(false);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<StockBalance | null>(null);
  const [adjusting, setAdjusting] = useState<StockBalance | null>(null);

  const load = useCallback(async () => {
    setRows(null);
    setError(null);
    try {
      const response = await inventory.balances({ low_stock_only: lowOnly });
      setRows(response.items);
    } catch (caught) {
      setRows([]);
      setError(
        caught instanceof ApiError
          ? describeError(caught.code).message
          : ERRORS.unexpected,
      );
    }
  }, [lowOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Filtering happens on the rows already fetched, using the **same normalisation as
   * search** — so `tt407` finds `TT-407-BS` here exactly as it does at the counter. A
   * cashier should not have to learn that this box behaves differently.
   */
  const visible = useMemo(() => {
    if (!rows) return null;
    const sku = normalizeSku(filter);
    const name = normalizeName(filter);
    if (!sku && !name) return rows;
    return rows.filter(
      (row) =>
        normalizeName(row.name).includes(name) || normalizeSku(row.name).includes(sku),
    );
  }, [rows, filter]);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-semibold text-[#232852]">{STOCK.title}</h2>
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label={STOCK.filterLabel}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            hint={STOCK.filterHint}
            className="w-64"
          />
          <Button
            variant={lowOnly ? 'primary' : 'secondary'}
            aria-pressed={lowOnly}
            onClick={() => setLowOnly((value) => !value)}
          >
            {STOCK.lowStockOnly}
          </Button>
          <Button onClick={() => void load()}>{COMMON.refresh}</Button>
        </div>
      </header>

      {error ? <Panel tone="danger">{error}</Panel> : null}

      {visible === null ? (
        <Busy label={COMMON.loading} />
      ) : visible.length === 0 ? (
        // An empty list is never a blank screen: it says which of the two reasons it is.
        <Panel tone="info">
          {rows && rows.length === 0
            ? lowOnly
              ? STOCK.emptyNoLowStock
              : STOCK.emptyNoStock
            : STOCK.emptyNoMatch}
        </Panel>
      ) : (
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{STOCK.tableCaption}</caption>
          <thead>
            <tr className="border-b border-slate-300 text-left">
              <th scope="col" className="py-2">
                {STOCK.colItem}
              </th>
              <th scope="col" className="py-2 text-right">
                {STOCK.colQuantity}
              </th>
              <th scope="col" className="py-2 text-right">
                {STOCK.colReorder}
              </th>
              <th scope="col" className="py-2">
                {COMMON.actions}
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const quantity = parseMoney(row.quantity);
              const reorder = row.reorder_level ? parseMoney(row.reorder_level) : null;
              // Low stock is `quantity <= reorder_level`, and only when a reorder level
              // exists. A missing level is not a level of zero.
              const low = reorder !== null && quantity.lte(reorder);
              return (
                <tr key={row.product_id} className="border-b border-slate-100">
                  <td className="py-2">{row.name}</td>
                  <td className="py-2 text-right font-medium">
                    {formatQuantity(quantity)}
                    {low ? (
                      // Words, not just a colour (NFR-FE-UX-007).
                      <span className="ml-2 rounded bg-amber-100 px-1 text-xs text-amber-900">
                        {STOCK.lowBadge}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 text-right text-slate-600">
                    {reorder === null ? STOCK.noReorderLevel : formatQuantity(reorder)}
                  </td>
                  <td className="py-2">
                    <div className="flex gap-2">
                      <Button variant="quiet" onClick={() => setSelected(row)}>
                        {STOCK.viewHistory}
                      </Button>
                      {canAdjust ? (
                        <Button variant="quiet" onClick={() => setAdjusting(row)}>
                          {STOCK.adjust}
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {selected ? (
        <MovementHistory product={selected} onClose={() => setSelected(null)} />
      ) : null}

      {adjusting ? (
        <AdjustDialog
          product={adjusting}
          onClose={() => setAdjusting(null)}
          onDone={() => {
            setAdjusting(null);
            void load();
          }}
        />
      ) : null}
    </section>
  );
}

// --- movement history ---------------------------------------------------------

function MovementHistory({
  product,
  onClose,
}: {
  product: StockBalance;
  onClose: () => void;
}) {
  const [movements, setMovements] = useState<StockMovement[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await inventory.movements({ product_id: product.product_id });
        if (!cancelled) setMovements(response.items);
      } catch (caught) {
        if (!cancelled) {
          setMovements([]);
          setError(
            caught instanceof ApiError
              ? describeError(caught.code).message
              : ERRORS.unexpected,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [product.product_id]);

  return (
    <Dialog
      open
      title={`${STOCK.historyTitle} — ${product.name}`}
      onDismiss={onClose}
      actions={<Button onClick={onClose}>{COMMON.close}</Button>}
    >
      {error ? <Panel tone="danger">{error}</Panel> : null}
      {movements === null ? (
        <Busy label={COMMON.loading} />
      ) : movements.length === 0 ? (
        <p>{STOCK.emptyNoMovements}</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{STOCK.historyCaption}</caption>
          <thead>
            <tr className="border-b border-slate-300 text-left">
              <th scope="col" className="py-1">
                {STOCK.colWhen}
              </th>
              <th scope="col" className="py-1">
                {STOCK.colWhy}
              </th>
              <th scope="col" className="py-1 text-right">
                {STOCK.colChange}
              </th>
              <th scope="col" className="py-1 text-right">
                {STOCK.colAfter}
              </th>
            </tr>
          </thead>
          <tbody>
            {movements.map((movement) => {
              const delta = parseMoney(movement.quantity_delta);
              return (
                <tr key={movement.id} className="border-b border-slate-100">
                  <td className="py-1">
                    {new Date(movement.created_at).toLocaleString()}
                  </td>
                  <td className="py-1">
                    {MOVEMENT_LABELS[movement.reason] ?? movement.reason}
                    {movement.oversell_override ? (
                      <span className="ml-1 text-xs text-amber-900">
                        {STOCK.wasOversold}
                      </span>
                    ) : null}
                    {movement.override_reason ? (
                      <div className="text-xs text-slate-500">
                        {movement.override_reason}
                      </div>
                    ) : null}
                  </td>
                  <td className="py-1 text-right">
                    {/* The sign is the information. `+` is added explicitly because a
                        bare number reads as a quantity, not as a change. */}
                    {delta.isNegative() ? '' : '+'}
                    {formatQuantity(delta)}
                  </td>
                  <td className="py-1 text-right text-slate-600">
                    {formatQuantity(parseMoney(movement.balance_after))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}

// --- adjustment ---------------------------------------------------------------

function AdjustDialog({
  product,
  onClose,
  onDone,
}: {
  product: StockBalance;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reasonCode, setReasonCode] = useState<string>(REASONS[0].code);
  const [amount, setAmount] = useState('');
  const [reasonText, setReasonText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = parseMoney(product.quantity);
  const parsed = amount.trim() === '' ? null : tryParseMoney(amount);
  const increases = reasonCode === 'adjustment_increase';
  const resulting =
    parsed === null ? null : increases ? current.plus(parsed) : current.minus(parsed);

  // Refusals, each with its own message. A disabled button with no explanation is the
  // thing this avoids.
  const problem =
    parsed === null
      ? null
      : parsed.lte(0)
        ? STOCK.amountMustBePositive
        : reasonText.trim().length < 3
          ? STOCK.reasonRequired
          : resulting !== null && resulting.isNegative()
            ? STOCK.wouldGoNegative
            : null;

  async function submit(): Promise<void> {
    if (parsed === null || problem) return;
    setBusy(true);
    setError(null);
    try {
      await inventory.adjust(
        {
          product_id: product.product_id,
          // The server takes a **signed** delta; the sign comes from the chosen reason,
          // so the two can never disagree.
          quantity_delta: increases ? parsed.toString() : parsed.negated().toString(),
          reason_code: reasonCode,
          reason_text: reasonText.trim(),
        },
        // Persisted-key discipline is not needed here: an adjustment is not a sale and
        // the server's key requirement already makes a retry safe.
        uuidv7(),
      );
      onDone();
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
      title={`${STOCK.adjustTitle} — ${product.name}`}
      {...(busy ? {} : { onDismiss: onClose })}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            {COMMON.cancel}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={parsed === null || problem !== null}
            onClick={() => void submit()}
          >
            {STOCK.recordAdjustment}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          {STOCK.currentQuantity}: <strong>{formatQuantity(current)}</strong>
        </p>

        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium text-slate-700">
            {STOCK.whatHappened}
          </legend>
          {REASONS.map((reason) => (
            <label key={reason.code} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="reason-code"
                value={reason.code}
                checked={reasonCode === reason.code}
                onChange={() => setReasonCode(reason.code)}
                className="h-4 w-4"
              />
              {reason.label}
            </label>
          ))}
        </fieldset>

        <Field
          label={STOCK.howMany}
          value={amount}
          inputMode="decimal"
          onChange={(event) => setAmount(event.target.value)}
          hint={STOCK.howManyHint}
        />

        <Field
          label={STOCK.why}
          value={reasonText}
          onChange={(event) => setReasonText(event.target.value)}
          hint={STOCK.whyHint}
        />

        {resulting !== null && !problem ? (
          // Shown before committing, because "decrease by 3" and "set to 3" are easy to
          // confuse and only one of them is on offer.
          <p className="text-sm">
            {STOCK.afterThis}: <strong>{formatQuantity(resulting)}</strong>
          </p>
        ) : null}

        {problem ? <Panel tone="warning">{problem}</Panel> : null}
        {error ? <Panel tone="danger">{error}</Panel> : null}
      </div>
    </Dialog>
  );
}

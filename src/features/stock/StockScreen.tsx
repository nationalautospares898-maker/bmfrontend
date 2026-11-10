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
import { COMMON, ERRORS, STOCK, STOCK_COUNT } from '@/lib/strings';
import { isLow } from './lowStock';
import { MovementReport } from './MovementReport';
import { StockCountScreen } from './StockCountScreen';
import { StockSheet } from './StockSheet';

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

/**
 * How a movement reads once its source is taken into account.
 *
 * `adjustment_increase` is two different events to a shopkeeper. Written by the stock
 * sheet it means *goods arrived*; written by the Adjust dialog it means *somebody
 * corrected the figure*. The ledger reason is deliberately the same — the sheet has no
 * supplier document, so claiming `purchase_receipt` would put an orphan receipt in the
 * purchase ledger — and `source_type` is what tells them apart.
 */
function movementLabel(movement: StockMovement): string {
  if (movement.source_type === 'stock_entry') {
    return movement.reason === 'opening' ? 'Opening stock' : 'Stock received';
  }
  return MOVEMENT_LABELS[movement.reason] ?? movement.reason;
}

export interface StockScreenProps {
  /** `inventory.adjust`; without it the Adjust button is absent. */
  canAdjust: boolean;
  /**
   * `catalog.write` **and** `inventory.adjust` — the sheet creates or updates a product
   * and moves stock. The server re-asserts both in `StockEntryService`; this only
   * decides whether `Add Items` is worth showing.
   */
  canAddStock: boolean;
  /**
   * Today, in the **business's** timezone, straight from `/sync/bootstrap`.
   *
   * Passed in rather than derived here: a counter PC set to UTC would make
   * `new Date()` yesterday for the first five and a half hours of every `Asia/Kolkata`
   * day, and the report would open on the wrong one (FE-E-3).
   */
  businessDate: string;
}

export function StockScreen({ canAdjust, canAddStock, businessDate }: StockScreenProps) {
  const [rows, setRows] = useState<StockBalance[] | null>(null);
  const [lowOnly, setLowOnly] = useState(false);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<StockBalance | null>(null);
  const [adjusting, setAdjusting] = useState<StockBalance | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [stockCountOpen, setStockCountOpen] = useState(false);
  /**
   * The product currently mid-flight on a `+`/`−` click (owner request, 2026-11-10).
   *
   * Keyed by `product_id` rather than a boolean so one row's click cannot disable every
   * other row, and checked before sending so a second click on the same row while the
   * first is still in flight cannot fire a duplicate adjustment (the server's
   * idempotency key would make a true retry safe, but a double-click here is two
   * *different* adjustments of +1 each, which the key does not and should not collapse).
   */
  const [quickAdjustingId, setQuickAdjustingId] = useState<string | null>(null);
  const [quickAdjustError, setQuickAdjustError] = useState<string | null>(null);

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
   * The inline `[ − ] qty [ + ]` control (owner request, 2026-11-10): a one-unit
   * correction with no popup, no reason prompt and no confirmation, for the everyday
   * case of nudging a count up or down. It still goes through
   * `POST /inventory/adjustments` — the one writer of the ledger (FR-INV-002) — with a
   * fixed, honest reason text, so the movement is exactly as audited as one made
   * through the Adjust dialog. A bigger or unusual change still belongs in that dialog,
   * which remains for anyone who wants to state why.
   */
  async function quickAdjust(row: StockBalance, direction: 1 | -1): Promise<void> {
    if (quickAdjustingId !== null) return;
    setQuickAdjustingId(row.product_id);
    setQuickAdjustError(null);
    try {
      await inventory.adjust(
        {
          product_id: row.product_id,
          quantity_delta: direction === 1 ? '1' : '-1',
          reason_code: direction === 1 ? 'adjustment_increase' : 'adjustment_decrease',
          reason_text: STOCK.quickAdjustReason,
        },
        uuidv7(),
      );
      await load();
    } catch (caught) {
      setQuickAdjustError(
        caught instanceof ApiError
          ? describeError(caught.code).message
          : ERRORS.unexpected,
      );
    } finally {
      setQuickAdjustingId(null);
    }
  }

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
          {/* The owner's entry point. Primary, and first, because adding stock is what
              this screen is opened to do. */}
          {canAddStock ? (
            <Button
              variant="primary"
              onClick={() => {
                // The previous delivery's confirmation is cleared on the way in. Left
                // standing it becomes a lie the moment a second sheet is opened —
                // "Saved 1 item" sitting above a sheet that has saved nothing yet — and
                // a stale success message is worse than none, because it is the thing a
                // user checks to know whether their work landed.
                setSaved(null);
                setSheetOpen(true);
              }}
            >
              {STOCK.addItems}
            </Button>
          ) : null}
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
          {/* The day's report, alongside the per-product History the table already
              offers — a second question about the same ledger, not a replacement for
              the first. */}
          <Button
            aria-expanded={reportOpen}
            onClick={() => setReportOpen((open) => !open)}
          >
            {STOCK.reportAction}
          </Button>
          {canAdjust ? (
            <Button variant="secondary" onClick={() => setStockCountOpen(true)}>
              {STOCK_COUNT.title}
            </Button>
          ) : null}
          <Button onClick={() => void load()}>{COMMON.refresh}</Button>
        </div>
      </header>

      {reportOpen ? (
        <MovementReport
          businessDate={businessDate}
          onClose={() => setReportOpen(false)}
        />
      ) : null}

      <StockCountScreen
        open={stockCountOpen}
        onClose={() => setStockCountOpen(false)}
        onFinalized={() => void load()}
      />

      {sheetOpen ? (
        <StockSheet
          onClose={() => setSheetOpen(false)}
          onSaved={(message) => {
            setSheetOpen(false);
            setSaved(message);
            // Reloaded straight away so the new figures — and the low-stock list — are
            // the ones on screen, not the ones from before the delivery.
            void load();
          }}
        />
      ) : null}

      {saved ? (
        <Panel tone="success" title={saved}>
          {STOCK.lowStockRule}
        </Panel>
      ) : null}

      {error ? <Panel tone="danger">{error}</Panel> : null}
      {quickAdjustError ? <Panel tone="danger">{quickAdjustError}</Panel> : null}

      {/* The low-stock section, always visible rather than behind the filter: the owner
          asked for items below their own minimum to be easy to spot. Driven from the same
          rows the table renders, so the two can never disagree. */}
      {rows !== null && !lowOnly ? <LowStockSection rows={rows} /> : null}

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
                {STOCK.colPrice}
              </th>
              <th scope="col" className="py-2 text-right">
                {STOCK.colMinQty}
              </th>
              <th scope="col" className="py-2 text-right">
                {STOCK.colQuantity}
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
              return (
                <tr key={row.product_id} className="border-b border-slate-100">
                  <td className="py-2">
                    {row.name}
                    {row.sku ? (
                      <span className="ml-2 text-xs text-slate-500">{row.sku}</span>
                    ) : null}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {row.default_selling_price
                      ? formatQuantity(parseMoney(row.default_selling_price))
                      : '—'}
                  </td>
                  <td className="py-2 text-right text-slate-600 tabular-nums">
                    {reorder === null ? STOCK.noReorderLevel : formatQuantity(reorder)}
                  </td>
                  <td className="py-2 text-right font-medium tabular-nums">
                    {canAdjust ? (
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="secondary"
                          aria-label={STOCK.quickDecrease(row.name)}
                          disabled={quickAdjustingId !== null || quantity.lte(0)}
                          onClick={() => void quickAdjust(row, -1)}
                        >
                          −
                        </Button>
                        <span
                          className="min-w-10 text-center"
                          data-testid="stock-quantity"
                        >
                          {formatQuantity(quantity)}
                        </span>
                        <Button
                          variant="secondary"
                          aria-label={STOCK.quickIncrease(row.name)}
                          disabled={quickAdjustingId !== null}
                          onClick={() => void quickAdjust(row, 1)}
                        >
                          +
                        </Button>
                      </div>
                    ) : (
                      formatQuantity(quantity)
                    )}
                    {isLow(row) ? (
                      // Words, not just a colour (NFR-FE-UX-007).
                      <span className="ml-2 rounded bg-amber-100 px-1 text-xs text-amber-900">
                        {STOCK.lowBadge}
                      </span>
                    ) : null}
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

// --- low stock ----------------------------------------------------------------

/**
 * Items below their own minimum, listed where they cannot be missed.
 *
 * Derived from the rows already on screen rather than fetched separately, so the section,
 * the badges in the table and the "only what is running low" filter cannot disagree about
 * the same item — and so the list updates the instant a delivery is saved without a
 * second request.
 *
 * Each line carries both figures, because "running low" without the numbers tells a
 * shopkeeper to go and look them up.
 */
function LowStockSection({ rows }: { rows: readonly StockBalance[] }) {
  const low = rows.filter(isLow);
  if (low.length === 0) {
    return (
      <p className="text-sm text-slate-600">
        {STOCK.lowStockEmpty} {STOCK.lowStockRule}
      </p>
    );
  }
  return (
    <section className="rounded border border-amber-500 bg-amber-50 p-3">
      <h3 className="text-base font-semibold text-amber-900">
        {STOCK.lowStockHeading} ({low.length})
      </h3>
      {/* Named, so the list is addressable in its own right — by assistive technology,
          and by a test that needs to ask "is *this* item short?" without matching the
          same name in the table below. */}
      <ul
        aria-label={STOCK.lowStockListLabel}
        className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-sm text-amber-900"
      >
        {low.map((row) => (
          <li key={row.product_id}>
            <span className="font-medium">{row.name}</span>{' '}
            <span className="text-xs">
              {STOCK.lowStockLine(
                formatQuantity(parseMoney(row.quantity)),
                formatQuantity(parseMoney(row.reorder_level ?? '0')),
              )}
            </span>
          </li>
        ))}
      </ul>
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
        // Oldest first, so the running balance reads downwards: each row's "In stock
        // after" follows from the one above it, which is how a shopkeeper checks a
        // figure. Every movement is here — the opening figure, each delivery, each
        // correction, each sale and each reversal of a cancelled bill — read from the
        // ledger's own `balance_after` and never reconstructed from today's total.
        const response = await inventory.movements({
          product_id: product.product_id,
          oldest_first: true,
        });
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
              <th scope="col" className="py-1">
                {STOCK.colReference}
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
                    {movementLabel(movement)}
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
                  <td className="py-1 text-slate-600">
                    {/* The bill this came from, when there is one to look up. A delivery
                        sheet, a correction and the opening figure have no document, and
                        show a dash rather than an invented placeholder. */}
                    {movement.reference ?? STOCK.noReference}
                  </td>
                  <td className="py-1 text-right tabular-nums">
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

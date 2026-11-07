/**
 * The bill, as a spreadsheet. `S.No · Item · Qty · Price · Total`, fifteen rows always
 * visible, growing past fifteen as they fill.
 *
 * This is the surface the owner approved after the first demo. Earlier records said the
 * application must *not* look like a spreadsheet and that the screen's labels should stay
 * distinct from the printed bill's; the owner has reversed that for the billing
 * workspace, and `docs/UI-UX-SPECIFICATION.md §4a` records the reversal with its date.
 * Only the **screen** changed: `print.css`, `InvoicePrintLayout` and the printed headers
 * (`S R · ITEM · QTY · PRICE · TOTAL`) are untouched, and still isolated by ADR-028.
 *
 * ## There is no second billing engine here
 *
 * Every cell edits the same `LocalDraft` through the same `draftStore` actions the old
 * table used — `addLine`, `updateLine`, `removeLine`. Totals are still derived selectors
 * (`lineTotal`, `draftTotal`), money arithmetic still happens only in `lib/money.ts`, and
 * finalisation is still one `POST /sales:finalize`. A grid that computed its own figures
 * would eventually disagree with the bill it is previewing.
 *
 * ## Why rows are addressed by index and lines by id
 *
 * A row is a position on screen; a line is a record. Row 7 may hold line `x` now and
 * nothing later. The focus model therefore tracks `(rowIndex, column)` — a coordinate,
 * like a spreadsheet — while every mutation addresses a line by `line.id`. Keying the
 * focus to a line id instead would lose the cursor the moment a line is removed, which is
 * exactly when the cashier is looking at it.
 *
 * ## Keyboard: context-aware, never global
 *
 * The one rule that makes this safe to build: **the grid's key handling lives on its
 * cells, not on `window`.** `BillingCounter` owns the only window-level listener and it
 * returns immediately unless `ctrlKey` is held, so `Tab`, `Enter`, the arrows and `Space`
 * can never reach `Print Bill` or `Credit Bill` (FR-BILL-013's four actions keep their
 * `Ctrl` shortcuts untouched).
 *
 * Inside a cell the keys are interpreted against what the user is actually doing:
 *
 * | Key | While the product list is open | Otherwise |
 * |---|---|---|
 * | `↓` `↑` | Move through the matches | Move a row down / up |
 * | `Enter` | Add the highlighted product | Move down a row |
 * | `Esc` | Close the list, keep the text | — |
 * | `←` `→` | Move the text caret | Previous / next column |
 * | `Tab` | Previous / next column (never trapped) | Previous / next column |
 * | `Space` | A space in the product name | A space in the product name |
 *
 * `Space` is listed because the owner asked for spreadsheet-style `Space`, and the honest
 * answer is that it must stay a character: a part is called `AXEL PACKING`, and a grid
 * that swallowed the space to "select a cell" would make half the catalogue untypeable.
 * `←`/`→` only move between columns when the caret is already at the end of the text, so
 * arrowing through what you typed still works.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { LocalDraftLine } from '@/db/schema';
import { formatForScreen, tryParseMoney, parseMoney, ZERO } from '@/lib/money';
import { BILLING } from '@/lib/strings';
import { lineTotal } from './draftStore';
import { rowCount } from './gridRows';
import { ItemCell, type SearchHit } from './ItemCell';

/** The editable columns, left to right. `S.No` and `Total` are not editable. */
const COLUMNS = ['item', 'quantity', 'price'] as const;
type GridColumn = (typeof COLUMNS)[number];

// Named rather than indexed, because `noUncheckedIndexedAccess` makes `COLUMNS[0]`
// possibly-undefined and a non-null assertion here would be noise on a tuple that cannot
// be empty.
const FIRST_COLUMN: GridColumn = 'item';
const LAST_COLUMN: GridColumn = 'price';

interface GridFocus {
  row: number;
  column: GridColumn;
}

export interface BillGridProps {
  lines: readonly LocalDraftLine[];
  readOnly: boolean;
  online: boolean;
  /** `billing.price.override`. Without it the Price cell is read-only, not hidden. */
  canOverridePrice: boolean;
  /** `catalog.write`. Gates the Item cell's "Add New Item to Stock" affordance. */
  canCreateProduct: boolean;
  /** `catalog.write` + `inventory.adjust`. Lets a new item declare its opening stock. */
  onAddProduct: (hit: SearchHit, rowIndex: number) => void;
  onChangeLine: (lineId: string, patch: Partial<LocalDraftLine>) => void;
  onRemoveLine: (lineId: string) => void;
}

export function BillGrid({
  lines,
  readOnly,
  online,
  canOverridePrice,
  canCreateProduct,
  onAddProduct,
  onChangeLine,
  onRemoveLine,
}: BillGridProps) {
  const total = rowCount(lines.length);
  const [focus, setFocus] = useState<GridFocus>({ row: 0, column: 'item' });
  const [quantityErrors, setQuantityErrors] = useState<Record<string, string>>({});

  // The cell to focus on the next paint. A ref rather than state because the move is an
  // imperative DOM effect, and storing it in state would re-render the whole grid twice
  // for every cursor movement on a twenty-line bill.
  const pending = useRef<GridFocus | null>(null);
  const container = useRef<HTMLTableSectionElement>(null);

  const move = useCallback(
    (next: GridFocus) => {
      const row = Math.max(0, Math.min(next.row, rowCount(lines.length) - 1));
      setFocus({ row, column: next.column });
      pending.current = { row, column: next.column };
    },
    [lines.length],
  );

  // Focus follows the coordinate, after the row that may have just been created exists.
  useEffect(() => {
    const target = pending.current;
    if (!target) return;
    pending.current = null;
    const selector = `[data-cell="${target.row}-${target.column}"]`;
    const element = container.current?.querySelector<HTMLElement>(selector);
    element?.focus();
    if (element instanceof HTMLInputElement) element.select();
  });

  /** Spreadsheet traversal. Wraps across columns, clamps at the top and bottom. */
  const step = useCallback(
    (from: GridFocus, direction: 'next' | 'previous' | 'up' | 'down'): GridFocus => {
      const index = COLUMNS.indexOf(from.column);
      if (direction === 'up') return { ...from, row: from.row - 1 };
      if (direction === 'down') return { ...from, row: from.row + 1 };
      if (direction === 'next') {
        const column = COLUMNS[index + 1];
        // Past the last column, carry to the start of the next row — the behaviour that
        // lets a cashier type a whole bill without ever reaching for the mouse.
        return column === undefined
          ? { row: from.row + 1, column: FIRST_COLUMN }
          : { ...from, column };
      }
      const previous = COLUMNS[index - 1];
      if (previous !== undefined) return { ...from, column: previous };
      // Already at the first column of the first row: stay put rather than wrap to
      // nowhere.
      return from.row === 0 ? from : { row: from.row - 1, column: LAST_COLUMN };
    },
    [],
  );

  function commitQuantity(line: LocalDraftLine, raw: string): void {
    const parsed = tryParseMoney(raw);
    if (!parsed || parsed.lte(ZERO)) {
      setQuantityErrors((current) => ({
        ...current,
        [line.id]: 'Enter a quantity above zero.',
      }));
      return;
    }
    setQuantityErrors((current) => {
      const next = { ...current };
      delete next[line.id];
      return next;
    });
    onChangeLine(line.id, { quantity: parsed.toFixed(3) });
  }

  function commitPrice(line: LocalDraftLine, raw: string): void {
    const parsed = tryParseMoney(raw);
    if (!parsed || parsed.lt(ZERO)) return;
    const catalogue = tryParseMoney(line.catalog_price_at_add) ?? parsed;
    onChangeLine(line.id, {
      unit_price: parsed.toFixed(4),
      // Recorded, never inferred later: the server audits a manual override, and it can
      // only do so because the client says which it was.
      price_source: parsed.eq(catalogue) ? 'catalog' : 'manual_override',
    });
  }

  /** Shared by the Qty and Price cells — plain inputs with no dropdown to consider. */
  function numericKeys(
    event: React.KeyboardEvent<HTMLInputElement>,
    row: number,
    column: GridColumn,
  ): void {
    const input = event.currentTarget;
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    const atEnd =
      input.selectionStart === input.value.length &&
      input.selectionEnd === input.value.length;

    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur(); // commit through onBlur before the cursor leaves
      move(step({ row, column }, 'down'));
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(step({ row, column }, 'down'));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(step({ row, column }, 'up'));
    } else if (event.key === 'ArrowRight' && atEnd) {
      // Only at the end of the text: otherwise the caret still has somewhere to go, and
      // hijacking the key would stop the user correcting a figure they just typed.
      event.preventDefault();
      move(step({ row, column }, 'next'));
    } else if (event.key === 'ArrowLeft' && atStart) {
      event.preventDefault();
      move(step({ row, column }, 'previous'));
    }
    // `Tab` is deliberately not handled: the browser's own order already walks the cells
    // left-to-right then down, and trapping it would break the one key every user
    // already trusts.
  }

  return (
    <div className="flex min-h-0 flex-col">
      {/* The grid scrolls; the bill header and the totals do not. That is what keeps the
          normal controls reachable without scrolling the page (R5.1). */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse border border-nas-navy text-sm tabular-nums">
          <caption className="sr-only">{BILLING.gridLabel}</caption>
          <colgroup>
            <col className="w-14" />
            <col />
            <col className="w-24" />
            <col className="w-32" />
            <col className="w-36" />
            <col className="w-10" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-[#eef0f8]">
            <tr>
              <th
                scope="col"
                className="border border-nas-navy px-2 py-2 text-center font-semibold"
              >
                {BILLING.columnSerial}
              </th>
              <th
                scope="col"
                className="border border-nas-navy px-2 py-2 text-left font-semibold"
              >
                {BILLING.columnItem}
              </th>
              <th
                scope="col"
                className="border border-nas-navy px-2 py-2 text-right font-semibold"
              >
                {BILLING.columnQuantity}
              </th>
              <th
                scope="col"
                className="border border-nas-navy px-2 py-2 text-right font-semibold"
              >
                {BILLING.columnPrice}
              </th>
              <th
                scope="col"
                className="border border-nas-navy px-2 py-2 text-right font-semibold"
              >
                {BILLING.columnTotal}
              </th>
              {/* The packing tick. Placed after Total so the three typed columns —
                  Item, Qty, Price — stay contiguous and the type-flow picks up nothing
                  new between them. */}
              <th
                scope="col"
                title={BILLING.columnCollectedTitle}
                className="border border-nas-navy px-1 py-2 text-center font-semibold"
              >
                {BILLING.columnCollected}
              </th>
              <th scope="col" className="border border-nas-navy px-1 py-2">
                <span className="sr-only">{BILLING.columnRemove}</span>
              </th>
            </tr>
          </thead>
          <tbody ref={container}>
            {Array.from({ length: total }, (_, row) => {
              const line = lines[row];
              const active = focus.row === row;
              return (
                <tr
                  key={line?.id ?? `empty-${row}`}
                  className={active ? 'bg-[#f7f8fc]' : undefined}
                >
                  <td className="border border-nas-navy px-2 py-1 text-center text-slate-600">
                    {row + 1}
                  </td>

                  <td className="border border-nas-navy p-0">
                    <ItemCell
                      row={row}
                      line={line}
                      online={online}
                      readOnly={readOnly}
                      canCreateProduct={canCreateProduct}
                      onPick={(hit) => onAddProduct(hit, row)}
                      onFocusCell={() => setFocus({ row, column: 'item' })}
                      onMove={(direction) =>
                        move(step({ row, column: 'item' }, direction))
                      }
                    />
                  </td>

                  <td className="border border-nas-navy p-0">
                    {line ? (
                      <>
                        <label className="sr-only" htmlFor={`qty-${line.id}`}>
                          {BILLING.cellQuantityLabel(row + 1)}
                        </label>
                        <input
                          id={`qty-${line.id}`}
                          data-cell={`${row}-quantity`}
                          // Uncontrolled: a controlled input re-renders the whole grid on
                          // every keystroke, and a twenty-line bill has to stay under the
                          // 50 ms line-edit budget (NFR-FE-PERF-002). `key` refreshes it
                          // when the stored value changes underneath.
                          key={`qty-${line.id}-${line.quantity}`}
                          defaultValue={formatForScreen(parseMoney(line.quantity))}
                          inputMode="decimal"
                          disabled={readOnly}
                          aria-invalid={quantityErrors[line.id] ? true : undefined}
                          className="w-full bg-transparent px-2 py-1 text-right outline-none focus:bg-white focus:ring-2 focus:ring-inset focus:ring-nas-navy"
                          onFocus={() => setFocus({ row, column: 'quantity' })}
                          onBlur={(event) => commitQuantity(line, event.target.value)}
                          onKeyDown={(event) => numericKeys(event, row, 'quantity')}
                        />
                      </>
                    ) : (
                      <div
                        data-cell={`${row}-quantity`}
                        className="px-2 py-1"
                        aria-hidden="true"
                      />
                    )}
                  </td>

                  <td className="border border-nas-navy p-0">
                    {line ? (
                      <>
                        <label className="sr-only" htmlFor={`price-${line.id}`}>
                          {BILLING.cellPriceLabel(row + 1)}
                        </label>
                        <input
                          id={`price-${line.id}`}
                          data-cell={`${row}-price`}
                          key={`price-${line.id}-${line.unit_price}`}
                          defaultValue={formatForScreen(parseMoney(line.unit_price))}
                          inputMode="decimal"
                          // Permission-gated as read-only rather than absent: the figure
                          // still has to be visible, and the server re-checks the
                          // override regardless (§5 rule 12).
                          disabled={readOnly || !canOverridePrice}
                          className="w-full bg-transparent px-2 py-1 text-right outline-none focus:bg-white focus:ring-2 focus:ring-inset focus:ring-nas-navy disabled:text-slate-700"
                          onFocus={() => setFocus({ row, column: 'price' })}
                          onBlur={(event) => commitPrice(line, event.target.value)}
                          onKeyDown={(event) => numericKeys(event, row, 'price')}
                        />
                      </>
                    ) : (
                      <div
                        data-cell={`${row}-price`}
                        className="px-2 py-1"
                        aria-hidden="true"
                      />
                    )}
                  </td>

                  <td className="border border-nas-navy px-2 py-1 text-right font-medium">
                    {line ? formatForScreen(lineTotal(line)) : ''}
                  </td>

                  <td className="border border-nas-navy p-0 text-center">
                    {line ? (
                      <input
                        type="checkbox"
                        checked={line.collected === true}
                        disabled={readOnly}
                        aria-label={BILLING.collectedLabel(line.product_name)}
                        className="h-4 w-4 align-middle"
                        onChange={(event) =>
                          onChangeLine(line.id, { collected: event.target.checked })
                        }
                      />
                    ) : null}
                  </td>

                  <td className="border border-nas-navy p-0 text-center">
                    {line && !readOnly ? (
                      <button
                        type="button"
                        onClick={() => onRemoveLine(line.id)}
                        aria-label={BILLING.removeRow(line.product_name)}
                        className="h-full w-full px-1 py-1 text-slate-500 hover:bg-red-50 hover:text-red-700"
                      >
                        ×
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Kept even though the grid is never literally empty: FR-BILL-011 asks for a hint
          rather than a bare table, and fifteen blank numbered rows are exactly the
          "empty table with no guidance" it was written against. */}
      {lines.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600">{BILLING.emptyHint}</p>
      ) : null}
      {/* Said once, under the grid: the tick is for the packer, not for the bill. */}
      {lines.length > 0 ? (
        <p className="mt-1 text-xs text-slate-500">{BILLING.collectedHint}</p>
      ) : null}
      {Object.values(quantityErrors).map((message) => (
        <p key={message} role="alert" className="mt-1 text-xs font-medium text-red-700">
          {message}
        </p>
      ))}
      <p className="mt-1 text-xs text-slate-500">{BILLING.keyboardHint}</p>
    </div>
  );
}

/**
 * The owner's stock sheet: **Item · Price · Min Qty · Stock Qty**, four columns side by
 * side, one row per delivery.
 *
 * ## `Stock Qty` is an arrival, never a new total
 *
 * This is the one thing in this file that destroys real inventory if it is wrong. 20 on
 * the shelf plus a typed 200 is 220. The wording says so, the live preview under the row
 * says `In stock 20 + 200 = 220` before anything is saved, and the server has no code
 * path that assigns a balance even if a client asked it to. Three layers, because a
 * mistake here would leave the balance table and the ledger agreeing with each other and
 * nothing to notice it by.
 *
 * ## Why the row knows whether it is new
 *
 * `GET /inventory/stock-entries:resolve` answers *"will this add a product or top up an
 * existing one?"* from the **same matcher the save uses**, so the badge cannot promise
 * something the save then does differently. It also returns the current stock, price and
 * minimum, which is what the `20 + 200 = 220` preview is made of — and it pre-fills Price
 * and Min Qty from the existing product, so a cashier topping up a part does not have to
 * retype figures that have not changed.
 *
 * Matching is exact on the normalised name, so `axel packing` finds `Axel Packing`, while
 * `Brake Shoe Set Ace` and `Brake Shoe Set Bolero` stay two different parts. An
 * `ambiguous` or `inactive` answer is shown and blocks the save: the server refuses
 * either way, and saying so while the user is still typing is better than a 422 after
 * they press the button.
 *
 * ## Keyboard
 *
 * `Tab` and the arrows move between cells, `Enter` moves down a row and adds one if the
 * cursor is on the last. `Space` stays a space — a part is called `AXEL PACKING`.
 * Nothing is bound to `window`, so none of it can reach the Stock screen's own controls.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { inventory } from '@/api/endpoints';
import { ApiError, describeError, fieldErrors } from '@/api/errors';
import type { StockEntryMatch } from '@/api/types';
import { Button, Panel } from '@/components/primitives';
import { uuidv7 } from '@/lib/ids';
import { parseMoney, tryParseMoney, ZERO } from '@/lib/money';
import { COMMON, ERRORS, STOCK } from '@/lib/strings';

/** How many blank rows the sheet opens with. Enough to look like a sheet. */
const INITIAL_ROWS = 8;
const RESOLVE_DEBOUNCE_MS = 250;

const CELLS = ['item', 'price', 'min_qty', 'stock_qty'] as const;
type Cell = (typeof CELLS)[number];

interface SheetRow {
  /** Stable across re-renders so React keys survive a row being removed. */
  id: string;
  item: string;
  price: string;
  min_qty: string;
  stock_qty: string;
  /** What the server says this name resolves to; `null` until it has been asked. */
  match: StockEntryMatch | null;
}

function blankRow(): SheetRow {
  return { id: uuidv7(), item: '', price: '', min_qty: '', stock_qty: '', match: null };
}

/** A row the user has actually started filling in. Blank rows are simply ignored. */
function isFilled(row: SheetRow): boolean {
  return (
    row.item.trim() !== '' ||
    row.price.trim() !== '' ||
    row.min_qty.trim() !== '' ||
    row.stock_qty.trim() !== ''
  );
}

export interface StockSheetProps {
  onClose: () => void;
  /** Called after a successful save so the Stock list reloads. */
  onSaved: (message: string) => void;
}

export function StockSheet({ onClose, onSaved }: StockSheetProps) {
  const [rows, setRows] = useState<SheetRow[]>(() =>
    Array.from({ length: INITIAL_ROWS }, blankRow),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldProblems, setFieldProblems] = useState<Record<string, string>>({});

  const container = useRef<HTMLTableSectionElement>(null);
  const pendingFocus = useRef<{ row: number; cell: Cell } | null>(null);

  /**
   * One idempotency key per sheet, minted when the sheet opens and **reused** on every
   * attempt (§5 rule 4).
   *
   * This is the button a worried user presses twice. The server claims the key, so the
   * second press returns the first outcome instead of booking the delivery again — and
   * because `stock_movements` can never be deleted, a double booking could not be tidied
   * away afterwards. A new key is minted only after a successful save, because the next
   * sheet is a new intent.
   */
  const idempotencyKey = useRef(uuidv7());

  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    container.current
      ?.querySelector<HTMLElement>(`[data-sheet="${target.row}-${target.cell}"]`)
      ?.focus();
  });

  const focusCell = useCallback((row: number, cell: Cell) => {
    pendingFocus.current = { row, cell };
  }, []);

  function update(index: number, patch: Partial<SheetRow>): void {
    setRows((current) =>
      current.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    );
  }

  function addRow(): void {
    setRows((current) => [...current, blankRow()]);
  }

  function removeRow(index: number): void {
    setRows((current) =>
      current.length === 1
        ? [blankRow()]
        : current.filter((_, position) => position !== index),
    );
  }

  // --- resolution, debounced per row -----------------------------------------

  const resolveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const inFlight = useRef<Map<string, AbortController>>(new Map());

  // Keyed by `row.id`, not by position: a row removed above this one changes its index
  // but not its identity, and an in-flight lookup must still land on the row that
  // started it.
  const resolve = useCallback((rowId: string, item: string) => {
    const timers = resolveTimers.current;
    const existingTimer = timers.get(rowId);
    if (existingTimer) clearTimeout(existingTimer);
    inFlight.current.get(rowId)?.abort();

    const name = item.trim();
    if (name === '') {
      setRows((current) =>
        current.map((row) => (row.id === rowId ? { ...row, match: null } : row)),
      );
      return;
    }

    timers.set(
      rowId,
      setTimeout(() => {
        const controller = new AbortController();
        inFlight.current.set(rowId, controller);
        void inventory
          .resolveStockEntry(name, controller.signal)
          .then((match) => {
            setRows((current) =>
              current.map((row) => {
                if (row.id !== rowId) return row;
                // Pre-fill from the existing product, but never overwrite a figure the
                // user has already typed — they may be changing the price on purpose.
                const price =
                  row.price.trim() === '' && match.current_price !== null
                    ? String(match.current_price)
                    : row.price;
                const minQty =
                  row.min_qty.trim() === '' && match.current_min_qty !== null
                    ? String(match.current_min_qty)
                    : row.min_qty;
                return { ...row, match, price, min_qty: minQty };
              }),
            );
          })
          .catch(() => {
            // A failed lookup must not stop someone recording a delivery. The badge
            // simply stays absent and the server decides on save.
            if (controller.signal.aborted) return;
            setRows((current) =>
              current.map((row) => (row.id === rowId ? { ...row, match: null } : row)),
            );
          });
      }, RESOLVE_DEBOUNCE_MS),
    );
  }, []);

  useEffect(
    () => () => {
      resolveTimers.current.forEach((timer) => clearTimeout(timer));
      inFlight.current.forEach((controller) => controller.abort());
    },
    [],
  );

  // --- validation and save ---------------------------------------------------

  const filled = rows.filter(isFilled);

  /** Local checks, mirroring the server's so the user hears about it sooner. */
  function localProblem(): string | null {
    if (filled.length === 0) return STOCK.sheetNeedRow;
    if (filled.some((row) => row.item.trim() === '')) return STOCK.sheetNeedName;
    if (filled.some((row) => tryParseMoney(row.price) === null))
      return STOCK.sheetNeedPrice;
    if (
      filled.some((row) => {
        const quantity = tryParseMoney(row.stock_qty);
        return quantity === null || quantity.lte(ZERO);
      })
    ) {
      return STOCK.sheetNeedQty;
    }
    if (filled.some((row) => row.match?.kind === 'ambiguous'))
      return STOCK.sheetAmbiguous;
    if (filled.some((row) => row.match?.kind === 'inactive')) return STOCK.sheetInactive;
    // The same part twice: the server refuses it, and so does this, because which
    // quantity the user meant is genuinely unknown.
    const seen = new Set<string>();
    for (const row of filled) {
      const key = row.item.trim().toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) return STOCK.sheetDuplicate(1);
      seen.add(key);
    }
    return null;
  }

  async function save(): Promise<void> {
    const refusal = localProblem();
    if (refusal) {
      setProblem(refusal);
      return;
    }
    setBusy(true);
    setProblem(null);
    setFieldProblems({});
    try {
      const result = await inventory.saveStockEntries(
        {
          entries: filled.map((row) => ({
            item: row.item.trim(),
            // Emitted as decimal **strings**, parsed through `lib/money` so nothing
            // reaches the wire as a JavaScript number (ADR-013).
            price: parseMoney(row.price).toFixed(4),
            min_qty: parseMoney(row.min_qty || '0').toFixed(3),
            stock_qty: parseMoney(row.stock_qty).toFixed(3),
          })),
        },
        idempotencyKey.current,
      );
      const created = result.items.filter((item) => item.created).length;
      // A new intent follows a committed one, so the next sheet gets its own key.
      idempotencyKey.current = uuidv7();
      onSaved(STOCK.sheetSaved(result.items.length, created));
    } catch (caught) {
      if (caught instanceof ApiError) {
        // `details.fields` from the server, mapped back onto the sheet so the message
        // lands next to the row that caused it rather than as a generic refusal.
        setFieldProblems(fieldErrors(caught));
        setProblem(describeError(caught.code).message);
      } else {
        setProblem(ERRORS.unexpected);
      }
    } finally {
      setBusy(false);
    }
  }

  // --- keyboard --------------------------------------------------------------

  function onCellKeyDown(
    event: React.KeyboardEvent<HTMLInputElement>,
    index: number,
    cell: Cell,
  ): void {
    const input = event.currentTarget;
    const column = CELLS.indexOf(cell);
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    const atEnd =
      input.selectionStart === input.value.length &&
      input.selectionEnd === input.value.length;

    const down = (): void => {
      // Enter on the last row grows the sheet, so a long delivery never runs out of rows.
      if (index === rows.length - 1) addRow();
      focusCell(index + 1, cell);
      setRows((current) => [...current]); // re-render so the focus effect runs
    };

    if (event.key === 'Enter' || event.key === 'ArrowDown') {
      event.preventDefault();
      down();
    } else if (event.key === 'ArrowUp' && index > 0) {
      event.preventDefault();
      focusCell(index - 1, cell);
      setRows((current) => [...current]);
    } else if (event.key === 'ArrowRight' && atEnd) {
      const next = CELLS[column + 1];
      event.preventDefault();
      if (next !== undefined) focusCell(index, next);
      else down();
      setRows((current) => [...current]);
    } else if (event.key === 'ArrowLeft' && atStart) {
      const previous = CELLS[column - 1];
      if (previous !== undefined) {
        event.preventDefault();
        focusCell(index, previous);
        setRows((current) => [...current]);
      }
    }
    // `Tab` is left to the browser: its natural order already walks the cells
    // left-to-right then down, and trapping it would break the one key every user trusts.
    // `Space` is left alone too — it is a character in a part name.
  }

  const cellClass =
    'w-full border border-slate-300 px-2 py-1 text-base outline-none focus:border-nas-navy focus:ring-2 focus:ring-inset focus:ring-nas-navy';

  return (
    <section className="flex flex-col gap-3 rounded border border-nas-navy bg-white p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-nas-navy">{STOCK.sheetTitle}</h2>
        <Button variant="quiet" onClick={onClose} disabled={busy}>
          {STOCK.sheetCancel}
        </Button>
      </header>

      {/* Said before the sheet, not after a mistake. */}
      <p className="text-sm text-slate-700">{STOCK.sheetExplainer}</p>

      {problem ? <Panel tone="danger">{problem}</Panel> : null}
      {Object.entries(fieldProblems).map(([field, message]) => (
        <p key={field} role="alert" className="text-sm font-medium text-red-700">
          {field}: {message}
        </p>
      ))}

      <div className="overflow-x-auto">
        <table className="w-full min-w-176 border-collapse text-sm">
          <caption className="sr-only">{STOCK.sheetTitle}</caption>
          <colgroup>
            <col className="w-10" />
            <col />
            <col className="w-28" />
            <col className="w-28" />
            <col className="w-28" />
            <col className="w-56" />
            <col className="w-10" />
          </colgroup>
          <thead>
            <tr className="bg-[#eef0f8]">
              <th scope="col" className="border border-nas-navy px-1 py-2 text-center">
                #
              </th>
              {/* The four columns, side by side, exactly as the owner's sheet has them —
                  never stacked into a two-up form. */}
              <th scope="col" className="border border-nas-navy px-2 py-2 text-left">
                {STOCK.colItem}
              </th>
              <th scope="col" className="border border-nas-navy px-2 py-2 text-right">
                {STOCK.colPrice}
              </th>
              <th scope="col" className="border border-nas-navy px-2 py-2 text-right">
                {STOCK.colMinQty}
              </th>
              <th scope="col" className="border border-nas-navy px-2 py-2 text-right">
                {STOCK.colStockQty}
              </th>
              <th scope="col" className="border border-nas-navy px-2 py-2 text-left">
                <span className="sr-only">What this row will do</span>
              </th>
              <th scope="col" className="border border-nas-navy px-1 py-2">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody ref={container}>
            {rows.map((row, index) => (
              <tr key={row.id}>
                <td className="border border-nas-navy px-1 py-1 text-center text-slate-500">
                  {index + 1}
                </td>
                <td className="border border-nas-navy p-1">
                  <label className="sr-only" htmlFor={`sheet-item-${row.id}`}>
                    {STOCK.colItem}, row {index + 1}
                  </label>
                  <input
                    id={`sheet-item-${row.id}`}
                    data-sheet={`${index}-item`}
                    value={row.item}
                    disabled={busy}
                    autoComplete="off"
                    className={cellClass}
                    onChange={(event) => {
                      update(index, { item: event.target.value });
                      resolve(row.id, event.target.value);
                    }}
                    onKeyDown={(event) => onCellKeyDown(event, index, 'item')}
                  />
                </td>
                <td className="border border-nas-navy p-1">
                  <label className="sr-only" htmlFor={`sheet-price-${row.id}`}>
                    {STOCK.colPrice}, row {index + 1}
                  </label>
                  <input
                    id={`sheet-price-${row.id}`}
                    data-sheet={`${index}-price`}
                    value={row.price}
                    inputMode="decimal"
                    disabled={busy}
                    className={`${cellClass} text-right`}
                    onChange={(event) => update(index, { price: event.target.value })}
                    onKeyDown={(event) => onCellKeyDown(event, index, 'price')}
                  />
                </td>
                <td className="border border-nas-navy p-1">
                  <label className="sr-only" htmlFor={`sheet-min-${row.id}`}>
                    {STOCK.colMinQty}, row {index + 1}
                  </label>
                  <input
                    id={`sheet-min-${row.id}`}
                    data-sheet={`${index}-min_qty`}
                    value={row.min_qty}
                    inputMode="decimal"
                    disabled={busy}
                    className={`${cellClass} text-right`}
                    onChange={(event) => update(index, { min_qty: event.target.value })}
                    onKeyDown={(event) => onCellKeyDown(event, index, 'min_qty')}
                  />
                </td>
                <td className="border border-nas-navy p-1">
                  <label className="sr-only" htmlFor={`sheet-qty-${row.id}`}>
                    {STOCK.colStockQty}, row {index + 1}
                  </label>
                  <input
                    id={`sheet-qty-${row.id}`}
                    data-sheet={`${index}-stock_qty`}
                    value={row.stock_qty}
                    inputMode="decimal"
                    disabled={busy}
                    className={`${cellClass} text-right`}
                    onChange={(event) => update(index, { stock_qty: event.target.value })}
                    onKeyDown={(event) => onCellKeyDown(event, index, 'stock_qty')}
                  />
                </td>
                <td className="border border-nas-navy px-2 py-1 text-xs">
                  <RowOutcome row={row} />
                </td>
                <td className="border border-nas-navy p-0 text-center">
                  <button
                    type="button"
                    onClick={() => removeRow(index)}
                    disabled={busy}
                    aria-label={STOCK.sheetRemoveRow(index + 1)}
                    className="h-full w-full px-1 py-1 text-slate-500 hover:bg-red-50 hover:text-red-700"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500">{STOCK.sheetKeyboardHint}</p>

      <div className="flex flex-wrap gap-3">
        <Button variant="primary" busy={busy} onClick={() => void save()}>
          {STOCK.sheetSave}
        </Button>
        <Button variant="secondary" onClick={addRow} disabled={busy}>
          {STOCK.sheetAddRow}
        </Button>
        <Button variant="quiet" onClick={onClose} disabled={busy}>
          {COMMON.cancel}
        </Button>
      </div>
    </section>
  );
}

/**
 * What this row will do, said in words before it is saved.
 *
 * The owner asked to be shown clearly whether a row adds a new product or tops up an
 * existing one. For an existing one it spells out the arithmetic — `In stock 20 + 200 =
 * 220` — because that is the sentence that makes it impossible to read `Stock Qty` as a
 * replacement figure.
 */
function RowOutcome({ row }: { row: SheetRow }) {
  if (!row.match || row.item.trim() === '') return null;

  if (row.match.kind === 'new') {
    return <span className="font-medium text-green-800">{STOCK.sheetNewItem}</span>;
  }
  if (row.match.kind === 'ambiguous') {
    return <span className="font-medium text-red-700">{STOCK.sheetAmbiguous}</span>;
  }
  if (row.match.kind === 'inactive') {
    return <span className="font-medium text-red-700">{STOCK.sheetInactive}</span>;
  }

  const current = row.match.current_quantity;
  const incoming = tryParseMoney(row.stock_qty);
  if (
    current === null ||
    current === undefined ||
    incoming === null ||
    incoming.lte(ZERO)
  ) {
    return <span className="text-slate-600">{STOCK.sheetExistingShort}</span>;
  }
  const currentQuantity = parseMoney(String(current));
  return (
    <span className="text-slate-700">
      {STOCK.sheetExisting(
        currentQuantity.toString(),
        incoming.toString(),
        currentQuantity.plus(incoming).toString(),
      )}
    </span>
  );
}

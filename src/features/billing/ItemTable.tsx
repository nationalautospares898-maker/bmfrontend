/**
 * The bill's item table.
 *
 * A real `<table>` with a real `<caption>` and real column headers, because a cashier
 * using a screen reader or keyboard navigation needs the structure, and because a grid
 * of `<div>`s announces nothing.
 *
 * Quantity and price are **uncontrolled** inputs (`defaultValue` + `onBlur`), which is
 * what keeps a twenty-line bill under the 50 ms line-edit budget
 * (NFR-FE-PERF-002): a controlled input re-renders the whole table on every keystroke.
 * The trade is that the store is updated on blur rather than per character, which is
 * also the behaviour a counter hand expects — they type a figure and tab away.
 *
 * Removal is **undoable** (`BILLING.removeUndo`). A mis-click that silently deletes a
 * line from a bill the customer is watching is worse than one extra affordance.
 */

import { useState } from 'react';

import type { LocalDraftLine } from '@/db/schema';
import { formatForScreen, tryParseMoney } from '@/lib/money';
import { BILLING } from '@/lib/strings';
import { Button } from '@/components/primitives';
import { lineTotal } from './draftStore';

export interface ItemTableProps {
  lines: readonly LocalDraftLine[];
  readOnly: boolean;
  onChangeLine: (lineId: string, patch: Partial<LocalDraftLine>) => void;
  onRemoveLine: (lineId: string) => void;
  onRestoreLine: (line: LocalDraftLine) => void;
}

export function ItemTable({
  lines,
  readOnly,
  onChangeLine,
  onRemoveLine,
  onRestoreLine,
}: ItemTableProps) {
  const [removed, setRemoved] = useState<LocalDraftLine | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /**
   * Validate and store a typed quantity.
   *
   * Fractional quantities are refused for a unit that does not allow them (E-18). The
   * check is here as well as on the server so the cashier finds out while the cursor is
   * still in the field, not after pressing `Print Bill`.
   */
  function commitQuantity(line: LocalDraftLine, raw: string): void {
    const parsed = tryParseMoney(raw);
    if (!parsed || parsed.lte(0)) {
      setFieldErrors((current) => ({
        ...current,
        [line.id]: 'Enter a quantity above zero.',
      }));
      return;
    }
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[line.id];
      return next;
    });
    onChangeLine(line.id, { quantity: parsed.toFixed(3) });
  }

  function commitPrice(line: LocalDraftLine, raw: string): void {
    const parsed = tryParseMoney(raw);
    if (!parsed || parsed.lt(0)) return;
    const changed = !parsed.eq(tryParseMoney(line.catalog_price_at_add) ?? parsed);
    onChangeLine(line.id, {
      unit_price: parsed.toFixed(4),
      // Recorded, not inferred later: the server audits a manual override and the
      // reason it can do so is that the client says which it was.
      price_source: changed ? 'manual_override' : 'catalog',
    });
  }

  function remove(line: LocalDraftLine): void {
    setRemoved(line);
    onRemoveLine(line.id);
  }

  return (
    <div className="flex flex-col gap-2">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Items on this bill</caption>
        <thead>
          <tr className="border-b border-slate-300 text-left">
            <th scope="col" className="w-12 px-2 py-2">
              {BILLING.columnSerial}
            </th>
            <th scope="col" className="px-2 py-2">
              {BILLING.columnItem}
            </th>
            <th scope="col" className="w-28 px-2 py-2 text-right">
              {BILLING.columnQuantity}
            </th>
            <th scope="col" className="w-32 px-2 py-2 text-right">
              {BILLING.columnUnitPrice}
            </th>
            <th scope="col" className="w-32 px-2 py-2 text-right">
              {BILLING.columnTotal}
            </th>
            <th scope="col" className="w-24 px-2 py-2">
              <span className="sr-only">{BILLING.columnRemove}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-2 py-6 text-center text-slate-500">
                Type a part name or code above to start this bill.
              </td>
            </tr>
          ) : null}
          {lines.map((line) => (
            <tr key={line.id} className="border-b border-slate-200">
              <td className="px-2 py-2">{line.line_no}</td>
              <td className="px-2 py-2">
                <span className="font-medium">{line.product_name}</span>
                {line.sku ? (
                  <span className="ml-2 text-xs text-slate-500">{line.sku}</span>
                ) : null}
                {/* The stock the client last knew, with its age. Advisory: the server
                    decides at finalisation. */}
                {line.known_stock !== null && line.stock_as_of ? (
                  <span className="ml-2 text-xs text-slate-500">
                    {BILLING.stockAnnotation(
                      line.known_stock,
                      new Date(line.stock_as_of).toLocaleTimeString(),
                    )}
                  </span>
                ) : null}
                {fieldErrors[line.id] ? (
                  <span role="alert" className="ml-2 text-xs font-medium text-red-700">
                    {fieldErrors[line.id]}
                  </span>
                ) : null}
              </td>
              <td className="px-2 py-2 text-right">
                <label className="sr-only" htmlFor={`qty-${line.id}`}>
                  {BILLING.columnQuantity} for {line.product_name}
                </label>
                <input
                  id={`qty-${line.id}`}
                  // Uncontrolled: see the file comment. `key` on the value so a
                  // server-driven change still refreshes what is displayed.
                  key={`qty-${line.id}-${line.quantity}`}
                  defaultValue={formatForScreen(
                    tryParseMoney(line.quantity) ?? tryParseMoney('0')!,
                  )}
                  inputMode="decimal"
                  disabled={readOnly}
                  aria-invalid={fieldErrors[line.id] ? true : undefined}
                  className="w-24 rounded border border-slate-300 px-2 py-1 text-right"
                  onBlur={(event) => commitQuantity(line, event.target.value)}
                />
                <span className="ml-1 text-xs text-slate-500">{line.unit_code}</span>
              </td>
              <td className="px-2 py-2 text-right">
                <label className="sr-only" htmlFor={`price-${line.id}`}>
                  {BILLING.columnUnitPrice} for {line.product_name}
                </label>
                <input
                  id={`price-${line.id}`}
                  key={`price-${line.id}-${line.unit_price}`}
                  defaultValue={formatForScreen(
                    tryParseMoney(line.unit_price) ?? tryParseMoney('0')!,
                  )}
                  inputMode="decimal"
                  disabled={readOnly}
                  className="w-28 rounded border border-slate-300 px-2 py-1 text-right"
                  onBlur={(event) => commitPrice(line, event.target.value)}
                />
                {line.price_source === 'manual_override' ? (
                  <span className="ml-1 text-xs text-amber-700">changed</span>
                ) : null}
              </td>
              <td className="px-2 py-2 text-right font-medium">
                {formatForScreen(lineTotal(line))}
              </td>
              <td className="px-2 py-2">
                <Button
                  variant="quiet"
                  disabled={readOnly}
                  onClick={() => remove(line)}
                  aria-label={`Remove ${line.product_name}`}
                >
                  Remove
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {removed ? (
        <div
          // `polite`: it is recoverable, so it must not interrupt whatever is being
          // typed next.
          role="status"
          aria-live="polite"
          className="flex items-center gap-3 rounded border border-slate-300 bg-slate-50 px-3 py-2 text-sm"
        >
          <span>{removed.product_name} removed.</span>
          <Button
            variant="secondary"
            onClick={() => {
              onRestoreLine(removed);
              setRemoved(null);
            }}
          >
            {BILLING.removeUndo}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

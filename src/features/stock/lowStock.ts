/**
 * The low-stock rule, in one place.
 *
 * Its own module so `StockScreen.tsx` exports only components, and so the boundary — the
 * part of this that is easy to get wrong — can be tested without rendering a screen.
 */

import type { StockBalance } from '@/api/types';
import { parseMoney } from '@/lib/money';

/**
 * Is this item below **its own** minimum?
 *
 * `<`, not `<=`: the owner's rule is that an item is running low once its stock "goes
 * below the minimum quantity", so a part with a minimum of 4 and 4 on the shelf is *at*
 * its minimum, not under it. The same comparison runs server-side in
 * `InventoryService.balances(low_stock_only=True)`, `ProductView.is_low_stock` and
 * `ReportService.stock_position`, so the badge, the filter and the report agree.
 *
 * The threshold is **per product** (`products.reorder_level`), set item by item — never
 * one figure applied to the whole catalogue.
 *
 * A product with **no** minimum set is never low. A missing minimum is not a minimum of
 * zero, which is why the screen renders "Not set" for it rather than "0".
 *
 * ⚠️ The post-sale `LOW_STOCK_AFTER_SALE` warning deliberately uses `<=` instead. It is
 * documented as firing when stock "fell **to or** below" the level
 * (`../../bmbackend/docs/API-SPECIFICATION.md §4.3`) and answers a different question —
 * *reorder this soon* after a sale, rather than *this is short right now*. Do not
 * "fix" the difference by aligning one to the other.
 */
export function isLow(row: StockBalance): boolean {
  if (row.reorder_level === null || row.reorder_level === undefined) return false;
  return parseMoney(row.quantity).lt(parseMoney(row.reorder_level));
}

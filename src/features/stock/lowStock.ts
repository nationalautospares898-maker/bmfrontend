/**
 * The low-stock rule, in one place.
 *
 * Its own module so `StockScreen.tsx` exports only components, and so the boundary — the
 * part of this that is easy to get wrong — can be tested without rendering a screen.
 */

import type { StockBalance } from '@/api/types';
import { parseMoney } from '@/lib/money';

/**
 * Is this item at or below **its own** minimum?
 *
 * ⚠️ **`<=`, changed from `<` on 2026-11-22 by owner decision.** A part with a minimum
 * of 10 and 10 on the shelf **is** low: `reorder_level` means *reorder when you reach
 * this*, so reaching it is the moment that matters.
 *
 * This used to be one of two rules. The listing surfaces compared `<` while the
 * post-sale warning and the notification producers compared `<=`, so the Stock screen
 * and the notification bell could disagree about the same part — and a part sold down to
 * exactly its minimum was alerted and then silently un-alerted. There is now **one**
 * rule, and this is the client's copy of it. The server's copies are
 * `InventoryService.balances(low_stock_only=True)`, `ProductView.is_low_stock`,
 * `ReportService.stock_position`, `domain/notifications/low_stock.py` and
 * `SalesService._low_stock_warnings`, all `<=`. They move together or not at all; the
 * authority is `ProductView.is_low_stock`'s docstring.
 *
 * The threshold is **per product** (`products.reorder_level`), set item by item — never
 * one figure applied to the whole catalogue.
 *
 * A product with **no** minimum set is never low. A missing minimum is not a minimum of
 * zero, which is why the screen renders "Not set" for it rather than "0".
 */
export function isLow(row: StockBalance): boolean {
  if (row.reorder_level === null || row.reorder_level === undefined) return false;
  return parseMoney(row.quantity).lte(parseMoney(row.reorder_level));
}

/**
 * How many rows the invoice grid renders.
 *
 * Its own module so `BillGrid.tsx` exports only a component (which is what keeps Vite's
 * fast refresh working), and so the rule can be tested without rendering anything.
 */

/**
 * The owner's sheet shows fifteen numbered rows whether or not they are used.
 *
 * Seeing three rows for a three-line bill was the specific complaint after the first
 * demo: the bill should look like the bill, not grow out of nothing.
 */
export const VISIBLE_ROWS = 15;

/**
 * Always at least fifteen, and always one spare below the last filled row.
 *
 * The spare is why this is `+ 1` rather than `max(15, lineCount)`: when the cashier fills
 * row 15 and moves on, row 16 is already there and they never have to ask for one
 * (R5.5).
 */
export function rowCount(lineCount: number): number {
  return Math.max(VISIBLE_ROWS, lineCount + 1);
}

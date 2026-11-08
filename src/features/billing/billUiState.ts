/**
 * One bill's **screen** state — what the workspace is doing about a bill, as opposed to
 * what is on it.
 *
 * ## Why none of this is in the draft
 *
 * An advance is taken at finalisation and is not part of the bill; a conflict is the
 * server's answer to one attempt; an oversell approval is an exception granted for one
 * attempt. Persisting any of it to Dexie would mean a reload could resurrect an
 * approval nobody re-made, which is exactly the thing `§5 rule 12` and E-5 exist to
 * prevent. Totals, lines and header fields are the draft's; this is the screen's.
 *
 * ## Why it is not inside the column either
 *
 * That is where it started, and it was wrong. The workspace renders three columns and a
 * bill scrolling out of the window **unmounts** its one — so the advance a cashier had
 * typed and the shortfall the server had just reported vanished the moment they looked
 * at another bill, and a finalisation still in flight had nowhere to deliver its
 * outcome. Reported by the owner as "I update a bill, make a few more, come back and it
 * has reset".
 *
 * So `BillingCounter` holds one of these per bill and a column is a view of it.
 *
 * ## Keyed by draft id, never by column
 *
 * A map keyed by position — "the middle column" — would hand bill 4's advance to bill 5
 * the instant the window rolled. That is the one mistake in this feature that would
 * cost real money, and addressing by id is what makes it unreachable: the same rule
 * every mutation in `draftStore` already follows.
 *
 * ## Its own module
 *
 * So `BillPanel.tsx` exports only components and Vite's fast refresh keeps working —
 * the same reason `rowCount` lives in `gridRows.ts` rather than in `BillGrid.tsx`.
 */

import type { ErrorCode } from '@/api/errors';

/**
 * A business conflict raised against one bill.
 *
 * Rendered as an inline panel above that bill's buttons, never as a toast (PRD §6.1):
 * a toast can be missed while looking at a customer, and these block a sale.
 */
export type Conflict =
  | { kind: 'error'; code: ErrorCode; details: Record<string, unknown> }
  | { kind: 'money'; message: string }
  | { kind: 'unconfirmed'; stale: boolean }
  | null;

export interface BillUiState {
  /** The optional advance on a credit bill. A **string**, like every amount (ADR-013). */
  advance: string;
  advanceMethod: string;
  /**
   * A finalisation is in flight for this bill.
   *
   * Held out here with the rest so the in-flight state survives the column. A `busy`
   * that reset when the bill scrolled away would re-enable `Print Bill` on a sale that
   * was still being committed — and the customer may already have been charged.
   */
  busy: boolean;
  conflict: Conflict;
  /** Only ever set after the server has reported a shortfall, and never carried over. */
  oversellApproved: boolean;
  oversellReason: string;
}

/** What a bill starts with, and what a bill with no entry yet reads as. */
export const EMPTY_BILL_UI: BillUiState = {
  advance: '',
  advanceMethod: 'cash',
  busy: false,
  conflict: null,
  oversellApproved: false,
  oversellReason: '',
};

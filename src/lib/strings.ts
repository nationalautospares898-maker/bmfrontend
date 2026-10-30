/**
 * Every user-facing string, in one file the owner can review (§10).
 *
 * Two reasons this is not scattered through components:
 *
 * 1. The four primary action labels are **owner-decided** (OD-14) and must be
 *    changeable in one place, not hunted for across a dozen files.
 * 2. Counter staff have little computer experience, so every message has to say what
 *    happened **and what to do next** — which is easier to review as a list than as
 *    fragments inside JSX.
 *
 * No HTTP status codes, no jargon, no stack traces (§10).
 */

export const ACTIONS = {
  /** OD-14. Exactly four primary actions, and no fifth. */
  printBill: 'Print Bill',
  creditBill: 'Credit Bill',
  saveDraft: 'Save a Draft',
  clearDraft: 'Clear Draft',
} as const;

export const ACTION_SHORTCUTS = {
  printBill: 'Ctrl+Enter',
  creditBill: 'Ctrl+Shift+Enter',
  saveDraft: 'Ctrl+S',
  clearDraft: 'Ctrl+Shift+Backspace',
} as const;

export const BILLING = {
  searchPlaceholder: 'Type a part name or code',
  searchLabel: 'Find an item',
  /** The total on screen is a preview; the server confirms it on completion. */
  totalPreviewLabel: 'Total (preview — confirmed on completion)',
  columnSerial: 'S.No',
  columnItem: 'Item',
  columnQuantity: 'Qty',
  columnUnitPrice: 'Unit Price',
  columnTotal: 'Total',
  columnRemove: 'Remove',
  removeUndo: 'Removed. Undo',
  stockAnnotation: (quantity: string, asOf: string) =>
    `In stock: ${quantity} (as of ${asOf})`,
  lowStockAnnotation: (quantity: string) => `Only ${quantity} left`,
  outOfStockAnnotation: 'Not in stock — the server will check when you complete the bill',
  inactiveProduct: 'This item is no longer stocked',
  newTab: 'New bill',
  tabLimitReached: (max: number) =>
    `All ${max} bill tabs are in use. Complete or clear one before starting another. ` +
    'Nothing will be closed for you.',
  clearDraftConfirm: (lines: number) =>
    `Clear this bill? ${lines} item${lines === 1 ? '' : 's'} will be removed. ` +
    'This does not affect any completed bill.',
  clearDraftBlocked:
    'This bill cannot be cleared yet — we are still confirming whether it was completed. ' +
    'Check Daily Bills first.',
  creditNeedsCustomer: 'Choose or add a customer before using Credit Bill.',
} as const;

export const CREDIT = {
  /** FR-CREDIT-013/026. The confirmation must say this: it is how a cashier knows the
   *  sale is done and the stock is already down. */
  stockUpdated: 'Stock has been updated.',
  confirmationTitle: 'Credit bill completed',
  outstandingLabel: 'Outstanding',
  dueDateLabel: 'Due',
  printNow: 'Print now',
  /** No print dialog opens for a credit bill (OD-21). */
  printLater: 'You can print this later from Daily Bills.',
} as const;

export const OFFLINE = {
  banner: 'Working offline — bills are being saved on this computer.',
  /** `Credit Bill` is refused offline exactly like `Print Bill`: since ADR-033 it
   *  finalises a sale. "Credit" is about who owes money, never about whether the sale
   *  happened. */
  finalisationDisabled:
    'Completing a bill needs a connection. Your bill is saved here and nothing is lost.',
  paymentDisabled: 'Recording a payment needs a connection.',
  counterSlip: 'Print a counter slip',
  counterSlipNote: 'A counter slip is not a bill and does not complete the sale.',
  storageUnavailable:
    'This computer cannot save bills offline right now. You can keep billing while ' +
    'connected, but do not rely on bills surviving a restart. Tell the owner.',
  deviceRevoked:
    'This computer is no longer allowed to use the system. Nothing on it has been ' +
    'deleted. Ask the owner to allow it again.',
  notConfirmed:
    'We could not confirm whether this bill was completed. Do not bill it again — ' +
    'check Daily Bills first.',
  notConfirmedStale:
    'This bill is still unconfirmed. Stop retrying and check Daily Bills to see ' +
    'whether it went through.',
} as const;

export const ERRORS = {
  insufficientStock: 'There is not enough stock for some items.',
  insufficientStockLine: (name: string, requested: string, available: string) =>
    `${name}: you entered ${requested}, only ${available} in stock.`,
  priceChanged:
    'Some prices changed since this bill was started. Check them before completing.',
  priceChangedLine: (name: string, was: string, now: string) =>
    `${name}: was ${was}, now ${now}.`,
  draftVersionConflict:
    'This bill was changed on another computer. Choose which version to keep.',
  draftAlreadyFinalized:
    'This bill was already completed. Open it from Daily Bills instead of billing again.',
  totalMismatch:
    'The total on screen does not match the server. Reload the bill and check it before ' +
    'completing.',
  permissionDenied: 'You do not have permission to do this. Ask a supervisor.',
  oversellNotPermitted: 'Selling below stock needs a supervisor.',
  oversellReasonRequired: 'Give a reason of at least 10 characters.',
  creditLimitExceeded: 'This sale would take the customer past their credit limit.',
  creditCustomerRequired: 'A credit bill needs a saved customer, not just a typed name.',
  signInAgain: 'Please sign in again. Your bills are safe.',
  accountLocked: (seconds: number) =>
    `Too many failed attempts. Try again in about ${Math.ceil(seconds / 60)} minutes.`,
  unexpected:
    'Something went wrong and nothing was saved. Try again, and tell the owner if it ' +
    'keeps happening.',
  serviceUnavailable: 'The system is briefly unavailable. Your bill is safe here.',
  /** The whole-rupee rule (addendum §3). Never rounded for the user. */
  wholeRupeeRequired: (amount: string) =>
    `${amount} includes paise, which this bill format cannot show. ` +
    'Adjust the amount — it will not be rounded for you.',
} as const;

export const PRINT = {
  /** OD-24 / FR-PRINT-021: `ESTIMATE` for cash and credit alike. `BILL`, `INVOICE` and
   *  `Tax Invoice` must never appear as source literals. */
  thankYou: 'THANK YOU  VISIT AGAIN',
  duplicateCopy: 'DUPLICATE COPY',
  counterSlipTitle: 'COUNTER SLIP',
  counterSlipWatermark: 'NOT A BILL',
  /** Printed column headers are the owner's own, and deliberately not the on-screen
   *  labels (`UI-UX-SPECIFICATION.md §12.1`). The app is not a spreadsheet replica;
   *  the bill is. */
  columnSerial: 'S R',
  columnItem: 'ITEM',
  columnQuantity: 'QTY',
  columnPrice: 'PRICE',
  columnTotal: 'TOTAL',
  grandTotal: 'GRAND TOTAL',
  estimate: 'ESTIMATE',
  paid: 'Paid',
  balance: 'Balance',
  due: 'Due',
} as const;

export const COMMON = {
  loading: 'Loading…',
  retry: 'Retry',
  cancel: 'Cancel',
  save: 'Save',
  close: 'Close',
  emptyList: 'Nothing to show yet.',
  asOf: (time: string) => `as of ${time}`,
} as const;

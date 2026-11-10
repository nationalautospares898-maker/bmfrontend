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

  // --- the optional advance on a credit bill (owner request, 2026-11-07) ------
  //
  // A **field**, not a fifth action: OD-14 settles the four primary actions and says
  // there is no fifth, and this does not need one.
  /**
   * Shown where the shop's name used to sit, at the top of each bill column.
   *
   * The owner asked for it there when the workspace became three bills wide: the shop
   * name is already the application's own heading and repeating it over every column
   * spent the one row this field needed. Still optional, still not a fifth action.
   */
  advanceLabel: 'Advance Received',
  /**
   * No longer rendered under the field.
   *
   * The field moved into the bill's own header, where a column is a third of the screen
   * wide and a second line of help under it pushed a row off the grid. What it says is
   * said better by the field being empty and by `advancePreview` appearing the moment
   * an amount is typed — and the word *optional* is in `advanceLabel`'s own docstring
   * rather than in the label, which the owner wanted short. Kept because the owner
   * reviews this file and a string that was approved should not vanish without a note.
   */
  advanceHint: 'Leave blank if nothing was paid now.',
  advanceMethod: 'Paid by',
  /** Spelled out so the advance is never read as a discount on the bill. */
  advancePreview: (total: string, advance: string, outstanding: string) =>
    `Bill ${total} − advance ${advance} = ${outstanding} outstanding. ` +
    `The bill total stays ${total}.`,
} as const;

export const ACTION_SHORTCUTS = {
  printBill: 'Ctrl+Enter',
  creditBill: 'Ctrl+Shift+Enter',
  saveDraft: 'Ctrl+S',
  clearDraft: 'Ctrl+Shift+Backspace',
} as const;

/**
 * The navigation the owner asked for after the first demo: six sections, vertical, on
 * the right. These six and nothing else.
 *
 * `Imports`, `Counters` and `Purchases` are deliberately **absent**. They are product
 * decisions, not deletions — the screens, their routes and every backend module behind
 * them are untouched. `Counters` was the last to go and could only go once the server
 * stopped needing it: a computer now prepares itself for billing on first sign-in, so
 * there is no stranded state left for the screen to rescue (see `AppShell`).
 */
export const NAV = {
  label: 'Sections',
  billing: 'Billing',
  dailyBills: 'Daily Bills',
  creditBills: 'Credit Bills',
  canceledBills: 'Canceled Bills',
  stock: 'Stock',
  customers: 'Customers',
  orders: 'Orders',
  sync: 'Saving and syncing',
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
  // --- the bill header, as the owner's own sheet labels it ---------------------
  //
  // These are the ON-SCREEN labels for the spreadsheet workspace the owner approved
  // after the first demo. The PRINTED bill keeps its own headers in `PRINT` below
  // (`S R · ITEM · QTY · PRICE · TOTAL`) — the two surfaces still have different
  // audiences, and `print.css` is still isolated from application styling (ADR-028).
  // What changed is only that the *screen* now follows the sheet too.
  estimate: 'ESTIMATE',
  headerCustomer: 'Customer Name',
  headerMechanic: 'Mechanic Name',
  headerVehicle: 'Vehicle Number',
  headerDate: 'Date',
  grandTotal: 'GRAND TOTAL',
  columnPrice: 'Price',
  gridLabel: 'Bill items',
  /** FR-BILL-011 — an empty bill still tells the user what to do. */
  emptyHint: 'Type a part name or code in the Item column to start this bill.',
  cellItemLabel: (row: number) => `Item, row ${row}`,
  cellQuantityLabel: (row: number) => `Quantity, row ${row}`,
  cellPriceLabel: (row: number) => `Price, row ${row}`,
  removeRow: (name: string) => `Remove ${name}`,
  /** Shown once, under the grid: the keys that move the cursor. */
  keyboardHint:
    'Tab or the arrow keys move between cells. Enter moves down a row. ' +
    'While a product list is open, the arrows choose from it and Enter picks.',
  closeTab: (label: string) => `Close ${label}`,
  closeTabTitle: 'Close this bill?',
  closeTabHasWork: (lines: number) =>
    `This bill has ${lines} item${lines === 1 ? '' : 's'} on it. ` +
    'Closing it discards them. Save it as a draft instead if you want to come back to it.',
  closeTabSaveFirst: 'Save it as a draft',
  closeTabDiscard: 'Discard this bill',
  closeTabKeep: 'Keep this bill open',
  removeUndo: 'Removed. Undo',
  stockAnnotation: (quantity: string, asOf: string) =>
    `In stock: ${quantity} (as of ${asOf})`,
  lowStockAnnotation: (quantity: string) => `Only ${quantity} left`,
  outOfStockAnnotation: 'Not in stock — the server will check when you complete the bill',
  inactiveProduct: 'This item is no longer stocked',
  // --- the three-bill workspace (owner request, 2026-11-08) --------------------
  //
  // Three bills are on screen at once and the tab strip is how the other twelve are
  // reached. Each of these names a *position*, never an invoice: a bill's number here is
  // where it sits in the open tabs and changes when one is closed. There is still no
  // invoice number anywhere in this application (OD-3).
  /** The accessible name of one bill column, so three identical grids are tellable apart. */
  panelLabel: (position: number, name: string) => `Bill ${position}: ${name}`,
  /** The tab's accessible name: its position, then whoever the bill is for. */
  tabLabel: (position: number, name: string) => `Bill ${position}: ${name}`,
  /** Said once under the three columns rather than three times over. */
  workspaceHint:
    'Three bills are shown at a time. Choose any bill from the tabs above and it opens ' +
    'on the left, with the next two beside it.',
  newTab: 'New bill',
  /**
   * The accessible name of the **action**, distinct from a tab that happens to be
   * *called* `New bill` until its first product renames it. Two controls with one name
   * is ambiguous for a screen reader and for anyone saying "click New bill". The visible
   * text stays `+ New bill`, which this contains, so WCAG 2.5.3 still holds.
   */
  newTabAction: 'Start a new bill',
  tabLimitReached: (max: number) =>
    `All ${max} bill tabs are in use. Complete or clear one before starting another. ` +
    'Nothing will be closed for you.',
  clearDraftConfirm: (lines: number) =>
    `Clear this bill? ${lines} item${lines === 1 ? '' : 's'} will be removed. ` +
    'This does not affect any completed bill.',
  clearDraftBlocked:
    'This bill cannot be cleared yet — we are still confirming whether it was completed. ' +
    'Check Daily Bills first.',
  // The customer picker (FR-CREDIT-009). Plain words: the cashier is looking for a
  // person, not performing a lookup against a directory.
  findCustomer: 'Find a saved customer',
  findCustomerHint: 'Name, phone or vehicle number. Needed for a credit bill.',
  billingTo: 'Billing to:',
  changeCustomer: 'Change',
  customerNotFound: 'No saved customer matches that.',
  /** Shown beside the matches, because two customers can genuinely share a name. */
  notTheRightCustomer: 'Not the right person?',
  saveAsNewCustomer: 'Save as a new customer',
  duplicateSuspected: 'This may already be a customer',
  creditNeedsCustomer: 'Choose or add a customer before using Credit Bill.',

  // --- the mechanic picker -----------------------------------------------------
  //
  // Deliberately the same vocabulary as the customer picker above: the cashier should
  // not have to learn that one field is a "lookup" and the other a "search".
  findMechanic: 'Mechanic Name',
  findMechanicHint: 'Start typing, or pick a recent one.',
  mechanicRecent: 'Recently used',
  mechanicNoMatch: 'No saved mechanic matches that. It will be saved when you move on.',
  mechanicSaveFailed:
    'That mechanic could not be saved for next time. The name is still on this bill.',

  // --- adding a missing item from the bill (owner request, 2026-11-07) ---------
  //
  // Offered **only** when the search found nothing and only to a user holding
  // `catalog.write`. See `ItemCell`'s docstring for why it is gated that tightly.
  addMissingItem: 'Add New Item to Stock',
  addMissingItemNoMatch: (name: string) => `Nothing in stock matches “${name}”.`,
  /**
   * Shown when the search **did** return something, but nothing that is actually the
   * part the cashier typed.
   *
   * This is the `Damage Filter` / `Diesel Filter` case the owner reported: the two share
   * enough trigrams for a fuzzy match, so the list is not empty, and the old copy
   * ("Nothing in stock matches") would have been a lie while the only offer on screen
   * was the wrong part. Naming what was typed is the whole point — the cashier has to be
   * able to see that the suggestion below is **not** it.
   */
  addMissingItemNotListed: (name: string) =>
    `None of these is “${name}” — the matches above are only suggestions.`,
  addMissingItemTitle: 'Add a new item to stock',
  /** Creating a catalogue entry never records a delivery or changes inventory. */
  addMissingItemIntro:
    'This creates a catalogue product and puts it on this bill. It records no stock. ' +
    'If stock is short, an owner or manager can choose an audited oversell override.',
  addMissingItemName: 'Item name',
  addMissingItemPrice: 'Selling price',
  addMissingItemMinQty: 'Minimum quantity',
  addMissingItemMinQtyHint: 'Used for the low-stock warning. 10 unless you change it.',
  addMissingItemSave: 'Create and add to the bill',

  addMissingItemNeedName: 'Enter a name for the item.',
  addMissingItemNeedPrice: 'Enter a selling price.',
  /** Stated plainly, because a created product with no stock will read as oversold. */
  addMissingItemStockNote:
    'Stock for this item is zero until a delivery is recorded, so completing this bill ' +
    'may need an oversell override.',
  oversellApprovalLabel: 'I approve this sale against insufficient recorded stock',
  oversellApprovalWarning:
    'This does not add stock. The sale will be marked as an authorised oversell, the ' +
    'recorded balance may become negative, and this reason will be audited.',
  oversellReasonLabel: 'Reason (required)',
  oversellReasonRequired: 'Enter a reason with at least 10 characters before retrying.',
  oversellRetryHint: 'Choose Print Bill or Credit Bill again to complete this sale.',

  // --- the physical-collection tick (owner request, 2026-11-07) ----------------
  //
  // A note to self for the person packing the order. It is **not** a stock movement,
  // not a financial field, never printed, and never sent to the server.
  columnCollected: 'Got it',
  columnCollectedTitle: 'Tick when the physical item has been brought to the counter',
  collectedLabel: (name: string) => `${name} has been brought to the counter`,
  collectedHint:
    'For your own use while packing. It is not printed and does not change the bill.',
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

export const AUTH = {
  changePasswordTitle: 'Set a new password',
  changePasswordIntro:
    'Your account was created with a temporary password. Set a new one to continue — ' +
    'nothing else needs to happen first.',
  currentPasswordLabel: 'Current password',
  newPasswordLabel: 'New password',
  confirmPasswordLabel: 'Confirm new password',
  submit: 'Set password',
  signOutInstead: 'Sign out instead',
  // Mirrors the server's own floor (`bm.domain.auth.hashing.MIN_PASSWORD_LENGTH`) so the
  // user hears about it before a round trip, not instead of the server's own check.
  tooShort: 'Use at least 10 characters. A short phrase works well.',
  mismatch: 'Those two passwords do not match.',
  sameAsCurrent: 'Choose a password you have not used here.',
  currentPasswordWrong: 'Your current password is incorrect.',
  passwordChangedSignInAgain: 'Password changed. Sign in with your new password.',
} as const;

export const ERRORS = {
  /**
   * The last resort on the billing screen, and it should never be seen.
   *
   * Signing in prepares this computer for billing automatically, so this wording covers
   * only the case no login can fix: a shop with no active counter at all. It names no
   * screen, because the one that used to be named has been withdrawn, and it does not
   * ask the user to do something the application cannot offer them.
   */
  billingNotReadyTitle: 'Billing is not ready on this computer',
  billingNotReady:
    'This computer could not be prepared for billing. Try signing out and in again. ' +
    'If it still will not start, the shop needs setting up by whoever installed it. ' +
    'Any bills already saved on this computer are safe.',
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

/**
 * The application's own name, as this build is packaged.
 *
 * **Not a business fact, and not a substitute for one.** The shop's identity comes from
 * `/sync/bootstrap` and is what the shell shows whenever it is there; this is the
 * fallback for the two places that cannot have it — the sign-in screen, which has no
 * session yet, and the moment before a profile loads. It matches `index.html`'s
 * `<title>` and the web manifest's `name`, which already carry it, so the heading and
 * the browser tab say the same thing rather than one of them going blank.
 *
 * Nothing is ever *printed* from here: the bill's heading block comes from the server's
 * own payload, verbatim (FR-PRINT-016, ADR-028).
 */
export const APP = {
  name: 'National Auto Spares',
} as const;

export const COMMON = {
  loading: 'Loading…',
  retry: 'Retry',
  cancel: 'Cancel',
  save: 'Save',
  close: 'Close',
  refresh: 'Refresh',
  actions: 'Actions',
  emptyList: 'Nothing to show yet.',
  asOf: (time: string) => `as of ${time}`,
} as const;

// --- M25 screens --------------------------------------------------------------
//
// Every label is a sentence a shopkeeper would say. No jargon from the data model
// reaches the screen: the table shows "Running low", not `reorder_level breached`, and
// the stock control says "Adjust", not "Create movement".

export const STOCK = {
  title: 'Stock',
  filterLabel: 'Find an item',
  filterHint: 'Part code or name. Separators do not matter.',
  lowStockOnly: 'Only what is running low',
  tableCaption: 'Stock on hand, with reorder levels',
  // --- the inline +/- control (owner request, 2026-11-10) ---------------------
  quickAdjustReason: 'Quick adjustment from the Stock page',
  quickIncrease: (name: string) => `Increase stock of ${name} by one`,
  quickDecrease: (name: string) => `Decrease stock of ${name} by one`,
  colItem: 'Item',
  colQuantity: 'In stock',
  colReorder: 'Reorder at',
  lowBadge: 'Running low',
  noReorderLevel: 'Not set',
  viewHistory: 'History',
  adjust: 'Adjust',
  emptyNoStock: 'No stock has been recorded yet.',
  emptyNoLowStock: 'Nothing is running low.',
  emptyNoMatch: 'No item matches what you typed.',
  historyTitle: 'Stock history',
  historyCaption:
    'Every change to this item’s stock, oldest first, so the running total reads downwards',
  colWhen: 'When',
  colWhy: 'What happened',
  colChange: 'Change',
  colAfter: 'In stock after',
  emptyNoMovements: 'Nothing has moved for this item yet.',
  wasOversold: '(sold below zero)',
  adjustTitle: 'Correct the stock',
  currentQuantity: 'In stock now',
  whatHappened: 'What happened?',
  reasonDecrease: 'There is less than the system says',
  reasonIncrease: 'There is more than the system says',
  reasonScrap: 'Damaged or thrown away',
  howMany: 'How many?',
  howManyHint: 'The difference, not the new total.',
  why: 'Why?',
  whyHint: 'Recorded permanently. Say what you found.',
  afterThis: 'In stock after this',
  recordAdjustment: 'Record the correction',
  amountMustBePositive: 'Enter how many — more than zero.',
  reasonRequired: 'Say why. This is kept as a permanent record.',
  wouldGoNegative: 'That would take the stock below zero. Check the number.',
  // --- the owner's four-column entry sheet -------------------------------------
  //
  // Wording chosen so nobody can read `Stock Qty` as a new total. "How many came in"
  // and the live `20 + 200 = 220` preview both say the same thing, because getting this
  // wrong destroys real inventory and the ledger would agree with itself afterwards.
  addItems: 'Add Items',
  sheetTitle: 'Add stock',
  sheetExplainer:
    'One row per item. Stock Qty is how many came in now — it is added to what is ' +
    'already on the shelf, never used to replace it.',
  colPrice: 'Price',
  colMinQty: 'Min Qty',
  colStockQty: 'Stock Qty',
  sheetAddRow: 'Add another row',
  sheetRemoveRow: (row: number) => `Remove row ${row}`,
  sheetSave: 'Save these items',
  sheetCancel: 'Cancel',
  sheetNewItem: 'New item',
  sheetExisting: (current: string, incoming: string, after: string) =>
    `In stock ${current} + ${incoming} = ${after}`,
  sheetExistingShort: 'Adds to existing stock',
  sheetAmbiguous: 'More than one item has this name — open Stock and pick the right one.',
  sheetInactive: 'This item is no longer stocked. Make it active again first.',
  sheetNeedRow: 'Fill in at least one row.',
  sheetNeedName: 'Every filled row needs an item name.',
  sheetNeedQty: 'Every filled row needs a Stock Qty above zero.',
  sheetNeedPrice: 'Every filled row needs a price.',
  sheetDuplicate: (row: number) =>
    `Already on row ${row}. Put the whole quantity on one row.`,
  sheetSaved: (count: number, created: number) =>
    `Saved ${count} item${count === 1 ? '' : 's'}. ${created} new, ${count - created} topped up.`,
  sheetKeyboardHint:
    'Tab or the arrow keys move between cells. Enter moves down to the next row.',
  colReference: 'Bill',
  noReference: '—',
  lowStockHeading: 'Running low',
  lowStockListLabel: 'Items running low',
  lowStockEmpty: 'Nothing is below its minimum quantity.',
  lowStockLine: (current: string, minimum: string) =>
    `${current} left, minimum ${minimum}`,
  /** The boundary, said out loud, because "below" and "at or below" are not the same. */
  lowStockRule: 'An item is listed here once its stock falls below its own Min Qty.',

  // --- the day's stock movement report -----------------------------------------
  //
  // The per-product History answers "what happened to this part". This answers the
  // other question the owner asks at closing time: "what moved today?"
  reportAction: 'Stock Movement Report',
  reportTitle: 'Stock movement on one day',
  reportClose: 'Close report',
  /**
   * Named apart from the Stock page's own `Refresh`, which is still on screen behind the
   * report. Two buttons both called "Refresh" is ambiguous for anyone saying "press
   * Refresh" and for a screen reader reading the page twice over; the component test
   * found the collision.
   */
  reportRefresh: 'Refresh report',
  reportDateLabel: 'Start date',
  /** Owner request (2026-11-11): a date range, not only one day. Defaults to Start date. */
  reportEndDateLabel: 'End date',
  reportAdded: 'Stock Added',
  reportSold: 'Stock Sold',
  /** `adjusted`: every decrease that is not a sale — a correction, scrap, a transfer out. */
  reportAdjusted: 'Adjustments',
  reportTableAdded: 'Stock added in the chosen period',
  reportTableSold: 'Stock sold in the chosen period',
  reportTableAdjusted: 'Stock adjustments in the chosen period',
  reportEmptyAdded: 'No stock was added in this period.',
  reportEmptySold: 'Nothing was sold in this period.',
  reportEmptyAdjusted: 'No adjustments in this period.',
  reportColProduct: 'Product',
  reportColCode: 'Product Code',
  reportColQtyAdded: 'Quantity Added',
  reportColQtySold: 'Quantity Sold',
  reportColQtyAdjusted: 'Quantity Adjusted',
  reportColBefore: 'Stock Before',
  reportColAfter: 'Stock After',
  reportColMovement: 'Movement Type',
  /** `stock_count`, `purchase`, `manual`, … — distinguishes a count correction from a
   *  manual one even though both can carry the same `Movement Type`. */
  reportColSource: 'Source',
  reportColReference: 'Reference',
  reportColInvoice: 'Invoice Number',
  reportColSaleType: 'Sale Type',
  reportColTime: 'Time',
  reportCash: 'Cash',
  reportCredit: 'Credit',
  /** A bill cancelled later: the deduction stands, and its reversal is in Stock Added. */
  reportCancelled: 'Cancelled',
  reportSummaryProducts: 'Products affected',
  reportSummaryQuantityAdded: 'Total quantity added',
  reportSummaryQuantitySold: 'Total quantity sold',
  reportSummaryQuantityAdjusted: 'Total quantity adjusted',
  reportSummaryMovements: 'Stock movements',
  reportSummaryInvoices: 'Invoices',
  /** `stock_count`, `purchase`, `invoice`, `stock_sheet`, `manual`, … in the owner's words. */
  reportSource: (sourceType: string | null): string =>
    sourceType === null
      ? '—'
      : ({
          stock_count: 'Stock Count',
          invoice: 'Bill',
          purchase: 'Purchase',
          stock_sheet: "Owner's sheet",
          manual: 'Manual',
        })[sourceType] ?? sourceType,
  /** Said plainly rather than letting a capped list look complete. */
  reportTruncated:
    'This day had more movements than can be shown at once. The figures above cover the ' +
    'movements listed.',
  /** The movement vocabulary, in the owner's words rather than the database's. */
  reportReason: (reason: string): string =>
    ({
      opening: 'Opening stock',
      purchase_receipt: 'Purchase',
      adjustment_increase: 'Correction (more)',
      adjustment_decrease: 'Correction (less)',
      sale: 'Sale',
      sale_cancellation: 'Cancelled bill returned',
      customer_return: 'Customer return',
      supplier_return: 'Returned to supplier',
      transfer_in: 'Transferred in',
      transfer_out: 'Transferred out',
      import_apply: 'Imported',
      scrap: 'Scrapped',
    })[reason] ?? reason,
} as const;

// --- physical stock count (Feature A.6, 2026-11-10) -----------------------------
export const STOCK_COUNT = {
  title: 'Stock Count',
  explanation:
    'Count what is actually on the shelf. Nothing changes until you finalize — ' +
    'cancel any time before that and nothing is applied.',
  progress: (counted: number, total: number) => `${counted} of ${total} counted`,
  colItem: 'Item',
  colSystem: 'System Qty',
  colCounted: 'Counted Qty',
  colDiscrepancy: 'Discrepancy',
  countedLabel: (name: string) => `Counted quantity for ${name}`,
  notCounted: 'Not counted',
  filterLabel: 'Find an item',
  filterHint: 'Part code or name. Separators do not matter.',
  noMatches: 'No items match that search.',
  save: 'Save',
  finalize: 'Finalize',
  cancelCount: 'Cancel Count',
  confirmFinalizeTitle: 'Apply this stock count?',
  confirmFinalizeBody: (counted: number, discrepancies: number) =>
    `${counted} item(s) were counted, ${discrepancies} with a discrepancy. This writes ` +
    'an adjustment for each discrepancy and cannot be undone — only reversed by ' +
    'another count or adjustment.',
  confirmFinalizeAction: 'Yes, apply it',
  confirmCancelTitle: 'Cancel this stock count?',
  confirmCancelBody: 'Nothing counted so far will be applied. This cannot be undone.',
  confirmCancelAction: 'Yes, cancel it',
} as const;

export const PURCHASES = {
  title: 'Purchases',
  newPurchase: 'Record a supplier bill',
  tableCaption: 'Supplier bills, newest first',
  colSupplier: 'Supplier',
  colDocument: 'Their bill no.',
  colDate: 'Date',
  colLines: 'Items',
  colTotal: 'Total',
  colStatus: 'Status',
  statusDraft: 'Entered, not received',
  statusConfirmed: 'Received into stock',
  statusCancelled: 'Cancelled',
  confirm: 'Receive into stock',
  cancelPurchase: 'Cancel',
  empty: 'No supplier bills recorded yet.',
  // The distinction the whole screen turns on (FR-PUR-003).
  draftExplainer:
    'Entering a supplier bill records what it says. Stock only changes when you press “Receive into stock”.',
  confirmTitle: 'Receive these goods into stock?',
  confirmBody:
    'This adds the quantities on this bill to your stock. It cannot be undone from here.',
  alreadyReceived: 'This bill was already received. Nothing was added a second time.',
  supplier: 'Supplier',
  chooseSupplier: 'Choose a supplier',
  newSupplier: 'Add a supplier',
  supplierName: 'Supplier name',
  supplierPhone: 'Phone',
  documentNumber: 'Their bill number',
  documentDate: 'Date on their bill',
  notes: 'Notes',
  addLine: 'Add an item',
  removeLine: 'Remove',
  colCost: 'Cost each',
  colQuantity: 'Quantity',
  lineTotal: 'Line total',
  runningTotal: 'Total so far',
  savePurchase: 'Save the bill',
  needSupplier: 'Choose which supplier this bill is from.',
  needLines: 'Add at least one item.',
  needProduct: 'Choose an item for every line.',
  needQuantity: 'Every line needs a quantity above zero.',
  needCost: 'Every line needs a cost.',
  savedNotReceived:
    'Saved. Stock has not changed — press “Receive into stock” when the goods are on the shelf.',
} as const;

// --- Correcting a finalised bill ----------------------------------------------
//
// Written to be read by a cashier under pressure with a customer waiting, so it says
// what will happen in the order it will happen, and names the consequence before asking
// for a reason. The word "edit" is used for the button because that is what the person
// is trying to do; the dialog then explains, immediately, that a finalised bill is not
// altered but replaced — because the alternative is them believing they changed a bill
// that is in fact still on the record (OD-10, FR-SALE-010, ADR-015).

export const AMEND = {
  /**
   * **Renamed from `Edit Bill`** (2026-11-07).
   *
   * It was called that because there was no edit path — cancel-and-rebill was the only
   * correction, so it carried the name the cashier would look for. Real editing now
   * exists (`EDIT_BILL`), and leaving this label alone put two buttons both reading
   * "Edit Bill" in the same Daily Bills row: ambiguous to a person, ambiguous to a
   * screen reader, and found by a browser test that could not tell them apart.
   *
   * Cancellation has not gone away (owner Decision C) — it is the right answer when a
   * sale should not have happened at all. It just has its own honest name now.
   *
   * **Renamed again to `Delete Bill`** (2026-11-08), because the owner asked for "a
   * delete bill option in Daily Bills" and this *is* that option — they could not find
   * it under `Cancel & Re-bill`, which reads like a promise that a replacement bill is
   * compulsory (it is not: `cancelOnly` has always been there).
   *
   * **Nothing about the operation changed.** There is no hard delete, no new endpoint
   * and no second cancellation path: this is still the one `POST /invoices/{id}:cancel`
   * behind `CancellationService`, which reverses the stock, cancels what a credit
   * customer owes, and leaves the invoice in the list marked cancelled. `invoices` has
   * no `DELETE` grant and `stock_movements` is append-only, so a financial record cannot
   * be erased even deliberately — which is why the word *delete* is paired everywhere
   * below with what actually happens. A button the owner can find, in front of the safe
   * operation, beats a correctly-named button they never press.
   */
  action: 'Delete Bill',
  title: 'Delete this bill',
  howItWorksTitle: 'The bill is cancelled and kept in the record — never erased',
  howItWorks:
    'This is for a sale that should not have happened. Deleting the bill puts the stock ' +
    'back and, for a credit bill, cancels what the customer owes. The bill itself stays ' +
    'in the list marked cancelled, because a bill that was once issued is a permanent ' +
    'record and this system cannot erase one — you can start a replacement bill at the ' +
    'same time if you need to. To change what is **on** a bill instead — quantities, ' +
    'prices, the mechanic — use Edit Bill, which keeps the one bill and records what it ' +
    'said before.',
  originalBill: 'What is on this bill now',
  billTotal: 'Bill total',
  reason: 'Why is this bill being deleted?',
  reasonHint: 'Kept as a permanent record. At least a few words.',
  cancelAndRebuild: 'Delete it and start a replacement bill',
  /** The owner's "just get rid of it" path. It was always here; now it is findable. */
  cancelOnly: 'Just delete it',
  cancelledTitle: 'Bill deleted',
  cancelledBody:
    'The stock has been put back and the bill is marked cancelled. It keeps its number ' +
    'and stays in the list.',
  creditNoteNote:
    'This is a credit bill, so cancelling it also cancels what the customer owes for ' +
    'it. A credit note is recorded against their account.',
  cashNote: 'Cancelling puts the stock back and marks this bill cancelled.',
  cashRefundTitle: 'The money is not handled by the system',
  cashRefundBody: (amount: string) =>
    `This bill was paid ${amount} in cash. Cancelling it puts the stock back, but this ` +
    'system does not record cash going out — there is no refund entry anywhere in it. ' +
    'If you give the money back, that is between you and the till, and nothing here ' +
    'will show it.',
  cashRefundAcknowledge:
    'I understand the refund will not be recorded anywhere, and I will account for the ' +
    'cash myself.',
} as const;

// --- Credit Bills: what was actually bought -----------------------------------
//
// The screen could say how much a customer owed and which bills were open, but not what
// any of it was *for* — which is the question asked across the counter when someone
// queries a balance.

export const CREDIT_BILLS = {
  openBill: 'Open',
  whatWasBought: 'What was bought on this bill',
  billTotal: 'Bill total',
  noOpenBills: 'No credit bills for this customer.',
  /**
   * Said out loud, because the opposite was the owner's first-demo complaint: a paid
   * credit bill looked deleted. It never was — the list hid the customer once they owed
   * nothing. Now it does not, and the screen says so.
   */
  permanentRecord:
    'Every customer who has ever had a credit bill is listed here, including those who ' +
    'have paid in full. Open a customer to see all their bills, and a bill to see what ' +
    'was bought on it.',

  // --- the per-invoice actions (owner request, 2026-11-07) ---------------------
  viewFullBill: 'View Full Bill',
  hideFullBill: 'Hide Full Bill',
  receivePayment: 'Receive Payment',
  paymentHistory: 'Payment History',
  reprint: 'Reprint',

  // --- the full bill viewer ----------------------------------------------------
  fullBillTitle: 'The bill as it was issued',
  /** Said once, because the figures are historical and that is the whole point. */
  fullBillHistoricalNote:
    'Every figure below is the bill’s own saved copy — the prices, names and ' +
    'quantities as they were when it was issued, not today’s catalogue.',
  fieldReference: 'Bill reference (internal)',
  fieldCustomer: 'Customer Name',
  fieldBusinessName: 'Business',
  fieldMechanic: 'Mechanic Name',
  fieldVehicle: 'Vehicle Number',
  fieldPhone: 'Phone',
  fieldDate: 'Date',
  fieldDueDate: 'Due',
  fieldNotes: 'Notes',
  colSerial: 'S.No',
  colItem: 'Item',
  colCode: 'Code',
  colQuantity: 'Qty',
  colPrice: 'Price',
  colLineTotal: 'Total',
  subtotal: 'Subtotal',
  discount: 'Discount',
  tax: 'Tax',
  rounding: 'Rounding',
  grandTotal: 'GRAND TOTAL',
  creditAmount: 'Credit amount',
  paidAmount: 'Paid',
  outstanding: 'Outstanding',
  paymentStatus: 'Status',
  cancelled: 'Cancelled',

  // --- receiving a payment against one invoice ---------------------------------
  receiveTitle: 'Receive a payment on this bill',
  /**
   * The distinction from the Customers screen, stated so the two workflows cannot be
   * confused: that one allocates oldest-first across every open bill, this one pays
   * exactly the bill in front of you.
   */
  receiveHint:
    'This payment is recorded against this bill only. To let the shop allocate a ' +
    'payment across a customer’s oldest unpaid bills instead, use the Customers screen.',
  receiveAmount: 'Amount received',
  receiveMethod: 'Method',
  receiveReference: 'Reference (optional)',
  receiveSubmit: 'Record the payment',
  receiveNeedsAmount: 'Enter an amount greater than zero.',
  receiveOverpay: (outstanding: string) =>
    `That is more than the ${outstanding} still outstanding on this bill.`,
  receiveDone: 'Payment recorded.',
  settled: 'This bill is settled in full.',

  // --- payment history ---------------------------------------------------------
  historyTitle: 'Payments on this bill',
  historyEmpty: 'No payments have been recorded against this bill yet.',
  historyWhen: 'When',
  historyAmount: 'Amount',
  historyMethod: 'Method',
  historyReference: 'Reference',
} as const;

// --- Canceled Bills (owner request, 2026-11-10) ---------------------------------
export const CANCELED_BILLS = {
  title: 'Canceled Bills',
  explanation:
    'A cancelled bill is kept here for the record — it is removed from Daily Bills ' +
    'and Credit Bills so it never counts as an active sale or an active outstanding ' +
    'debt, but nothing about it is deleted.',
  noRows: 'No cancelled bills.',
  colType: 'Type',
  typeCash: 'Cash',
  typeCredit: 'Credit',
  colInvoice: 'Bill reference (internal)',
  colCustomer: 'Customer',
  colAmount: 'Amount',
  colCancelledAt: 'Cancelled on',
  colReason: 'Reason',
  view: 'View',
  hide: 'Hide',
} as const;

// --- Chitti orders (Feature B, 2026-11-10) --------------------------------------
export const ORDERS = {
  title: 'Orders',
  pending: 'Pending',
  completed: 'Completed',
  newOrder: '+ New Order',
  emptyPending: 'No pending orders. Click "+ New Order" to write one down.',
  emptyCompleted: 'No completed orders yet.',
  bodyPlaceholder: 'Write down the order — items, quantities, anything to remember…',
  customerName: 'Customer (optional)',
  phone: 'Phone (optional)',
  save: 'Save',
  markComplete: 'Mark Complete',
  trash: 'Trash',
  trashConfirm: 'Yes, trash it',
  confirmTrash: 'Discard this order?',
  /** Owner request (2026-11-11): a one-time reminder for one order, on top of the
   *  existing flat ten-minute nudge every pending order already gets. */
  reminderNone: 'No reminder set',
  reminderSet: (when: string): string => `Reminder: ${when}`,
  reminderOverdue: (when: string): string => `Overdue reminder: ${when}`,
  reminderSetAction: 'Set reminder',
  reminderChangeAction: 'Change',
  reminderClearAction: 'Clear',
  reminderSaveAction: 'Save',
  reminderCancelAction: 'Cancel',
  reminderLabel: 'Remind me at',
  reminderFailed: 'Could not update the reminder. Try again.',
} as const;

// --- the universal notification bell (Feature A.1/A.2, 2026-11-10) -------------
export const NOTIFICATIONS = {
  bellIcon: '🔔',
  bellLabel: (count: number) =>
    count > 0 ? `Notifications (${count} active)` : 'Notifications',
  panelTitle: 'Notifications',
  manageReminders: 'Manage reminders',
  close: 'Close',
  loading: 'Loading…',
  empty: 'Nothing needs your attention right now.',
  goTo: 'Go to',
  acknowledge: 'Acknowledge',
  snooze: 'Snooze 1 hour',
  dismiss: 'Dismiss',
  dismissLabel: (title: string) => `Dismiss: ${title}`,
  actionFailed: 'Could not update that notification. Try again.',
  /** Device-style (OS/browser) notifications (owner request, 2026-11-11) — on top of,
   *  never instead of, this in-app panel, which stays the fallback. */
  enableDevice: 'Get alerts on this device, even when you are not looking at this tab',
  enableDeviceAction: 'Enable',
  deviceEnabled: 'Device alerts are on for this browser.',
  deviceDenied:
    'Device alerts are blocked in this browser. In-app alerts (the bell) still work.',
  deviceUnsupported: 'This browser does not support device alerts. The bell still works.',
} as const;

// --- reminder management (Feature A.5, 2026-11-10) ------------------------------
export const REMINDERS = {
  title: 'Reminders',
  explanation:
    'The bill and stock reminders are always here. Add your own for anything else ' +
    'worth being nudged about.',
  colLabel: 'Reminder',
  colWhen: 'When',
  colStatus: 'Status',
  enabled: 'On',
  disabled: 'Off',
  enable: 'Turn on',
  disable: 'Turn off',
  remove: 'Remove',
  addTitle: 'Add a reminder',
  fieldLabel: 'What should it say?',
  triggerKind: 'When should it remind you?',
  triggerTime: 'At a time of day',
  triggerInterval: 'Every few hours',
  fieldTime: 'Time (business-local)',
  fieldInterval: 'Every how many hours (3-5)',
  add: 'Add reminder',
  addFailed: 'Could not add that reminder.',
  close: 'Close',
} as const;

/**
 * Editing a finalised bill (F7–F10; owner Decision A, 2026-11-07).
 *
 * The old `AMEND` strings explained that "Edit Bill" would cancel the bill and start a
 * replacement. They are kept, because cancellation is still a real and separate action
 * (Decision C) — these are the words for the thing that actually edits.
 */
export const EDIT_BILL = {
  action: 'Edit Bill',
  title: 'Edit this bill',
  /** What the operator needs to trust the action, instead of a warning about losing it. */
  whatIsKept:
    'This changes the bill itself — it keeps the same bill reference, stays in the same ' +
    'list, and keeps every payment already recorded against it. The previous version is ' +
    'saved and can be viewed afterwards.',
  mechanic: 'Mechanic Name',
  vehicle: 'Vehicle Number',
  notes: 'Notes',
  itemsCaption: 'The items on this bill',
  colItem: 'Item',
  colQuantity: 'Qty',
  colPrice: 'Price',
  colRemove: 'Remove',
  quantityLabel: (name: string) => `Quantity for ${name}`,
  priceLabel: (name: string) => `Price for ${name}`,
  removeLabel: (name: string) => `Remove ${name} from this bill`,
  addItem: 'Add an item to this bill',
  /** Labelled a preview: the server recomputes and its figure is the one that lands. */
  previewTotal: 'New total (preview)',
  alreadyPaid: 'Already paid',
  paidRule: (paid: string) =>
    `This bill has ${paid} paid against it. The new total cannot be lower than that — ` +
    'to refund, use a return or a credit note instead.',
  reason: 'Why is this bill being changed?',
  reasonHint: 'Recorded with the previous version. At least 5 characters.',
  needReason: 'Say why this bill is being changed (at least 5 characters).',
  needLines:
    'A bill needs at least one item. To void the whole bill, use the cancel action instead.',
  badQuantity: (name: string) => `Enter a quantity greater than zero for ${name}.`,
  badPrice: (name: string) => `Enter a valid price for ${name}.`,
  save: 'Save the changes',
  discard: 'Discard the changes',
  savedTitle: 'The bill has been updated',
  savedBody:
    'The bill keeps its original reference and its payments. The previous version is ' +
    'saved in its history.',

  // --- the revision history ----------------------------------------------------
  historyTitle: 'Previous versions of this bill',
  historyNote:
    'Every edit saves the bill exactly as it was. These records cannot be changed or removed.',
  historyEmpty: 'This bill has not been edited.',
  revisionLabel: (n: number) => `Version ${n}`,
  wasTotal: 'Total was',
  wasPaid: 'Paid was',
} as const;

export const CUSTOMERS = {
  title: 'Customers',
  searchLabel: 'Find a customer',
  searchHint: 'Name, phone or vehicle number.',
  newCustomer: 'Add a customer',
  tableCaption: 'Customers, with any credit outstanding',
  colName: 'Customer',
  colPhone: 'Phone',
  colOutstanding: 'Owed',
  colOldest: 'Oldest unpaid',
  colBills: 'Unpaid bills',
  // Was "Include customers who owe nothing", which only relaxed a filter on a list
  // that could never contain them. The directory shows everyone, so the useful toggle
  // is the other way round.
  owingOnly: 'Only customers who owe',
  empty: 'No customers yet. Use Add a customer.',
  emptyNoneOwing: 'Nobody owes anything right now.',
  showMore: 'Show more customers',
  emptyNoMatch: 'No customer matches what you typed.',
  view: 'Open',
  edit: 'Edit',
  detailTitle: 'Customer',
  name: 'Name',
  phone: 'Phone',
  businessName: 'Business name',
  address: 'Address',
  creditLimit: 'Credit limit',
  creditTerms: 'Payment terms (days)',
  saveCustomer: 'Save',
  needName: 'A customer needs a name.',
  // The rule that keeps the ledger honest (ADR-022).
  balanceExplainer:
    'What a customer owes is worked out from their bills and payments. It cannot be typed in.',
  outstandingNow: 'Owed now',
  unpaidBills: 'Unpaid bills',
  // A dash in a money column, explained. The figures used to be merged from a credit
  // list the screen asked for with no limit, so the server capped it at twenty rows and
  // every customer past the cap was drawn as 0.00 owed — then hidden by "Only customers
  // who owe". The shop could not see those debts and so never chased them. A dash that
  // says what to do next is recoverable; a confident zero is not.
  figureUnknown:
    'A dash under Owed or Unpaid bills means this screen could not read that figure. ' +
    'It does not mean nothing is owed. Search for the customer by name to see what ' +
    'they owe, or open Credit Bills for the unpaid bills themselves.',
  // Recording a payment. Said in money terms, not ledger terms: the person at the
  // counter is taking cash off an account, not creating an allocation.
  recordPayment: 'Take a payment',
  recordPaymentHint:
    'This is put against their oldest unpaid bills first. What they owe is worked out ' +
    'again from their bills and payments — it is never typed in.',
  paymentAmount: 'Amount received',
  paymentMethod: 'How did they pay?',
  paymentReference: 'Reference',
  paymentReferenceHint: 'Optional. A UPI or cheque number, if there is one.',
  savePayment: 'Record this payment',
  paymentNeedsAmount: 'Enter how much was received — more than zero.',
  methodCash: 'Cash',
  methodUpi: 'UPI',
  methodCard: 'Card',
  methodBankTransfer: 'Bank transfer',
  methodCheque: 'Cheque',
  paymentHistory: 'Payments received',
  colWhen: 'When',
  colAmount: 'Amount',
  colMethod: 'How',
  noPayments: 'No payments recorded for this customer.',
  duplicateWarning: 'A customer with this phone number already exists.',
} as const;

export const IMPORTS = {
  title: 'Imports',
  upload: 'Upload a file',
  chooseFile: 'Choose a file',
  fileHint: 'A spreadsheet (.xlsx), a .csv, or a .pdf. Up to 10 MB.',
  intent: 'What is this file?',
  intentPriceList: 'A price list — update prices only',
  intentReceipt: 'A supplier bill — may add stock',
  // FR-IMP-002, said in the user's own terms.
  intentExplainer:
    'A price list never changes stock. A supplier bill can add stock once you apply it.',
  startUpload: 'Upload',
  historyCaption: 'Files uploaded, newest first',
  colFile: 'File',
  colWhat: 'What it is',
  colStatus: 'Status',
  colRows: 'Rows',
  colWhen: 'Uploaded',
  empty: 'No file has been uploaded yet.',
  statusUploaded: 'Waiting to be read',
  statusParsing: 'Being read',
  statusParsed: 'Read — ready to apply',
  statusNeedsReview: 'Needs your decisions',
  statusApplying: 'Being applied',
  statusApplied: 'Applied',
  statusFailed: 'Could not be read',
  statusCancelled: 'Cancelled',
  open: 'Open',
  reviewTitle: 'Review the rows',
  reviewCaption: 'Every row read from the file, with what it was matched to',
  colRow: 'Row',
  colFromFile: 'From the file',
  colMatched: 'Matched to',
  colPrice: 'Price',
  colCost: 'Cost',
  colQuantity: 'Quantity',
  colDecision: 'Your decision',
  matchExactSku: 'Part code matched',
  matchExactAlias: 'Alternate code matched',
  matchFuzzy: 'Name matched — check this',
  matchAmbiguous: 'Several items match — choose one',
  matchNewProduct: 'Not in the catalogue',
  matchDuplicate: 'Appears earlier in this file',
  matchInvalid: 'Could not be read',
  decisionPending: 'Not decided',
  decisionAccept: 'Use the match',
  decisionCreate: 'Add as a new item',
  decisionSkip: 'Leave it out',
  // FR-IMP-007, stated where the user will read it.
  pendingExplainer: (count: number) =>
    count === 1
      ? '1 row still needs your decision. Nothing is applied until every one is decided.'
      : `${count} rows still need your decision. Nothing is applied until every one is decided.`,
  decideAllNew: 'Add all the new items',
  decideAllSkipNew: 'Leave out all the new items',
  decideAllSkipInvalid: 'Leave out all the unreadable rows',
  apply: 'Apply this import',
  cancelImport: 'Cancel this import',
  applyTitle: 'Apply this import?',
  applyBodyPriceList: 'This updates prices. Stock will not change.',
  applyBodyReceipt:
    'This adds the quantities in this file to your stock, as a received supplier bill.',
  applied: (applied: number, skipped: number) =>
    `Applied ${applied} row${applied === 1 ? '' : 's'}. Left out ${skipped}.`,
  reportTitle: 'What happened to each row',
  colResult: 'Result',
  colReason: 'Reason',
  resultApplied: 'Applied',
  resultSkipped: 'Left out',
  resultFailed: 'Failed',
  duplicateFile: 'This exact file was uploaded before.',
  duplicateReason: 'Why upload it again?',
  uploadAnyway: 'Upload it again',
  needFile: 'Choose a file first.',
  needSupplier: 'A supplier bill import needs to say which supplier it is from.',
} as const;

// --- counter administration (C-2) ---------------------------------------------
//
// Written for the owner, who thinks in tills and computers, not devices and foreign
// keys. "This computer" rather than "device"; "till" never appears because the rest of
// the app says "counter" and one word for one thing matters more than the better word.

export const COUNTERS = {
  title: 'Counters and computers',
  explainer:
    'Each computer that makes bills has to be set to a counter. Until it is, that ' +
    'computer cannot start billing.',
  countersHeading: 'Counters',
  devicesHeading: 'Computers',
  colCounter: 'Counter',
  colCapacity: 'Bills it can hold open',
  colComputers: 'Computers on it',
  colComputer: 'Computer',
  colAssignedTo: 'Set to',
  colLastSeen: 'Last used',
  noCounters: 'This shop has no counters yet. Ask whoever set up the shop to add one.',
  noDevices: 'No computer has signed in yet.',
  unassigned: 'Not set to a counter',
  closed: 'Closed',
  revoked: 'Blocked',
  assignLabel: 'Set this computer to',
  assignAction: 'Save',
  unassign: 'Take off the counter',
  assigned: (device: string, counter: string) => `${device} is now set to ${counter}.`,
  unassigned_ok: (device: string) => `${device} is no longer set to a counter.`,
  signInAgain: 'That computer needs to sign in again before it can bill.',
  noPermission:
    'Only the owner can change which counter a computer is set to. Ask them to do it.',
  // A revoked machine is refused rather than silently skipped: the administrator chose
  // it, so they are told why it cannot be used.
  cannotAssignRevoked:
    'That computer has been blocked. It has to be registered again before it can bill.',
} as const;

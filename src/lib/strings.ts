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
  historyCaption: 'Every change to this item’s stock, newest first',
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

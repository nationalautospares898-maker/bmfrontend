/**
 * Keyboard helpers for groups of controls, so the whole application can be driven from
 * the keys the owner asked for — not just the billing grid.
 *
 * ## What this is, and what it deliberately is not
 *
 * The owner asked for an Excel-like keyboard experience "throughout the application".
 * The tempting implementation — one `keydown` listener on `window` that interprets every
 * key — is the wrong one, and the brief says so: it would hijack typing, break the
 * browser's own focus order, fight the spreadsheet's existing handlers and make screen
 * readers unusable. It also would not be needed for most of what was asked:
 *
 * * **Tab / Shift+Tab** already work everywhere, because every control in this
 *   application is a real `<button>`, `<input>`, `<select>` or `<a>`. The focus order is
 *   the document order, which is the one the platform maintains for free.
 * * **Enter and Space** already activate a focused `<button>`, and **Enter** already
 *   submits a `<form>`. That is browser behaviour, not something to re-implement.
 *
 * What genuinely was missing is **arrow-key movement inside a group of related
 * controls** — the right-side navigation being the one the owner uses constantly. That is
 * all this module adds, scoped to the container it is attached to.
 *
 * ## The rules every helper here obeys
 *
 * 1. **Never intercept a key while the user is typing.** A text field, a number field, a
 *    `<select>` or anything `contentEditable` keeps its own arrow behaviour — moving the
 *    caret, stepping a number, opening a dropdown. Stealing `ArrowLeft` inside a product
 *    name is a worse bug than the one being fixed.
 * 2. **Never intercept a modified key.** `Ctrl+ArrowRight` is a word jump and
 *    `Alt+ArrowLeft` is the browser's Back. Both stay with the platform.
 * 3. **`preventDefault()` only when focus actually moved.** Otherwise a key that this
 *    code chose not to act on would also stop scrolling the page, which is how
 *    "keyboard support" turns into a page that cannot be scrolled.
 * 4. **Nothing is focusable here that was not already.** These helpers move focus between
 *    existing controls; they never add `tabIndex` to something inert.
 */

/** A control a user can focus and operate. Disabled controls are excluded by the query. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * True when the keystroke belongs to whatever the user is currently typing in.
 *
 * Checked against the event **target** rather than `document.activeElement` so it is
 * correct during the bubble phase, and `closest` is used so a control wrapped in a
 * label or a cell is still recognised.
 */
function isTypingContext(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const field = target.closest('input, textarea, select');
  return field !== null;
}

/**
 * Focus a control that does not exist yet, on the next frame.
 *
 * **Why this is needed at all.** Some of this application's controls are *replaced* when
 * they are used rather than merely updated. Choosing a customer swaps the search box for
 * the chosen name plus a `Change` button; pressing `Change` swaps it back. React unmounts
 * the old node, and **the browser moves focus to `<body>` when the focused element is
 * removed** — so the next `Tab` starts again from the top of the document instead of
 * continuing to the next field. That is the whole of the defect the cashier reported as
 * "after picking a customer, Tab doesn't go to Mechanic Name".
 *
 * The frame matters: the replacement has to be in the DOM before it can be focused, and
 * React has not committed it at the moment the handler runs.
 *
 * **The target must already exist**, which is true for every caller: the header fields
 * and the grid cells are mounted the whole time, so one frame is all that is needed to
 * let React commit whatever else changed.
 *
 * It does **not** poll for a control that has yet to appear. An earlier version did —
 * with a deadline and a "has the user moved on?" guard — to handle the customer box
 * coming back after `Change`, where the replacement waits on a Dexie commit. That grew a
 * race of its own and still failed about one run in five. The right tool for "focus it
 * once it is back" is a `useEffect` keyed on the state that brings it back: the effect
 * runs *after* the commit, so the element is guaranteed to be there and nothing has to
 * be guessed. `CustomerPicker` does exactly that.
 *
 * **`root` scopes the lookup to one bill.** The workspace shows three bills side by
 * side, and every one of them has a `[data-bill-field="vehicle"]` and a
 * `[data-cell="0-item"]`. A document-wide `querySelector` returns the *first* of them,
 * which is whichever bill happens to be leftmost — so a cashier filling the middle bill
 * had the caret thrown into the left one. Passing the panel element keeps a hand-off
 * inside the bill that asked for it; omitting it is still correct wherever only one of
 * something exists.
 *
 * This is deliberately a *hand-off* and takes focus unconditionally — it only ever runs
 * as the direct result of a keystroke or click the user made, which is exactly when
 * moving focus is wanted. The other direction, where code wants focus for its own reasons
 * and must not take it from someone mid-word, is `isUserTyping` below.
 */
export function focusOnNextFrame(selector: string, root?: ParentNode | null): void {
  requestAnimationFrame(() => {
    (root ?? document).querySelector<HTMLElement>(selector)?.focus();
  });
}

/**
 * Is the user currently typing into something?
 *
 * Used to decide whether code may move focus. Automatic focus is a convenience; a
 * half-typed customer name is the user's work, and the convenience must lose.
 *
 * A focused **button** does not count. Pressing a button is a completed act, so taking
 * focus from one — a bill tab the cashier just clicked, say — is the handover they
 * asked for. Only fields that hold text in progress are protected.
 */
export function isUserTyping(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.isContentEditable) return true;
  return active.matches('input, textarea, select');
}

/** `Ctrl`, `Alt`, `Meta` or `Shift` — any of which makes the key the platform's. */
function hasModifier(event: {
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): boolean {
  return event.ctrlKey || event.altKey || event.metaKey || event.shiftKey;
}

/**
 * Move focus between the focusable children of the element the handler is attached to.
 *
 * Both axes are accepted on purpose: the navigation is a vertical column on a desktop
 * and a horizontal row on a narrow window, and the same keys should work in both without
 * the user having to know which layout they are looking at. `Home` and `End` jump to the
 * ends, which is what the ARIA authoring practices specify for a composite widget and
 * what a spreadsheet user expects anyway.
 *
 * Focus **does not wrap**. At the last item, `ArrowDown` does nothing rather than
 * silently jumping back to the top — in a six-item list a wrap reads as a glitch, and the
 * user still has `Home`.
 *
 * Note this moves focus only; it does not activate. Navigating with an arrow and then
 * pressing `Enter` or `Space` is two deliberate acts, so arrowing past `Billing` cannot
 * discard what is on screen.
 */
export function navigateWithArrows(event: React.KeyboardEvent<HTMLElement>): void {
  if (hasModifier(event)) return;
  if (isTypingContext(event.target)) return;

  const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
  const backward = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
  const toStart = event.key === 'Home';
  const toEnd = event.key === 'End';
  if (!forward && !backward && !toStart && !toEnd) return;

  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (items.length === 0) return;

  const current = items.findIndex((item) => item === document.activeElement);
  // An arrow pressed while focus is in the group but on nothing we recognise should not
  // teleport the user to the first item; only the explicit Home/End do that.
  if (current === -1 && (forward || backward)) return;

  const next = toStart
    ? 0
    : toEnd
      ? items.length - 1
      : forward
        ? Math.min(current + 1, items.length - 1)
        : Math.max(current - 1, 0);

  const target = items[next];
  if (!target || target === document.activeElement) return;

  target.focus();
  // Only now, because focus genuinely moved (rule 3).
  event.preventDefault();
}

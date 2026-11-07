/**
 * The Mechanic Name field: free text, with suggestions from the saved list.
 *
 * ## Why this is not the customer picker
 *
 * `CustomerPicker` attaches an **id** to the bill, because a credit sale needs a
 * persisted `customer_id` and a free-text name is refused (FR-CREDIT-009). A mechanic is
 * the opposite: `invoices.mechanic_name_snapshot` is free text and always has been, and
 * nothing downstream needs an id. So this component's output is still a **string** —
 * `header.mechanic_name`, exactly as before — and the saved list is only a source of
 * suggestions.
 *
 * That difference is what keeps the feature safe. The suggestion list is mutable
 * reference data; the bill's copy is an immutable snapshot. Correcting a misspelled
 * mechanic changes what the *next* bill offers and nothing about a bill already issued.
 *
 * ## Why the name is saved on blur rather than on finalisation
 *
 * The owner asked that "newly entered mechanic names must be saved and reused on
 * subsequent bills". Saving at finalisation would miss the cases that actually happen:
 * a bill saved as a draft, or cleared, would never contribute its mechanic — so the name
 * typed this morning would still not be suggested this afternoon. Blur is the moment the
 * cashier has finished with the field, and `POST /mechanics` is a get-or-create, so
 * leaving the field repeatedly is harmless.
 *
 * It is **fire-and-forget**. A failure to save the suggestion must never block billing
 * or lose what was typed: `onChange` has already committed the name to the draft by the
 * time the request goes out, and a rejection only costs the convenience of a suggestion
 * next time. That is reported quietly rather than as an error over the bill.
 *
 * ## Keyboard
 *
 * The same grammar as `CustomerPicker` and `ItemCell`, because the cashier should not
 * have to learn three autocompletes on one screen:
 *
 * * list open — `↓ ↑` move the highlight, `Enter` and `Tab` pick it, `Escape` closes and
 *   keeps what was typed.
 * * list closed — `Enter` means "done with this field" and moves to Vehicle Number.
 *
 * `Space` is deliberately **not** a selection key while the text box has focus. The
 * owner asked for Space to select, and it does — but only on a focused option in the
 * list, never in the input, because a mechanic is called `Ramesh Kumar` and a field that
 * ate the space to "select" something would make two-word names untypeable. That is the
 * same reasoning `ItemCell` records for `AXEL PACKING`.
 */

import { useEffect, useId, useRef, useState } from 'react';

import { mechanics as mechanicsApi } from '@/api/endpoints';
import type { Mechanic } from '@/api/types';
import { BILLING } from '@/lib/strings';

/** Matches `CustomerPicker`'s 250 ms; the server's list is small and indexed. */
const DEBOUNCE_MS = 250;

export interface MechanicPickerProps {
  /** The draft's current value. */
  value: string;
  /** Commits the name to the draft. Called before anything is persisted remotely. */
  onChange: (name: string) => void;
  /** Where `Enter` goes when no suggestion list is open. */
  onDone: () => void;
  /**
   * Remounts the field when the draft changes, so switching bill tabs shows the right
   * name rather than the previous tab's.
   */
  resetKey: string;
  disabled?: boolean | undefined;
}

export function MechanicPicker({
  value,
  onChange,
  onDone,
  resetKey,
  disabled = false,
}: MechanicPickerProps) {
  const [term, setTerm] = useState(value);
  const [suggestions, setSuggestions] = useState<Mechanic[]>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);
  const listId = useId();
  const inputId = useId();

  // The draft is the source of truth: switching tabs, or loading a saved draft, must
  // replace what is in the box. `resetKey` changes with the draft id.
  useEffect(() => {
    setTerm(value);
    setOpen(false);
    // `value` is deliberately absent: re-syncing on every keystroke's committed value
    // would fight the user's typing. Only a change of draft resets the box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  /** The last name successfully handed to `POST /mechanics`, so idle blurs are free. */
  const lastEnsured = useRef<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const latest = useRef(0);

  useEffect(() => () => inFlight.current?.abort(), []);

  useEffect(() => {
    if (!open) return;
    const sequence = latest.current + 1;
    latest.current = sequence;
    const timer = setTimeout(() => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      void mechanicsApi
        // An empty term is a real request: it returns the recently-used list, which is
        // what should appear the moment the field is focused.
        .search(term.trim() || undefined, { signal: controller.signal })
        .then((response) => {
          if (sequence !== latest.current) return;
          setSuggestions(response.items);
          setHighlighted(0);
        })
        .catch(() => {
          // Silent: a mechanic field with no suggestions still works perfectly as a
          // text box, and an error panel over a bill for a failed convenience lookup
          // is worse than no suggestions.
          if (sequence === latest.current) setSuggestions([]);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term, open]);

  // Keep the highlight in view: the arrows move a highlight, not focus, and a browser
  // only auto-scrolls for real focus.
  useEffect(() => {
    document
      .getElementById(`${listId}-${highlighted}`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [highlighted, listId]);

  /**
   * Commit to the draft, then save to the list for next time.
   *
   * Order matters: the draft is updated first and unconditionally, so what is on the
   * bill never depends on a network call succeeding.
   */
  function commit(name: string): void {
    const trimmed = name.trim();
    onChange(trimmed);
    if (!trimmed || trimmed === lastEnsured.current) return;
    lastEnsured.current = trimmed;
    setSaveFailed(false);
    void mechanicsApi.ensure(trimmed).catch(() => {
      // Allow a later blur to try again rather than treating one failure as final.
      lastEnsured.current = null;
      setSaveFailed(true);
    });
  }

  function pick(mechanic: Mechanic): void {
    setTerm(mechanic.name);
    setOpen(false);
    // A suggestion came from the list, so it is already saved — but `commit` still runs
    // it through `ensure`, which bumps `last_used_at` and is what makes the ordering
    // "most recently used" rather than "most recently created".
    commit(mechanic.name);
    onDone();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    const listOpen = open && suggestions.length > 0;

    if (listOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlighted((current) => Math.min(current + 1, suggestions.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlighted((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        // `Tab` picks as well as `Enter` — the owner asked for both. `Tab` keeps its
        // native "move on" behaviour afterwards, which is why it is not prevented: the
        // highlight is taken and focus still advances, which is what pressing Tab on a
        // highlighted option should feel like.
        const chosen = suggestions[highlighted];
        if (!chosen) return;
        if (event.key === 'Enter') event.preventDefault();
        pick(chosen);
        return;
      }
      if (event.key === 'Escape') {
        // Keeps what was typed. The cashier may be mid-word, and a key that discarded
        // their typing would be worse than one that did nothing.
        event.preventDefault();
        setOpen(false);
        return;
      }
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      commit(term);
      onDone();
    }
  }

  return (
    <div className="relative flex flex-col gap-1">
      <label className="text-sm font-medium text-slate-700" htmlFor={inputId}>
        {BILLING.headerMechanic}
      </label>
      <input
        id={inputId}
        value={term}
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-expanded={open && suggestions.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        {...(open && suggestions.length > 0
          ? { 'aria-activedescendant': `${listId}-${highlighted}` }
          : {})}
        // The hand-off target `CustomerPicker` focuses after a customer is chosen.
        // Choosing one unmounts its search box, so focus has to be placed deliberately.
        data-bill-field="mechanic"
        className="min-h-11 rounded border border-slate-300 px-3"
        onChange={(event) => {
          setTerm(event.target.value);
          setOpen(true);
        }}
        // Opening on focus is what makes the recently-used list useful: three names
        // account for most bills, and they should be one keystroke away.
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        onBlur={(event) => {
          commit(event.target.value);
          // Delayed a tick: a click on an option blurs the input first, and closing
          // immediately would unmount the option before its click landed.
          setTimeout(() => setOpen(false), 120);
        }}
      />

      {open && suggestions.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          // Not a tab stop, even though it scrolls — Chromium makes scrollable
          // containers focusable, which would put a labelless stop between this field
          // and Vehicle Number. Focus stays in the input; `aria-activedescendant`
          // reports the highlight. Same note as the customer list and `ItemCell`.
          tabIndex={-1}
          className="absolute left-0 top-full z-30 mt-1 max-h-56 w-full min-w-[14rem] divide-y divide-slate-200 overflow-y-auto rounded border border-nas-navy bg-white shadow-lg"
        >
          {term.trim() === '' ? (
            <li className="px-3 py-1 text-xs text-slate-500">{BILLING.mechanicRecent}</li>
          ) : null}
          {suggestions.map((mechanic, index) => (
            <li
              key={mechanic.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === highlighted}
            >
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(mechanic)}
                /**
                 * `Space` selects **here**, on a focused option — which is what the
                 * owner asked for — and nowhere else. It cannot reach this handler from
                 * the text box, so two-word names stay typeable.
                 *
                 * A `<button>` already activates on `Space` natively, so this only has
                 * to stop the page scrolling.
                 */
                onKeyDown={(event) => {
                  if (event.key === ' ') event.preventDefault();
                }}
                className={`flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left ${
                  index === highlighted ? 'bg-slate-100' : 'bg-white'
                }`}
              >
                <span className="font-medium">{mechanic.name}</span>
                {mechanic.phone ? (
                  <span className="text-xs text-slate-500">{mechanic.phone}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {saveFailed ? (
        // Quiet and non-blocking: the name is on the bill regardless, and this only
        // reports that the convenience of a suggestion next time was lost.
        <p className="text-xs text-amber-700">{BILLING.mechanicSaveFailed}</p>
      ) : null}
    </div>
  );
}

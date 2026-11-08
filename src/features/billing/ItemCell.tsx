/**
 * The Item cell: a spreadsheet cell that is also the product autocomplete.
 *
 * The old screen had one search box above a table. The owner's approved workspace types
 * the part name **into the row**, so the search moved into the cell — and with it the one
 * behaviour `CLAUDE.md §6` says never to break: *search is focused on load and after
 * every added line* (FR-BILL-001). It still is. `BillGrid` focuses row 1's Item cell on
 * mount, and `BillingCounter` moves focus to the next row's Item cell after each add, so
 * a cashier types part, quantity, part, quantity without touching the mouse. The control
 * changed; the keyboard-only path did not.
 *
 * Reused from `ProductSearch` and deliberately unchanged, because each is a requirement:
 *
 * * **Results from the first character** (FR-CAT-003) — a one-character part code has to
 *   be findable.
 * * **~120 ms debounce, previous request aborted** (NFR-FE-PERF-001) — without the abort,
 *   a slow reply for `br` lands after `brake` and replaces it.
 * * **Offline it searches the Dexie cache and says so**, with the age of the data, rather
 *   than quietly returning a shorter list as though it were complete (FR-OFFLINE-009).
 * * **No retry while someone is typing** (§7) — a stale result three keystrokes later is
 *   worse than a Retry they can press.
 *
 * ## Creating a missing part from the cell
 *
 * This cell used to refuse, on the grounds that "a cashier inventing a part mid-bill is
 * how a shop ends up with four spellings of one clutch plate". The owner asked for it
 * anyway (2026-11-07): when a part is not in the catalogue, the counter should not have
 * to abandon a half-written bill to go and add it.
 *
 * The original concern was real, so it is **mitigated rather than dismissed**:
 *
 * * The affordance appears **only when the search returned nothing**. The catalogue
 *   search has a trigram tier, so "nothing" already means no exact, prefix, alias or
 *   fuzzy match — the near-duplicate case cannot reach it.
 * * It appears **only with `catalog.write`**, the permission that already governs
 *   creating a product. A cashier without it sees no dead button, following the same
 *   rule the cancel action does: a control that is sometimes a 403 is worse than none.
 * * It creates a **catalogue entry only**. No stock movement is written, because none
 *   happened — see `NewItemDialog`.
 *
 * Physical arrivals are still recorded on the Stock screen, which remains the only place
 * that writes a receipt movement.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { catalog } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import * as catalogCache from '@/db/catalogCache';
import type { Product } from '@/api/types';
import type { LocalDraftLine } from '@/db/schema';
import { BILLING } from '@/lib/strings';
import { NewItemDialog } from './NewItemDialog';

const DEBOUNCE_MS = 120;

export interface SearchHit {
  productId: string;
  name: string;
  sku: string | null;
  unitCode: string;
  allowsFraction: boolean;
  unitPrice: string;
  /** `null` when the server does not know — not zero. */
  stock: string | null;
  stockAsOf: string | null;
  isActive: boolean;
  fromCache: boolean;
  /**
   * Which tier of `SEARCH_SQL` produced this row — `exact_sku`, `sku_prefix`,
   * `name_prefix`, `alias_prefix` or `fuzzy`. `null` for a hit read from the offline
   * cache, which is matched locally and carries no ranking.
   *
   * The server has always sent this and the client used to throw it away, which is how
   * a trigram match came to be indistinguishable from an exact one.
   */
  matchKind: string | null;
}

/**
 * Match tiers precise enough to stand under the cursor with `Enter` armed.
 *
 * Everything here is something the cashier **typed the beginning of**: an exact part
 * code, a part-code prefix, a name prefix, an alias prefix. `fuzzy` is deliberately
 * absent — it is trigram similarity, which is a fine way to *suggest* a part and a
 * terrible way to *choose* one. `Damage Filter` and `Diesel Filter` share the trigrams
 * of ` Filter`, so the owner typing the first got the second pre-selected and one press
 * of `Enter` put the wrong part on a customer's bill.
 */
const CONFIDENT_MATCH_KINDS: ReadonlySet<string> = new Set([
  'exact_sku',
  'sku_prefix',
  'name_prefix',
  'alias_prefix',
]);

/** Case- and space-insensitive, so `  damage  filter ` and `Damage Filter` compare equal. */
function compareKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Whether this hit is a safe thing to have highlighted when `Enter` is pressed.
 *
 * The server's own tier decides it where there is one. Cached hits have no tier, so they
 * fall back to the same question asked locally: does this actually start with what was
 * typed? A cached row that merely contains the text is a suggestion too.
 */
function isConfidentMatch(hit: SearchHit, query: string): boolean {
  if (hit.matchKind !== null) return CONFIDENT_MATCH_KINDS.has(hit.matchKind);
  const typed = compareKey(query);
  if (typed === '') return false;
  return (
    compareKey(hit.name).startsWith(typed) ||
    (hit.sku !== null && compareKey(hit.sku).startsWith(typed))
  );
}

/**
 * Where the highlight starts: on the first match only if that match is confident.
 *
 * `-1` means *nothing is highlighted*, which is the state that fixes the owner's bug.
 * The suggestions are still right there and `↓` reaches them in one keystroke — they
 * just are not armed under `Enter` before anybody has looked at them.
 */
function initialHighlight(hits: readonly SearchHit[], query: string): number {
  const first = hits[0];
  return first && isConfidentMatch(first, query) ? 0 : -1;
}

function fromProduct(product: Product): SearchHit {
  return {
    productId: product.id,
    name: product.name,
    sku: product.sku,
    unitCode: product.unit.code,
    allowsFraction: product.unit.allows_fraction,
    unitPrice: String(product.default_selling_price),
    stock: product.stock ? String(product.stock.branch_quantity) : null,
    stockAsOf: product.stock?.as_of ?? null,
    isActive: product.is_active,
    fromCache: false,
    matchKind: product.match?.kind ?? null,
  };
}

export interface ItemCellProps {
  row: number;
  /**
   * The bill this cell belongs to.
   *
   * Only ever used to build a DOM `id`. Three bills are on screen at once and each has
   * its own row 1, so `item-0` was three different elements sharing one identifier —
   * which makes `<label for>` point at whichever the browser found first, and sends a
   * screen reader (and every test that asks for "Item, row 1") to the wrong bill.
   */
  billId: string;
  /** `undefined` for one of the empty rows below the last item. */
  line: LocalDraftLine | undefined;
  online: boolean;
  readOnly: boolean;
  /**
   * `catalog.write`. Without it the "Add New Item to Stock" affordance is not offered,
   * because the server would refuse the creation.
   */
  canCreateProduct: boolean;
  /**
   * `catalog.write` + `inventory.adjust`. Lets the create dialog also ask how many are
   * on the shelf, so the part can be sold immediately — see `NewItemDialog`.
   */
  onPick: (hit: SearchHit) => void;
  onFocusCell: () => void;
  onMove: (direction: 'next' | 'previous' | 'up' | 'down') => void;
}

export function ItemCell({
  row,
  billId,
  line,
  online,
  readOnly,
  canCreateProduct,
  onPick,
  onFocusCell,
  onMove,
}: ItemCellProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  /** `-1` = nothing highlighted, so `Enter` cannot pick a mere suggestion. */
  const [highlighted, setHighlighted] = useState(-1);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usedCache, setUsedCache] = useState(false);
  /** Open when the cashier has asked to create the part they just failed to find. */
  const [creating, setCreating] = useState(false);
  /**
   * A search has **completed** and returned nothing.
   *
   * Distinct from `hits.length === 0`, which is also true before the first search and
   * while one is in flight — offering "Add New Item to Stock" in either of those states
   * would dangle it under the cell while results were still on their way.
   */
  /**
   * A **server** search came back without an error.
   *
   * Replaces the old `searchedEmpty`, which was `items.length === 0` and therefore the
   * reason the owner could not create `Damage Filter`: `Diesel Filter` came back as a
   * fuzzy match, the list was not empty, and the one affordance for adding the part that
   * genuinely did not exist switched itself off. Whether anything was found is a
   * separate question from whether the catalogue was actually asked — and only the
   * second one decides if creating is safe to offer.
   */
  const [searchCompleted, setSearchCompleted] = useState(false);

  const inFlight = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listId = useId();
  /**
   * This cell's own input.
   *
   * Held rather than looked up: the dialog used to come back to
   * `document.querySelector('[data-cell="0-item"]')`, and with three bills on screen
   * that is three elements — so cancelling the dialog on the middle bill put the caret
   * in the left one. A ref cannot point at the wrong bill.
   */
  const input = useRef<HTMLInputElement | null>(null);

  const run = useCallback(
    async (text: string) => {
      inFlight.current?.abort();
      if (!text.trim()) {
        setHits([]);
        setOpen(false);
        setUsedCache(false);
        setSearchCompleted(false);
        setHighlighted(-1);
        return;
      }

      if (!online) {
        const cached = await catalogCache.searchOffline(text);
        const offline: SearchHit[] = cached.map(({ product }) => ({
          productId: product.id,
          name: product.name,
          sku: product.sku,
          unitCode: product.unit_code,
          allowsFraction: product.allows_fraction,
          unitPrice: product.default_selling_price,
          stock: product.branch_quantity,
          stockAsOf: product.as_of,
          isActive: product.is_active,
          fromCache: true,
          matchKind: null,
        }));
        setHits(offline);
        setHighlighted(initialHighlight(offline, text));
        setOpen(true);
        setUsedCache(true);
        setError(null);
        // Creation is never offered from the cache: "not in the copy saved on this
        // computer" is not evidence that the catalogue lacks the part, and creating a
        // duplicate of something that exists on the server is exactly the wrong outcome.
        setSearchCompleted(false);
        return;
      }

      const controller = new AbortController();
      inFlight.current = controller;
      try {
        const result = await catalog.search(text, { signal: controller.signal });
        const found = result.items.map(fromProduct);
        setHits(found);
        // **Not always 0.** A confident match is armed under `Enter` exactly as before,
        // so nothing slows down for the 99% of searches that are a prefix of a real
        // part. A list of mere suggestions starts with no highlight at all.
        setHighlighted(initialHighlight(found, text));
        setOpen(true);
        setUsedCache(false);
        setError(null);
        setSearchCompleted(true);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(
          caught instanceof ApiError
            ? describeError(caught.code).message
            : 'Search is unavailable. Keep typing or try again.',
        );
        // A failed search is not an empty catalogue. Offering to create here would
        // invite a duplicate of a part the server knows about perfectly well.
        setSearchCompleted(false);
      }
    },
    [online],
  );

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(query), DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, run]);

  useEffect(() => () => inFlight.current?.abort(), []);

  // Keep the highlighted match in view: the arrows move a highlight, not focus, and the
  // browser only scrolls for real focus.
  useEffect(() => {
    document
      .getElementById(`${listId}-${highlighted}`)
      // Optional call: scrolling the highlight into view is a nicety, and jsdom (which
      // the component tests run in) does not implement `scrollIntoView` at all.
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [highlighted, listId]);

  /**
   * Whether "Add New Item to Stock" should be on offer right now.
   *
   * Every condition is load-bearing: a completed search (not one in flight), that found
   * nothing, from the **server** (not the offline cache), by someone who may create a
   * product, for a name they have actually typed.
   */
  /**
   * Does any hit actually **name** what was typed?
   *
   * This is the question that decides whether creating is still on offer. An exact name
   * or part code means the part exists and must be chosen, not duplicated. Anything
   * weaker — a prefix, a trigram neighbour — leaves "the part I typed" unaccounted for,
   * so the offer stands alongside the suggestions.
   */
  const typedKey = compareKey(query);
  const hasExactMatch =
    typedKey !== '' &&
    hits.some(
      (hit) =>
        compareKey(hit.name) === typedKey ||
        (hit.sku !== null && compareKey(hit.sku) === typedKey),
    );

  const offerCreate =
    canCreateProduct &&
    online &&
    searchCompleted &&
    !usedCache &&
    typedKey !== '' &&
    // **Not `hits.length === 0`.** See `searchCompleted`: a fuzzy neighbour used to
    // suppress this and strand the owner with no way to add a genuinely new part.
    !hasExactMatch;

  function pick(hit: SearchHit): void {
    onPick(hit);
    // Cleared so the row can be typed again immediately. The cell is a *cursor*, not the
    // stored value — the product name comes from the line once it exists.
    setQuery('');
    setHits([]);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    const input = event.currentTarget;
    const listOpen = open && hits.length > 0;

    // While the list is open it owns the vertical keys and Enter. This is the whole of
    // the context-awareness the owner asked for: the same `↓` that walks the matches
    // walks the rows once the list is closed.
    if (listOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlighted((current) => Math.min(current + 1, hits.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlighted((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === 'Enter') {
        // `highlighted` is `-1` when the list holds nothing but suggestions, and then
        // `Enter` must not pick one. What it does instead depends on what is on offer:
        //
        //   * creation is available — take it. This is the owner's path: type
        //     `Damage Filter`, press Enter, fill two fields, carry on billing, with
        //     `Diesel Filter` sitting in the list untouched.
        //   * creation is not available (offline, no `catalog.write`, a cached list) —
        //     fall through to grid movement, so `Enter` still means "down a row" rather
        //     than nothing at all.
        //
        // Either way a suggestion is only ever chosen by `↓` first, or by a click.
        const hit = highlighted >= 0 ? hits[highlighted] : undefined;
        if (hit) {
          event.preventDefault();
          pick(hit);
          return;
        }
        if (offerCreate) {
          event.preventDefault();
          setCreating(true);
          return;
        }
      }
      if (event.key === 'Escape') {
        // Closes the list and keeps what was typed — the user may be mid-word.
        event.preventDefault();
        setOpen(false);
        return;
      }
    }

    // Nothing was found and this user may create it, so `Enter` means "create the part
    // I just typed" rather than "move down a row". That keeps the keyboard-only path
    // whole: type the name, press Enter, fill two fields, carry on billing.
    if (event.key === 'Enter' && offerCreate) {
      event.preventDefault();
      setCreating(true);
      return;
    }

    // Grid movement. `Space` is absent on purpose: a part is called `AXEL PACKING`, and a
    // cell that ate the space to "select" itself would make half the catalogue
    // untypeable. It stays an ordinary character, here and in every other cell.
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    const atEnd =
      input.selectionStart === input.value.length &&
      input.selectionEnd === input.value.length;

    if (event.key === 'Enter' || event.key === 'ArrowDown') {
      event.preventDefault();
      onMove('down');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      onMove('up');
    } else if (event.key === 'ArrowRight' && atEnd) {
      event.preventDefault();
      onMove('next');
    } else if (event.key === 'ArrowLeft' && atStart) {
      event.preventDefault();
      onMove('previous');
    }
  }

  // A row that already holds a line shows the product, not an input. Editing an item
  // means removing the line and typing again — the same rule the old table had, and it
  // keeps `product_id` and `product_name` from ever disagreeing.
  if (line) {
    return (
      <div
        data-cell={`${row}-item`}
        tabIndex={0}
        role="textbox"
        aria-readonly="true"
        aria-label={BILLING.cellItemLabel(row + 1)}
        // `min-w-0` + `truncate` on the name: the Item column is about 100px wide with
        // three bills across a counter monitor, and a long part name used to widen the
        // cell until `Got it` fell off the panel. Truncated **on screen only** — the
        // printed bill wraps names in full (§9), and the full text is in `title`.
        className="flex w-full min-w-0 items-baseline gap-1 overflow-hidden whitespace-nowrap px-2 py-1 outline-none focus:bg-white focus:ring-2 focus:ring-inset focus:ring-nas-navy"
        title={line.product_name}
        onFocus={onFocusCell}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'ArrowDown') {
            event.preventDefault();
            onMove('down');
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            onMove('up');
          } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            onMove('next');
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault();
            onMove('previous');
          }
        }}
      >
        {/*
          **One line, and the name wins it.**

          The annotations used to sit beside the name as ordinary inline text, which was
          right on a full-width screen and wrong on a third of one: `In stock: 4.000 (as
          of 3:30:00 PM)` wrapped over six lines and a single item filled half the grid.
          So the name is `shrink-0` — it takes the width it needs and truncates only
          when it alone is too long — and everything after it shares what is left and
          truncates first. Nothing is dropped: the cell's `title` carries the product
          name in full, and the stock figure is advisory here in any case, because the
          server decides at finalisation (ADR-006).
        */}
        <span className="max-w-full shrink-0 truncate font-medium">
          {line.product_name}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-slate-500">
          {line.sku ? <span>{line.sku}</span> : null}
          {/* The stock the client last knew, with its age. */}
          {line.known_stock !== null && line.stock_as_of ? (
            <span className="ml-1">
              {BILLING.stockAnnotation(
                line.known_stock,
                new Date(line.stock_as_of).toLocaleTimeString(),
              )}
            </span>
          ) : null}
          {line.price_source === 'manual_override' ? (
            <span className="ml-1 text-amber-700">changed</span>
          ) : null}
        </span>
      </div>
    );
  }

  return (
    <div className="relative">
      <label className="sr-only" htmlFor={`item-${billId}-${row}`}>
        {BILLING.cellItemLabel(row + 1)}
      </label>
      <input
        id={`item-${billId}-${row}`}
        ref={input}
        data-cell={`${row}-item`}
        value={query}
        disabled={readOnly}
        autoComplete="off"
        role="combobox"
        aria-expanded={open && hits.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        // Reports which match the arrows are standing on without moving focus out of
        // the cell — the other half of keeping the options off the tab order.
        {...(open && hits.length > 0 && highlighted >= 0
          ? { 'aria-activedescendant': `${listId}-${highlighted}` }
          : {})}
        placeholder={row === 0 ? BILLING.searchPlaceholder : undefined}
        className="w-full bg-transparent px-2 py-1 outline-none focus:bg-white focus:ring-2 focus:ring-inset focus:ring-nas-navy"
        onFocus={onFocusCell}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        // Closed on the way out so a stale list cannot hang over the next row. Delayed a
        // tick because a click on an option blurs the input first.
        onBlur={() => setTimeout(() => setOpen(false), 120)}
      />

      {open && hits.length > 0 ? (
        <ul
          id={listId}
          role="listbox"
          // Not a tab stop, even though it scrolls: Chromium makes scrollable containers
          // focusable, which would put a labelless, actionless stop between the cell and
          // `Quantity`. Focus stays in the cell; `aria-activedescendant` reports the
          // highlight. See the same note on the customer list.
          tabIndex={-1}
          className="absolute left-0 top-full z-30 max-h-64 w-[26rem] max-w-[90vw] divide-y divide-slate-200 overflow-y-auto rounded border border-nas-navy bg-white shadow-lg"
        >
          {usedCache ? (
            <li className="bg-amber-50 px-3 py-1 text-xs text-amber-900">
              Showing the list saved on this computer. It may be incomplete.
            </li>
          ) : null}
          {hits.map((hit, index) => (
            <li
              key={hit.productId}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === highlighted}
            >
              <button
                type="button"
                /**
                 * **Not a tab stop.** Focus belongs in the cell; the arrows walk the
                 * list and `Enter` picks, which is the combobox contract the input
                 * above already declares. Without this, `Tab` out of a cell showing ten
                 * matches went through ten buttons before reaching `Quantity` — and
                 * none of them did anything when pressed, because selection was on
                 * `onMouseDown` and a keyboard press fires `click`.
                 */
                tabIndex={-1}
                // The default is cancelled only to stop the cell's blur closing the list
                // before the click lands; the selection itself is on `onClick`, which a
                // mouse and a keyboard both produce.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(hit)}
                className={`flex w-full items-baseline justify-between gap-4 px-3 py-2 text-left ${
                  index === highlighted ? 'bg-slate-100' : 'bg-white'
                }`}
              >
                <span>
                  <span className="font-medium">{hit.name}</span>
                  {hit.sku ? (
                    <span className="ml-2 text-xs text-slate-500">{hit.sku}</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-xs text-slate-600">
                  {hit.stock === null
                    ? BILLING.outOfStockAnnotation
                    : BILLING.stockAnnotation(
                        hit.stock,
                        hit.stockAsOf
                          ? new Date(hit.stockAsOf).toLocaleTimeString()
                          : '—',
                      )}
                </span>
              </button>
            </li>
          ))}
          {/*
            **The offer has to live inside the list.**

            Before, it was a second absolutely-positioned panel at the same `top-full`,
            so whenever both were on screen they sat on top of each other — which is the
            other half of why the owner could not add `Damage Filter` while
            `Diesel Filter` was being suggested. Here it is the last row of the one
            list: visible, scrolled to with the same `↓`, and unmistakably *after* the
            suggestions rather than one of them.

            `role="presentation"` because it is not an `option` — picking it does not
            select a product, it opens the create dialog. Leaving it an `option` would
            put a thing `Enter` cannot pick into the listbox's own count.
          */}
          {offerCreate ? (
            <li role="presentation" className="bg-slate-50 p-2">
              <p className="px-1 pb-2 text-xs text-slate-700">
                {BILLING.addMissingItemNotListed(query.trim())}
              </p>
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setCreating(true)}
                className="w-full rounded bg-nas-navy px-3 py-2 text-left text-sm font-medium text-white"
              >
                {BILLING.addMissingItem}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}

      {/* The empty-result case keeps its own panel: there is no list to sit inside. */}
      {open && offerCreate && hits.length === 0 ? (
        <div className="absolute left-0 top-full z-30 w-[26rem] max-w-[90vw] rounded border border-nas-navy bg-white p-2 shadow-lg">
          <p className="px-1 pb-2 text-xs text-slate-600">
            {BILLING.addMissingItemNoMatch(query.trim())}
          </p>
          <button
            type="button"
            /**
             * **Not a tab stop**, for the same reason the result options are not: focus
             * belongs in the cell, and `Enter` already reaches this (see `onKeyDown`).
             * A stop here would sit between the cell and `Quantity` on every bill where
             * a search came back empty.
             */
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setCreating(true)}
            className="w-full rounded bg-nas-navy px-3 py-2 text-left text-sm font-medium text-white"
          >
            {BILLING.addMissingItem}
          </button>
        </div>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="absolute left-0 top-full z-30 bg-white px-2 text-xs text-red-700"
        >
          {error}
        </p>
      ) : null}

      {creating ? (
        <NewItemDialog
          initialName={query.trim()}
          onCancel={() => {
            setCreating(false);
            // Focus back where it was, or the next `Tab` restarts from the top of the
            // document — the same hazard `CustomerPicker` documents.
            input.current?.focus();
          }}
          onCreated={(product) => {
            setCreating(false);
            // Straight onto the current row, so the bill continues rather than
            // restarting. `pick` clears the cell and the caller advances focus to
            // Quantity, exactly as choosing an existing part does — there is
            // deliberately no second "now find it again" step.
            pick(fromProduct(product));
          }}
        />
      ) : null}
    </div>
  );
}

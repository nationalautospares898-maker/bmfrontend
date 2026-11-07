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
  };
}

export interface ItemCellProps {
  row: number;
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
  const [highlighted, setHighlighted] = useState(0);
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
  const [searchedEmpty, setSearchedEmpty] = useState(false);

  const inFlight = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listId = useId();

  const run = useCallback(
    async (text: string) => {
      inFlight.current?.abort();
      if (!text.trim()) {
        setHits([]);
        setOpen(false);
        setUsedCache(false);
        setSearchedEmpty(false);
        return;
      }

      if (!online) {
        const cached = await catalogCache.searchOffline(text);
        setHits(
          cached.map(({ product }) => ({
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
          })),
        );
        setHighlighted(0);
        setOpen(true);
        setUsedCache(true);
        setError(null);
        // Never offered from the cache: "not in the copy saved on this computer" is not
        // evidence that the catalogue lacks the part, and creating a duplicate of
        // something that exists on the server is exactly the wrong outcome.
        setSearchedEmpty(false);
        return;
      }

      const controller = new AbortController();
      inFlight.current = controller;
      try {
        const result = await catalog.search(text, { signal: controller.signal });
        setHits(result.items.map(fromProduct));
        setHighlighted(0);
        setOpen(true);
        setUsedCache(false);
        setError(null);
        setSearchedEmpty(result.items.length === 0);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(
          caught instanceof ApiError
            ? describeError(caught.code).message
            : 'Search is unavailable. Keep typing or try again.',
        );
        // A failed search is not an empty catalogue. Offering to create here would
        // invite a duplicate of a part the server knows about perfectly well.
        setSearchedEmpty(false);
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
  const offerCreate =
    canCreateProduct && online && searchedEmpty && !usedCache && query.trim() !== '';

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
        event.preventDefault();
        const hit = hits[highlighted];
        if (hit) pick(hit);
        return;
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
        className="flex w-full items-baseline gap-2 px-2 py-1 outline-none focus:bg-white focus:ring-2 focus:ring-inset focus:ring-nas-navy"
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
        <span className="font-medium">{line.product_name}</span>
        {line.sku ? <span className="text-xs text-slate-500">{line.sku}</span> : null}
        {/* The stock the client last knew, with its age. Advisory — the server decides at
            finalisation (ADR-006). */}
        {line.known_stock !== null && line.stock_as_of ? (
          <span className="text-xs text-slate-500">
            {BILLING.stockAnnotation(
              line.known_stock,
              new Date(line.stock_as_of).toLocaleTimeString(),
            )}
          </span>
        ) : null}
        {line.price_source === 'manual_override' ? (
          <span className="text-xs text-amber-700">changed</span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="relative">
      <label className="sr-only" htmlFor={`item-${row}`}>
        {BILLING.cellItemLabel(row + 1)}
      </label>
      <input
        id={`item-${row}`}
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
        {...(open && hits.length > 0
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
        </ul>
      ) : null}

      {open && offerCreate ? (
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
            document.querySelector<HTMLElement>(`[data-cell="${row}-item"]`)?.focus();
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

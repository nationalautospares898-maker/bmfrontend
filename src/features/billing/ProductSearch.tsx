/**
 * The item search box — the control the whole screen is built around.
 *
 * Two things make keyboard-only billing possible, and both are requirements rather than
 * polish:
 *
 * - **Searching from the first character** (FR-CAT-003). A minimum query length of two
 *   would make a one-character part code unfindable.
 * - **120 ms debounce with cancellation** (NFR-FE-PERF-001). The previous request is
 *   aborted on the next keystroke, so the results never belong to a query the user has
 *   already moved past.
 *
 * Offline it searches the Dexie cache instead and says so, with the age of the data —
 * never silently returning a smaller result set as though it were complete
 * (FR-OFFLINE-009).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { catalog } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import * as catalogCache from '@/db/catalogCache';
import type { Product } from '@/api/types';
import { BILLING, COMMON } from '@/lib/strings';
import { Busy, Field } from '@/components/primitives';

const DEBOUNCE_MS = 120;

export interface SearchHit {
  productId: string;
  name: string;
  sku: string | null;
  unitCode: string;
  allowsFraction: boolean;
  unitPrice: string;
  /** `null` when the server does not know (no branch stock row), not zero. */
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

export interface ProductSearchProps {
  online: boolean;
  onPick: (hit: SearchHit) => void;
  /** Focused by the parent after each add, so the next item can be typed immediately. */
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

export function ProductSearch({ online, onPick, inputRef }: ProductSearchProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usedCache, setUsedCache] = useState(false);

  const inFlight = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(
    async (text: string) => {
      // Cancel the previous request. Without this, a slow response for `br` can arrive
      // after the response for `brake` and replace it.
      inFlight.current?.abort();
      if (!text.trim()) {
        setHits([]);
        setUsedCache(false);
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
        setUsedCache(true);
        setError(null);
        return;
      }

      const controller = new AbortController();
      inFlight.current = controller;
      setBusy(true);
      try {
        const result = await catalog.search(text, { signal: controller.signal });
        setHits(result.items.map(fromProduct));
        setHighlighted(0);
        setUsedCache(false);
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        // No automatic retry while someone is typing — a "Retry" they can press is
        // better than a stale result arriving three keystrokes later (§7).
        setError(
          caught instanceof ApiError
            ? describeError(caught.code).message
            : 'Search is unavailable. Press Retry or keep typing.',
        );
      } finally {
        if (!controller.signal.aborted) setBusy(false);
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

  function pick(hit: SearchHit): void {
    onPick(hit);
    // Cleared so the next item can be typed straight away without reaching for the
    // mouse or selecting the old text.
    setQuery('');
    setHits([]);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlighted((current) => Math.min(current + 1, hits.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const hit = hits[highlighted];
      if (hit) pick(hit);
    } else if (event.key === 'Escape') {
      setHits([]);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Field
        ref={inputRef}
        label={BILLING.searchLabel}
        placeholder={BILLING.searchPlaceholder}
        value={query}
        autoComplete="off"
        role="combobox"
        aria-expanded={hits.length > 0}
        aria-controls="search-results"
        aria-autocomplete="list"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        {...(error ? { error } : {})}
      />

      {busy ? <Busy label={COMMON.loading} /> : null}

      {usedCache ? (
        // Said plainly. A cashier who cannot find a part needs to know the list is the
        // cached one, not that the part does not exist.
        <p className="text-xs text-amber-800">
          Showing the list saved on this computer. It may be incomplete.
        </p>
      ) : null}

      {hits.length > 0 ? (
        <ul
          id="search-results"
          role="listbox"
          className="max-h-64 divide-y divide-slate-200 overflow-y-auto rounded border border-slate-300"
        >
          {hits.map((hit, index) => (
            <li key={hit.productId} role="option" aria-selected={index === highlighted}>
              <button
                type="button"
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
                  {/*
                    Stock is annotated with its `as_of` whenever it is known, and an
                    unknown stock figure is stated as unknown rather than shown as zero
                    — the server decides at finalisation either way.
                  */}
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
    </div>
  );
}

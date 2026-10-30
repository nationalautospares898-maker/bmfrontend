/**
 * The offline catalog cache.
 *
 * Deliberately **bounded** by the server's `cache_policy.max_rows`. The client never
 * tries to pull the whole catalog, for a security reason rather than a performance one:
 * a counter machine that walks out of the shop should not carry the shop's entire stock
 * list (`SECURITY.md §11`).
 *
 * ⚠️ `cost_price` is never present in the delta and is never stored here **even if it
 * somehow appeared**. The row type has no field for it, so there is nowhere to put it.
 *
 * Every cached figure carries its `as_of`, and the UI renders that alongside the number
 * (FR-OFFLINE-009). A stock figure with no timestamp reads as live, and acting on a
 * stale figure as if it were live is how something gets sold twice.
 */

import { sync } from '@/api/endpoints';
import type { CachedProduct } from '@/api/types';
import { normalizeName, normalizeSku, rankOffline, type Ranked } from '@/lib/normalize';
import { getCatalogCursor, setCatalogCursor } from './meta';
import { db, type CachedProductRow, type CounterDatabase } from './schema';

function toRow(product: CachedProduct, asOf: string): CachedProductRow {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    barcode: product.barcode,
    // Normalised on the way in, so an offline search is an index lookup rather than a
    // scan that normalises every row on every keystroke.
    normalized_name: normalizeName(product.name),
    normalized_sku: product.sku ? normalizeSku(product.sku) : null,
    unit_code: product.unit.code,
    allows_fraction: product.unit.allows_fraction,
    default_selling_price: product.default_selling_price,
    is_active: product.is_active,
    branch_quantity: product.stock.branch_quantity,
    as_of: product.stock.as_of,
    updated_at: asOf,
  };
}

export interface RefreshResult {
  upserted: number;
  hasMore: boolean;
  /** The server rebuilt its delta source; the local cache was cleared and re-pulled. */
  wasReset: boolean;
  /** e.g. `CATALOG_CACHE_TRUNCATED` — offline search will be incomplete until next sync. */
  warnings: string[];
}

/**
 * Pull one page of the delta and apply it.
 *
 * `reset_required` clears the cache first. That is not an optimisation: a delta cursor
 * the server no longer recognises means the local rows may be missing deletions, and a
 * product that was deactivated would keep selling offline.
 */
export async function refresh(
  limit = 500,
  database: CounterDatabase = db,
): Promise<RefreshResult> {
  const cursor = await getCatalogCursor(database);
  const delta = await sync.catalogDelta(cursor, limit);

  const wasReset = delta.reset_required;
  if (wasReset) await database.catalog_cache.clear();

  const rows = delta.products.map((product) => toRow(product, delta.as_of));
  await database.catalog_cache.bulkPut(rows);
  await setCatalogCursor(wasReset ? delta.next_cursor : delta.next_cursor, database);

  return {
    upserted: rows.length,
    hasMore: delta.has_more,
    wasReset,
    warnings: delta.warnings.map((warning) => warning.code),
  };
}

/** Pull until the server says there is no more, bounded so a loop cannot run away. */
export async function refreshFully(
  database: CounterDatabase = db,
  maxPages = 20,
): Promise<RefreshResult> {
  let total = 0;
  let wasReset = false;
  const warnings = new Set<string>();

  for (let page = 0; page < maxPages; page += 1) {
    const result = await refresh(500, database);
    total += result.upserted;
    wasReset = wasReset || result.wasReset;
    for (const warning of result.warnings) warnings.add(warning);
    if (!result.hasMore) {
      return { upserted: total, hasMore: false, wasReset, warnings: [...warnings] };
    }
  }
  // Stopping at the page cap is reported, not hidden: silently truncating would read as
  // "the catalog is fully cached" when it is not.
  return {
    upserted: total,
    hasMore: true,
    wasReset,
    warnings: [...warnings, 'PAGE_CAP_REACHED'],
  };
}

export interface OfflineHit {
  product: CachedProductRow;
  kind: Ranked<CachedProductRow>['kind'];
  score: number;
}

/**
 * Search the cache, using the same tier order as the server.
 *
 * Inactive products are excluded by default, matching the online endpoint — a cashier
 * must not be able to add a discontinued part offline that they could not add online.
 */
export async function searchOffline(
  query: string,
  limit = 20,
  database: CounterDatabase = db,
): Promise<OfflineHit[]> {
  if (!query.trim()) return [];
  const rows = await database.catalog_cache.toArray();
  return rankOffline(
    rows.filter((row) => row.is_active),
    query,
  )
    .slice(0, limit)
    .map((ranked) => ({ product: ranked.item, kind: ranked.kind, score: ranked.score }));
}

export async function cachedCount(database: CounterDatabase = db): Promise<number> {
  return database.catalog_cache.count();
}

export async function getCached(
  productId: string,
  database: CounterDatabase = db,
): Promise<CachedProductRow | undefined> {
  return database.catalog_cache.get(productId);
}

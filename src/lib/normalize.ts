/**
 * Normalisation for offline search.
 *
 * ⚠️ **This logic is duplicated on the server** (`bm.domain.shared.normalize`), which is
 * a deliberate, documented constraint rather than an oversight (ARCHITECTURE.md §8.3).
 * Offline search has to work with no server, so the rules have to exist on both sides.
 *
 * The mitigation is what makes it acceptable: one small pure module on each side, and a
 * **shared fixture list** of real part-number spellings (`normalize.test.ts` here,
 * `test_normalize.py` there) run by both suites. Drift is then caught by a failing test
 * rather than discovered when a cashier cannot find a part they can see on the shelf.
 *
 * The rules, from FR-CAT-006:
 *
 * - case-insensitive;
 * - separators (`-`, `.`, `/`, space) are **removed** from part codes, so `TT-407-BS`,
 *   `tt407bs` and `tt 407 bs` are one key;
 * - names keep single spaces, because a name is read by a human.
 */

/** Unicode decomposition, so `Dürr` and `Durr` are the same key. */
function stripAccents(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** Collapse whitespace, lower-case. Spaces are kept — a name is read by a human. */
export function normalizeName(value: string): string {
  return stripAccents(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * A part code reduced to its comparison key: separators removed entirely.
 *
 * This is the rule that makes a counter hand's typing work. Nobody types a part number
 * the way it is printed, and a search that insisted on the separators would be unusable.
 *
 * Returns `''` for input with no alphanumerics. The server's `normalize_sku` returns
 * `None` in that case, and the difference is deliberate: there it is a stored column
 * under a partial unique index, which has to allow many products with no part code,
 * while here it is only ever a search key. `rankOffline` checks for the empty string
 * before comparing, so an empty key never matches everything.
 */
export function normalizeSku(value: string): string {
  return stripAccents(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Digits only, **keeping the last ten**.
 *
 * `+91 98765 43210`, `098765 43210` and `9876543210` are one phone number to the person
 * who owns it. Keeping the last ten drops a country code or a trunk `0` without having
 * to work out which is which.
 *
 * This matches `bm.domain.shared.normalize.normalize_phone` exactly, and it has to: the
 * duplicate detector keys on this value (FR-CUST-004), so a client that kept the `91`
 * would file the same customer twice — once from a bill typed offline and once from a
 * bill typed online.
 */
export function normalizePhone(value: string): string {
  const digits = value.replace(/\D+/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** Vehicle numbers are written every possible way; strip to alphanumerics. */
export function normalizeVehicleNumber(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

/** How a cached row matched, mirroring the server's ranking tiers. */
export type MatchKind = 'exact_sku' | 'sku_prefix' | 'name_prefix' | 'barcode' | 'fuzzy';

export interface Ranked<T> {
  readonly item: T;
  readonly kind: MatchKind;
  readonly score: number;
}

/**
 * Rank cached rows for an offline query, in the **same tier order as the server**:
 * exact SKU → SKU prefix → name prefix → barcode → substring.
 *
 * Matching the server's order matters more than matching its exact scores: a cashier
 * must not have to learn that the first result means something different offline.
 */
export function rankOffline<
  T extends {
    normalized_sku: string | null;
    normalized_name: string;
    barcode: string | null;
  },
>(rows: readonly T[], query: string): Ranked<T>[] {
  const sku = normalizeSku(query);
  const name = normalizeName(query);
  if (!sku && !name) return [];

  const ranked: Ranked<T>[] = [];
  for (const row of rows) {
    if (sku && row.normalized_sku === sku) {
      ranked.push({ item: row, kind: 'exact_sku', score: 100 });
    } else if (sku && row.normalized_sku?.startsWith(sku)) {
      ranked.push({ item: row, kind: 'sku_prefix', score: 80 });
    } else if (name && row.normalized_name.startsWith(name)) {
      ranked.push({ item: row, kind: 'name_prefix', score: 60 });
    } else if (sku && row.barcode && normalizeSku(row.barcode) === sku) {
      ranked.push({ item: row, kind: 'barcode', score: 55 });
    } else if (name && row.normalized_name.includes(name)) {
      // No trigram similarity offline — a substring match is the honest approximation,
      // and the UI says results come from the cached list and may be incomplete.
      ranked.push({ item: row, kind: 'fuzzy', score: 30 });
    }
  }

  return ranked.sort(
    (a, b) =>
      b.score - a.score || a.item.normalized_name.localeCompare(b.item.normalized_name),
  );
}

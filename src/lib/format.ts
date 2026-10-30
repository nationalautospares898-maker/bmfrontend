/**
 * Display helpers for values whose type the client cannot narrow.
 *
 * Report payloads and error `details` are open-ended by contract — a report spreads its
 * own figures, and `details` carries whatever the failing rule needs. Rendering those
 * with `String()` is how `[object Object]` ends up on a counter screen, so they go
 * through `asText` instead.
 */

/**
 * Render an unknown value as something a person can read, or an em dash.
 *
 * Never `[object Object]`, never `undefined`, never `null` as a word. An object or
 * array is deliberately rendered as a dash rather than JSON: a cashier cannot act on
 * `{"a":1}`, and the places that legitimately need structure unpack it explicitly.
 */
export function asText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return '—';
}

/** A `snake_case` key as a readable label: `cancelled_bill_count` → `cancelled bill count`. */
export function humanizeKey(key: string): string {
  return key.replace(/_/g, ' ');
}

/**
 * Client-generated identifiers.
 *
 * UUIDv7 rather than v4 because the ids are **time-ordered**: a draft, an outbox
 * operation and a device all sort by creation without a separate timestamp column, and
 * the sync protocol relies on `client_seq` ordering that reads naturally alongside them.
 *
 * Ids are generated on the client on purpose (FR-DRAFT-001, FR-CUST-003): a draft
 * created offline already has its final id, so syncing it is an upsert rather than a
 * create, and a retry cannot produce two rows.
 */

/** 48 bits of Unix-millisecond timestamp, 74 bits of randomness, version and variant. */
export function uuidv7(): string {
  // A plain array rather than the typed one for the timestamp writes: with
  // `noUncheckedIndexedAccess` a `Uint8Array` index reads as possibly-undefined, and
  // a non-null assertion per byte would be noise.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const at = (index: number): number => bytes[index] ?? 0;

  // `Date.now()` is only ever used for the ordering prefix. No business date is ever
  // derived from the client clock — the server's time comes from bootstrap (FE-E-3).
  const millis = Date.now();
  bytes[0] = (millis / 2 ** 40) & 0xff;
  bytes[1] = (millis / 2 ** 32) & 0xff;
  bytes[2] = (millis / 2 ** 24) & 0xff;
  bytes[3] = (millis / 2 ** 16) & 0xff;
  bytes[4] = (millis / 2 ** 8) & 0xff;
  bytes[5] = millis & 0xff;

  bytes[6] = (at(6) & 0x0f) | 0x70; // version 7
  bytes[8] = (at(8) & 0x3f) | 0x80; // RFC 4122 variant

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

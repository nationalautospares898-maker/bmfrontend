/**
 * The `meta` store: device identity, sync cursors, the client sequence counter.
 *
 * All of it is permanent and none of it is secret. The device id in particular is a
 * stable UUIDv7 generated **once** per browser profile and sent as `X-Device-Id`; if it
 * were regenerated on each load, every reload would look like a new device to the
 * server's device registry.
 *
 * ⚠️ No token, password or PIN is ever written here. `meta` is IndexedDB, which is
 * readable by any script on the origin — the access token stays in a module variable
 * (NFR-FE-SEC-002).
 */

import { uuidv7 } from '@/lib/ids';
import { db, type CounterDatabase } from './schema';

const KEYS = {
  deviceId: 'device_id',
  clientSeq: 'client_seq',
  catalogCursor: 'catalog_cursor',
  catalogSyncedAt: 'catalog_synced_at',
  lastCounterId: 'last_counter_id',
} as const;

async function get<T>(key: string, database: CounterDatabase = db): Promise<T | null> {
  const row = await database.meta.get(key);
  return row ? (row.value as T) : null;
}

async function set(
  key: string,
  value: unknown,
  database: CounterDatabase = db,
): Promise<void> {
  await database.meta.put({ key, value });
}

/**
 * The device id, created on first use.
 *
 * Read-then-write rather than upsert, so an existing id is never replaced: a new id
 * would orphan this machine's registration and force a re-login.
 */
export async function ensureDeviceId(database: CounterDatabase = db): Promise<string> {
  const existing = await get<string>(KEYS.deviceId, database);
  if (existing) return existing;
  const created = uuidv7();
  await set(KEYS.deviceId, created, database);
  return created;
}

/**
 * The next `client_seq` for an outbox operation.
 *
 * Monotonic per device and allocated inside a transaction, because two tabs claiming
 * the same sequence number would let the server apply two operations for one entity in
 * the wrong order — which for a draft means older content overwriting newer.
 */
export async function nextClientSeq(database: CounterDatabase = db): Promise<number> {
  return database.transaction('rw', database.meta, async () => {
    const current = (await get<number>(KEYS.clientSeq, database)) ?? 0;
    const next = current + 1;
    await set(KEYS.clientSeq, next, database);
    return next;
  });
}

export async function getCatalogCursor(
  database: CounterDatabase = db,
): Promise<string | null> {
  return get<string>(KEYS.catalogCursor, database);
}

export async function setCatalogCursor(
  cursor: string | null,
  database: CounterDatabase = db,
): Promise<void> {
  await set(KEYS.catalogCursor, cursor, database);
  await set(KEYS.catalogSyncedAt, new Date().toISOString(), database);
}

export async function getCatalogSyncedAt(
  database: CounterDatabase = db,
): Promise<string | null> {
  return get<string>(KEYS.catalogSyncedAt, database);
}

/** Remembered so a reload returns the cashier to the counter they were working at. */
export async function getLastCounterId(
  database: CounterDatabase = db,
): Promise<string | null> {
  return get<string>(KEYS.lastCounterId, database);
}

export async function setLastCounterId(
  counterId: string,
  database: CounterDatabase = db,
): Promise<void> {
  await set(KEYS.lastCounterId, counterId, database);
}

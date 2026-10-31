/**
 * Session state: **in memory only**.
 *
 * The access token lives in a module variable and nowhere else — not `localStorage`,
 * not `sessionStorage`, not Dexie, not a readable cookie (NFR-FE-SEC-002). A structural
 * test asserts the storage APIs appear nowhere in `src/`, because the cost of getting
 * this wrong is only visible after an XSS, by which point the token is already gone.
 *
 * Losing the token on reload is the intended trade: a silent `POST /auth/refresh` with
 * the `HttpOnly` cookie recovers it, and drafts load from Dexie **before** any of this
 * happens, so a logged-out cashier never loses typed work.
 */

import type { ErrorCode } from './errors';

export interface CounterInfo {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  /** From bootstrap, never a client constant (rule 15). */
  readonly max_open_drafts: number;
}

export interface SessionState {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly userId: string;
  readonly fullName: string;
  readonly role: string;
  readonly permissions: ReadonlySet<string>;
  readonly businessId: string;
  readonly activeBranchId: string | null;
  readonly mustChangePassword: boolean;
}

let session: SessionState | null = null;
let counter: CounterInfo | null = null;
let deviceId: string | null = null;

/**
 * Offset between the server's clock and this machine's, in milliseconds.
 *
 * Used for **display only**. The client never derives a business date — which financial
 * day a sale belongs to is the server's decision (FE-E-3), and a counter PC with a wrong
 * clock must not be able to move a sale between days.
 */
let serverTimeOffsetMs = 0;

/**
 * Today, in the **business's** timezone, as the server reported it at bootstrap.
 *
 * Stored rather than computed because FE-E-3 forbids the client deriving a business
 * date, and until bootstrap published this the client had no way to obey: a screen
 * defaulting a day filter to `new Date()` uses the *browser's* calendar date. On a
 * counter PC set to UTC that is yesterday's business date for the first five and a half
 * hours of every `Asia/Kolkata` day, so Daily Bills asked for the wrong day and showed
 * an empty list — the same defect the server's own `reports._today` documents.
 */
let businessToday: string | null = null;

type Listener = (state: SessionState | null) => void;
const listeners = new Set<Listener>();

function publish(): void {
  for (const listener of listeners) listener(session);
}

export function subscribeToSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSession(): SessionState | null {
  return session;
}

export function getAccessToken(): string | null {
  return session?.accessToken ?? null;
}

export function setSession(next: SessionState): void {
  session = next;
  publish();
}

/**
 * Clear in-memory session state.
 *
 * Deliberately does **not** touch Dexie. Bills belong to the shop, not the session: a
 * revoked device, an expired token and a deliberate logout all leave local drafts
 * exactly where they were (FR-OFFLINE-010).
 */
export function clearSession(): void {
  session = null;
  counter = null;
  publish();
}

export function getCounter(): CounterInfo | null {
  return counter;
}

export function setCounter(next: CounterInfo | null): void {
  counter = next;
}

export function getDeviceId(): string | null {
  return deviceId;
}

/** Set once at startup from Dexie `meta`, so `X-Device-Id` is stable per browser profile. */
export function setDeviceId(next: string): void {
  deviceId = next;
}

/** The business's calendar date, or `null` before bootstrap has answered. */
export function getBusinessToday(): string | null {
  return businessToday;
}

export function setBusinessToday(isoDate: string): void {
  businessToday = isoDate;
}

export function setServerTimeOffset(serverTimeIso: string): void {
  const serverMillis = Date.parse(serverTimeIso);
  if (!Number.isFinite(serverMillis)) return;
  serverTimeOffsetMs = serverMillis - Date.now();
}

/** The server's current time as best the client knows it. Display only. */
export function serverNow(): Date {
  return new Date(Date.now() + serverTimeOffsetMs);
}

export function serverNowIso(): string {
  return serverNow().toISOString();
}

export function hasPermission(permission: string): boolean {
  return session?.permissions.has(permission) ?? false;
}

/**
 * Whether the session should be treated as gone.
 *
 * Used to decide whether to even attempt a request. Expiry is checked against the
 * server-corrected clock so a skewed counter PC does not log itself out.
 */
export function isSessionExpired(): boolean {
  if (!session) return true;
  return serverNow().getTime() >= session.expiresAt;
}

/** Codes that mean the session is over and a new sign-in is required. */
export const SESSION_ENDING_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'REFRESH_TOKEN_REUSED',
  'USER_INACTIVE',
  'DEVICE_REVOKED',
  'DEVICE_NOT_REGISTERED',
  'ACCOUNT_LOCKED',
]);

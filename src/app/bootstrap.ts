/**
 * Application startup.
 *
 * The order here is a requirement, not a convenience (§9):
 *
 * 1. **Drafts load from Dexie first.** Always, before any network call and regardless
 *    of auth state. A cashier whose token expired overnight must open the app and see
 *    yesterday's half-typed bill, not a login screen that implies it is gone.
 * 2. **Then a silent refresh.** The access token lives only in memory, so a reload has
 *    no token; the `HttpOnly` cookie recovers one without anyone typing a password.
 * 3. **Then bootstrap.** `max_open_drafts`, the money policy, the discount caps, the
 *    print profile and the server's clock all come from there. The client hardcodes
 *    none of them (rule 15).
 *
 * Storage being unusable is reported, never worked around silently (FE-E-1).
 */

import { auth, sync } from '@/api/endpoints';
import { configureAuth, refreshSession } from '@/api/client';
import {
  clearSession,
  setBusinessToday,
  setCounter,
  setDeviceId,
  setServerTimeOffset,
  setSession,
  type SessionState,
} from '@/api/session';
import { ensureDeviceId, setLastCounterId } from '@/db/meta';
import { storageIsUsable } from '@/db/schema';
import type { Bootstrap, SessionResponse } from '@/api/types';
import type { MoneyPolicy } from '@/lib/money';

export interface StartupResult {
  /** `false` when IndexedDB cannot be used; the UI must say so loudly. */
  storageUsable: boolean;
  /** `null` when nobody is signed in yet — the login screen renders. */
  session: SessionState | null;
  bootstrap: Bootstrap | null;
  policy: MoneyPolicy | null;
}

/** Translate a login or refresh response into in-memory session state. */
export function toSessionState(response: SessionResponse): SessionState {
  return {
    accessToken: response.access_token,
    // Converted to an absolute instant so expiry survives a tab that was suspended.
    expiresAt: Date.now() + response.expires_in * 1000,
    userId: response.user.id,
    fullName: response.user.full_name,
    role: response.role,
    permissions: new Set(response.permissions),
    businessId: response.business.id,
    activeBranchId: response.active_branch_id,
    mustChangePassword: response.user.must_change_password,
  };
}

/**
 * The money policy, straight from bootstrap.
 *
 * Declared as a conversion rather than a default object on purpose: there is no
 * client-side fallback policy. A client that invented one would eventually disagree with
 * the invoice it was previewing.
 */
export function toMoneyPolicy(bootstrap: Bootstrap): MoneyPolicy {
  const policy = bootstrap.money_policy;
  return {
    version: policy.version,
    currency: policy.currency,
    amount_scale: policy.amount_scale,
    unit_price_scale: policy.unit_price_scale,
    quantity_scale: policy.quantity_scale,
    percent_scale: policy.percent_scale,
    rounding_mode: policy.rounding_mode as MoneyPolicy['rounding_mode'],
    round_grand_total_to_rupee: policy.round_grand_total_to_rupee,
    require_integral_amounts: policy.require_integral_amounts,
    display_decimal_places: policy.display_decimal_places,
  };
}

export interface StartupOptions {
  /** Called when the session is lost mid-session, so the shell can prompt a login. */
  onSessionLost: () => void;
}

export async function startApplication(options: StartupOptions): Promise<StartupResult> {
  // 1. Local storage, and the device identity that every request carries.
  const storageUsable = await storageIsUsable();
  if (storageUsable) {
    setDeviceId(await ensureDeviceId());
  }

  // The client's single shared refresh path. Wired before the first request so a 401
  // during bootstrap is handled by the same mechanism as a 401 mid-bill.
  // The error is deliberately **not** swallowed here. `refreshOnce` classifies it: a
  // server refusal ends the session, a transport failure leaves it alone and is retried.
  // Collapsing both to `null` here is what made a dropped packet look identical to a
  // revoked cookie, and signed cashiers out mid-bill.
  configureAuth({
    refresh: async () => toSessionState(await auth.refresh()),
    onSessionLost: options.onSessionLost,
  });

  // 2. The silent refresh, through the client's **shared** refresh path.
  //
  // It used to call `auth.refresh()` directly, which bypassed the single-flight guard
  // in `client.ts`, and that mattered because `startApplication` runs inside a
  // `useEffect`: React's development double-mount invokes it twice. Two refreshes, one
  // cookie — the first rotated it, the second presented a spent token, and FR-AUTH-002
  // correctly revoked the family. So in `npm run dev` **every page reload signed the
  // user out**, which is exactly the "it refreshes and logs me out" being reported.
  //
  // Going through `refreshSession()` means the second mount awaits the first attempt
  // and receives the same session, rather than racing it. A failure here is the normal
  // "not signed in" case, not an error to report.
  //
  // No `catch` here, deliberately: `refreshSession` resolves `null` for every failure,
  // having already classified it for the 401 handler, so it cannot throw. There used to
  // be a `DEVICE_REVOKED` branch and it had become unreachable — a revoked machine now
  // reaches the login screen and is told why when it tries to sign in, which is the
  // screen that can actually say it. Local data is **never** deleted either way (§8).
  const session = await refreshSession();
  if (!session) return { storageUsable, session: null, bootstrap: null, policy: null };

  // 3. Bootstrap. Everything the client is not allowed to assume.
  //
  // Guarded, because this call used to sit outside any `try`. Its only caller is a
  // `void (async () => …)()` in `AppShell` whose last statement is `setStarting(false)`,
  // so a rejection here meant that line never ran and the application sat on the
  // "Starting" spinner **for ever** — no error, no retry, nothing to act on. The
  // reachable path was a cold start: a counter PC every morning, where the silent
  // refresh succeeds and then the bootstrap request times out or 500s. The same
  // symptom was fixed for the null-counter case; this was the other half of it.
  //
  // Returning a session with no bootstrap lets the shell render the signed-in state and
  // say what is wrong, which is strictly better than a spinner.
  let bootstrap: Bootstrap;
  try {
    bootstrap = await sync.bootstrap();
  } catch {
    return { storageUsable, session, bootstrap: null, policy: null };
  }

  setServerTimeOffset(bootstrap.server_time);
  setBusinessToday(bootstrap.business_date);
  if (bootstrap.counter) {
    setCounter({
      id: bootstrap.counter.id,
      code: bootstrap.counter.code,
      name: bootstrap.counter.name,
      max_open_drafts: bootstrap.counter.max_open_drafts,
    });
    if (storageUsable) await setLastCounterId(bootstrap.counter.id);
  }

  return { storageUsable, session, bootstrap, policy: toMoneyPolicy(bootstrap) };
}

/**
 * Sign in.
 *
 * The device id is sent so the server can register this machine; it comes from Dexie and
 * is stable per browser profile, which is what makes device revocation meaningful.
 */
export async function signIn(
  username: string,
  password: string,
  deviceId: string,
  deviceLabel = 'Counter PC',
): Promise<StartupResult> {
  const response = await auth.login({
    username,
    password,
    device: { id: deviceId, label: deviceLabel },
  });
  const session = toSessionState(response);
  setSession(session);

  const bootstrap = await sync.bootstrap();
  setServerTimeOffset(bootstrap.server_time);
  setBusinessToday(bootstrap.business_date);
  if (bootstrap.counter) {
    setCounter({
      id: bootstrap.counter.id,
      code: bootstrap.counter.code,
      name: bootstrap.counter.name,
      max_open_drafts: bootstrap.counter.max_open_drafts,
    });
    await setLastCounterId(bootstrap.counter.id);
  }

  return { storageUsable: true, session, bootstrap, policy: toMoneyPolicy(bootstrap) };
}

/**
 * Sign out.
 *
 * Clears **memory only**. Dexie is untouched: bills belong to the shop, not the
 * session, and a logout that deleted unsynced drafts would be unforgivable at a counter.
 */
export async function signOut(): Promise<void> {
  try {
    await auth.logout();
  } catch {
    // The cookie may already be gone. Clearing local session state matters more than
    // the server acknowledging it.
  }
  clearSession();
}

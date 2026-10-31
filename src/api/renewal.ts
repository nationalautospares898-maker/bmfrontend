/**
 * Renew the access token **before** it expires.
 *
 * The client used to renew only in reaction to a 401. That works, but it means the
 * normal path through a 15-minute shift boundary is: a request fails, the client
 * notices, refreshes, and retries. Three things go wrong with that at a counter:
 *
 * 1. Every expiry is a thundering herd. When the token dies, whatever the screen was
 *    doing — a search, a poll, a draft push — all fail at once and all queue behind one
 *    refresh. The single-flight guard makes that safe, but it makes the first action
 *    after a lull visibly slow.
 * 2. It puts the refresh on the critical path of a real action. A cashier pressing
 *    Print Bill at minute 15 waits for a token round trip before the sale is attempted,
 *    and if anything about that round trip fails the sale is the thing that appears
 *    broken.
 * 3. A failed reactive refresh is indistinguishable, to the person at the counter, from
 *    "the system logged me out for no reason" — because that is what it looks like.
 *
 * Renewing early moves all of that off the critical path and into a quiet moment. The
 * reactive path in `client.ts` stays exactly as it was: this is a supplement, not a
 * replacement, and if the timer never fires (a suspended laptop, a throttled background
 * tab) the 401 handler still catches it.
 *
 * Nothing here loosens a security control. It spends the refresh cookie no more often
 * than before — less often, in fact, because a renewal that succeeds early prevents the
 * scatter of concurrent 401s that used to race for it.
 *
 * This was briefly inert, and the reason is worth keeping. `refreshOnce`'s cross-tab
 * re-check asked "is the session still in date?", and a renewal runs `RENEW_MARGIN_MS`
 * *before* expiry by definition — so the answer was always yes and the renewal returned
 * without rotating anything. The re-check now compares **token identity** instead: a
 * renewal passes the token it means to replace, finds it unchanged, and proceeds. A
 * second tab passes the token it found stale, finds the winner's different one, and
 * stands down. One question, answered correctly for both callers.
 */

import { refreshSession } from './client';
import { getSession, isSessionExpired } from './session';

/**
 * How long before expiry to renew.
 *
 * Comfortably longer than any single request, so a renewal cannot land in the middle of
 * one, and comfortably shorter than the 15-minute token so there is a wide quiet window
 * to land in. Not derived from the token's lifetime on purpose: the server owns that
 * number and may shorten it, and a margin expressed as a fraction would shrink with it
 * just when it mattered most.
 */
const RENEW_MARGIN_MS = 120_000;

/** Never busier than this, however short the token is. */
const MIN_INTERVAL_MS = 30_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

function clear(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function scheduleNext(): void {
  clear();
  if (!running) return;

  const session = getSession();
  if (!session) return;

  const untilExpiry = session.expiresAt - Date.now();
  const delay = Math.max(untilExpiry - RENEW_MARGIN_MS, MIN_INTERVAL_MS);

  timer = setTimeout(() => {
    void renewNow();
  }, delay);
}

async function renewNow(): Promise<void> {
  if (!running) return;
  const session = getSession();
  if (!session) return;

  // Only renew if it is actually close to expiry. Another tab may have renewed while
  // this timer was pending, in which case there is nothing to do and spending the
  // single-use cookie again would be the precise mistake this module exists to avoid.
  const dueSoon = session.expiresAt - Date.now() <= RENEW_MARGIN_MS;
  if (!dueSoon && !isSessionExpired()) {
    scheduleNext();
    return;
  }

  // `refreshSession` holds the cross-tab lock and re-checks the session inside it, so
  // several tabs waking together produce one rotation rather than one revocation.
  //
  // Nothing is caught here because there is nothing to catch: `refreshOnce` resolves to
  // `null` for every failure, having already recorded **why** for the 401 handler to read.
  // Both reasons come back to this schedule, which is deliberate:
  //
  //   * a transport failure leaves the session intact, so the next tick simply tries
  //     again — that is the whole of the fix for "a blip signed me out";
  //   * a refusal is **not** acted on from here. Ending a session stays the 401 handler's
  //     decision, taken on a request the cashier can see fail, because a background timer
  //     that cleared the screen would do it with no user action to explain it — which is
  //     the complaint this module exists to answer, not to reproduce on a timer.
  //
  // The cost is that a refused cookie is presented again every `MIN_INTERVAL_MS` until a
  // real request settles it. Asking rotates nothing, so it cannot make the revocation
  // worse; it is still the reason the floor is thirty seconds and not one.
  await refreshSession();
  scheduleNext();
}

/** Begin renewing ahead of expiry. Idempotent. */
export function startSessionRenewal(): void {
  if (running) return;
  running = true;
  scheduleNext();

  // A laptop lid closed over lunch suspends timers; the token is long dead by the time
  // it opens. Re-evaluating on wake renews immediately rather than waiting for a
  // request to fail first.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisible);
  }
}

export function stopSessionRenewal(): void {
  running = false;
  clear();
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisible);
  }
}

function onVisible(): void {
  if (document.visibilityState === 'visible') void renewNow();
}

/**
 * The one notification feed, owned by the module rather than by a component.
 *
 * ## What this is, and what it replaced
 *
 * Until 2026-11-22 this ran an unconditional `setInterval` every 30 seconds for as long
 * as a signed-in tab was visible — 120 requests an hour, every one of them through
 * Vercel's `/api/*` rewrite and on to Railway, almost all of them answering "nothing has
 * changed". The owner asked for that to stop.
 *
 * It is now **demand-and-schedule driven**. There are two kinds of reason to fetch, and
 * the design turns on keeping them apart:
 *
 * 1. **The person did something** that means the list might be stale to them — signed
 *    in, came back to the tab, reconnected, opened the bell. Each of those fetches once,
 *    immediately.
 * 2. **The server said a scheduled notification is about to exist.** Every response
 *    carries `next_check_after_seconds`, computed by the backend from the actual
 *    `reminder_schedules` rows (`domain/reminders/service.next_due_in_seconds`). A
 *    single `setTimeout` for exactly that long replaces the fixed interval.
 *
 * The second point is the whole reason this is not simply "fetch on interaction". The
 * 5 PM stock summary, the hourly credit reminder and the hourly pending-order nudge are
 * created by the backend whether or not anybody touches the browser, and a cashier who
 * has been looking at the billing screen since four o'clock performs no interaction at
 * all. Something has to wake up. What it must *not* do is wake up every 30 seconds to
 * discover that 5 PM is still three hours away — so the server, which owns the
 * schedules, says how long to sleep, and the client sleeps that long.
 *
 * ## Why the cadence is the server's answer and not a constant here
 *
 * A client-side constant would be a second copy of the schedule. The owner can disable
 * the credit reminder, delete it, or add a custom one at any time through
 * `RemindersSettings`; a hardcoded "check hourly" would carry on regardless, and would
 * be wrong in both directions — too slow to catch a reminder the owner just re-enabled,
 * too fast for a business with every reminder switched off. The hint comes from the rows
 * the firing logic itself reads, so the two cannot drift.
 *
 * `MAX_CHECK_INTERVAL_MS` still clamps it locally. The server already clamps to the same
 * ceiling; doing it again here means a malformed, stale or absent hint degrades to a
 * known-good 15 minutes instead of stranding the bell for hours.
 *
 * ## The guards, which are unchanged
 *
 * Both predate this change and both stay, at module scope where nothing a component does
 * can reset them (that was the fix in `ad9e6ec`, after a `visibilitychange` storm and a
 * remount storm were each measured driving ~7 requests/second):
 *
 * * **Single-flight.** At most one `GET /notifications` in flight at any moment; a
 *   refresh asked for while one is running joins it rather than starting a second.
 * * **A floor between request starts.** `MIN_FETCH_INTERVAL_MS`, whatever asks. This is
 *   what bounds the event-driven triggers, which have no natural rate limit — a user can
 *   open and close the bell as fast as they can click.
 *
 * ## What is deliberately *not* here
 *
 * **Cross-tab leader election.** `scheduler.ts` establishes Web Locks as this
 * application's cross-tab primitive, so it was the obvious next step — and it is the
 * wrong one here. Fetching is already gated on `document.visibilityState === 'visible'`,
 * and only a tab the cashier is actually looking at is visible, so background tabs cost
 * nothing. Electing one owner across tabs would mean a *hidden* tab could hold the lock
 * while the visible one showed nothing.
 */

import { notifications as notificationsApi } from '@/api/endpoints';
import type { Notification } from '@/api/types';

/**
 * The fallback sleep, used when the server sends no usable hint — and the ceiling any
 * hint is clamped to.
 *
 * Fifteen minutes is the longest this application will ever leave a scheduled
 * notification undiscovered. It is not a polling interval: in normal operation the
 * server's hint is what decides, and that is typically far longer (an hour, or the hours
 * remaining until 17:00). This is the bound on how wrong the hint is allowed to make us.
 */
export const MAX_CHECK_INTERVAL_MS = 15 * 60 * 1000;

/**
 * The shortest sleep a server hint can produce, so a schedule that is already overdue
 * cannot turn into a tight request loop. Mirrors the backend's own floor.
 */
export const MIN_CHECK_INTERVAL_MS = 60 * 1000;

/**
 * The floor between two fetch *starts*, whatever triggers them.
 *
 * Five seconds. It exists only to bound the event-driven refreshes — visibility changes,
 * reconnects, bell openings, remounts — which have no natural rate limit of their own.
 * The scheduled sleep never comes near it.
 */
export const MIN_FETCH_INTERVAL_MS = 5_000;

type Listener = (items: Notification[]) => void;

const listeners = new Set<Listener>();

/** Module scope on purpose: a remount must not be able to reset any of these. */
let inFlight: Promise<void> | null = null;
let lastStartedAt = Number.NEGATIVE_INFINITY;
let timer: ReturnType<typeof setTimeout> | null = null;
/**
 * A refresh that the floor turned down, re-armed for the moment the floor expires.
 *
 * At most one is ever pending, which is what keeps the rate identical to simply
 * dropping it: one request per `MIN_FETCH_INTERVAL_MS`, no matter how many asks arrive
 * in between. See `refreshNotifications` for why dropping was not good enough.
 *
 * ## It can never fire after becoming obsolete, and that is structural
 *
 * A deferral exists only while the floor is blocking, so it is at most
 * `MIN_FETCH_INTERVAL_MS` (5 s) in the future. A *scheduled* check is at least
 * `MIN_CHECK_INTERVAL_MS` (60 s) away, because that is the server hint's own floor. And
 * no other trigger can start a fetch inside the deferral's window either — the floor
 * that caused the deferral is the same floor that declines everything else until it
 * expires.
 *
 * So no fetch can occur between a deferral being armed and it firing: the deferred
 * refresh is always the *first* request after the floor lifts, and the data it asks for
 * has never already arrived. An "is this still needed?" check at fire time would be a
 * branch that can never be taken. `notificationsPoller.test.ts` asserts the invariant
 * (`MIN_CHECK_INTERVAL_MS > MIN_FETCH_INTERVAL_MS`) rather than the dead branch.
 */
let deferred: ReturnType<typeof setTimeout> | null = null;
let listenersAttached = false;

function isVisible(): boolean {
  // `document` is absent in a non-DOM context; treat that as "do not fetch" rather than
  // throwing, matching how `renewal.ts` guards the same listener.
  return typeof document !== 'undefined' && document.visibilityState === 'visible';
}

/** Clamp a server hint into something safe to sleep for. */
function intervalFromHint(seconds: unknown): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return MAX_CHECK_INTERVAL_MS;
  }
  return Math.min(MAX_CHECK_INTERVAL_MS, Math.max(MIN_CHECK_INTERVAL_MS, seconds * 1000));
}

/**
 * Arm the next scheduled check.
 *
 * A single `setTimeout`, replaced each time rather than a repeating interval: the delay
 * is a fresh answer from the server on every response, so there is nothing to repeat.
 * Re-arming only while somebody is subscribed is what stops a timer outliving the bell.
 */
function schedule(delayMs: number): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (listeners.size === 0) return;
  timer = setTimeout(() => {
    timer = null;
    void refreshNotifications();
  }, delayMs);
}

/**
 * Fetch, unless a fetch is already running, the tab is hidden, or the floor has not
 * elapsed.
 *
 * Returns the in-flight promise when it joins one, so a caller can await "the current
 * refresh" without having caused an extra request.
 *
 * Exported because the bell calls it directly when the panel is opened — an explicit
 * "show me" is exactly the interaction that deserves a fetch.
 */
export function refreshNotifications(): Promise<void> {
  if (inFlight) return inFlight;
  if (!isVisible()) return Promise.resolve();

  const now = Date.now();
  const sinceLast = now - lastStartedAt;
  if (sinceLast < MIN_FETCH_INTERVAL_MS) {
    // **Deferred, not dropped.** Dropping was the first implementation and the browser
    // suite found what is wrong with it: finalise a bill, open the bell within five
    // seconds, and the floor silently refuses — so the panel shows the list from before
    // the sale, and the next scheduled check is up to fifteen minutes away. An explicit
    // "show me" that answers with stale data is a worse failure than an extra request.
    //
    // Re-arming for the moment the floor expires honours the ask without weakening the
    // limit at all: only one deferral is ever pending, so the ceiling is still exactly
    // one request per `MIN_FETCH_INTERVAL_MS` however many asks arrive — which is the
    // same bound the storm tests measure.
    if (deferred === null && listeners.size > 0) {
      deferred = setTimeout(() => {
        deferred = null;
        void refreshNotifications();
      }, MIN_FETCH_INTERVAL_MS - sinceLast);
    }
    return Promise.resolve();
  }
  lastStartedAt = now;

  inFlight = (async () => {
    try {
      const response = await notificationsApi.list();
      // The server's answer to "when could the next scheduled notification exist".
      schedule(intervalFromHint(response.next_check_after_seconds));
      // A response that arrives after the last subscriber has gone is dropped rather
      // than published: there is nobody to render it, and firing device notifications
      // for an unmounted bell would be a popup with no window behind it.
      if (listeners.size === 0) return;
      for (const listener of listeners) listener(response.notifications);
    } catch {
      // A failed fetch keeps whatever was last shown and waits out a full fallback
      // interval before trying again. It deliberately does not retry sooner — the
      // request layer has already retried the transport (`api/client.ts`), and a retry
      // here is how a flaky connection turns into a request loop.
      schedule(MAX_CHECK_INTERVAL_MS);
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Becoming visible refreshes immediately; the floor is what stops a stream of these
 * events becoming a stream of requests. Going hidden refreshes nothing — the guard in
 * `refreshNotifications` sees `visibilityState === 'hidden'` and declines.
 */
const onVisibilityChange = (): void => {
  if (!isVisible()) return;
  void refreshNotifications();
};

/**
 * Reconnecting refreshes immediately.
 *
 * This is new as of 2026-11-22 and closes a real gap: the old fixed interval meant a tab
 * that had been offline waited out the remainder of its 30 seconds, but a tab that had
 * been offline for an hour under the *new* schedule-driven sleep could be most of a
 * fallback interval away from noticing. A reconnect is the clearest possible signal that
 * what we hold may be stale.
 */
const onOnline = (): void => {
  void refreshNotifications();
};

function startIfNeeded(): void {
  if (listenersAttached || typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', onVisibilityChange);
  if (typeof window !== 'undefined') window.addEventListener('online', onOnline);
  listenersAttached = true;
}

function stopIfIdle(): void {
  if (listeners.size > 0) return;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (deferred !== null) {
    clearTimeout(deferred);
    deferred = null;
  }
  if (listenersAttached && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
    listenersAttached = false;
  }
}

/**
 * Start receiving notifications. Returns the unsubscribe function.
 *
 * The first subscriber attaches the listeners and asks for an immediate refresh — which
 * is the application-open / sign-in fetch, since the bell mounts only once there is a
 * session. Every later subscriber joins the existing feed rather than adding another.
 * The last to leave clears the timer and removes the listeners.
 *
 * Because the floor is module-level, a component that unmounts and remounts immediately
 * re-subscribes to a feed that simply declines to fetch again until the floor has
 * elapsed.
 */
export function subscribeToNotifications(listener: Listener): () => void {
  listeners.add(listener);
  startIfNeeded();
  // If a timer is already armed from a previous subscriber's response, leave it alone;
  // otherwise make sure one exists even if the immediate refresh below is declined by
  // the floor or by the tab being hidden, so the feed cannot end up with no future.
  if (timer === null) schedule(MAX_CHECK_INTERVAL_MS);
  void refreshNotifications();

  return () => {
    listeners.delete(listener);
    stopIfIdle();
  };
}

/** Exposed for tests only, so one test's state does not leak into the next. */
export function resetNotificationsPoller(): void {
  listeners.clear();
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (deferred !== null) clearTimeout(deferred);
  deferred = null;
  if (listenersAttached && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
  }
  listenersAttached = false;
  inFlight = null;
  lastStartedAt = Number.NEGATIVE_INFINITY;
}

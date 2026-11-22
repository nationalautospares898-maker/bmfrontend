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

/**
 * Set once this tab learns that the build it is running has been superseded.
 *
 * ## Why a running tab needs an off switch at all
 *
 * `vite.config.ts` sets `skipWaiting: false` and `clientsClaim: false` (ADR-031),
 * deliberately: a forced reload mid-sale is worse than running a version behind. The
 * consequence is that an open tab keeps executing **its own** bundle until somebody
 * closes it or accepts the update prompt — indefinitely, on a counter PC that is never
 * closed.
 *
 * That is survivable when the old build is merely out of date. It is not survivable
 * when the old build is *defective in its request behaviour*, which is exactly what
 * happened: the bundle before `45570db` re-fetched on every response (a `useEffect`
 * whose dependency changed on every parent render), looping at network round-trip speed
 * — roughly eight requests a second from one tab, which is what exhausted the CDN
 * budget. Deploying the fix could not stop it, because the tabs doing it never loaded
 * the fix.
 *
 * So detection and reload are separated here, and only the safe half is automatic:
 *
 * * **Stopping the poll is automatic.** It cancels nothing the user is doing, touches
 *   no draft and no session — the worst case is a bell that stops refreshing in a tab
 *   whose replacement is already downloaded and waiting.
 * * **Reloading stays a prompt**, exactly as before (`swUpdate.applyUpdate`).
 *
 * A defective build therefore goes quiet within one update check even if nobody is at
 * the counter to click anything.
 */
let stale = false;

/** Aborts the request in flight when this tab is declared stale. */
let inFlightAbort: AbortController | null = null;

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
  if (stale) return;
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
  // A superseded build asks for nothing further, whatever triggers it — the scheduled
  // timer, a visibility change, a reconnect, or the bell being opened. The replacement
  // build will fetch on its own first subscribe.
  if (stale) return Promise.resolve();
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

  const abort = new AbortController();
  inFlightAbort = abort;
  inFlight = (async () => {
    try {
      const response = await notificationsApi.list(50, abort.signal);
      // Declared stale while this was in flight: publish nothing and, crucially, arm
      // nothing. `schedule` already refuses, but returning here keeps the listeners
      // from being handed a payload by a build that is being retired.
      if (stale) return;
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
      //
      // An abort caused by this tab being declared stale lands here too, and must not
      // re-arm: `schedule` refuses while `stale`, so the retirement is final.
      schedule(MAX_CHECK_INTERVAL_MS);
    } finally {
      inFlight = null;
      if (inFlightAbort === abort) inFlightAbort = null;
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

/**
 * The channel one tab uses to tell the others that the build they share is obsolete.
 *
 * Every tab on the origin runs the same bundle, so a discovery by one is true for all —
 * but each tab has its own service-worker update timing, so without this the quietest
 * tab could keep polling long after a sibling has been told. `BroadcastChannel` rather
 * than the Web Lock used elsewhere: this is a one-way announcement, not a mutual
 * exclusion, and there is nothing to hold.
 *
 * Absent in older browsers, where each tab simply discovers it independently — the
 * degraded behaviour is "slower", never "wrong".
 */
const STALE_CHANNEL = 'bm-client-stale';
let staleChannel: BroadcastChannel | null = null;

function staleBroadcast(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (staleChannel === null) {
    staleChannel = new BroadcastChannel(STALE_CHANNEL);
    staleChannel.onmessage = () => {
      // Announced by a sibling. Retire locally without re-announcing, so two tabs
      // cannot bounce the message between them.
      markClientStale({ announce: false });
    };
  }
  return staleChannel;
}

/**
 * Retire this tab's notification feed: no further requests, ever, from this build.
 *
 * Called when the service worker reports that a newer build is waiting
 * (`app/swUpdate.ts`). It deliberately does **not** reload, prompt, clear the session or
 * touch a draft — see the note on `stale` for why stopping and reloading are separate
 * decisions. The bell keeps rendering whatever it last received; it simply stops asking
 * for more.
 *
 * Idempotent, so repeated update events and a sibling's broadcast cost nothing.
 */
export function markClientStale(options: { announce?: boolean } = {}): void {
  const announce = options.announce ?? true;
  if (!stale) {
    stale = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (deferred !== null) {
      clearTimeout(deferred);
      deferred = null;
    }
    // Stop the listeners too: a visibility change or reconnect in a retired tab should
    // not even reach the guard.
    if (listenersAttached && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
      listenersAttached = false;
    }
    inFlightAbort?.abort();
    inFlightAbort = null;
  }
  if (announce) {
    try {
      staleBroadcast()?.postMessage({ type: 'stale' });
    } catch {
      // A closed or unavailable channel must never break the retirement itself.
    }
  }
}

/** Whether this tab has retired its feed. Exposed for tests and diagnostics. */
export function isClientStale(): boolean {
  return stale;
}

/** Exposed for tests only, so one test's state does not leak into the next. */
export function resetNotificationsPoller(): void {
  stale = false;
  inFlightAbort = null;
  if (staleChannel !== null) {
    staleChannel.onmessage = null;
    try {
      staleChannel.close();
    } catch {
      // Already closed.
    }
    staleChannel = null;
  }
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

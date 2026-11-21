/**
 * The one notification poller, owned by the module rather than by a component.
 *
 * ## Why this exists at all
 *
 * `NotificationBell` used to own its own `setInterval` and its own `visibilitychange`
 * listener. Three separate mechanisms could drive that arrangement far past its intended
 * 30-second cadence, each measured at ~7 requests/second in
 * `notificationsPoller.test.ts`'s own comparison — which is the rate that exhausted a
 * 1,000,000-request monthly CDN budget for a two-person shop:
 *
 * 1. **A `visibilitychange` storm.** The handler fetched on *every* event with no floor,
 *    so N events produced N requests, however fast they arrived.
 * 2. **A remount storm.** All the state that could have throttled it (`lastStartedAt`)
 *    lived in the component, so unmounting and remounting reset it and fetched again
 *    immediately, every time.
 * 3. **Overlapping requests.** Nothing tracked an in-flight fetch, so a slow response
 *    did not stop another request being issued on top of it.
 *
 * All three are the same underlying omission — no single-flight, and no minimum interval,
 * anywhere that outlives a component instance. Both guards live here, at module scope, so
 * they cannot be reset by anything a component does. That is the whole design: the
 * component subscribes and renders; it does not get to decide when a request happens.
 *
 * ## The two hard guarantees
 *
 * * **Single-flight.** At most one `GET /notifications` is in flight at any moment. A
 *   refresh asked for while one is running joins the running one instead of starting a
 *   second.
 * * **A floor between requests.** Two fetches can never *start* closer together than
 *   `MIN_FETCH_INTERVAL_MS`, no matter what asks. This is what converts an unbounded
 *   storm into a bounded trickle: the measured 7 req/s becomes 0.2 req/s worst case, and
 *   the normal cadence (one per 30 s) is far below the floor and so is never affected.
 *
 * ## What is deliberately *not* here
 *
 * **Cross-tab leader election.** `scheduler.ts` establishes Web Locks as this
 * application's cross-tab primitive, so it was the obvious next step — and it is the
 * wrong one here. Polling is already gated on `document.visibilityState === 'visible'`,
 * and only a tab the cashier is actually looking at is visible, so ten background tabs
 * cost nothing today. Electing one polling owner across tabs would mean a *hidden* tab
 * could hold the lock while the visible one showed nothing — trading a request saving
 * that the visibility gate has already banked for a bell that silently stops updating.
 * `notificationsPoller.test.ts` measures the multi-tab case rather than assuming it.
 */

import { notifications as notificationsApi } from '@/api/endpoints';
import type { Notification } from '@/api/types';

/** The intended steady-state cadence (FR-A.1). Unchanged. */
export const POLL_INTERVAL_MS = 30_000;

/**
 * The floor between two fetch *starts*, whatever triggers them.
 *
 * Five seconds, not thirty: a cashier returning to the tab should see current
 * notifications, and the scheduled cadence never comes near this floor anyway. It exists
 * only to bound event-driven refreshes — visibility changes and remounts — which have no
 * natural rate limit of their own.
 */
export const MIN_FETCH_INTERVAL_MS = 5_000;

type Listener = (items: Notification[]) => void;

const listeners = new Set<Listener>();

/** Module scope on purpose: a remount must not be able to reset these. */
let inFlight: Promise<void> | null = null;
let lastStartedAt = Number.NEGATIVE_INFINITY;
let timer: ReturnType<typeof setInterval> | null = null;
let listenerAttached = false;

function isVisible(): boolean {
  // `document` is absent in a non-DOM context; treat that as "do not poll" rather than
  // throwing, matching how `renewal.ts` guards the same listener.
  return typeof document !== 'undefined' && document.visibilityState === 'visible';
}

/**
 * Fetch, unless a fetch is already running or the floor has not elapsed.
 *
 * Returns the in-flight promise when it joins one, so a caller can await "the current
 * refresh" without having caused an extra request.
 */
export function refreshNotifications(): Promise<void> {
  if (inFlight) return inFlight;
  if (!isVisible()) return Promise.resolve();

  const now = Date.now();
  if (now - lastStartedAt < MIN_FETCH_INTERVAL_MS) return Promise.resolve();
  lastStartedAt = now;

  inFlight = (async () => {
    try {
      const response = await notificationsApi.list();
      // A response that arrives after the last subscriber has gone is dropped rather
      // than published: there is nobody to render it, and firing device notifications
      // for an unmounted bell would be a popup with no window behind it.
      if (listeners.size === 0) return;
      for (const listener of listeners) listener(response.notifications);
    } catch {
      // A failed poll keeps whatever was last shown and waits for the next scheduled
      // tick. It deliberately does not retry sooner — a retry here is how a flaky
      // connection turns into a request loop.
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

const onVisibilityChange = (): void => {
  // Becoming visible refreshes immediately; the floor in `refreshNotifications` is what
  // stops a stream of these events becoming a stream of requests.
  void refreshNotifications();
};

function startIfNeeded(): void {
  if (timer === null) {
    timer = setInterval(() => void refreshNotifications(), POLL_INTERVAL_MS);
  }
  if (!listenerAttached && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
    listenerAttached = true;
  }
}

function stopIfIdle(): void {
  if (listeners.size > 0) return;
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (listenerAttached && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    listenerAttached = false;
  }
}

/**
 * Start receiving polled notifications. Returns the unsubscribe function.
 *
 * The first subscriber starts the timer and asks for an immediate refresh; every later
 * one joins the existing poll rather than adding another. The last to leave stops the
 * timer and removes the listener. Because the floor is module-level, a component that
 * unmounts and remounts immediately re-subscribes to a poller that simply declines to
 * fetch again until the floor has elapsed.
 */
export function subscribeToNotifications(listener: Listener): () => void {
  listeners.add(listener);
  startIfNeeded();
  void refreshNotifications();

  return () => {
    listeners.delete(listener);
    stopIfIdle();
  };
}

/** Exposed for tests only, so one test's poller state does not leak into the next. */
export function resetNotificationsPoller(): void {
  listeners.clear();
  if (timer !== null) clearInterval(timer);
  timer = null;
  if (listenerAttached && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }
  listenerAttached = false;
  inFlight = null;
  lastStartedAt = Number.NEGATIVE_INFINITY;
}

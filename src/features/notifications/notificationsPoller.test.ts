/**
 * The notification feed's guarantees, measured rather than asserted by inspection.
 *
 * ## Two generations of defect are under test here
 *
 * **First**, the request storms. A render-triggered loop in this feature consumed a
 * 1,000,000-request monthly CDN budget for a two-person shop. Three distinct mechanisms
 * were each measured driving the pre-poller component at **~7 requests/second** — a
 * visibility storm, a remount storm, and overlapping slow requests. So the storm tests
 * below do not check "is there a throttle": they drive each mechanism at the rate that
 * reproduced the incident and assert the resulting count stays bounded.
 *
 * | implementation | visibility storm | remount storm | overlapping |
 * |---|---|---|---|
 * | original (pre-`45570db`) | ~7.0 req/s | ~7.0 req/s | unbounded |
 * | previous (`45570db`, no floor) | ~7.05 req/s | ~7.02 req/s | unbounded |
 * | this feed | bounded by the floor | bounded by the floor | one at a time |
 *
 * **Second**, the unconditional 30-second timer itself, removed on 2026-11-22. Bounding
 * the storms left the steady state untouched: 120 requests an hour per visible tab,
 * almost all of them answering "nothing has changed". The tests in
 * *"no unconditional polling"* are the ones that would fail if a fixed interval were
 * ever reintroduced under any name — which is the specific regression the owner asked to
 * be protected against.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Notification } from '@/api/types';
import {
  MAX_CHECK_INTERVAL_MS,
  MIN_CHECK_INTERVAL_MS,
  MIN_FETCH_INTERVAL_MS,
  refreshNotifications,
  resetNotificationsPoller,
  subscribeToNotifications,
} from './notificationsPoller';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@/api/endpoints', () => ({
  notifications: {
    list: mocks.list,
    dismiss: vi.fn(),
    acknowledge: vi.fn(),
    snooze: vi.fn(),
  },
}));

function notification(id = 'n-1'): Notification {
  return {
    id,
    kind: 'low_stock',
    severity: 'warning',
    title: 'Brake Shoe Set is running low',
    body: null,
    created_at: '2026-11-10T10:00:00Z',
    status: 'active',
    entity_type: 'product',
    entity_id: 'prod-1',
    read_at: null,
  };
}

/**
 * Resolves after `latencyMs`, the way a real round trip does.
 *
 * `hintSeconds` is the server's `next_check_after_seconds`. The default is the ceiling,
 * which is what a shop with nothing scheduled soon is told.
 */
function respondAfter(latencyMs: number, id = 'n-1', hintSeconds?: number): void {
  mocks.list.mockImplementation(
    () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              notifications: [notification(id)],
              next_check_after_seconds: hintSeconds ?? MAX_CHECK_INTERVAL_MS / 1000,
            }),
          latencyMs,
        ),
      ),
  );
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

beforeEach(() => {
  mocks.list.mockReset();
  respondAfter(140);
  setVisibility('visible');
  resetNotificationsPoller();
  vi.useFakeTimers();
});

afterEach(() => {
  resetNotificationsPoller();
  vi.useRealTimers();
});

describe('notificationsPoller — normal operation', () => {
  it('fetches once on subscribe (sign-in / application open)', async () => {
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('publishes each payload to every subscriber', async () => {
    const seen: Notification[][] = [];
    subscribeToNotifications((items) => seen.push(items));
    subscribeToNotifications((items) => seen.push(items));
    await vi.advanceTimersByTimeAsync(200);

    expect(mocks.list).toHaveBeenCalledTimes(1); // one request, two subscribers
    expect(seen).toHaveLength(2);
    expect(seen[0]?.[0]?.id).toBe('n-1');
  });

  it('the scheduled sleep is far above the floor, so the two never interact', () => {
    expect(MIN_CHECK_INTERVAL_MS).toBeGreaterThan(MIN_FETCH_INTERVAL_MS * 2);
    expect(MAX_CHECK_INTERVAL_MS).toBeGreaterThan(MIN_CHECK_INTERVAL_MS);
  });
});

describe('notificationsPoller — no unconditional polling', () => {
  it('does NOT fetch every 30 seconds: one subscribe fetch, then nothing for 10 minutes', async () => {
    // The regression this protects against. Under the old 30-second interval this same
    // window produced 20 requests.
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('an idle visible tab makes at most 4 requests an hour, not 120', async () => {
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1_000);

    const perHour = mocks.list.mock.calls.length;
    // 1 subscribe fetch + one per ceiling-length sleep.
    const ceiling = 1 + 3_600_000 / MAX_CHECK_INTERVAL_MS;
    expect(perHour).toBeLessThanOrEqual(ceiling);
    expect(perHour).toBeLessThan(10);
  });

  it('sleeps for exactly as long as the server says, when the server says soon', async () => {
    // A 5 PM summary two minutes away: the server says 120s and the client must come
    // back then, not in fifteen minutes.
    respondAfter(10, 'n-1', 120);
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    // Not yet.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    // Now.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('clamps an absurdly small hint up to the floor, so it cannot become a loop', async () => {
    respondAfter(10, 'n-1', 1); // the server would never send this; a proxy might
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MIN_CHECK_INTERVAL_MS - 5_000);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('clamps an absurdly large hint down to the ceiling, so the bell cannot be stranded', async () => {
    respondAfter(10, 'n-1', 86_400); // "come back tomorrow"
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(50);

    await vi.advanceTimersByTimeAsync(MAX_CHECK_INTERVAL_MS + 1_000);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('falls back to the ceiling when the server sends no hint at all', async () => {
    mocks.list.mockResolvedValue({ notifications: [] });
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MAX_CHECK_INTERVAL_MS + 1_000);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });
});

describe('notificationsPoller — interaction triggers', () => {
  it('refreshes when the tab becomes visible again', async () => {
    setVisibility('hidden');
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.list).not.toHaveBeenCalled();

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the network reconnects', async () => {
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    // Past the floor, so the reconnect is allowed to fetch.
    await vi.advanceTimersByTimeAsync(MIN_FETCH_INTERVAL_MS + 100);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(200);

    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('an explicit refresh (opening the bell) fetches, bounded by the floor', async () => {
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    // Opened again immediately: the floor declines rather than issuing a second request.
    void refreshNotifications();
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MIN_FETCH_INTERVAL_MS);
    void refreshNotifications();
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('a refresh the floor turned down is honoured as soon as the floor expires', async () => {
    // Found by the browser suite: finalise a bill, open the bell within five seconds,
    // and dropping the refresh meant the panel showed the list from before the sale
    // with the next scheduled check up to fifteen minutes away. An explicit "show me"
    // has to be answered eventually.
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    // Asked again immediately: declined now...
    void refreshNotifications();
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    // ...and served the moment the floor allows, without anybody asking again.
    await vi.advanceTimersByTimeAsync(MIN_FETCH_INTERVAL_MS);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('a deferred refresh can never fire after becoming obsolete', async () => {
    // Asserted as the *invariant* rather than by trying to construct the stale case,
    // because the stale case cannot be constructed — which is the point.
    //
    // A deferral is at most MIN_FETCH_INTERVAL_MS (5 s) in the future; a scheduled check
    // is at least MIN_CHECK_INTERVAL_MS (60 s) away. And every other trigger is declined
    // by the same floor that armed the deferral. So the deferred refresh is always the
    // first request after the floor lifts, and the data it asks for has never already
    // arrived. If this assertion ever fails, the obsolescence case becomes reachable and
    // `refreshNotifications` needs a staleness check at fire time.
    expect(MIN_CHECK_INTERVAL_MS).toBeGreaterThan(MIN_FETCH_INTERVAL_MS);

    // And the behaviour that follows from it: an ask inside the floor is served exactly
    // once, by the deferral, with no second request behind it.
    respondAfter(10, 'n-1', MIN_CHECK_INTERVAL_MS / 1000);
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(50);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    void refreshNotifications(); // declined, deferred
    await vi.advanceTimersByTimeAsync(MIN_FETCH_INTERVAL_MS + 100);
    expect(mocks.list).toHaveBeenCalledTimes(2);

    // Nothing further until the server's own hint comes due.
    await vi.advanceTimersByTimeAsync(
      MIN_CHECK_INTERVAL_MS - MIN_FETCH_INTERVAL_MS - 1_000,
    );
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('many declined refreshes collapse into ONE deferred request, not a queue', async () => {
    // What keeps the deferral from weakening the rate limit it defers to.
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(200);

    for (let i = 0; i < 30; i += 1) void refreshNotifications();
    await vi.advanceTimersByTimeAsync(MIN_FETCH_INTERVAL_MS * 2);

    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('opening and closing the bell 50 times is still bounded by the floor', async () => {
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(200);

    for (let i = 0; i < 50; i += 1) {
      void refreshNotifications();
      await vi.advanceTimersByTimeAsync(100);
    }

    // 50 openings over ~5 seconds: the subscribe fetch, plus at most one per floor
    // window — the deferral collapses the rest rather than queueing them.
    expect(mocks.list.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('going hidden does not fetch', async () => {
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(MIN_FETCH_INTERVAL_MS + 100);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(200);

    expect(mocks.list).toHaveBeenCalledTimes(1);
  });
});

describe('notificationsPoller — storms the production audit asked about', () => {
  it('repeated offline/online transitions cannot storm', async () => {
    // A flapping wifi adapter at the counter fires `online` as fast as the OS notices.
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(200);

    for (let i = 0; i < 200; i += 1) {
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(300); // 60 simulated seconds of flapping
    }

    const total = mocks.list.mock.calls.length;
    const ceiling = 60_000 / MIN_FETCH_INTERVAL_MS + 2; // + subscribe fetch + one deferral
    console.log(`[storm] 200 offline/online cycles over 60s -> ${total} requests`);
    expect(total).toBeLessThanOrEqual(ceiling);
  });

  it('rapid tab switching cannot storm', async () => {
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(200);

    for (let i = 0; i < 200; i += 1) {
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(300);
    }

    const total = mocks.list.mock.calls.length;
    const ceiling = 60_000 / MIN_FETCH_INTERVAL_MS + 2;
    console.log(`[storm] 200 hide/show cycles over 60s -> ${total} requests`);
    expect(total).toBeLessThanOrEqual(ceiling);
  });

  it('a long-running session spends a bounded number of requests per hour', async () => {
    // Eight hours of an idle, visible, signed-in tab — the counter PC's normal day.
    respondAfter(10, 'n-1', MAX_CHECK_INTERVAL_MS / 1000);
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);

    const total = mocks.list.mock.calls.length;
    const ceiling = 1 + (8 * 3_600_000) / MAX_CHECK_INTERVAL_MS;
    console.log(`[session] 8 idle hours -> ${total} requests (ceiling ${ceiling})`);
    expect(total).toBeLessThanOrEqual(ceiling);
    // The old 30-second poll would have spent 960.
    expect(total).toBeLessThan(40);
  });
});

describe('notificationsPoller — the three mechanisms that reproduced the incident', () => {
  it('2+3. a visibilitychange storm at 7/s for 60s cannot exceed the floor', async () => {
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(200);
    const afterSubscribe = mocks.list.mock.calls.length;
    expect(afterSubscribe).toBe(1);

    // 420 events over 60 simulated seconds — the measured production cadence.
    for (let i = 0; i < 420; i += 1) {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(143);
    }

    const total = mocks.list.mock.calls.length;
    const perSecond = total / 60;
    // Ceiling: 60s / 5s floor = 12 possible starts, plus the subscribe fetch.
    const ceiling = 60_000 / MIN_FETCH_INTERVAL_MS + 1;
    console.log(
      `[storm] 420 visibilitychange events over 60s -> ${total} requests ` +
        `(${perSecond.toFixed(2)} req/s), ceiling ${ceiling}`,
    );
    expect(total).toBeLessThanOrEqual(ceiling);
    expect(perSecond).toBeLessThan(0.25); // vs. the 7.05 req/s this used to produce
  });

  it('5. a remount storm at 7/s for 60s cannot exceed the floor', async () => {
    // Each iteration is a full unsubscribe/subscribe cycle — what an unmount and
    // immediate remount does. The floor lives at module scope precisely so this cannot
    // reset it.
    for (let i = 0; i < 420; i += 1) {
      const unsubscribe = subscribeToNotifications(() => {});
      await vi.advanceTimersByTimeAsync(143);
      unsubscribe();
    }

    const total = mocks.list.mock.calls.length;
    const ceiling = 60_000 / MIN_FETCH_INTERVAL_MS + 1;
    console.log(
      `[storm] 420 remounts over 60s -> ${total} requests ` +
        `(${(total / 60).toFixed(2)} req/s), ceiling ${ceiling}`,
    );
    expect(total).toBeLessThanOrEqual(ceiling);
    expect(total / 60).toBeLessThan(0.25);
  });

  it('6. overlapping slow requests: only one is ever in flight', async () => {
    respondAfter(10_000); // a very slow round trip
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(10);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    // Ask repeatedly while the first is still outstanding, including via the storm path.
    for (let i = 0; i < 50; i += 1) {
      void refreshNotifications();
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('online'));
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.list).toHaveBeenCalledTimes(1); // still exactly one

    // Once it resolves, a later refresh is allowed again (floor permitting).
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(MIN_FETCH_INTERVAL_MS);
    void refreshNotifications();
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('4. many subscribers in one document share a single feed, not one each', async () => {
    const unsubscribers = Array.from({ length: 20 }, () =>
      subscribeToNotifications(() => {}),
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MAX_CHECK_INTERVAL_MS + 200);
    expect(mocks.list).toHaveBeenCalledTimes(2); // not 40

    for (const unsubscribe of unsubscribers) unsubscribe();
  });
});

describe('notificationsPoller — hidden tabs, failures and cleanup', () => {
  it('9. a hidden tab never fetches, however long it sits there', async () => {
    setVisibility('hidden');
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(MAX_CHECK_INTERVAL_MS * 3);
    expect(mocks.list).not.toHaveBeenCalled();

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('a hidden tab does not even consume the floor, so becoming visible is immediate', async () => {
    setVisibility('hidden');
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('7. a failed request does not retry early, and keeps the last payload', async () => {
    const seen: Notification[][] = [];
    mocks.list.mockRejectedValue(new Error('network down'));
    subscribeToNotifications((items) => seen.push(items));
    await vi.advanceTimersByTimeAsync(200);

    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(0); // nothing published, nothing cleared

    // No early retry: still one call well before the fallback interval elapses.
    await vi.advanceTimersByTimeAsync(MAX_CHECK_INTERVAL_MS - 1_000);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('8. recovery: the check after a failure succeeds and publishes', async () => {
    const seen: Notification[][] = [];
    mocks.list.mockRejectedValueOnce(new Error('network down'));
    subscribeToNotifications((items) => seen.push(items));
    await vi.advanceTimersByTimeAsync(200);
    expect(seen).toHaveLength(0);

    respondAfter(140, 'n-2');
    await vi.advanceTimersByTimeAsync(MAX_CHECK_INTERVAL_MS + 200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]?.id).toBe('n-2');
  });

  it('a failure still arms the next check, so the feed cannot die silently', async () => {
    mocks.list.mockRejectedValue(new Error('network down'));
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MAX_CHECK_INTERVAL_MS + 200);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('a storm of failing requests is still bounded by the floor (no retry loop)', async () => {
    mocks.list.mockRejectedValue(new Error('network down'));
    subscribeToNotifications(() => {});
    for (let i = 0; i < 420; i += 1) {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(143);
    }
    const ceiling = 60_000 / MIN_FETCH_INTERVAL_MS + 1;
    expect(mocks.list.mock.calls.length).toBeLessThanOrEqual(ceiling);
  });

  it('unsubscribing stops the timer: no orphaned check fires afterwards', async () => {
    const unsubscribe = subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(MAX_CHECK_INTERVAL_MS * 3);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing removes the visibility and online listeners too', async () => {
    const unsubscribe = subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(200);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(MIN_FETCH_INTERVAL_MS * 2);

    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.list).toHaveBeenCalledTimes(1); // the subscribe-time fetch only
  });

  it('a response arriving after the last subscriber left is dropped, not published', async () => {
    respondAfter(10_000);
    const seen: Notification[][] = [];
    const unsubscribe = subscribeToNotifications((items) => seen.push(items));
    await vi.advanceTimersByTimeAsync(10);
    unsubscribe();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen).toHaveLength(0);
  });
});

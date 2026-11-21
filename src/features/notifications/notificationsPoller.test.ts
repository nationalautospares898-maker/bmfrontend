/**
 * The notification poller's two hard guarantees, measured rather than asserted by
 * inspection: **single-flight**, and **a floor between request starts**.
 *
 * ## Why these numbers matter
 *
 * A render-triggered loop in this feature consumed a 1,000,000-request monthly CDN
 * budget for a two-person shop. Three distinct mechanisms were each measured driving the
 * pre-poller component at **~7 requests/second** — a visibility storm, a remount storm,
 * and overlapping slow requests. The scheduled 30-second cadence was never the problem;
 * the absence of any limit that outlived a component instance was. So the tests below do
 * not check "is there a throttle" — they drive each of those three mechanisms at the rate
 * that reproduced the incident and assert the resulting request count stays bounded.
 *
 * Numbers to compare against, from the measured three-way comparison recorded in
 * `bmbackend/docs/`:
 *
 * | implementation | visibility storm | remount storm | overlapping |
 * |---|---|---|---|
 * | original (pre-`45570db`) | ~7.0 req/s | ~7.0 req/s | unbounded |
 * | previous (`45570db`, no floor) | ~7.05 req/s | ~7.02 req/s | unbounded |
 * | this poller | bounded by the floor | bounded by the floor | one at a time |
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Notification } from '@/api/types';
import {
  MIN_FETCH_INTERVAL_MS,
  POLL_INTERVAL_MS,
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

/** Resolves after `latencyMs`, the way a real round trip does. */
function respondAfter(latencyMs: number, id = 'n-1'): void {
  mocks.list.mockImplementation(
    () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ notifications: [notification(id)] }), latencyMs),
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
  it('1. one active tab: fetches once on subscribe, then once per 30 seconds', async () => {
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(mocks.list).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(mocks.list).toHaveBeenCalledTimes(3);
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

  it('12. the scheduled cadence is unaffected by the floor (30s is far above it)', () => {
    expect(POLL_INTERVAL_MS).toBeGreaterThan(MIN_FETCH_INTERVAL_MS * 2);
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

  it('4. many subscribers in one document share a single poller, not one each', async () => {
    const unsubscribers = Array.from({ length: 20 }, () =>
      subscribeToNotifications(() => {}),
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(mocks.list).toHaveBeenCalledTimes(2); // not 40

    for (const unsubscribe of unsubscribers) unsubscribe();
  });
});

describe('notificationsPoller — hidden tabs, failures and cleanup', () => {
  it('9. a hidden tab never polls, and resumes on becoming visible', async () => {
    setVisibility('hidden');
    subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
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

    // No early retry: still one call well before the next scheduled tick.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1_000);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('8. recovery: the next scheduled tick after a failure succeeds and publishes', async () => {
    const seen: Notification[][] = [];
    mocks.list.mockRejectedValueOnce(new Error('network down'));
    subscribeToNotifications((items) => seen.push(items));
    await vi.advanceTimersByTimeAsync(200);
    expect(seen).toHaveLength(0);

    respondAfter(140, 'n-2');
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]?.id).toBe('n-2');
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

  it('unsubscribing stops the timer: no orphaned poll fires afterwards', async () => {
    const unsubscribe = subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing removes the visibility listener too', async () => {
    const unsubscribe = subscribeToNotifications(() => {});
    await vi.advanceTimersByTimeAsync(200);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(MIN_FETCH_INTERVAL_MS * 2);

    document.dispatchEvent(new Event('visibilitychange'));
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

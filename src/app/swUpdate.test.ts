/**
 * `registerType: 'prompt'` (`vite.config.ts`) was declared but nothing ever called the
 * hook that makes it mean anything — `injectRegister: 'auto'`'s generated script
 * registers the worker with no `onNeedRefresh` handler, so a new build would sit in
 * Workbox's `waiting` phase forever on a counter PC that is never closed. This module
 * is what actually wires the callback through to something the UI can subscribe to,
 * and `applyUpdate()` is the only path that may ever call the registration's reload
 * function — never automatically, which is the property under test here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyUpdate,
  getNeedsRefresh,
  initUpdatePrompt,
  resetUpdateState,
  subscribeToUpdate,
} from './swUpdate';

afterEach(() => {
  resetUpdateState();
});

describe('swUpdate', () => {
  it('starts with no update pending', () => {
    expect(getNeedsRefresh()).toBe(false);
  });

  it('notifies subscribers only once the worker reports onNeedRefresh', () => {
    let onNeedRefresh: (() => void) | undefined;
    initUpdatePrompt((options) => {
      onNeedRefresh = options?.onNeedRefresh;
      return vi.fn();
    });

    const seen: boolean[] = [];
    subscribeToUpdate((value) => seen.push(value));
    expect(getNeedsRefresh()).toBe(false);
    expect(seen).toEqual([]);

    onNeedRefresh?.();

    expect(getNeedsRefresh()).toBe(true);
    expect(seen).toEqual([true]);
  });

  it('applyUpdate calls the registration function with reload=true, and never on its own', async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    initUpdatePrompt(() => reload);

    expect(reload).not.toHaveBeenCalled();

    await applyUpdate();

    expect(reload).toHaveBeenCalledWith(true);
  });

  it('periodically asks the browser to re-check for a new build, every 30 minutes', () => {
    vi.useFakeTimers();
    const update = vi.fn().mockResolvedValue(undefined);
    const registration = { update } as unknown as ServiceWorkerRegistration;
    let onRegistered: ((registration: ServiceWorkerRegistration | undefined) => void) | undefined;
    initUpdatePrompt((options) => {
      onRegistered = options?.onRegistered;
      return vi.fn();
    });
    onRegistered?.(registration);

    expect(update).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(update).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(update).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('does not schedule a check, and does not throw, when no registration is available', () => {
    vi.useFakeTimers();
    let onRegistered: ((registration: ServiceWorkerRegistration | undefined) => void) | undefined;
    initUpdatePrompt((options) => {
      onRegistered = options?.onRegistered;
      return vi.fn();
    });

    expect(() => onRegistered?.(undefined)).not.toThrow();
    // No way to observe "nothing scheduled" directly without a registration's `update`
    // mock, but advancing time must not throw if a timer was mistakenly set on `undefined`.
    expect(() => vi.advanceTimersByTime(60 * 60 * 1000)).not.toThrow();

    vi.useRealTimers();
  });

  it('never calls the registration update on a schedule shorter than 30 minutes', () => {
    vi.useFakeTimers();
    const update = vi.fn().mockResolvedValue(undefined);
    const registration = { update } as unknown as ServiceWorkerRegistration;
    let onRegistered: ((registration: ServiceWorkerRegistration | undefined) => void) | undefined;
    initUpdatePrompt((options) => {
      onRegistered = options?.onRegistered;
      return vi.fn();
    });
    onRegistered?.(registration);

    vi.advanceTimersByTime(30 * 60 * 1000 - 1);
    expect(update).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('resetUpdateState stops a pending periodic check from firing later', () => {
    vi.useFakeTimers();
    const update = vi.fn().mockResolvedValue(undefined);
    const registration = { update } as unknown as ServiceWorkerRegistration;
    let onRegistered: ((registration: ServiceWorkerRegistration | undefined) => void) | undefined;
    initUpdatePrompt((options) => {
      onRegistered = options?.onRegistered;
      return vi.fn();
    });
    onRegistered?.(registration);

    resetUpdateState();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(update).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

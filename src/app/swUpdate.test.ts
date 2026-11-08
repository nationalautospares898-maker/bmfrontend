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
});

import { describe, expect, it } from 'vitest';

import { relativeTime } from './notificationTime';

const NOW = Date.parse('2026-11-22T12:00:00Z');

function at(iso: string): string | null {
  return relativeTime(iso, NOW);
}

describe('relativeTime', () => {
  it('calls anything under a minute "Just now"', () => {
    expect(at('2026-11-22T11:59:30Z')).toBe('Just now');
    expect(at('2026-11-22T12:00:00Z')).toBe('Just now');
  });

  it('counts minutes, then hours, then days', () => {
    expect(at('2026-11-22T11:58:00Z')).toBe('2 minutes ago');
    expect(at('2026-11-22T09:00:00Z')).toBe('3 hours ago');
    expect(at('2026-11-19T12:00:00Z')).toBe('3 days ago');
  });

  it('uses the singular where it reads better', () => {
    expect(at('2026-11-22T11:59:00Z')).toBe('1 minute ago');
    expect(at('2026-11-22T11:00:00Z')).toBe('1 hour ago');
    expect(at('2026-11-21T12:00:00Z')).toBe('Yesterday');
  });

  it('treats a slightly future timestamp as "Just now" rather than a negative figure', () => {
    // A few seconds of clock skew between the shop's PC and the server is normal.
    expect(at('2026-11-22T12:00:20Z')).toBe('Just now');
  });

  it('returns null for an unparseable timestamp instead of guessing', () => {
    // A card with no time is better than a card with a wrong one.
    expect(at('not a date')).toBeNull();
  });
});

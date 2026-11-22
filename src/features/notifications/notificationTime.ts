/**
 * Relative timestamps for notification cards.
 *
 * A notification without a time reads as timeless, and "is this the low-stock alert from
 * this morning or the one from last week" is exactly the question the owner has when two
 * similar cards sit next to each other. The redesigned panel shows one per card.
 *
 * Deliberately **not** `Intl.RelativeTimeFormat`, and deliberately not a date library:
 * `bmfrontend/CLAUDE.md §3` forbids adding a date library without an ADR, and every
 * string a counter user reads has to live in `lib/strings.ts` where the owner can review
 * it — which a browser-generated locale string would bypass. Four buckets is all this
 * needs; past a few days the exact figure stops mattering and the card is stale anyway.
 */

import { NOTIFICATIONS } from '@/lib/strings';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * `created_at` → something like "12 minutes ago".
 *
 * An unparseable or future timestamp returns `null` rather than a guess: a card with no
 * time is better than a card claiming "in -3 minutes", and clock skew between the shop's
 * PC and the server is real (a few seconds of it is normal, which is why anything under
 * a minute is "Just now" rather than a negative figure).
 */
export function relativeTime(iso: string, now: number = Date.now()): string | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;

  const elapsed = now - then;
  if (elapsed < MINUTE) return NOTIFICATIONS.justNow;
  if (elapsed < HOUR) return NOTIFICATIONS.minutesAgo(Math.floor(elapsed / MINUTE));
  if (elapsed < DAY) return NOTIFICATIONS.hoursAgo(Math.floor(elapsed / HOUR));
  return NOTIFICATIONS.daysAgo(Math.floor(elapsed / DAY));
}

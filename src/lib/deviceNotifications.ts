/**
 * A thin, defensive wrapper around the Web Notifications API (owner request,
 * 2026-11-11): real OS/browser-level alerts, on top of — never instead of — the
 * in-app bell (`NotificationBell.tsx`), which stays the fallback for a denied or
 * unsupported browser.
 *
 * ## The honest limit of what this gives
 *
 * This only ever runs from script already executing in the browser — a poll tick
 * while the tab (or an installed PWA window) is open. It cannot wake a closed
 * browser. That needs Web Push: a service-worker `push` event handler, a per-device
 * subscription stored server-side, and a backend that sends an encrypted push message
 * to the browser's own push service — none of which exists in this codebase yet, and
 * none of which this module fakes. See `MASTER-IMPLEMENTATION-REPORT.md` for exactly
 * what that would take.
 */

export type DevicePermission = 'default' | 'granted' | 'denied' | 'unsupported';

/** `typeof Notification === 'undefined'` in a browser that never implemented it
 *  (some in-app webviews, older mobile browsers) — checked once, not assumed. */
export function isSupported(): boolean {
  // `typeof window.Notification === 'function'`, not `'Notification' in window`: the
  // `in` operator is true for a key that exists but holds `undefined` (observed when
  // stubbing "no Notification API" in tests, and plausible wherever a platform strips
  // the constructor but leaves the property declared), which would otherwise pass
  // this check and crash the next read of `.permission`.
  return typeof window !== 'undefined' && typeof window.Notification === 'function';
}

export function currentPermission(): DevicePermission {
  if (!isSupported()) return 'unsupported';
  return Notification.permission;
}

/**
 * Ask the browser for permission. Callers must only do this from a genuine user
 * gesture (a click on "Enable") — browsers increasingly refuse or auto-deny a request
 * made any other way, and the owner was explicit that this must never be asked
 * automatically or repeatedly.
 */
export async function requestPermission(): Promise<DevicePermission> {
  if (!isSupported()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    // Older Safari's callback-style API throws if awaited as a promise on some
    // versions; a failed request is the same as "still default" to this caller.
    return Notification.permission;
  }
}

/**
 * Show one device notification. Silently does nothing rather than throwing when
 * unsupported or not granted — callers are expected to have already checked
 * `currentPermission()`, but a second, defensive check here means a stray call can
 * never crash the poll loop that drives the in-app bell.
 *
 * `tag` is always the notification's own id, so the OS collapses a duplicate `show()`
 * for the same alert into the one it already has rather than stacking two.
 */
export function show(
  tag: string,
  title: string,
  options: { body?: string | undefined; onClick?: (() => void) | undefined } = {},
): void {
  if (currentPermission() !== 'granted') return;
  try {
    const n = new Notification(
      title,
      options.body !== undefined ? { body: options.body, tag } : { tag },
    );
    if (options.onClick) {
      n.onclick = () => {
        // Best-effort: some platforms refuse an unsolicited `focus()` outright, and
        // the test environment does not implement it at all. Either way, navigating
        // via `onClick` below is the part that actually matters.
        try {
          window.focus();
        } catch {
          // Ignored — see above.
        }
        n.close();
        options.onClick?.();
      };
    }
  } catch {
    // A platform that reports `granted` but still refuses to construct one (observed
    // on some locked-down enterprise/mobile builds) must not take the poll loop down
    // with it — the in-app bell already shows the same thing either way.
  }
}

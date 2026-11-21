/**
 * Surfaces the service-worker update lifecycle, mirroring `api/session.ts`'s own
 * subscribable-module pattern.
 *
 * `vite.config.ts` declares `registerType: 'prompt'` specifically because a forced
 * reload mid-sale would be worse than running one version behind for a few minutes
 * (ADR-031) — but nothing in the application ever called the hook that makes "prompt"
 * mean anything. Without it, a new build installs and sits in Workbox's `waiting` phase
 * indefinitely on a counter PC that is never closed, and the only way to receive any
 * future update — this one included — was to notice and hard-refresh by hand.
 *
 * `applyUpdate()` is the explicit, user-initiated action this screen exists for. It is
 * never called automatically: that would be exactly the forced-reload-mid-sale outcome
 * `skipWaiting: false` and `clientsClaim: false` were set to prevent.
 *
 * ## Why this also periodically calls `registration.update()`
 *
 * A browser's own default re-check for a new service-worker script happens on
 * navigation — which a single-page app, on a counter PC that is "never closed"
 * (`worker.py`'s own phrase for this shop's usage pattern), essentially never does after
 * the first load. Without an explicit nudge, a tab could sit far behind the deployed
 * version indefinitely, not because `skipWaiting`/`clientsClaim` are correctly holding
 * an update back (they are, by design), but because nothing ever asked the browser to
 * *notice* the update exists in the first place — `onNeedRefresh` never firing is a
 * different failure from the update banner being ignored once shown. This periodic
 * check only ever *detects* a new build sooner; applying it remains exactly as
 * user-gated as before (`applyUpdate()`, unchanged).
 *
 * `registerSW` is *passed in* rather than imported here with `virtual:pwa-register`
 * deliberately: that specifier only resolves through the VitePWA plugin's own Vite
 * instance, which `vitest.config.ts` does not register — a direct import made this
 * module untestable rather than merely untested. `main.tsx` (excluded from coverage,
 * where the real import belongs) is the only place that needs the virtual module at
 * all.
 */

type RegisterSW = (options?: {
  onNeedRefresh?: () => void;
  onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void;
}) => (reload?: boolean) => Promise<void>;

type Listener = (needsRefresh: boolean) => void;

/** How often a long-lived tab asks the browser to re-check for a new build. Minutes, not
 * seconds — this is a courtesy nudge, not a poll the owner's CDN budget needs to absorb;
 * `registration.update()` is a conditional request against the SW script's own URL. */
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

const listeners = new Set<Listener>();
let needsRefresh = false;
let apply: ((reload?: boolean) => Promise<void>) | null = null;
let updateCheckTimer: ReturnType<typeof setInterval> | null = null;

function publish(): void {
  for (const listener of listeners) listener(needsRefresh);
}

export function initUpdatePrompt(registerSW: RegisterSW): void {
  apply = registerSW({
    onNeedRefresh() {
      needsRefresh = true;
      publish();
    },
    onRegistered(registration) {
      if (!registration) return;
      updateCheckTimer = setInterval(() => {
        void registration.update();
      }, UPDATE_CHECK_INTERVAL_MS);
    },
  });
}

export function subscribeToUpdate(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNeedsRefresh(): boolean {
  return needsRefresh;
}

/** Activates the waiting service worker and reloads. The one moment this is safe to
 * call is when the user has explicitly asked for it. */
export async function applyUpdate(): Promise<void> {
  await apply?.(true);
}

/** Exposed for tests only, so one test's registration does not leak into the next. */
export function resetUpdateState(): void {
  needsRefresh = false;
  apply = null;
  listeners.clear();
  if (updateCheckTimer !== null) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }
}

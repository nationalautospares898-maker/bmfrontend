/**
 * The explicit "prompt" half of `registerType: 'prompt'`.
 *
 * Mounted independently wherever it's needed — the login screen, the forced
 * password-change screen, the normal shell — because it subscribes to the same
 * module-level store (`swUpdate.ts`) regardless of where it lives, the same way
 * `AppShell` already subscribes to `api/session.ts` without any prop drilling.
 *
 * Never reloads on its own. `skipWaiting: false` and `clientsClaim: false`
 * (`vite.config.ts`, ADR-031) exist so a build update cannot land mid-sale; the one
 * thing this component adds is a way for a human to say "now is fine" instead of the
 * update sitting in Workbox's `waiting` phase until the tab happens to close.
 */

import { useEffect, useState } from 'react';

import { Button, Panel } from '@/components/primitives';
import { applyUpdate, getNeedsRefresh, subscribeToUpdate } from './swUpdate';

export function UpdateBanner() {
  const [needsRefresh, setNeedsRefresh] = useState(getNeedsRefresh);
  const [applying, setApplying] = useState(false);

  useEffect(() => subscribeToUpdate(setNeedsRefresh), []);

  if (!needsRefresh) return null;

  return (
    <Panel tone="info" title="An update is available">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>Nothing is lost — any open bill is saved on this computer either way.</span>
        <Button
          variant="primary"
          busy={applying}
          onClick={() => {
            setApplying(true);
            void applyUpdate();
          }}
        >
          Reload to update
        </Button>
      </div>
    </Panel>
  );
}

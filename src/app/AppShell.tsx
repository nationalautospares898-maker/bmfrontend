/**
 * The application shell: startup, login, navigation, and the permission-aware layout.
 *
 * Routing is **lazy beyond billing** (NFR-FE-PERF-005). The billing screen, the API
 * client and the draft layer are in the initial bundle because a cold start at the
 * counter should load the one screen that matters; everything else arrives when asked
 * for.
 *
 * Navigation is **words, never icons alone** (NFR-FE-UX-007), and a screen the user has
 * no permission for is not rendered as a disabled mystery — it is simply absent, with
 * the reason available if they ask.
 */

import { lazy, Suspense, useCallback, useEffect, useState } from 'react';

import { ApiError, describeError } from '@/api/errors';
import { getDeviceId, subscribeToSession, type SessionState } from '@/api/session';
import { useBillingStore } from '@/features/billing/draftStore';
import { BillingCounter } from '@/features/billing/BillingCounter';
import { scheduler } from '@/features/sync/scheduler';
import * as catalogCache from '@/db/catalogCache';
import { ensureDeviceId } from '@/db/meta';
import type { Bootstrap } from '@/api/types';
import type { MoneyPolicy } from '@/lib/money';
import { Busy, Button, Field, Panel, StatusDot } from '@/components/primitives';
import { COMMON, ERRORS, OFFLINE } from '@/lib/strings';
import { signIn, signOut, startApplication } from './bootstrap';

const DailyBills = lazy(() =>
  import('@/features/reports/DailyBills').then((module) => ({
    default: module.DailyBills,
  })),
);
const CreditBills = lazy(() =>
  import('@/features/reports/DailyBills').then((module) => ({
    default: module.CreditBills,
  })),
);
const SyncPanel = lazy(() =>
  import('@/features/sync/SyncPanel').then((module) => ({ default: module.SyncPanel })),
);

type Screen = 'billing' | 'daily-bills' | 'credit-bills' | 'sync';

/** `navigator.onLine` is a hint, not a guarantee — the client still handles failures. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);
  return online;
}

export function AppShell() {
  const [starting, setStarting] = useState(true);
  const [storageUsable, setStorageUsable] = useState(true);
  const [session, setSession] = useState<SessionState | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [policy, setPolicy] = useState<MoneyPolicy | null>(null);
  const [screen, setScreen] = useState<Screen>('billing');
  const [sessionLost, setSessionLost] = useState(false);
  const online = useOnline();
  const billing = useBillingStore();

  const onSessionLost = useCallback(() => {
    // Drafts are deliberately left alone. The prompt says so, because a cashier who
    // thinks a re-login costs them their typing will avoid logging in.
    setSessionLost(true);
    setSession(null);
  }, []);

  useEffect(() => subscribeToSession(setSession), []);

  useEffect(() => {
    void (async () => {
      const result = await startApplication({ onSessionLost });
      setStorageUsable(result.storageUsable);
      setSession(result.session);
      setBootstrap(result.bootstrap);
      setPolicy(result.policy);
      setStarting(false);
    })();
  }, [onSessionLost]);

  // Once signed in: open the drafts for this counter, start the scheduler, warm the
  // offline catalog. In that order — drafts first, always.
  useEffect(() => {
    if (!session || !bootstrap?.counter) return;
    void billing.initialise(bootstrap.counter.id, bootstrap.counter.max_open_drafts);
    scheduler.start();
    void catalogCache.refreshFully().catch(() => {
      // A cold cache degrades offline search only; it never blocks billing.
    });
    return () => scheduler.stop();
    // `billing` is a store handle and stable; depending on it would restart the
    // scheduler on every draft change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, bootstrap]);

  if (starting) return <Busy label="Starting" />;

  if (!session) {
    return (
      <LoginScreen
        sessionLost={sessionLost}
        storageUsable={storageUsable}
        onSignedIn={(result) => {
          setSession(result.session);
          setBootstrap(result.bootstrap);
          setPolicy(result.policy);
          setSessionLost(false);
        }}
      />
    );
  }

  const canBill = session.permissions.has('billing.sale.finalize');
  const canReadSales = session.permissions.has('reports.sales.read');
  const canReadCredit = session.permissions.has('credit.read');

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-300 pb-3">
        <div>
          <h1 className="text-lg font-semibold text-[#232852]">National Auto Spares</h1>
          <p className="text-xs text-slate-500">
            {session.fullName} · {session.role}
            {bootstrap?.counter ? ` · ${bootstrap.counter.name}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <StatusDot state={online ? 'online' : 'offline'} />
          <Button
            variant="quiet"
            onClick={() => {
              void signOut().then(() => setSession(null));
            }}
          >
            Sign out
          </Button>
        </div>
      </header>

      {!storageUsable ? (
        // Blocking, and worded so nobody mistakes it for a minor warning (FE-E-1).
        <Panel tone="danger" title="Bills cannot be saved on this computer">
          {OFFLINE.storageUnavailable}
        </Panel>
      ) : null}

      {session.mustChangePassword ? (
        <Panel tone="warning" title="Your password needs changing">
          Ask the owner to help you set a new one before the end of the day.
        </Panel>
      ) : null}

      <nav aria-label="Screens" className="flex flex-wrap gap-2">
        <Button
          variant={screen === 'billing' ? 'primary' : 'secondary'}
          onClick={() => setScreen('billing')}
          aria-current={screen === 'billing' ? 'page' : undefined}
        >
          Billing
        </Button>
        {canReadSales ? (
          <Button
            variant={screen === 'daily-bills' ? 'primary' : 'secondary'}
            onClick={() => setScreen('daily-bills')}
            aria-current={screen === 'daily-bills' ? 'page' : undefined}
          >
            Daily Bills
          </Button>
        ) : null}
        {canReadCredit ? (
          <Button
            variant={screen === 'credit-bills' ? 'primary' : 'secondary'}
            onClick={() => setScreen('credit-bills')}
            aria-current={screen === 'credit-bills' ? 'page' : undefined}
          >
            Credit Bills
          </Button>
        ) : null}
        <Button
          variant={screen === 'sync' ? 'primary' : 'secondary'}
          onClick={() => setScreen('sync')}
          aria-current={screen === 'sync' ? 'page' : undefined}
        >
          Saving and syncing
        </Button>
      </nav>

      <main>
        {policy === null ? (
          <Panel tone="danger" title="Settings could not be loaded">
            {/* Without the money policy the client would have to invent one, and a
                client that invents a rounding rule eventually disagrees with the
                invoice it is previewing (rule 15). Billing is refused instead. */}
            Billing is unavailable until the server's settings load. Tell the owner.
          </Panel>
        ) : (
          <Suspense fallback={<Busy label={COMMON.loading} />}>
            {screen === 'billing' ? (
              <BillingCounter
                policy={policy}
                online={online}
                canBill={canBill}
                onSynced={() => scheduler.notifyMutation()}
              />
            ) : null}
            {screen === 'daily-bills' && canReadSales ? (
              <DailyBills policy={policy} />
            ) : null}
            {screen === 'credit-bills' && canReadCredit ? <CreditBills /> : null}
            {screen === 'sync' ? <SyncPanel online={online} /> : null}
          </Suspense>
        )}
      </main>
    </div>
  );
}

// --- login --------------------------------------------------------------------

function LoginScreen({
  sessionLost,
  storageUsable,
  onSignedIn,
}: {
  sessionLost: boolean;
  storageUsable: boolean;
  onSignedIn: (result: Awaited<ReturnType<typeof signIn>>) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const deviceId = getDeviceId() ?? (await ensureDeviceId());
      onSignedIn(await signIn(username, password, deviceId));
    } catch (caught) {
      // The message comes from the registry code, never from the server's text, and
      // never mentions a status code (§10).
      setError(
        caught instanceof ApiError
          ? describeError(caught.code).message
          : ERRORS.unexpected,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold text-[#232852]">National Auto Spares</h1>

      {sessionLost ? (
        // The reassurance is the point: drafts are safe and nothing was lost.
        <Panel tone="warning">{ERRORS.signInAgain}</Panel>
      ) : null}
      {!storageUsable ? <Panel tone="danger">{OFFLINE.storageUnavailable}</Panel> : null}

      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
        <Field
          label="Username"
          value={username}
          autoComplete="username"
          autoFocus
          onChange={(event) => setUsername(event.target.value)}
        />
        <Field
          label="Password"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(event) => setPassword(event.target.value)}
          {...(error ? { error } : {})}
        />
        <Button
          type="submit"
          variant="primary"
          busy={busy}
          disabled={!username || !password}
        >
          Sign in
        </Button>
      </form>

      <p className="text-xs text-slate-500">
        {/* Stated here because a cashier who believes a sign-in costs them their
            typing will keep working on an expired session instead. */}
        Any bills saved on this computer are kept, whether you are signed in or not.
      </p>
    </div>
  );
}

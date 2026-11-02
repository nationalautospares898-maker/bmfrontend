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
 *
 * ## The navigation the owner asked for after the first demo
 *
 * Six sections, vertical, down the **right**: Billing · Daily Bills · Credit Bills ·
 * Stock · Customers · Saving and syncing.
 *
 * `FR-NAV-002` specified a **left** sidebar of seven items including Purchases. The
 * owner has replaced that; `docs/UI-UX-SPECIFICATION.md §3a` records the reversal with
 * its date. (The as-built nav was neither — a horizontal wrap of nine buttons — so this
 * is the first time the shell has matched any recorded design.)
 *
 * ## Imports, Counters and Purchases are withdrawn, not deleted
 *
 * The owner wants a straightforward single-computer shop application, so these three are
 * gone from the navigation. Nothing behind them was removed: the screens, their
 * components, every endpoint, every migration, the purchase and import history and all
 * the permissions are untouched, and the backend still receives stock through
 * `PurchaseService` exactly as before.
 *
 * Two deliberate consequences:
 *
 * * **Receiving stock has a new everyday path.** `Stock → Add Items` is the owner's own
 *   four-column sheet and is now how goods arriving at the shop get recorded. The
 *   supplier-document workflow (enter a bill, then `Receive into stock`) remains in the
 *   code for a shop that later wants it.
 * * **Counters is gone outright, because setting one up is no longer a thing anyone
 *   does.** An earlier cut kept the screen on a conditional, since billing is refused
 *   without a counter and hiding the only cure would strand a freshly installed machine.
 *   The server now closes that gap properly: a device binds itself to the shop's counter
 *   on first sign-in (`AuthService._ensure_billing_counter`), so there is no state left
 *   for the screen to rescue. Withdrawing a control is only safe once the condition it
 *   existed for cannot arise — that fix came first, and this followed it.
 *
 * ## Scrolling
 *
 * `<main>` is the one scrolling region, and **billing is the only screen that does not
 * scroll**: it is a fixed spreadsheet workspace that fits the viewport. Every other screen
 * is a list that can outgrow the window — stock, customers, credit folders — so it must
 * scroll, and applying the billing rule to all of them is what clipped their lower halves
 * on a desktop with no scrollbar to recover with.
 *
 * The overflow therefore follows **the screen and the available height**, not the width
 * breakpoint alone. Billing only stops scrolling while the window is at least 600px tall;
 * shorter than that and its own completion buttons would be below an unscrollable fold,
 * which the browser acceptance run demonstrated by being unable to click `Clear Draft` at
 * 1366x420.
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';

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
import { navigateWithArrows } from '@/lib/keyboard';
import { COMMON, ERRORS, NAV, OFFLINE } from '@/lib/strings';
import { startSessionRenewal, stopSessionRenewal } from '@/api/renewal';
import type { RebuildLine } from '@/features/reports/AmendBill';
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
// The M25 screens. Lazy like every screen beyond billing (NFR-FE-PERF-005): a counter
// hand who only ever bills never downloads them.
const StockScreen = lazy(() =>
  import('@/features/stock/StockScreen').then((module) => ({
    default: module.StockScreen,
  })),
);
const CustomersScreen = lazy(() =>
  import('@/features/customers/CustomersScreen').then((module) => ({
    default: module.CustomersScreen,
  })),
);

/**
 * `purchases`, `imports` and `counters` are **absent from this union**, which is the
 * enforcement: `setScreen('counters')` no longer type-checks, so the sections cannot be
 * reached by a stale link, a forgotten handler or a later edit. `PurchasesScreen`,
 * `ImportsScreen` and `CountersScreen` remain in the repository with their tests, and
 * every endpoint behind them is live — these are withdrawn entry points, not deleted
 * capabilities. `GET`/`PUT /admin/counters` still work for an operator who needs them,
 * and the permission that guards them is unchanged.
 */
type Screen = 'billing' | 'daily-bills' | 'credit-bills' | 'stock' | 'customers' | 'sync';

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
  /** Bumped to re-run startup after a session loss; see `retriedAfterLoss`. */
  const [attempt, setAttempt] = useState(0);
  const online = useOnline();
  const billing = useBillingStore();

  /**
   * Start a replacement bill from the lines of a bill that was just cancelled.
   *
   * This is the second half of the only sanctioned amendment: a finalised invoice is
   * immutable (OD-10, FR-SALE-010), so correcting one means cancelling it and issuing a
   * new one. The new bill is an ordinary draft — nothing special, no link to the old
   * invoice — which is exactly right: two invoices exist afterwards, one cancelled and
   * one issued, and neither has been rewritten.
   *
   * The lines are carried over so the cashier re-keys nothing and can simply add the
   * item the customer asked for. Prices come from the original bill rather than the
   * catalogue, and are therefore marked `manual_override`: carrying a price forward is a
   * deliberate human decision, and the server audits it as one. Stock is left unknown
   * rather than guessed — the figures on the old bill are a snapshot from when it was
   * issued and saying "in stock: 4" from them would be inventing a fact.
   */
  const rebuildFromCancelled = useCallback(
    async (lines: RebuildLine[]) => {
      const draftId = await billing.newDraft();
      if (!draftId) return; // every tab is in use; the store says so on screen
      for (const line of lines) {
        await billing.addLine(draftId, {
          product_id: line.product_id,
          product_name: line.product_name,
          sku: line.sku,
          unit_code: line.unit_code,
          quantity: line.quantity,
          unit_price: line.unit_price,
          catalog_price_at_add: line.unit_price,
          price_source: 'manual_override',
          discount_percent: '0.000',
          known_stock: null,
          stock_as_of: null,
        });
      }
      setScreen('billing');
    },
    // `billing` is a stable store handle; depending on it would rebuild this callback
    // on every draft change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onSessionLost = useCallback(() => {
    // Drafts are deliberately left alone. The prompt says so, because a cashier who
    // thinks a re-login costs them their typing will avoid logging in.
    setSessionLost(true);
    setSession(null);
    // Ask startup to run again, once. On a server with unattended access it quietly
    // recovers; on one without, it fails the same way it does today and the sign-in form
    // renders — which is exactly what happens now.
    if (!retriedAfterLoss.current) {
      retriedAfterLoss.current = true;
      setAttempt((value) => value + 1);
    }
  }, []);

  useEffect(() => subscribeToSession(setSession), []);

  /**
   * One automatic retry per session loss.
   *
   * On a server that lets the shop in without a password, a session lost mid-shift
   * should not leave the till staring at a sign-in form it was never meant to see —
   * `startApplication` can simply get another one. A ref rather than state because it
   * must not cause a render, and it is reset once a session exists so the *next* loss
   * gets its own retry.
   *
   * Exactly one, so a server that refuses cannot be asked in a loop: the second failure
   * falls through to the sign-in form, which is the right answer when automatic entry is
   * not available.
   */
  const retriedAfterLoss = useRef(false);

  useEffect(() => {
    void (async () => {
      const result = await startApplication({ onSessionLost });
      setStorageUsable(result.storageUsable);
      setSession(result.session);
      setBootstrap(result.bootstrap);
      setPolicy(result.policy);
      setStarting(false);
      if (result.session) retriedAfterLoss.current = false;
    })();
  }, [onSessionLost, attempt]);

  // Once signed in: open the drafts for this counter, start the scheduler, warm the
  // offline catalog. In that order — drafts first, always.
  useEffect(() => {
    if (!session || !bootstrap?.counter) return;
    void billing.initialise(bootstrap.counter.id, bootstrap.counter.max_open_drafts);
    scheduler.start();
    // Renew the access token ahead of its 15-minute expiry, so the first action after a
    // quiet spell is not waiting on a token round trip — and so an expiry is not the
    // first thing a cashier learns about from a failed Print Bill.
    startSessionRenewal();
    void catalogCache.refreshFully().catch(() => {
      // A cold cache degrades offline search only; it never blocks billing.
    });
    return () => {
      scheduler.stop();
      stopSessionRenewal();
    };
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
  // `billing.sale.cancel` was granted by roles and referenced by no screen, so the only
  // sanctioned way to correct a finalised bill — cancellation (ADR-015) — was
  // unreachable from the application. Daily Bills now offers it.
  const canCancelSales = session.permissions.has('billing.sale.cancel');
  const canReadCredit = session.permissions.has('credit.read');
  // Each M25 screen is gated on the permission its own endpoints require, so a role
  // that cannot use a screen never sees its tab — rather than finding a 403 behind it.
  const canReadCatalog = session.permissions.has('catalog.read');
  const canAdjustStock = session.permissions.has('inventory.adjust');
  // The stock sheet creates or updates a product **and** moves stock, so it needs both.
  // The server re-asserts the pair in `StockEntryService`; this only decides whether the
  // button is worth showing.
  const canAddStock =
    session.permissions.has('catalog.write') &&
    session.permissions.has('inventory.adjust');
  // Price cells on the bill are read-only without it, never hidden — the figure still
  // has to be visible, and the server re-checks the override regardless (§5 rule 12).
  const canOverridePrice = session.permissions.has('billing.price.override');
  const canEditCustomers = session.permissions.has('customer.manage');
  // Its own authority: editing a customer's details and taking money off what they owe
  // are different permissions server-side, so they are different props here too.
  const canRecordPayment = session.permissions.has('credit.payment.record');

  /**
   * The six everyday sections the owner asked for. Nothing else belongs here.
   */
  const sections: Array<{ key: Screen; label: string }> = [
    { key: 'billing', label: NAV.billing },
    ...(canReadSales ? [{ key: 'daily-bills' as Screen, label: NAV.dailyBills }] : []),
    ...(canReadCredit ? [{ key: 'credit-bills' as Screen, label: NAV.creditBills }] : []),
    ...(canReadCatalog ? [{ key: 'stock' as Screen, label: NAV.stock }] : []),
    ...(canReadCredit ? [{ key: 'customers' as Screen, label: NAV.customers }] : []),
    { key: 'sync', label: NAV.sync },
  ];

  return (
    // Full viewport, and the **only** scrolling region is inside `<main>`. The owner
    // asked for the invoice workspace to fit without scrolling the page to reach its
    // controls (R5.1), which `h-dvh` + `min-h-0` on every intermediate flex child is what
    // actually delivers — `h-screen` alone is wrong on a phone with a dynamic toolbar.
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b border-slate-300 px-4 py-2">
        <div>
          <h1 className="text-lg font-semibold text-[#232852]">National Auto Spares</h1>
          {/* Who is signed in, and nothing else. The counter name used to be appended
              here; on a one-computer shop "Counter 1" told the owner nothing they did
              not know and was the last place the withdrawn feature still showed. */}
          <p className="text-xs text-slate-500">
            {session.fullName} · {session.role}
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

      {/* `lg:flex-row` with the nav **last** in the DOM: on a wide screen it sits down
          the right as the owner asked, and on a narrow one it falls below the content
          rather than becoming the horizontal top row the owner rejected. One source
          order, both layouts, and the reading order is the content first either way. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3 lg:flex-row">
        {/* Billing is the fixed workspace and must not scroll the page to reach its
            controls; every other screen is a list that has to. `lg:overflow-hidden` was
            applied unconditionally, which is why Stock, Customers, Credit Bills, Daily
            Bills and Saving-and-syncing were cut off at the foot of a desktop window
            with no scrollbar to recover with — the content was rendered, just
            unreachable. Below `lg` everything scrolls, billing included, because a
            narrow window cannot hold the sheet.

            **The height condition is not decoration.** "Fixed workspace" only makes
            sense while the window is tall enough to hold one. At 1366x420 the browser
            acceptance run could not click `Clear Draft` at all: the four completion
            actions sat below the fold of a pane that had been told never to scroll, so a
            cashier on a short window could not finish a sale and had nothing to drag.
            Clipping the till's own buttons is a worse outcome than a scrollbar, so below
            600px of height billing scrolls like everything else. 600 is comfortably under
            any real counter monitor — the owner's is 768 — so the fixed layout is what
            they will actually see; this is the escape hatch for a half-height window, a
            large zoom level, or a laptop with every toolbar open. */}
        <main
          className={`flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto ${
            screen === 'billing' ? 'lg:[@media(min-height:600px)]:overflow-hidden' : ''
          }`}
        >
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

          {policy === null ? (
            <Panel tone="danger" title="Settings could not be loaded">
              {/* Without the money policy the client would have to invent one, and a
                client that invents a rounding rule eventually disagrees with the
                invoice it is previewing (rule 15). Billing is refused instead. */}
              Billing is unavailable until the server's settings load. Tell the owner.
            </Panel>
          ) : (
            <Suspense fallback={<Busy label={COMMON.loading} />}>
              {/* Say so, rather than spin.
                `BillingCounter` renders `Busy("Opening your bills")` until its draft
                store is ready, and the store is only initialised once the server has
                told us where bills are booked. If that never arrives the billing screen
                would sit on that spinner **for ever** — no error, no retry, nothing to
                act on — which is how a freshly installed PC came to look broken in a way
                nobody could diagnose from the screen.
                Signing in now prepares this computer for billing by itself, so reaching
                this panel means something genuinely unusual (a shop with no active
                counter at all, which only an operator can create). It therefore names
                no setup step the owner no longer has: there is no screen for them to
                visit, and inventing one client-side is forbidden regardless — the client
                must never make up business identity (rule 15). */}
              {screen === 'billing' && !bootstrap?.counter ? (
                <Panel tone="danger" title={ERRORS.billingNotReadyTitle}>
                  {ERRORS.billingNotReady}
                </Panel>
              ) : null}
              {screen === 'billing' && bootstrap?.counter ? (
                <BillingCounter
                  policy={policy}
                  online={online}
                  canBill={canBill}
                  canOverridePrice={canOverridePrice}
                  // The shop's own heading, read from the server's `businesses` row — the
                  // same source the printed bill's payload uses — so the screen and the
                  // paper cannot disagree, and neither invents a value the owner has not
                  // supplied (OD-4).
                  business={bootstrap.business}
                  businessDate={bootstrap.business_date}
                  onSynced={() => scheduler.notifyMutation()}
                  onOpenDailyBills={
                    canReadSales ? () => setScreen('daily-bills') : undefined
                  }
                />
              ) : null}
              {screen === 'daily-bills' && canReadSales ? (
                <DailyBills
                  policy={policy}
                  canCancel={canCancelSales}
                  onRebuild={canBill ? rebuildFromCancelled : undefined}
                />
              ) : null}
              {screen === 'credit-bills' && canReadCredit ? <CreditBills /> : null}
              {screen === 'stock' && canReadCatalog ? (
                <StockScreen
                  canAdjust={canAdjustStock}
                  canAddStock={canAddStock}
                  // The shop's own date, so the movement report opens on today rather
                  // than on whatever the browser's clock calls today (FE-E-3).
                  businessDate={bootstrap?.business_date ?? ''}
                />
              ) : null}
              {screen === 'customers' && canReadCredit ? (
                <CustomersScreen
                  canEdit={canEditCustomers}
                  canRecordPayment={canRecordPayment}
                />
              ) : null}
              {screen === 'sync' ? <SyncPanel online={online} /> : null}
            </Suspense>
          )}
        </main>

        {/* `lg:overflow-y-auto` rather than `visible`: six items fit any sensible
            window, but a short one (a laptop with the browser's bookmarks bar and a
            zoom level) must still be able to reach the last section. */}
        <nav
          aria-label={NAV.label}
          className="flex shrink-0 flex-row gap-2 overflow-x-auto border-t border-slate-300 pt-2 lg:w-56 lg:flex-col lg:overflow-x-visible lg:overflow-y-auto lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0"
          onKeyDown={navigateWithArrows}
        >
          {sections.map((section) => (
            <Button
              key={section.key}
              variant={screen === section.key ? 'primary' : 'secondary'}
              onClick={() => setScreen(section.key)}
              aria-current={screen === section.key ? 'page' : undefined}
              className="shrink-0 lg:w-full lg:justify-start"
            >
              {section.label}
            </Button>
          ))}
        </nav>
      </div>
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

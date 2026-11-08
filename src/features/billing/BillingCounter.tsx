/**
 * The billing workspace: **three bills side by side**, and the tab strip that reaches
 * the rest.
 *
 * The owner bills three customers at once at the counter. Until now the screen held one
 * bill and the other two were behind tabs, so finishing a bill meant remembering which
 * tab it was and clicking back to it. This renders three of them at a time.
 *
 * ## The rolling window, exactly as the owner described it
 *
 * Three columns are on screen. Which three depends on what the cashier last did, and
 * the two rules are different on purpose:
 *
 * | Action | Columns |
 * |---|---|
 * | Open bills 1, 2, 3 | `1 · 2 · 3` |
 * | Start a fourth | `2 · 3 · 4` |
 * | Start a fifteenth | `13 · 14 · 15` |
 * | Choose bill 3 from the tabs | `3 · 4 · 5` |
 * | Choose bill 7 from the tabs | `7 · 8 · 9` |
 *
 * **A new bill lands on the right**, because the bills beside it are the ones the
 * cashier was already working on and pushing them off-screen to make room would lose
 * their place. **A chosen bill lands on the left**, because choosing it says "this is
 * what I am working on now" and the two beside it are what comes next.
 *
 * The one place the two rules meet is the end of the list: choosing the last bill
 * cannot put two more to the right of it, so the window stops at the end and the chosen
 * bill sits wherever it falls. It is always visible, which is the part that matters.
 *
 * ## Fewer than three bills
 *
 * The columns stretch. One bill is full width — exactly the screen this replaced — two
 * are half each, three onwards are thirds. Blank placeholder columns were the
 * alternative and they would make the ordinary single-bill counter two-thirds empty.
 *
 * ## What did not change
 *
 * `draftStore` is untouched: the same Dexie-first writes, the same `maxOpenDrafts`
 * limit, the same tab labels, the same refusal to close anything to make room. Each
 * column is a `BillPanel` over one `LocalDraft`, finalising through the same
 * `finalizeSale` and the same single `POST /sales:finalize`. The **printed** bill is
 * untouched — its own headers, its own stylesheet, its own isolation (ADR-028).
 *
 * The print root stays here, once, because there is one `#print-root` and one printer:
 * a panel that finishes a sale asks the workspace to print rather than mounting a
 * second one.
 *
 * ## The shop's name is **not** drawn here
 *
 * It is the application's heading and the shell draws it, once, at the top left. This
 * screen briefly drew it again above the columns — a second `NATIONAL AUTO SPARES` on
 * the same screen, which the owner reported as soon as they saw it. One name, in the
 * one place that is about identity rather than about billing. The shell reads it from
 * `/sync/bootstrap`, so it is still the **configured** name and never a guess (OD-4,
 * FR-PRINT-016). The printed bill carries its own full heading block, from the server's
 * own payload, and is untouched by any of this (ADR-028).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { FinalizeResponse } from '@/api/types';
import type { LocalDraft } from '@/db/schema';
import type { MoneyPolicy } from '@/lib/money';
import { BILLING, OFFLINE } from '@/lib/strings';
import { Busy, Button, Dialog, Panel } from '@/components/primitives';
import { focusOnNextFrame } from '@/lib/keyboard';
import {
  CounterSlipRoot,
  PrintRoot,
  type CounterSlipData,
} from '@/features/print/PrintRoot';
import { useBillingStore } from './draftStore';
import { BillPanel, CompletionCard, type PrintRequest } from './BillPanel';
import { EMPTY_BILL_UI, type BillUiState } from './billUiState';

/**
 * How many bills are on screen at once.
 *
 * Three, because that is how many customers the owner serves at the counter together.
 * It is a constant rather than a setting: the column width, the compact density in
 * `app.css` and the two-by-two action buttons are all sized for three, and a fourth
 * column would be narrower than the Item cell needs.
 */
export const VISIBLE_BILLS = 3;

export interface BillingCounterProps {
  policy: MoneyPolicy;
  online: boolean;
  /** Whether the user may finalise at all; the UI explains rather than silently failing. */
  canBill: boolean;
  /** `billing.price.override`. Without it the Price cell is read-only, never hidden. */
  canOverridePrice: boolean;
  /** `inventory.oversell.override`. Cashiers do not receive it by default. */
  canOverrideOversell?: boolean | undefined;
  /**
   * `catalog.write`. Gates "Add New Item to Stock" in the Item cell.
   *
   * Offered rather than hidden-and-failing: the server refuses `POST /products` without
   * it, and a button that is sometimes a 403 is worse than no button — the same rule the
   * correction action follows in Daily Bills.
   */
  canCreateProduct?: boolean | undefined;
  /** Today, in the **business's** timezone. Never derived from the browser (FE-E-3). */
  businessDate?: string | undefined;
  onSynced?: (() => void) | undefined;
  /**
   * Switch the shell to Daily Bills.
   *
   * Passed in rather than navigated to, because this application has no router: the
   * screen is state in `AppShell`. A `location.assign` here reloaded the whole app.
   */
  onOpenDailyBills?: (() => void) | undefined;
}

export function BillingCounter({
  policy,
  online,
  canBill,
  canOverridePrice,
  canOverrideOversell = false,
  canCreateProduct = false,
  businessDate,
  onSynced,
  onOpenDailyBills,
}: BillingCounterProps) {
  const store = useBillingStore();

  /**
   * The leftmost of the three columns, as an index into `store.drafts`.
   *
   * Held here rather than in the store because it is a property of *this screen's
   * viewport*, not of the bills: nothing about a draft changes when it scrolls into
   * view, and putting it in the store would mean the sync layer and the Dexie mirror
   * both carried a number about scrolling.
   *
   * Always read through `start` below, never directly: a bill closing can leave this
   * pointing past the end, and the clamp is cheaper to do on read than to chase through
   * every path that removes a draft.
   */
  const [windowStart, setWindowStart] = useState(0);

  /** The one print root (ADR-028), and the one counter slip, for all three columns. */
  const [printing, setPrinting] = useState<PrintRequest | null>(null);
  const [slip, setSlip] = useState<CounterSlipData | null>(null);
  /** A tab the cashier asked to close that still has work on it. */
  const [closing, setClosing] = useState<LocalDraft | null>(null);
  /**
   * The bill that just completed, if one has and the cashier has not dismissed it.
   *
   * Held **here** rather than in the column that finished it, because finalising drops
   * the bill from the open drafts and that unmounts its column. While this was panel
   * state it went with it: the sale committed, the bill disappeared, and nothing ever
   * said "Stock has been updated." — the one sentence FR-CREDIT-013/026 requires,
   * because it is what stops a cashier reading "saved" as "not sold yet" and letting
   * the customer leave with the goods. Found by the keyboard-only browser run.
   */
  const [completed, setCompleted] = useState<FinalizeResponse | null>(null);

  /**
   * Each open bill's screen state, by draft id.
   *
   * The advance typed on it, the conflict the server last returned for it, whether a
   * finalisation is in flight, an oversell approval and its reason. See `BillUiState`
   * for why none of it is in the draft and none of it is in the column.
   *
   * **Keyed by draft id, never by column.** A map keyed by position would hand bill
   * 4's advance to bill 5 the instant the window rolled — the one mistake in this file
   * that would cost real money.
   */
  const [billUi, setBillUi] = useState<Record<string, BillUiState>>({});

  const patchBillUi = useCallback((draftId: string, patch: Partial<BillUiState>) => {
    setBillUi((current) => ({
      ...current,
      [draftId]: { ...EMPTY_BILL_UI, ...current[draftId], ...patch },
    }));
  }, []);

  const drafts = store.drafts;
  const maxStart = Math.max(0, drafts.length - VISIBLE_BILLS);
  const start = Math.min(Math.max(0, windowStart), maxStart);
  const visible = drafts.slice(start, start + VISIBLE_BILLS);

  /**
   * Put the caret in a bill's first free Item cell.
   *
   * The hand-off after choosing a tab or starting a bill: the cashier asked for that
   * bill, so the next thing they type is a part name. Two frames rather than one
   * because the column may not be mounted yet — choosing a tab can scroll the window,
   * which mounts a panel React has not committed when the handler runs.
   */
  const focusBill = useCallback((draftId: string) => {
    const row =
      useBillingStore.getState().drafts.find((draft) => draft.id === draftId)?.lines
        .length ?? 0;
    const selector = `[data-bill-panel="${draftId}"] [data-cell="${row}-item"]`;
    const cell = document.querySelector<HTMLElement>(selector);
    // Already mounted — the ordinary case, where the chosen bill was on screen anyway.
    if (cell) {
      cell.focus();
      return;
    }
    // Not mounted yet: the window scrolled to bring this bill in, and React has not
    // committed the new column at the moment the handler runs. One frame is enough, and
    // the lookup is scoped to the bill so it cannot settle on the column next door.
    focusOnNextFrame(selector);
  }, []);

  /**
   * Choosing a bill from the tabs opens it **on the left**, with the next two beside it.
   *
   * Clamped at the end of the list: bill 15 of 15 cannot have two to its right, so the
   * window stops and the chosen bill is the last column instead of the first. It is
   * visible either way, which is the promise the tab strip makes.
   */
  const selectBill = useCallback(
    (draftId: string) => {
      const all = useBillingStore.getState().drafts;
      const index = all.findIndex((draft) => draft.id === draftId);
      if (index < 0) return;
      store.selectDraft(draftId);
      setWindowStart(Math.min(index, Math.max(0, all.length - VISIBLE_BILLS)));
      focusBill(draftId);
    },
    [store, focusBill],
  );

  /**
   * A new bill opens **on the right**, keeping the two the cashier was already on.
   *
   * `newDraft` returns `null` at the tab limit and closes nothing to make room
   * (FR-DRAFT-003); the store sets `limitMessage`, which is rendered above the columns.
   */
  const startBill = useCallback(async () => {
    const draftId = await store.newDraft();
    if (!draftId) return;
    const all = useBillingStore.getState().drafts;
    const index = all.findIndex((draft) => draft.id === draftId);
    setWindowStart(
      Math.max(0, Math.min(index - (VISIBLE_BILLS - 1), all.length - VISIBLE_BILLS)),
    );
    focusBill(draftId);
  }, [store, focusBill]);

  /**
   * Keep the bill with focus on screen, and keep the window inside the list.
   *
   * Both jobs in one effect because they are the same correction from opposite
   * directions: closing a bill can shorten the list past the window, and the store can
   * move `activeDraftId` on its own — `clearDraft` falls back to the first remaining
   * bill — leaving the active bill outside the three columns with the `Ctrl` shortcuts
   * pointed at something nobody can see.
   */
  useEffect(() => {
    const index = drafts.findIndex((draft) => draft.id === store.activeDraftId);
    setWindowStart((current) => {
      const limit = Math.max(0, drafts.length - VISIBLE_BILLS);
      const clamped = Math.min(Math.max(0, current), limit);
      if (index < 0) return clamped;
      if (index < clamped) return index;
      if (index >= clamped + VISIBLE_BILLS) return Math.min(index, limit);
      return clamped;
    });
  }, [drafts, store.activeDraftId]);

  /**
   * Forget a bill's screen state once the bill is gone.
   *
   * Without this the map grows for the life of the session, and — much worse — a draft
   * id that came back would come back with a stale advance on it. A finished or cleared
   * bill has no screen state worth keeping: the confirmation card is held separately
   * and is what survives a completed sale.
   */
  useEffect(() => {
    const open = new Set(drafts.map((draft) => draft.id));
    setBillUi((current) => {
      const live = Object.keys(current).filter((id) => open.has(id));
      if (live.length === Object.keys(current).length) return current;
      return Object.fromEntries(live.map((id) => [id, current[id]!]));
    });
  }, [drafts]);

  /**
   * On opening the screen, the cursor starts where the cashier would put it: the first
   * empty Item cell of the bill they were on.
   *
   * Once only. It used to run whenever the active bill changed, which was harmless with
   * one bill on screen and is not with three: clicking `Save a Draft` in the middle
   * column makes that bill active, and re-running this would have yanked the caret out
   * of the button and into the grid.
   */
  const started = useRef(false);
  useEffect(() => {
    if (!store.ready || started.current || !store.activeDraftId) return;
    started.current = true;
    focusBill(store.activeDraftId);
  }, [store.ready, store.activeDraftId, focusBill]);

  /**
   * Close a tab, like closing a browser tab — but never silently.
   *
   * An empty bill closes straight away. One with items asks first and offers to save it
   * as a draft instead, because `No draft is ever auto-closed, auto-finalised or
   * silently discarded` (§5 rule 18) and a cashier who loses a half-typed bill to a
   * stray click stops trusting the system.
   */
  const closeTab = useCallback(
    async (draft: LocalDraft) => {
      if (draft.lines.length === 0) {
        await store.clearDraft(draft.id);
        return;
      }
      setClosing(draft);
    },
    [store],
  );

  const discardClosing = useCallback(async () => {
    if (!closing) return;
    await store.clearDraft(closing.id);
    setClosing(null);
  }, [closing, store]);

  const saveClosing = useCallback(async () => {
    if (!closing) return;
    await store.saveDraftToServer(closing.id);
    setClosing(null);
    onSynced?.();
  }, [closing, store, onSynced]);

  if (!store.ready) return <Busy label="Opening your bills" />;

  return (
    // `min-h-0` all the way down is what lets the grids be the only scrolling regions,
    // so the headers, the grand totals and the four buttons stay on screen (R5.1).
    // `bill-dense` is the compact sizing three columns need — see `app.css`.
    <div className="bill-dense flex min-h-0 flex-1 flex-col gap-2">
      <BillTabs
        drafts={drafts}
        activeId={store.activeDraftId}
        onSelect={selectBill}
        onClose={(draft) => void closeTab(draft)}
        onNew={() => void startBill()}
      />

      {store.limitMessage ? (
        <Panel tone="warning" title={store.limitMessage}>
          {BILLING.tabLimitReached(store.maxOpenDrafts)}
        </Panel>
      ) : null}

      {!online ? <Panel tone="warning">{OFFLINE.banner}</Panel> : null}

      {/* Above the columns, full width, because by the time it is shown the column that
          earned it has gone. */}
      {completed ? (
        <CompletionCard
          response={completed}
          policy={policy}
          onPrint={() =>
            setPrinting({
              payload: completed.print_payload,
              invoiceId: completed.invoice.id,
            })
          }
          onDismiss={() => setCompleted(null)}
        />
      ) : null}

      {/* The columns. `items-stretch` so three bills of different lengths still line up
          their headers and their buttons, which is what makes them readable as one
          workspace rather than three floating cards. */}
      <div className="flex min-h-0 flex-1 items-stretch gap-2 overflow-hidden">
        {visible.map((draft) => (
          <BillPanel
            key={draft.id}
            draft={draft}
            // Its place in the open tabs, not an invoice number. There is still no
            // invoice number anywhere in this application (OD-3).
            position={drafts.findIndex((candidate) => candidate.id === draft.id) + 1}
            active={draft.id === store.activeDraftId}
            // Only the focus moves. The three columns stay where they are, because a
            // cashier clicking the middle bill is not asking to be scrolled.
            onActivate={() => store.selectDraft(draft.id)}
            policy={policy}
            online={online}
            canBill={canBill}
            canOverridePrice={canOverridePrice}
            canOverrideOversell={canOverrideOversell}
            canCreateProduct={canCreateProduct}
            businessDate={businessDate}
            onSynced={onSynced}
            onOpenDailyBills={onOpenDailyBills}
            onPrint={setPrinting}
            onPrintSlip={setSlip}
            onCompleted={setCompleted}
            ui={billUi[draft.id] ?? EMPTY_BILL_UI}
            onUiChange={patchBillUi}
          />
        ))}
      </div>

      {/* The standing hints, said once under all three columns rather than three times
          over. They are advice about how the screen works, not about any one bill, and
          three copies of them cost rows of the grid height this redesign exists to give
          back. The packing-tick note is not here: it is the `Got it` column's own
          tooltip, where it is read in the one place it applies. */}
      <p className="shrink-0 truncate text-xs text-slate-500">
        {BILLING.keyboardHint} {BILLING.workspaceHint}
      </p>

      <Dialog
        open={closing !== null}
        title={BILLING.closeTabTitle}
        onDismiss={() => setClosing(null)}
        actions={
          <>
            <Button variant="quiet" onClick={() => setClosing(null)}>
              {BILLING.closeTabKeep}
            </Button>
            <Button variant="secondary" onClick={() => void saveClosing()}>
              {BILLING.closeTabSaveFirst}
            </Button>
            <Button variant="danger" onClick={() => void discardClosing()}>
              {BILLING.closeTabDiscard}
            </Button>
          </>
        }
      >
        {BILLING.closeTabHasWork(closing?.lines.length ?? 0)}
      </Dialog>

      <PrintRoot
        payload={printing?.payload ?? null}
        policy={policy}
        invoiceId={printing?.invoiceId ?? null}
        onAfterPrint={() => setPrinting(null)}
      />
      <CounterSlipRoot data={slip} policy={policy} onAfterPrint={() => setSlip(null)} />
    </div>
  );
}

// --- the tab strip ------------------------------------------------------------

/**
 * Bill tabs that behave like browser tabs, and are how the bills off-screen are reached.
 *
 * Each has a close control, a position and the name of whoever the bill is for. The
 * strip scrolls horizontally rather than wrapping or collapsing, because `No tab is ever
 * unreachable` (UI-UX §4) and twenty open bills must all stay clickable — a hidden tab
 * is a bill somebody cannot finish.
 *
 * Switching is local-only and instant: never a fetch, never a finalisation.
 *
 * ## What the three-column workspace changed here
 *
 * The strip now carries the whole burden of "I have fifteen bills open and I want the
 * third one", so a tab has to be recognisable rather than merely distinct:
 *
 * * **A position number**, shown as a badge. It says *where* a bill is, which is what
 *   somebody counting along the strip is actually looking for. It is `aria-hidden`, so
 *   it is decoration for the keyboard and the screen reader rather than part of the
 *   tab's name — the same treatment the `+` on `New bill` already has.
 * * **The customer's name**, as soon as there is one. A bill is "Rakesh Motors" to the
 *   person billing it long before it is "AXEL PACKING", so the tab follows the customer
 *   and falls back to `draft.label` — the first product, or `New bill` — when there is
 *   no customer yet. `draft.label` itself is **not** touched: it is the store's name for
 *   the bill and the thing uniqueness is computed against.
 * * **The current tab scrolls itself into view**, so choosing bill 3 out of fifteen and
 *   then coming back to the strip does not mean hunting for it again.
 *
 * ## A labelled list, deliberately **not** `role="tablist"`
 *
 * These look like tabs and are called tabs, but they are not the WAI-ARIA tab widget.
 * That pattern requires each tab to own a `tabpanel` via `aria-controls` *and* to move
 * between tabs with the arrow keys — and the arrows belong to the invoice grid here,
 * which is the whole point of the design. Declaring `tablist` while honouring neither is
 * a promise to a screen reader that the keyboard then breaks, and axe caught exactly
 * that: `aria-required-children`, because each tab is wrapped with its own close button.
 *
 * So it is a list of buttons with a name, and the current bill is marked with
 * `aria-current` — the same way the section navigation marks the current screen. Honest
 * about what it is, and reachable with `Tab` like every other control.
 */
function BillTabs({
  drafts,
  activeId,
  onSelect,
  onClose,
  onNew,
}: {
  drafts: readonly LocalDraft[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (draft: LocalDraft) => void;
  onNew: () => void;
}) {
  const current = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    // A nicety, and optional-called because jsdom does not implement it — the same note
    // the suggestion lists carry.
    current.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  return (
    <nav aria-label="Open bills" className="shrink-0 border-b border-slate-300 pb-1">
      <ul className="flex items-center gap-1 overflow-x-auto">
        {drafts.map((draft, index) => {
          const selected = draft.id === activeId;
          /**
           * Whoever this bill is for, falling back to what the store called it.
           *
           * The customer's name is this bill's snapshot (FR-CREDIT-012) and is written
           * on blur, so it appears as soon as the cashier moves on from the field —
           * which is exactly when they would start thinking of the bill by that name.
           */
          const name = draft.header.customer_name.trim() || draft.label;
          return (
            <li
              key={draft.id}
              ref={selected ? current : null}
              className={`flex shrink-0 items-center rounded-t border border-b-0 ${
                selected
                  ? 'border-nas-navy bg-nas-navy text-white'
                  : 'border-slate-300 bg-slate-50 text-slate-700'
              }`}
            >
              <button
                type="button"
                aria-current={selected ? 'true' : undefined}
                onClick={() => onSelect(draft.id)}
                className="flex max-w-56 items-center gap-2 px-2 py-1 text-sm font-medium"
                title={BILLING.tabLabel(index + 1, name)}
              >
                {/* The position, as decoration. Hidden from the accessible name so the
                    tab is still called by the customer's name — two controls differing
                    only by a number read badly, and the name is what anybody says out
                    loud. */}
                <span
                  aria-hidden="true"
                  className={`rounded px-1 text-xs tabular-nums ${
                    selected ? 'bg-white/20' : 'bg-slate-200 text-slate-700'
                  }`}
                >
                  {index + 1}
                </span>
                <span className="truncate">{name}</span>
                {/* A mark **in addition to** the status word in the panels below, never
                    colour or a glyph alone (NFR-FE-UX-007). */}
                {draft.status === 'conflict' ? ' ⚠' : ''}
                {draft.status === 'unconfirmed' ? ' …' : ''}
                {draft.status === 'finalized' ? ' ✓' : ''}
              </button>
              <button
                type="button"
                onClick={() => onClose(draft)}
                aria-label={BILLING.closeTab(name)}
                className={`px-2 py-1 text-sm ${
                  selected ? 'hover:bg-white/20' : 'hover:bg-slate-200'
                }`}
              >
                ×
              </button>
            </li>
          );
        })}
        <li className="shrink-0">
          <Button variant="quiet" onClick={onNew} aria-label={BILLING.newTabAction}>
            {/* The `+` is decoration. The accessible name is "Start a new bill" — not
                "New bill" — because a tab is *called* `New bill` until its first product
                renames it, and two controls sharing one name is ambiguous both to a
                screen reader and to anyone saying "click New bill". The visible text is
                contained in the accessible name, so WCAG 2.5.3 still holds. */}
            <span aria-hidden="true">+ </span>
            {BILLING.newTab}
          </Button>
        </li>
      </ul>
    </nav>
  );
}

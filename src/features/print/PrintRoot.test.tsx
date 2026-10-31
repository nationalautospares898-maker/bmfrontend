/**
 * The print roots: **one dialog per print request, and a re-render is not a request.**
 *
 * These assertions exist because the guard in `PrintRoot` was keyed on the *document*
 * (`${issued_at}:${is_duplicate}`) and never reset, and `CounterSlipRoot` armed itself
 * with a state flag that its own effect depended on. Both failures were silent, and a
 * silent print failure at a counter is the worst shape a defect can take: the operator
 * presses the button, nothing happens, there is no error to read and nothing to retry
 * while the customer waits (FR-PRINT-004, FR-OFFLINE-015).
 *
 * The two callers are imitated rather than imported, because the shape of the caller is
 * what the defects turned on:
 *
 * - **Reprint** (`DailyBills`) re-fetches the payload, so every press hands over a *new*
 *   object whose content is identical — including `is_duplicate: true`, which the server
 *   sets on every reprint once `print_log` has a row;
 * - **"Print now"** (the credit confirmation card) hands over the *same* payload object
 *   from the finalisation response on every press.
 *
 * Both pass an inline `onAfterPrint` arrow, so every parent render hands the root a new
 * function — the prop whose identity used to re-run the arming effect and cancel the
 * pending `window.print()`.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrintPayload } from '@/api/types';
import type { MoneyPolicy } from '@/lib/money';
import { CounterSlipRoot, PrintRoot } from './PrintRoot';
import type { CounterSlipData } from './PrintRoot';

const recordPrintEvent = vi.fn();

vi.mock('@/api/endpoints', () => ({
  invoices: {
    recordPrintEvent: (...args: unknown[]) => recordPrintEvent(...args) as unknown,
  },
}));

/** The `window.print` stub, so no assertion references an unbound method. */
let printSpy = vi.fn();

/** The whole-rupee v1 policy, as the settings endpoint publishes it (OD-23). */
const POLICY: MoneyPolicy = {
  version: 1,
  currency: 'INR',
  amount_scale: 2,
  unit_price_scale: 4,
  quantity_scale: 3,
  percent_scale: 2,
  rounding_mode: 'reject_fractional',
  round_grand_total_to_rupee: true,
  require_integral_amounts: true,
  display_decimal_places: 0,
};

/**
 * A complete reprint payload, as `GET /invoices/{id}/print-payload` returns it.
 *
 * Complete rather than minimal on purpose: the root portals it into
 * `InvoicePrintLayout`, so a payload missing `business` or `totals` throws inside the
 * portal and `window.print()` is never reached — which would make every assertion below
 * pass or fail for the wrong reason. `is_duplicate: true` because a reprint is what is
 * under test, and only the server decides that (FR-PRINT-004).
 */
function duplicatePayload(): PrintPayload {
  return {
    document_title: 'ESTIMATE',
    is_duplicate: true,
    business: {
      display_name: 'National Auto Spares',
      address_lines: ['Main Road', 'Hyderabad'],
      phone_numbers: ['9876543210'],
      tax_identifier: null,
      tax_identifier_label: null,
    },
    issued_at: '2026-10-30T10:15:00+05:30',
    customer: {
      name: 'Ramesh Motors',
      business_name: null,
      vehicle_number: 'KA01AB1234',
      mechanic_name: null,
      phone: null,
    },
    columns: ['sl_no', 'item', 'quantity', 'price', 'total'],
    lines: [
      {
        sl_no: 1,
        item: 'Brake Shoe Set',
        quantity: '2.000',
        price: '2500.00',
        total: '5000.00',
      },
    ],
    totals: {
      subtotal: '5000.00',
      discount: '0.00',
      tax: null,
      rounding: '0.00',
      grand_total: '5000.00',
    },
    amount_in_words: 'Five thousand rupees only',
    payment: {
      status: 'partially_paid',
      amount_paid: '3000.00',
      outstanding: '2000.00',
      method: null,
      due_date: '2026-11-15',
      is_credit: true,
    },
    footer_notes: [],
    tax_mode: 'estimate_only',
    print_profile: 'a5_portrait',
    date_format: 'MM-DD-YYYY',
    show_credit_block: true,
    item_row_capacity: 25,
  };
}

/** The slip is built from local draft data, so whole rupees only (OD-23). */
const SLIP: CounterSlipData = {
  printedAt: '2026-10-30T10:15:00+05:30',
  lines: [{ sl_no: 1, item: 'Brake Shoe Set', quantity: '2.000', price: '2500.00' }],
  total: '5000.00',
  customerName: 'Ramesh Motors',
  vehicleNumber: 'KA01AB1234',
};

/** One payload object, reused on every press, the way "Print now" does. */
const SHARED_PAYLOAD = duplicatePayload();

/**
 * A caller shaped like the real ones: it mounts a payload on a press and clears it when
 * the dialog closes.
 *
 * `rebuild` picks which real caller is being imitated — see the file comment. `Nudge` is
 * an unrelated parent state change, which is the re-render the arming guard has to
 * survive without opening a second dialog.
 */
function BillCaller({ rebuild }: { rebuild: boolean }) {
  const [payload, setPayload] = useState<PrintPayload | null>(null);
  const [nudges, setNudges] = useState(0);
  return (
    <>
      <button
        type="button"
        onClick={() => setPayload(rebuild ? duplicatePayload() : SHARED_PAYLOAD)}
      >
        Reprint
      </button>
      <button type="button" onClick={() => setNudges((count) => count + 1)}>
        Nudge
      </button>
      <span data-testid="nudges">{nudges}</span>
      <PrintRoot
        payload={payload}
        policy={POLICY}
        invoiceId="inv-1"
        onAfterPrint={() => setPayload(null)}
      />
    </>
  );
}

/** The offline caller: a slip per press, cleared when the dialog closes. */
function SlipCaller() {
  const [slip, setSlip] = useState<CounterSlipData | null>(null);
  return (
    <>
      <button type="button" onClick={() => setSlip({ ...SLIP })}>
        Counter slip
      </button>
      <CounterSlipRoot data={slip} policy={POLICY} onAfterPrint={() => setSlip(null)} />
    </>
  );
}

function pressButton(name: string): void {
  act(() => {
    screen.getByRole('button', { name }).click();
  });
}

/** The operator closing (or cancelling) the browser's print dialog. */
function closeDialog(): void {
  act(() => {
    window.dispatchEvent(new Event('afterprint'));
  });
}

beforeEach(() => {
  recordPrintEvent.mockReset();
  recordPrintEvent.mockResolvedValue(undefined);
  // `window.print` does not exist in jsdom, and the roots call it a frame after arming.
  printSpy = vi.fn();
  vi.stubGlobal('print', printSpy);
  // `#print-root` lives in `index.html`, **outside** the application layout, so one
  // `@media print` rule can hide the app and leave only the bill (ADR-028). A component
  // test has to supply it, or the portal has no target, nothing renders and every
  // assertion here passes vacuously.
  const root = document.createElement('div');
  root.id = 'print-root';
  document.body.append(root);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.getElementById('print-root')?.remove();
});

describe('repeat print requests (FR-PRINT-004)', () => {
  it('still opens the dialog on the third reprint of one invoice, which the document-keyed guard swallowed', async () => {
    render(<BillCaller rebuild />);

    for (const press of [1, 2, 3]) {
      pressButton('Reprint');
      // The dialog opens a frame after the payload is mounted. Before the fix the third
      // press never got here: the key `issued_at:is_duplicate` was unchanged from the
      // second press, so the effect returned early and `window.print()` was never
      // reached — no dialog, no error, nothing to retry.
      await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(press));
      closeDialog();
    }

    expect(printSpy).toHaveBeenCalledTimes(3);
    // And every one of them is logged against the invoice that was printed, as a
    // duplicate, because the server said so.
    await waitFor(() => expect(recordPrintEvent).toHaveBeenCalledTimes(3));
    expect(recordPrintEvent).toHaveBeenLastCalledWith('inv-1', true);
  });

  it('prints again when the very same payload object is handed over, which made "Print now" print only once', async () => {
    // The credit confirmation card passes `completed.print_payload` on every press, so
    // nothing about the payload changes between presses — not its content and not its
    // identity. Pressing it twice must still produce two dialogs.
    render(<BillCaller rebuild={false} />);

    pressButton('Reprint');
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    closeDialog();

    pressButton('Reprint');
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(2));
  });

  it('prints a counter slip at all, and again for the next one, where the state flag cancelled its own dialog', async () => {
    // The flag was set inside the effect and listed in its dependencies, so arming
    // re-rendered, the re-run's cleanup cancelled the pending `window.print()`, and the
    // flag then forced the early return. Offline this slip is the only thing a cashier
    // can hand over (FR-OFFLINE-015).
    render(<SlipCaller />);

    pressButton('Counter slip');
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    closeDialog();

    pressButton('Counter slip');
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(2));
    // A slip is not a bill and has no invoice: nothing is recorded against one.
    expect(recordPrintEvent).not.toHaveBeenCalled();
  });
});

describe('the guard that must survive', () => {
  it('opens no second dialog when the parent re-renders while a bill is printing', async () => {
    render(<BillCaller rebuild />);

    pressButton('Reprint');
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));

    // Two unrelated parent state changes, each handing the root a fresh `onAfterPrint`
    // closure while the same payload is still mounted. A customer must never be handed
    // two copies because a sibling component updated.
    pressButton('Nudge');
    pressButton('Nudge');
    expect(screen.getByTestId('nudges')).toHaveTextContent('2');

    await waitFor(() => expect(screen.getByTestId('nudges')).toHaveTextContent('2'));
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it('still prints when the parent re-renders inside the frame between arming and the dialog', async () => {
    // Both presses land in one synchronous block, so no timer can run between them: the
    // re-render is guaranteed to arrive inside the 50 ms arming window. The effect used
    // to re-run there, its cleanup cancelled the pending `window.print()`, and the
    // document-keyed guard then refused to arm again — the press did nothing at all.
    render(<BillCaller rebuild />);

    act(() => {
      screen.getByRole('button', { name: 'Reprint' }).click();
      screen.getByRole('button', { name: 'Nudge' }).click();
    });

    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    closeDialog();
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it('opens no dialog at all until the caller mounts a payload', async () => {
    render(<BillCaller rebuild />);
    pressButton('Nudge');
    await waitFor(() => expect(screen.getByTestId('nudges')).toHaveTextContent('1'));
    expect(printSpy).not.toHaveBeenCalled();
    expect(document.getElementById('print-root')?.textContent).toBe('');
  });
});

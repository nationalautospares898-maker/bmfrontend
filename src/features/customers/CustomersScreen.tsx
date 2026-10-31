/**
 * Customer management (M25).
 *
 * The rule that shapes this screen: **what a customer owes is derived, never typed**
 * (ADR-022, FR-CREDIT-003). `amount_paid` and `payment_status` are recomputed from
 * allocations on the server, so there is no editable balance field here, no "mark as
 * paid" control, and no place a figure can be corrected by hand. The screen says so in
 * words, because a shopkeeper who cannot find the field needs to know it is absent on
 * purpose rather than missing.
 *
 * Recording a payment is not an exception to that rule: `RecordPayment` below writes
 * a payment event and the server recomputes the balance from its allocations. Nothing
 * on this screen ever sets a balance directly.
 *
 * Everything editable is identity — name, phone, address, credit limit, terms.
 * Everything financial is read from `/credit/customers` and `/customers/{id}/ledger`
 * and rendered verbatim: the client sums nothing (FR-RPT-030).
 *
 * Duplicate handling follows FR-CUST-004: the server **surfaces candidates and never
 * merges**, so a suspected duplicate is shown as a warning beside a save that still
 * works. Blocking the save would strand a real second customer who shares a phone with
 * a relative.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { credit, customers as customersApi } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import type { DirectoryCustomer, PaymentHistoryEntry } from '@/api/types';
import { Busy, Button, Dialog, Field, Panel } from '@/components/primitives';
import { uuidv7 } from '@/lib/ids';
import { formatForScreen, tryParseMoney, ZERO } from '@/lib/money';
import { COMMON, CUSTOMERS, ERRORS } from '@/lib/strings';

export interface CustomersScreenProps {
  /** `customers.write`. Without it the screen is read-only. */
  canEdit: boolean;
  /**
   * `credit.payment.record`. Deliberately separate from `canEdit`: editing a customer's
   * details and taking money off what they owe are different authorities, and a shop
   * may well let someone do the first but not the second.
   */
  canRecordPayment?: boolean;
}

/**
 * One row: a customer from the directory, plus the credit aggregates when they have
 * any.
 *
 * Two sources on purpose. The screen used to read **only** `GET /credit/customers`,
 * which inner-joins credit invoices — it answers "who owes us money" and is, by the
 * specification's own words, the top of the Credit Bills view. So a customer with no
 * credit invoice was invisible here and could not be found by typing their name either,
 * and one created through `Add a customer` appeared to vanish. `GET /customers` is the
 * directory; the credit figures are merged on top so no column was lost in the fix.
 */
interface CustomerRow {
  customer: DirectoryCustomer;
  outstanding: string;
  open_invoice_count: number;
  oldest_due_date: string | null;
}

const NO_CREDIT: Omit<CustomerRow, 'customer'> = {
  outstanding: '0.00',
  open_invoice_count: 0,
  oldest_due_date: null,
};

export function CustomersScreen({
  canEdit,
  canRecordPayment = false,
}: CustomersScreenProps) {
  const [rows, setRows] = useState<CustomerRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [owingOnly, setOwingOnly] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CustomerRow | 'new' | null>(null);
  const [viewing, setViewing] = useState<CustomerRow | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Discards a response a newer request has superseded. Typing in the search box fires
  // a load per keystroke, and without this the slowest reply wins — showing results for
  // a prefix the box no longer contains.
  const latestLoad = useRef(0);

  /**
   * Fetch a page of the directory and merge the credit aggregates onto it.
   *
   * `append` is the "Show more" path; it keeps what is already on screen.
   */
  const fetchPage = useCallback(
    async (opts: { cursor?: string; append?: boolean } = {}) => {
      const sequence = latestLoad.current + 1;
      latestLoad.current = sequence;
      if (!opts.append) setRows(null);
      setError(null);
      try {
        const term = query.trim();
        const [directory, creditList] = await Promise.all([
          // Search when something is typed, otherwise the newest page. Search matches
          // name, phone, business name and vehicle (`API-SPECIFICATION.md §3.6`).
          term
            ? customersApi.search(term)
            : customersApi.list(opts.cursor ? { cursor: opts.cursor } : {}),
          // `include_settled` so a customer who has paid everything off still brings
          // their history, rather than the aggregates vanishing once they settle up.
          credit.customers({ include_settled: true }),
        ]);
        if (sequence !== latestLoad.current) return;

        const aggregates = new Map(
          creditList.items.map((item) => [item.customer.id, item]),
        );
        const page: CustomerRow[] = directory.items.map((customer) => {
          const found = aggregates.get(customer.id);
          return {
            customer,
            outstanding: found?.outstanding ?? NO_CREDIT.outstanding,
            open_invoice_count: found?.open_invoice_count ?? NO_CREDIT.open_invoice_count,
            oldest_due_date: found?.oldest_due_date ?? NO_CREDIT.oldest_due_date,
          };
        });

        setRows((existing) => (opts.append && existing ? [...existing, ...page] : page));
        // Search is unpaged by contract, so there is never a next page for a term.
        // `page` is optional-chained because a search response is not paged by
        // contract, and a missing page block must mean "no more" rather than throwing
        // and turning a perfectly good list into an error panel.
        setCursor(term ? null : (directory.page?.next_cursor ?? null));
      } catch (caught) {
        if (sequence !== latestLoad.current) return;
        if (!opts.append) setRows([]);
        setError(
          caught instanceof ApiError
            ? describeError(caught.code).message
            : ERRORS.unexpected,
        );
      }
    },
    [query],
  );

  const load = useCallback(async () => {
    await fetchPage();
  }, [fetchPage]);

  useEffect(() => {
    void load();
  }, [load]);

  // Filtered here rather than at the server: the directory is the source of truth for
  // *who exists*, and "only those who owe" is a view of it.
  const visible =
    rows === null
      ? null
      : owingOnly
        ? rows.filter((row) => (tryParseMoney(row.outstanding) ?? ZERO).greaterThan(0))
        : rows;

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-semibold text-[#232852]">{CUSTOMERS.title}</h2>
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label={CUSTOMERS.searchLabel}
            value={query}
            hint={CUSTOMERS.searchHint}
            onChange={(event) => setQuery(event.target.value)}
            className="w-64"
          />
          <Button
            variant={owingOnly ? 'primary' : 'secondary'}
            aria-pressed={owingOnly}
            onClick={() => setOwingOnly((value) => !value)}
          >
            {CUSTOMERS.owingOnly}
          </Button>
          {canEdit ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              {CUSTOMERS.newCustomer}
            </Button>
          ) : null}
        </div>
      </header>

      {/* Stated where someone would otherwise look for an editable field. */}
      <Panel tone="info">{CUSTOMERS.balanceExplainer}</Panel>

      {error ? <Panel tone="danger">{error}</Panel> : null}

      {visible === null ? (
        <Busy label={COMMON.loading} />
      ) : visible.length === 0 ? (
        <Panel tone="info">
          {query.trim()
            ? CUSTOMERS.emptyNoMatch
            : owingOnly
              ? CUSTOMERS.emptyNoneOwing
              : CUSTOMERS.empty}
        </Panel>
      ) : (
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{CUSTOMERS.tableCaption}</caption>
          <thead>
            <tr className="border-b border-slate-300 text-left">
              <th scope="col" className="py-2">
                {CUSTOMERS.colName}
              </th>
              <th scope="col" className="py-2">
                {CUSTOMERS.colPhone}
              </th>
              <th scope="col" className="py-2 text-right">
                {CUSTOMERS.colOutstanding}
              </th>
              <th scope="col" className="py-2 text-right">
                {CUSTOMERS.colBills}
              </th>
              <th scope="col" className="py-2">
                {CUSTOMERS.colOldest}
              </th>
              <th scope="col" className="py-2">
                {COMMON.actions}
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.customer.id} className="border-b border-slate-100">
                <td className="py-2">{row.customer.name}</td>
                <td className="py-2">{row.customer.primary_phone ?? '—'}</td>
                <td className="py-2 text-right font-medium">
                  {/* Rendered from the response. The client never sums these. */}
                  {formatForScreen(tryParseMoney(row.outstanding) ?? ZERO)}
                </td>
                <td className="py-2 text-right">{row.open_invoice_count}</td>
                <td className="py-2">{row.oldest_due_date ?? '—'}</td>
                <td className="py-2">
                  <div className="flex gap-2">
                    <Button variant="quiet" onClick={() => setViewing(row)}>
                      {CUSTOMERS.view}
                    </Button>
                    {/* "Edit", not "Save": this opens a form, it does not save
                        anything. A row button labelled Save also collided with the
                        form's own Save, which is how the ambiguity surfaced. */}
                    {canEdit ? (
                      <Button variant="quiet" onClick={() => setEditing(row)}>
                        {CUSTOMERS.edit}
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Paged, not scrolled-to-death: the directory is keyset-paged on the server so
          a shop with thousands of customers does not ship them all to the counter. */}
      {cursor && !query.trim() ? (
        <div>
          <Button
            busy={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              void fetchPage({ cursor, append: true }).finally(() =>
                setLoadingMore(false),
              );
            }}
          >
            {CUSTOMERS.showMore}
          </Button>
        </div>
      ) : null}

      {viewing ? (
        <CustomerDetail
          customer={viewing}
          canRecordPayment={canRecordPayment}
          onClose={() => setViewing(null)}
          onPaymentRecorded={() => {
            // The figures on this dialog are server aggregates, so the list has to be
            // refetched rather than adjusted locally — the client never computes a
            // balance (FR-RPT-030, ADR-022).
            setViewing(null);
            void load();
          }}
        />
      ) : null}

      {editing ? (
        <CustomerForm
          customer={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}
    </section>
  );
}

// --- detail -------------------------------------------------------------------

function CustomerDetail({
  customer,
  canRecordPayment,
  onClose,
  onPaymentRecorded,
}: {
  customer: CustomerRow;
  canRecordPayment: boolean;
  onClose: () => void;
  onPaymentRecorded: () => void;
}) {
  const [payments, setPayments] = useState<PaymentHistoryEntry[] | null>(null);
  // No form when nothing is owed: a payment against a settled account is an advance,
  // which is a different decision and not one to slip in behind an identical button.
  const owes = (tryParseMoney(customer.outstanding) ?? ZERO).greaterThan(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await credit.payments({ customer_id: customer.customer.id });
        if (!cancelled) setPayments(response.items);
      } catch {
        if (!cancelled) setPayments([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customer.customer.id]);

  return (
    <Dialog
      open
      title={`${CUSTOMERS.detailTitle} — ${customer.customer.name}`}
      onDismiss={onClose}
      actions={<Button onClick={onClose}>{COMMON.close}</Button>}
    >
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-slate-600">{CUSTOMERS.phone}</dt>
          <dd>{customer.customer.primary_phone ?? '—'}</dd>
          <dt className="text-slate-600">{CUSTOMERS.outstandingNow}</dt>
          <dd className="font-medium">
            {formatForScreen(tryParseMoney(customer.outstanding) ?? ZERO)}
          </dd>
          <dt className="text-slate-600">{CUSTOMERS.unpaidBills}</dt>
          <dd>{customer.open_invoice_count}</dd>
          <dt className="text-slate-600">{CUSTOMERS.colOldest}</dt>
          <dd>{customer.oldest_due_date ?? '—'}</dd>
        </dl>

        {canRecordPayment && owes ? (
          <RecordPayment
            customerId={customer.customer.id}
            outstanding={customer.outstanding}
            onRecorded={onPaymentRecorded}
          />
        ) : null}

        <section>
          <h3 className="text-sm font-semibold text-slate-700">
            {CUSTOMERS.paymentHistory}
          </h3>
          {payments === null ? (
            <Busy label={COMMON.loading} />
          ) : payments.length === 0 ? (
            <p className="mt-1 text-sm">{CUSTOMERS.noPayments}</p>
          ) : (
            <table className="mt-2 w-full border-collapse text-sm">
              <caption className="sr-only">{CUSTOMERS.paymentHistory}</caption>
              <thead>
                <tr className="border-b border-slate-300 text-left">
                  <th scope="col" className="py-1">
                    {CUSTOMERS.colWhen}
                  </th>
                  <th scope="col" className="py-1">
                    {CUSTOMERS.colMethod}
                  </th>
                  <th scope="col" className="py-1 text-right">
                    {CUSTOMERS.colAmount}
                  </th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id} className="border-b border-slate-100">
                    <td className="py-1">
                      {new Date(payment.received_at).toLocaleString()}
                    </td>
                    <td className="py-1">
                      {payment.method}
                      {/* A reversal is a separate row; the original is never edited
                          (FR-PAY-005), so both show and the kind distinguishes them. */}
                      {payment.kind === 'reversal' ? ` (${payment.kind})` : ''}
                    </td>
                    <td className="py-1 text-right">
                      {formatForScreen(tryParseMoney(payment.amount) ?? ZERO)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </Dialog>
  );
}

// --- create and edit ----------------------------------------------------------

function CustomerForm({
  customer,
  onClose,
  onSaved,
}: {
  customer: CustomerRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(customer?.customer.name ?? '');
  const [phone, setPhone] = useState(customer?.customer.primary_phone ?? '');
  // Prefilled from the record being edited. These three used to start empty whatever
  // was being edited, because the only data the screen had came from
  // `/credit/customers`, which does not carry them — and `save()` sends
  // `businessName.trim() || null`. So changing a customer's phone silently wiped their
  // business name, credit limit and payment terms. The credit limit is what the credit
  // check reads, so that was a financial control being cleared by an unrelated edit.
  const [businessName, setBusinessName] = useState(
    customer?.customer.business_name ?? '',
  );
  const [creditLimit, setCreditLimit] = useState(customer?.customer.credit_limit ?? '');
  const [creditTerms, setCreditTerms] = useState(
    customer?.customer.credit_terms_days != null
      ? String(customer.customer.credit_terms_days)
      : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState(false);

  /**
   * Check for a duplicate as the phone is typed, and **warn without blocking**
   * (FR-CUST-004). The server surfaces candidates and never merges; two relatives
   * genuinely do share a phone, and refusing the save would make that unrecordable.
   */
  useEffect(() => {
    const digits = phone.replace(/\D+/g, '');
    if (digits.length < 10 || customer) {
      setDuplicate(false);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const found = await customersApi.search(digits, controller.signal);
        setDuplicate(found.items.length > 0);
      } catch {
        // A failed lookup must not stop someone adding a customer.
      }
    })();
    return () => controller.abort();
  }, [phone, customer]);

  async function save(): Promise<void> {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // **Client-generated id** on create, so a retry is an upsert rather than a second
      // customer (FR-CUST-003) — the same rule that lets a customer be created offline.
      const id = customer?.customer.id ?? uuidv7();
      await customersApi.upsert(id, {
        name: name.trim(),
        phone: phone.trim() || null,
        business_name: businessName.trim() || null,
        credit_limit: creditLimit.trim() || null,
        credit_terms_days: parseWholeDays(creditTerms),
      });
      onSaved();
    } catch (caught) {
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
    <Dialog
      open
      title={customer ? CUSTOMERS.detailTitle : CUSTOMERS.newCustomer}
      {...(busy ? {} : { onDismiss: onClose })}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            {COMMON.cancel}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!name.trim()}
            onClick={() => void save()}
          >
            {CUSTOMERS.saveCustomer}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label={CUSTOMERS.name}
          value={name}
          onChange={(event) => setName(event.target.value)}
          {...(name.trim() ? {} : { error: CUSTOMERS.needName })}
        />
        <Field
          label={CUSTOMERS.phone}
          value={phone}
          inputMode="tel"
          onChange={(event) => setPhone(event.target.value)}
        />
        <Field
          label={CUSTOMERS.businessName}
          value={businessName}
          onChange={(event) => setBusinessName(event.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field
            label={CUSTOMERS.creditLimit}
            value={creditLimit}
            inputMode="decimal"
            onChange={(event) => setCreditLimit(event.target.value)}
          />
          <Field
            label={CUSTOMERS.creditTerms}
            value={creditTerms}
            inputMode="numeric"
            onChange={(event) => setCreditTerms(event.target.value)}
          />
        </div>

        {/* A warning, not a block. */}
        {duplicate ? <Panel tone="warning">{CUSTOMERS.duplicateWarning}</Panel> : null}
        {error ? <Panel tone="danger">{error}</Panel> : null}
      </div>
    </Dialog>
  );
}

/**
 * Record a payment against what a customer owes.
 *
 * This is **not** the "mark as paid" control the module docstring rules out, and the
 * distinction is the whole design: nothing here sets a balance. It records a payment
 * event — amount, method, time — and the server allocates it across the open invoices
 * and recomputes `amount_paid` and `payment_status` from the allocation rows
 * (ADR-022, FR-CREDIT-003). The figure shown afterwards is refetched, never adjusted
 * locally.
 *
 * Why it exists: `credit.recordPayment` was present and correct in the API client and
 * had **no caller anywhere in the application**. Credit bills could be issued and no
 * payment could ever be entered against them, so an outstanding balance could only
 * grow. The same shape of defect as the customer picker — a capability wired to the
 * server with no way in from a screen.
 *
 * Two deliberate choices, both the documented server defaults rather than inventions:
 *
 * - **Oldest first.** `allocation.strategy` defaults to `oldest_first` server-side and
 *   that is what a shop does when someone pays something off an account. Per-invoice
 *   allocation is supported by the API (`invoice_specific`) and is not offered here,
 *   because choosing it needs an invoice picker and a reason to override the obvious —
 *   that is a decision for the owner, not a default to guess at.
 * - **Prefilled with the full outstanding amount**, because settling up is the common
 *   case and retyping a figure that is already on screen is how transposition errors
 *   happen. It stays editable for a part payment.
 *
 * The amount is sent as typed and validated by the server: it enforces the whole-rupee
 * rule from the money policy, rejects zero and negatives, and is the only authority on
 * what a valid amount is. The client does not pre-judge it beyond requiring something
 * parseable, so the rule can never drift between the two.
 */
function RecordPayment({
  customerId,
  outstanding,
  onRecorded,
}: {
  customerId: string;
  outstanding: string;
  onRecorded: () => void;
}) {
  const [amount, setAmount] = useState(outstanding);
  const [method, setMethod] = useState('cash');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const parsed = tryParseMoney(amount);
    if (!parsed || !parsed.greaterThan(0)) {
      setError(CUSTOMERS.paymentNeedsAmount);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await credit.recordPayment(
        {
          customer_id: customerId,
          amount: parsed.toFixed(2),
          method,
          // Oldest first, which is the server's own default and what a shop does.
          allocation: { strategy: 'oldest_first' },
          ...(reference.trim() ? { reference: reference.trim() } : {}),
        },
        // A client-generated key, so a double click or a retry on a dropped response
        // records one payment rather than two (FR-PAY-004).
        uuidv7(),
      );
      onRecorded();
    } catch (caught) {
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
    <section className="rounded border border-[#232852] bg-[#f3f4fb] p-3">
      <h3 className="text-sm font-semibold text-slate-700">{CUSTOMERS.recordPayment}</h3>
      <p className="mt-1 text-xs text-slate-600">{CUSTOMERS.recordPaymentHint}</p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Field
          label={CUSTOMERS.paymentAmount}
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          className="w-32"
        />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700">{CUSTOMERS.paymentMethod}</span>
          <select
            value={method}
            onChange={(event) => setMethod(event.target.value)}
            className="min-h-11 rounded border border-slate-300 px-2"
          >
            {/* The server's own `payment_method` enum. No instrument data is ever
                collected or stored — only a method and a free-text reference such as a
                UPI transaction id (`SECURITY.md §10.1`). */}
            <option value="cash">{CUSTOMERS.methodCash}</option>
            <option value="upi">{CUSTOMERS.methodUpi}</option>
            <option value="card">{CUSTOMERS.methodCard}</option>
            <option value="bank_transfer">{CUSTOMERS.methodBankTransfer}</option>
            <option value="cheque">{CUSTOMERS.methodCheque}</option>
          </select>
        </label>
        <Field
          label={CUSTOMERS.paymentReference}
          hint={CUSTOMERS.paymentReferenceHint}
          value={reference}
          onChange={(event) => setReference(event.target.value)}
          className="w-44"
        />
        <Button variant="primary" busy={busy} onClick={() => void submit()}>
          {CUSTOMERS.savePayment}
        </Button>
      </div>

      {error ? (
        <div className="mt-2">
          <Panel tone="danger">{error}</Panel>
        </div>
      ) : null}
    </section>
  );
}

/**
 * A whole number of days, or `null`.
 *
 * Not `Number(value)`: that returns `0` for an empty string, which would silently set
 * terms of zero days — "payment due immediately" — on every customer saved without
 * filling the field in. It also accepts `1e3` and `" 7 "`. An explicit digits-only
 * match is the only reading that cannot be wrong, and `src/lib/money.ts` is the single
 * place allowed to parse a number loosely (ADR-013), which the structural suite
 * enforces.
 */
function parseWholeDays(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,4}$/.test(trimmed)) return null;
  let total = 0;
  for (const character of trimmed) {
    total = total * 10 + (character.codePointAt(0)! - 48);
  }
  return total;
}

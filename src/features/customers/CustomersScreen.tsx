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
 * Everything editable is identity — name, phone, address, credit limit, terms.
 * Everything financial is read from `/credit/customers` and `/customers/{id}/ledger`
 * and rendered verbatim: the client sums nothing (FR-RPT-030).
 *
 * Duplicate handling follows FR-CUST-004: the server **surfaces candidates and never
 * merges**, so a suspected duplicate is shown as a warning beside a save that still
 * works. Blocking the save would strand a real second customer who shares a phone with
 * a relative.
 */

import { useCallback, useEffect, useState } from 'react';

import { credit, customers as customersApi } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import type { CreditCustomer, PaymentHistoryEntry } from '@/api/types';
import { Busy, Button, Dialog, Field, Panel } from '@/components/primitives';
import { uuidv7 } from '@/lib/ids';
import { formatForScreen, tryParseMoney, ZERO } from '@/lib/money';
import { COMMON, CUSTOMERS, ERRORS } from '@/lib/strings';

export interface CustomersScreenProps {
  /** `customers.write`. Without it the screen is read-only. */
  canEdit: boolean;
}

export function CustomersScreen({ canEdit }: CustomersScreenProps) {
  const [rows, setRows] = useState<CreditCustomer[] | null>(null);
  const [query, setQuery] = useState('');
  const [includeSettled, setIncludeSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CreditCustomer | 'new' | null>(null);
  const [viewing, setViewing] = useState<CreditCustomer | null>(null);

  const load = useCallback(async () => {
    setRows(null);
    setError(null);
    try {
      const response = await credit.customers({
        include_settled: includeSettled,
        ...(query.trim() ? { query: query.trim() } : {}),
      });
      setRows(response.items);
    } catch (caught) {
      setRows([]);
      setError(
        caught instanceof ApiError
          ? describeError(caught.code).message
          : ERRORS.unexpected,
      );
    }
  }, [includeSettled, query]);

  useEffect(() => {
    void load();
  }, [load]);

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
            variant={includeSettled ? 'primary' : 'secondary'}
            aria-pressed={includeSettled}
            onClick={() => setIncludeSettled((value) => !value)}
          >
            {CUSTOMERS.includeSettled}
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

      {rows === null ? (
        <Busy label={COMMON.loading} />
      ) : rows.length === 0 ? (
        <Panel tone="info">
          {query.trim() ? CUSTOMERS.emptyNoMatch : CUSTOMERS.empty}
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
            {rows.map((row) => (
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

      {viewing ? (
        <CustomerDetail customer={viewing} onClose={() => setViewing(null)} />
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
  onClose,
}: {
  customer: CreditCustomer;
  onClose: () => void;
}) {
  const [payments, setPayments] = useState<PaymentHistoryEntry[] | null>(null);

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
  customer: CreditCustomer | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(customer?.customer.name ?? '');
  const [phone, setPhone] = useState(customer?.customer.primary_phone ?? '');
  const [businessName, setBusinessName] = useState('');
  const [creditLimit, setCreditLimit] = useState('');
  const [creditTerms, setCreditTerms] = useState('');
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

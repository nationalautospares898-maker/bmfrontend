/**
 * Canceled Bills (owner request, 2026-11-10).
 *
 * Daily Bills and Credit Bills now exclude cancelled bills server-side (`GET
 * /invoices` defaults to `status != 'cancelled'`) so a cancelled sale never looks like
 * an active cash sale or an active outstanding debt. Nothing about cancellation itself
 * changed — this screen is the one place those rows are still visible, fetched with
 * `status=cancelled`, so the record is inspectable rather than gone.
 *
 * Reuses `FullBillView` for "view full bill", the same component Credit Bills uses, so
 * a cancelled bill's item lines, snapshots and totals are rendered identically to an
 * active one — just with its existing cancellation banner (it already renders one when
 * `invoice.status === 'cancelled'`).
 */

import { Fragment, useEffect, useState } from 'react';

import { invoices } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import type { Invoice, InvoiceSummary } from '@/api/types';
import { formatForScreen, parseMoney } from '@/lib/money';
import { CANCELED_BILLS, COMMON } from '@/lib/strings';
import { Busy, Button, Panel } from '@/components/primitives';
import { FullBillView } from './CreditInvoiceDetail';

function money(value: string | number): string {
  return formatForScreen(parseMoney(String(value)));
}

export function CanceledBills() {
  const [rows, setRows] = useState<InvoiceSummary[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, Invoice | 'loading' | undefined>>({});

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const list = await invoices.list({ status: 'cancelled', limit: 200 });
        if (cancelled) return;
        setRows(list.items);
      } catch (caught) {
        if (cancelled) return;
        setError(
          caught instanceof ApiError ? describeError(caught.code).message : COMMON.retry,
        );
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(id: string): Promise<void> {
    if (open[id]) {
      setOpen((prev) => ({ ...prev, [id]: undefined }));
      return;
    }
    setOpen((prev) => ({ ...prev, [id]: 'loading' }));
    try {
      const full = await invoices.get(id);
      setOpen((prev) => ({ ...prev, [id]: full }));
    } catch {
      setOpen((prev) => ({ ...prev, [id]: undefined }));
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end gap-3">
        <h1 className="text-xl font-semibold text-[#232852]">{CANCELED_BILLS.title}</h1>
      </header>

      <p className="text-sm text-slate-600">{CANCELED_BILLS.explanation}</p>

      {error ? <Panel tone="danger">{error}</Panel> : null}

      {busy ? (
        <Busy label={COMMON.loading} />
      ) : rows.length === 0 ? (
        <Panel tone="info">{CANCELED_BILLS.noRows}</Panel>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-300 text-left text-slate-500">
                <th className="px-2 py-2">{CANCELED_BILLS.colType}</th>
                <th className="px-2 py-2">{CANCELED_BILLS.colInvoice}</th>
                <th className="px-2 py-2">{CANCELED_BILLS.colCustomer}</th>
                <th className="px-2 py-2">{CANCELED_BILLS.colAmount}</th>
                <th className="px-2 py-2">{CANCELED_BILLS.colCancelledAt}</th>
                <th className="px-2 py-2">{CANCELED_BILLS.colReason}</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Fragment key={row.id}>
                  <tr className="border-b border-slate-100">
                    <td className="px-2 py-2">
                      {row.is_credit ? CANCELED_BILLS.typeCredit : CANCELED_BILLS.typeCash}
                    </td>
                    <td className="px-2 py-2">{row.internal_reference}</td>
                    <td className="px-2 py-2">{row.customer_name ?? ''}</td>
                    <td className="px-2 py-2">{money(row.total)}</td>
                    <td className="px-2 py-2">
                      {row.cancelled_at ? new Date(row.cancelled_at).toLocaleString() : ''}
                    </td>
                    <td className="px-2 py-2">{row.cancellation_reason ?? ''}</td>
                    <td className="px-2 py-2">
                      <Button variant="quiet" onClick={() => void toggle(row.id)}>
                        {open[row.id] ? CANCELED_BILLS.hide : CANCELED_BILLS.view}
                      </Button>
                    </td>
                  </tr>
                  {open[row.id] ? (
                    <tr>
                      <td colSpan={7} className="bg-slate-50 px-2 py-3">
                        {open[row.id] === 'loading' ? (
                          <Busy label={COMMON.loading} />
                        ) : (
                          <FullBillView invoice={open[row.id] as Invoice} />
                        )}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

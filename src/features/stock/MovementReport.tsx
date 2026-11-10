/**
 * The day's stock movement report.
 *
 * The Stock screen already answers "what happened to this part" — that is the per-product
 * History, and it is untouched. This answers the other question the owner asks at closing
 * time: **what moved today?** Both read the same append-only ledger through the same
 * module, so the two can never tell different stories about the same movement.
 *
 * ## Where the figures come from
 *
 * Every number on screen is the server's. `stock_before` and `stock_after` are the
 * ledger's own values — `balance_after` as it was written, and `balance_after -
 * quantity_delta` for the figure immediately before — so nothing here is reconstructed
 * from the current total, and this component computes no arithmetic of its own beyond
 * formatting. A report that quietly recalculated history would be worse than no report.
 *
 * ## Two things that are easy to get wrong and are handled deliberately
 *
 * * **The date is the shop's, not the browser's.** The day opens on the business date
 *   from `/sync/bootstrap` and is sent back as a plain `YYYY-MM-DD` for the server to
 *   resolve in the shop's timezone. The client never derives a business date from
 *   `new Date()` (FE-E-3) — a counter PC set to UTC would otherwise ask for yesterday
 *   for the first five and a half hours of every day.
 * * **A slow answer must not overwrite a newer question.** Changing the date twice
 *   quickly, or switching tab while a request is in flight, used to be the classic way to
 *   show the wrong day's figures under the right day's heading. Each request carries an
 *   `AbortSignal` and a sequence number, and a reply that is no longer the latest is
 *   discarded.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { inventory } from '@/api/endpoints';
import { describeError, ApiError } from '@/api/errors';
import type { MovementReport as Report, MovementReportLine } from '@/api/types';
import { Busy, Button, Field, Panel } from '@/components/primitives';
import { formatQuantity, parseMoney } from '@/lib/money';
import { COMMON, ERRORS, STOCK } from '@/lib/strings';

export interface MovementReportProps {
  /** Today, in the **business's** timezone, from the server. Never `new Date()`. */
  businessDate: string;
  onClose: () => void;
}

type Kind = 'added' | 'sold' | 'adjusted';

/** `2026-11-02T09:10:00Z` → the time of day, in the reader's own locale. */
function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

export function MovementReport({ businessDate, onClose }: MovementReportProps) {
  const [date, setDate] = useState(businessDate);
  /**
   * The Stock Report's date range (owner request): both ends default to the same
   * business date, so a single-day report — this component's original shape — is just
   * the range where they happen to coincide. Each field clamps the other rather than
   * letting an invalid range (`end < start`) ever reach the server, which would 422.
   */
  const [endDate, setEndDate] = useState(businessDate);
  const [kind, setKind] = useState<Kind>('added');
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * The request currently worth listening to.
   *
   * A sequence number *and* an abort: the abort stops the work, the sequence stops a
   * reply that was already in flight from landing after a newer one. Either alone leaves
   * a window where the wrong day's figures appear under the right day's heading.
   */
  const latest = useRef(0);
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(async (on: string, end: string, which: Kind) => {
    const sequence = latest.current + 1;
    latest.current = sequence;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    setBusy(true);
    setError(null);
    try {
      const result = await inventory.movementReport(
        { on_date: on, end_date: end, kind: which },
        controller.signal,
      );
      if (sequence !== latest.current) return; // a newer question is already out
      setReport(result);
    } catch (caught) {
      if (sequence !== latest.current) return;
      // An abort is this component's own doing, not something to report to the owner.
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setReport(null);
      setError(
        caught instanceof ApiError
          ? describeError(caught.code).message
          : ERRORS.unexpected,
      );
    } finally {
      if (sequence === latest.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(date, endDate, kind);
  }, [date, endDate, kind, load]);

  useEffect(() => () => inFlight.current?.abort(), []);

  const added = kind === 'added';
  const sold = kind === 'sold';
  const adjusted = kind === 'adjusted';
  // `added` and `adjusted` both carry a meaningful "what kind of movement" per row;
  // `sold` already has its own Sale Type column instead.
  const showMovementCol = !sold;
  const lines: readonly MovementReportLine[] = report?.items ?? [];

  return (
    <section
      className="flex flex-col gap-3 rounded border border-nas-navy p-3"
      aria-label={STOCK.reportTitle}
    >
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h3 className="text-base font-semibold text-[#232852]">{STOCK.reportTitle}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label={STOCK.reportDateLabel}
            type="date"
            value={date}
            onChange={(event) => {
              const next = event.target.value;
              setDate(next);
              // Keep the range valid rather than letting the server reject it: widening
              // the start past the current end carries the end along with it.
              if (next > endDate) setEndDate(next);
            }}
            className="w-44"
          />
          <Field
            label={STOCK.reportEndDateLabel}
            type="date"
            value={endDate}
            min={date}
            onChange={(event) => {
              const next = event.target.value;
              // `next === ''` mid-edit (e.g. right after a clear, before typing the
              // replacement) must pass through rather than being clamped: an empty
              // string sorts before every real date, so the naive comparison would
              // snap a cleared field straight back to the start date and corrupt
              // whatever gets typed next.
              setEndDate(next !== '' && next < date ? date : next);
            }}
            className="w-44"
          />
          {/* Three views of one period. `aria-pressed` rather than a tablist: these are
              toggles that reload a table, and the ARIA tab pattern would promise
              arrow-key navigation between panels that does not exist here. */}
          <Button
            variant={added ? 'primary' : 'secondary'}
            aria-pressed={added}
            onClick={() => setKind('added')}
          >
            {STOCK.reportAdded}
          </Button>
          <Button
            variant={sold ? 'primary' : 'secondary'}
            aria-pressed={sold}
            onClick={() => setKind('sold')}
          >
            {STOCK.reportSold}
          </Button>
          <Button
            variant={adjusted ? 'primary' : 'secondary'}
            aria-pressed={adjusted}
            onClick={() => setKind('adjusted')}
          >
            {STOCK.reportAdjusted}
          </Button>
          <Button onClick={() => void load(date, endDate, kind)}>
            {STOCK.reportRefresh}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            {STOCK.reportClose}
          </Button>
        </div>
      </header>

      {error ? <Panel tone="danger">{error}</Panel> : null}

      {/* The totals the owner reads first. Rendered from the server's own counts rather
          than from the rows on screen, so a capped list cannot make them disagree. */}
      {report && !error ? (
        <dl className="flex flex-wrap gap-6 text-sm">
          <Summary label={STOCK.reportSummaryProducts} value={String(report.products)} />
          <Summary
            label={
              added
                ? STOCK.reportSummaryQuantityAdded
                : sold
                  ? STOCK.reportSummaryQuantitySold
                  : STOCK.reportSummaryQuantityAdjusted
            }
            value={formatQuantity(parseMoney(report.total_quantity))}
          />
          <Summary
            label={STOCK.reportSummaryMovements}
            value={String(report.movements)}
          />
          {sold ? (
            <Summary
              label={STOCK.reportSummaryInvoices}
              value={String(report.invoices)}
            />
          ) : null}
        </dl>
      ) : null}

      {report?.truncated ? <Panel tone="warning">{STOCK.reportTruncated}</Panel> : null}

      {busy ? (
        <Busy label={COMMON.loading} />
      ) : error ? null : lines.length === 0 ? (
        <Panel tone="info">
          {added
            ? STOCK.reportEmptyAdded
            : sold
              ? STOCK.reportEmptySold
              : STOCK.reportEmptyAdjusted}
        </Panel>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              {added
                ? STOCK.reportTableAdded
                : sold
                  ? STOCK.reportTableSold
                  : STOCK.reportTableAdjusted}
            </caption>
            <thead>
              <tr className="border-b border-nas-navy text-left">
                <th scope="col" className="px-2 py-1">
                  {STOCK.reportColProduct}
                </th>
                <th scope="col" className="px-2 py-1">
                  {STOCK.reportColCode}
                </th>
                <th scope="col" className="px-2 py-1 text-right">
                  {added
                    ? STOCK.reportColQtyAdded
                    : sold
                      ? STOCK.reportColQtySold
                      : STOCK.reportColQtyAdjusted}
                </th>
                <th scope="col" className="px-2 py-1 text-right">
                  {STOCK.reportColBefore}
                </th>
                <th scope="col" className="px-2 py-1 text-right">
                  {STOCK.reportColAfter}
                </th>
                {showMovementCol ? (
                  <th scope="col" className="px-2 py-1">
                    {STOCK.reportColMovement}
                  </th>
                ) : null}
                {adjusted ? (
                  <th scope="col" className="px-2 py-1">
                    {STOCK.reportColSource}
                  </th>
                ) : null}
                <th scope="col" className="px-2 py-1">
                  {sold ? STOCK.reportColInvoice : STOCK.reportColReference}
                </th>
                {sold ? (
                  <th scope="col" className="px-2 py-1">
                    {STOCK.reportColSaleType}
                  </th>
                ) : null}
                <th scope="col" className="px-2 py-1">
                  {STOCK.reportColTime}
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.movement_id} className="border-b border-slate-200">
                  <th scope="row" className="px-2 py-1 text-left font-normal">
                    {line.product_name}
                  </th>
                  <td className="px-2 py-1">{line.sku ?? STOCK.noReference}</td>
                  <td className="px-2 py-1 text-right font-medium tabular-nums">
                    {formatQuantity(parseMoney(line.quantity))}
                  </td>
                  {/* Both from the ledger. Neither is worked out on this machine. */}
                  <td className="px-2 py-1 text-right tabular-nums">
                    {formatQuantity(parseMoney(line.stock_before))}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {formatQuantity(parseMoney(line.stock_after))}
                  </td>
                  {showMovementCol ? (
                    <td className="px-2 py-1">{STOCK.reportReason(line.reason)}</td>
                  ) : null}
                  {adjusted ? (
                    <td className="px-2 py-1">
                      {STOCK.reportSource(line.source_type ?? null)}
                    </td>
                  ) : null}
                  <td className="px-2 py-1">
                    {line.reference ?? STOCK.noReference}
                    {/* A bill cancelled afterwards: the deduction stands on the day it
                        happened, and its reversal appears under Stock Added on the day it
                        was cancelled. Saying so beats leaving the owner to wonder why
                        stock came back. */}
                    {line.invoice_cancelled ? (
                      <span className="ml-2 rounded bg-amber-100 px-1 text-xs text-amber-900">
                        {STOCK.reportCancelled}
                      </span>
                    ) : null}
                  </td>
                  {sold ? (
                    <td className="px-2 py-1">
                      {line.is_credit === null
                        ? STOCK.noReference
                        : line.is_credit
                          ? STOCK.reportCredit
                          : STOCK.reportCash}
                    </td>
                  ) : null}
                  <td className="px-2 py-1 tabular-nums">{timeOf(line.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-slate-600">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-[#232852]">{value}</dd>
    </div>
  );
}

/**
 * Physical stock count (Feature A.6).
 *
 * The workflow the backend enforces (`domain/inventory/stock_count.py`), surfaced
 * plainly: start a count, record what is actually on the shelf for as many products
 * as you get to, review every discrepancy against the **current** system figure
 * (never a stale one), and only an explicit Finalize writes anything to the ledger.
 * Cancelling at any point before that applies nothing.
 */

import { useEffect, useMemo, useState } from 'react';

import { inventory } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import type { StockCountItem, StockCountSession } from '@/api/types';
import { Busy, Button, Dialog, Field, Panel } from '@/components/primitives';
import { formatQuantity, parseMoney, tryParseMoney } from '@/lib/money';
import { normalizeName, normalizeSku } from '@/lib/normalize';
import { COMMON, STOCK_COUNT } from '@/lib/strings';

export interface StockCountScreenProps {
  open: boolean;
  onClose: () => void;
  /** Reload the Stock list after a finalize changes balances. */
  onFinalized: () => void;
}

export function StockCountScreen({ open, onClose, onFinalized }: StockCountScreenProps) {
  const [session, setSession] = useState<StockCountSession | null>(null);
  const [items, setItems] = useState<StockCountItem[] | null>(null);
  const [filter, setFilter] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'finalize' | 'cancel' | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    setError(null);
    try {
      const existing = (await inventory.listStockCounts()).items.find(
        (s) => s.status === 'open',
      );
      const current = existing ?? (await inventory.startStockCount());
      setSession(current);
      const review = await inventory.reviewStockCount(current.id);
      setItems(review.items);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? describeError(caught.code).message : COMMON.retry,
      );
    }
  }

  useEffect(() => {
    if (open) {
      setSession(null);
      setItems(null);
      setDrafts({});
      setFilter('');
      void load();
    }
  }, [open]);

  async function saveCount(productId: string): Promise<void> {
    if (!session) return;
    const raw = drafts[productId];
    const parsed = raw === undefined ? null : tryParseMoney(raw);
    if (parsed === null || parsed.isNegative()) return;
    setSavingId(productId);
    setError(null);
    try {
      await inventory.recordStockCountItem(session.id, productId, parsed.toString());
      const review = await inventory.reviewStockCount(session.id);
      setItems(review.items);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? describeError(caught.code).message : COMMON.retry,
      );
    } finally {
      setSavingId(null);
    }
  }

  async function finalize(): Promise<void> {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await inventory.finalizeStockCount(session.id);
      setConfirming(null);
      onFinalized();
      onClose();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? describeError(caught.code).message : COMMON.retry,
      );
    } finally {
      setBusy(false);
    }
  }

  async function cancelCount(): Promise<void> {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await inventory.cancelStockCount(session.id);
      setConfirming(null);
      onClose();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? describeError(caught.code).message : COMMON.retry,
      );
    } finally {
      setBusy(false);
    }
  }

  const counted = items?.filter((i) => i.counted_quantity !== null).length ?? 0;
  const discrepancies =
    items?.filter((i) => i.discrepancy !== null && i.discrepancy !== '0.000').length ?? 0;

  /**
   * Find-an-item search (owner request), scoped to **display only**: `counted`,
   * `discrepancies`, and every save/finalize/cancel action above keep reading from the
   * full `items` array, never from this filtered view — so searching cannot hide an
   * already-counted row from the finalize count, and cannot cause a product to be
   * counted twice. Same normalisation as the Stock screen's own filter, so the owner
   * does not have to learn a second search behaviour.
   */
  const visible = useMemo(() => {
    if (!items) return null;
    const sku = normalizeSku(filter);
    const name = normalizeName(filter);
    if (!sku && !name) return items;
    return items.filter(
      (item) =>
        normalizeName(item.name).includes(name) ||
        (item.sku ? normalizeSku(item.sku).includes(sku) : false),
    );
  }, [items, filter]);

  return (
    <Dialog
      open={open}
      title={STOCK_COUNT.title}
      onDismiss={onClose}
      actions={
        confirming ? null : (
          <>
            <Button onClick={onClose}>{COMMON.close}</Button>
            <Button
              variant="quiet"
              onClick={() => setConfirming('cancel')}
              disabled={!session}
            >
              {STOCK_COUNT.cancelCount}
            </Button>
            <Button
              variant="primary"
              disabled={!session || counted === 0}
              onClick={() => setConfirming('finalize')}
            >
              {STOCK_COUNT.finalize}
            </Button>
          </>
        )
      }
    >
      <p className="mb-2 text-sm text-slate-600">{STOCK_COUNT.explanation}</p>
      {error ? <Panel tone="danger">{error}</Panel> : null}

      {confirming === 'finalize' ? (
        <Panel tone="warning" title={STOCK_COUNT.confirmFinalizeTitle}>
          <p className="mb-2">
            {STOCK_COUNT.confirmFinalizeBody(counted, discrepancies)}
          </p>
          <div className="flex gap-2">
            <Button variant="primary" busy={busy} onClick={() => void finalize()}>
              {STOCK_COUNT.confirmFinalizeAction}
            </Button>
            <Button onClick={() => setConfirming(null)}>{COMMON.cancel}</Button>
          </div>
        </Panel>
      ) : confirming === 'cancel' ? (
        <Panel tone="warning" title={STOCK_COUNT.confirmCancelTitle}>
          <p className="mb-2">{STOCK_COUNT.confirmCancelBody}</p>
          <div className="flex gap-2">
            <Button variant="danger" busy={busy} onClick={() => void cancelCount()}>
              {STOCK_COUNT.confirmCancelAction}
            </Button>
            <Button onClick={() => setConfirming(null)}>{COMMON.cancel}</Button>
          </div>
        </Panel>
      ) : items === null || visible === null ? (
        <Busy label={COMMON.loading} />
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
            <p className="text-sm text-slate-600">
              {STOCK_COUNT.progress(counted, items.length)}
            </p>
            <Field
              label={STOCK_COUNT.filterLabel}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              hint={STOCK_COUNT.filterHint}
              className="w-56"
            />
          </div>
          {visible.length === 0 ? (
            <p className="py-4 text-sm text-slate-500">{STOCK_COUNT.noMatches}</p>
          ) : (
            <div className="max-h-[50vh] overflow-y-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="sticky top-0 border-b border-slate-300 bg-white text-left">
                    <th className="py-1">{STOCK_COUNT.colItem}</th>
                    <th className="py-1 text-right">{STOCK_COUNT.colSystem}</th>
                    <th className="py-1 text-right">{STOCK_COUNT.colCounted}</th>
                    <th className="py-1 text-right">{STOCK_COUNT.colDiscrepancy}</th>
                    <th className="py-1" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((item) => {
                    const draft = drafts[item.product_id] ?? item.counted_quantity ?? '';
                    const discrepancy =
                      item.discrepancy !== null ? parseMoney(item.discrepancy) : null;
                    return (
                      <tr key={item.product_id} className="border-b border-slate-100">
                        <td className="py-1">
                          {item.name}
                          {item.sku ? (
                            <span className="ml-2 text-xs text-slate-500">
                              {item.sku}
                            </span>
                          ) : null}
                        </td>
                        <td className="py-1 text-right tabular-nums text-slate-600">
                          {formatQuantity(parseMoney(item.system_quantity))}
                        </td>
                        <td className="py-1 text-right">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={draft}
                            aria-label={STOCK_COUNT.countedLabel(item.name)}
                            onChange={(e) =>
                              setDrafts((prev) => ({
                                ...prev,
                                [item.product_id]: e.target.value,
                              }))
                            }
                            className="w-24 rounded border border-slate-300 px-2 py-1 text-right"
                          />
                        </td>
                        <td className="py-1 text-right tabular-nums">
                          {discrepancy === null ? (
                            <span className="text-slate-400">
                              {STOCK_COUNT.notCounted}
                            </span>
                          ) : discrepancy.isZero() ? (
                            <span className="text-emerald-700">0</span>
                          ) : (
                            <span
                              className={
                                discrepancy.isNegative()
                                  ? 'text-red-700'
                                  : 'text-amber-700'
                              }
                            >
                              {discrepancy.isNegative() ? '' : '+'}
                              {formatQuantity(discrepancy)}
                            </span>
                          )}
                        </td>
                        <td className="py-1">
                          <Button
                            variant="quiet"
                            busy={savingId === item.product_id}
                            disabled={
                              tryParseMoney(draft) === null ||
                              draft === (item.counted_quantity ?? '')
                            }
                            onClick={() => void saveCount(item.product_id)}
                          >
                            {STOCK_COUNT.save}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}

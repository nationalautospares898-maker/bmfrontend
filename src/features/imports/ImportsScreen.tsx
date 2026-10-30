/**
 * Imports (M25, the user interface over M23).
 *
 * Four acts, four states on screen: upload, wait while it is read, rule on the rows the
 * software could not resolve, apply. The screen never collapses them, because the whole
 * point of FR-IMP-007 is that **nothing is created or received from a guess**.
 *
 * So:
 *
 * - **The apply button is disabled while any row is pending**, and the reason is stated
 *   as a count beside it rather than left to be inferred from a greyed-out control.
 * - **The intent is chosen, never inferred** (FR-IMP-002), and the screen says what each
 *   choice will do to stock *before* a file is picked.
 * - **A duplicate file is a question, not a failure.** The server returns `409` with the
 *   existing job; the screen offers to upload it again and asks why, because FR-IMP-004
 *   requires a reason and an audit entry.
 * - **The report shows the skipped rows.** "47 applied" on its own hides exactly what
 *   the reader needs to check.
 *
 * Polling, and why it is polling: parsing happens in a worker, so the client has to find
 * out when it finished. A 1.5 s poll while a job is in a transient state, stopping the
 * moment it settles, is honest and costs almost nothing. A websocket for one screen that
 * one person opens occasionally would be more machinery than the problem deserves.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { imports, purchases } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import type { ImportJob, ImportRow, Supplier } from '@/api/types';
import { Busy, Button, Dialog, Field, Panel } from '@/components/primitives';
import { uuidv7 } from '@/lib/ids';
import { COMMON, ERRORS, IMPORTS } from '@/lib/strings';

const STATUS_LABELS: Record<string, string> = {
  uploaded: IMPORTS.statusUploaded,
  parsing: IMPORTS.statusParsing,
  parsed: IMPORTS.statusParsed,
  needs_review: IMPORTS.statusNeedsReview,
  applying: IMPORTS.statusApplying,
  applied: IMPORTS.statusApplied,
  failed: IMPORTS.statusFailed,
  cancelled: IMPORTS.statusCancelled,
};

const MATCH_LABELS: Record<string, string> = {
  exact_sku: IMPORTS.matchExactSku,
  exact_alias: IMPORTS.matchExactAlias,
  fuzzy_candidate: IMPORTS.matchFuzzy,
  ambiguous: IMPORTS.matchAmbiguous,
  new_product: IMPORTS.matchNewProduct,
  duplicate_in_file: IMPORTS.matchDuplicate,
  invalid: IMPORTS.matchInvalid,
};

const DECISION_LABELS: Record<string, string> = {
  pending: IMPORTS.decisionPending,
  accept_match: IMPORTS.decisionAccept,
  create_new: IMPORTS.decisionCreate,
  skip: IMPORTS.decisionSkip,
};

const INTENT_LABELS: Record<string, string> = {
  price_list: IMPORTS.intentPriceList,
  purchase_receipt: IMPORTS.intentReceipt,
};

/** States the server is still working through, so the screen keeps asking. */
const TRANSIENT = new Set(['uploaded', 'parsing', 'applying']);

const POLL_MS = 1500;

export function ImportsScreen() {
  const [jobs, setJobs] = useState<ImportJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [openJobId, setOpenJobId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setJobs((await imports.list()).jobs);
    } catch (caught) {
      setJobs([]);
      setError(
        caught instanceof ApiError
          ? describeError(caught.code).message
          : ERRORS.unexpected,
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep asking only while something is actually in flight.
  const anyTransient = (jobs ?? []).some((job) => TRANSIENT.has(job.status));
  useEffect(() => {
    if (!anyTransient) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [anyTransient, load]);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-[#232852]">{IMPORTS.title}</h2>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => setUploading(true)}>
            {IMPORTS.upload}
          </Button>
          <Button onClick={() => void load()}>{COMMON.refresh}</Button>
        </div>
      </header>

      {error ? <Panel tone="danger">{error}</Panel> : null}

      {jobs === null ? (
        <Busy label={COMMON.loading} />
      ) : jobs.length === 0 ? (
        <Panel tone="info">{IMPORTS.empty}</Panel>
      ) : (
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{IMPORTS.historyCaption}</caption>
          <thead>
            <tr className="border-b border-slate-300 text-left">
              <th scope="col" className="py-2">
                {IMPORTS.colFile}
              </th>
              <th scope="col" className="py-2">
                {IMPORTS.colWhat}
              </th>
              <th scope="col" className="py-2">
                {IMPORTS.colStatus}
              </th>
              <th scope="col" className="py-2 text-right">
                {IMPORTS.colRows}
              </th>
              <th scope="col" className="py-2">
                {IMPORTS.colWhen}
              </th>
              <th scope="col" className="py-2">
                {COMMON.actions}
              </th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id} className="border-b border-slate-100">
                <td className="py-2">{job.original_filename}</td>
                <td className="py-2">{INTENT_LABELS[job.intent] ?? job.intent}</td>
                <td className="py-2">
                  {STATUS_LABELS[job.status] ?? job.status}
                  {job.rows_pending_decision > 0 ? (
                    <span className="ml-2 rounded bg-amber-100 px-1 text-xs text-amber-900">
                      {job.rows_pending_decision}
                    </span>
                  ) : null}
                </td>
                <td className="py-2 text-right">{job.row_count}</td>
                <td className="py-2">{new Date(job.created_at).toLocaleString()}</td>
                <td className="py-2">
                  <Button variant="quiet" onClick={() => setOpenJobId(job.id)}>
                    {IMPORTS.open}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {uploading ? (
        <UploadDialog
          onClose={() => setUploading(false)}
          onUploaded={(jobId) => {
            setUploading(false);
            setOpenJobId(jobId);
            void load();
          }}
        />
      ) : null}

      {openJobId ? (
        <ReviewDialog
          jobId={openJobId}
          onClose={() => {
            setOpenJobId(null);
            void load();
          }}
        />
      ) : null}
    </section>
  );
}

// --- upload -------------------------------------------------------------------

function UploadDialog({
  onClose,
  onUploaded,
}: {
  onClose: () => void;
  onUploaded: (jobId: string) => void;
}) {
  const [intent, setIntent] = useState<'price_list' | 'purchase_receipt'>('price_list');
  const [supplierId, setSupplierId] = useState('');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateReason, setDuplicateReason] = useState('');
  const [duplicateFound, setDuplicateFound] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (intent !== 'purchase_receipt') return;
    void (async () => {
      try {
        setSuppliers((await purchases.suppliers()).items);
      } catch {
        setSuppliers([]);
      }
    })();
  }, [intent]);

  const problem = !file
    ? IMPORTS.needFile
    : intent === 'purchase_receipt' && !supplierId
      ? IMPORTS.needSupplier
      : null;

  async function submit(allowDuplicate: boolean): Promise<void> {
    if (!file || problem) return;
    setBusy(true);
    setError(null);
    try {
      const result = await imports.upload(file, {
        intent,
        ...(supplierId ? { supplierId } : {}),
        ...(allowDuplicate
          ? { allowDuplicate: true, duplicateReason: duplicateReason.trim() }
          : {}),
      });
      onUploaded(result.job_id);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'DUPLICATE_FILE') {
        // FR-IMP-004: a question, not a failure. The existing job is already there, and
        // proceeding needs an explicit flag and a reason.
        setDuplicateFound(true);
      } else {
        setError(
          caught instanceof ApiError
            ? describeError(caught.code).message
            : ERRORS.unexpected,
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={IMPORTS.upload}
      {...(busy ? {} : { onDismiss: onClose })}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            {COMMON.cancel}
          </Button>
          {duplicateFound ? (
            <Button
              variant="primary"
              busy={busy}
              disabled={duplicateReason.trim().length < 3}
              onClick={() => void submit(true)}
            >
              {IMPORTS.uploadAnyway}
            </Button>
          ) : (
            <Button
              variant="primary"
              busy={busy}
              disabled={problem !== null}
              onClick={() => void submit(false)}
            >
              {IMPORTS.startUpload}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium text-slate-700">{IMPORTS.intent}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="import-intent"
              checked={intent === 'price_list'}
              onChange={() => setIntent('price_list')}
              className="h-4 w-4"
            />
            {IMPORTS.intentPriceList}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="import-intent"
              checked={intent === 'purchase_receipt'}
              onChange={() => setIntent('purchase_receipt')}
              className="h-4 w-4"
            />
            {IMPORTS.intentReceipt}
          </label>
          {/* Said before a file is chosen, not after it is applied. */}
          <p className="text-xs text-slate-500">{IMPORTS.intentExplainer}</p>
        </fieldset>

        {intent === 'purchase_receipt' ? (
          <div className="flex flex-col gap-1">
            <label
              htmlFor="import-supplier"
              className="text-sm font-medium text-slate-700"
            >
              {IMPORTS.needSupplier}
            </label>
            <select
              id="import-supplier"
              value={supplierId}
              onChange={(event) => setSupplierId(event.target.value)}
              className="min-h-11 rounded border border-slate-300 px-3 text-base"
            >
              <option value="">—</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="flex flex-col gap-1">
          <label htmlFor="import-file" className="text-sm font-medium text-slate-700">
            {IMPORTS.chooseFile}
          </label>
          <input
            id="import-file"
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.pdf"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="min-h-11 rounded border border-slate-300 px-3 py-2 text-base"
          />
          <p className="text-xs text-slate-500">{IMPORTS.fileHint}</p>
        </div>

        {duplicateFound ? (
          <>
            <Panel tone="warning">{IMPORTS.duplicateFile}</Panel>
            <Field
              label={IMPORTS.duplicateReason}
              value={duplicateReason}
              onChange={(event) => setDuplicateReason(event.target.value)}
            />
          </>
        ) : null}

        {problem && !duplicateFound ? <Panel tone="info">{problem}</Panel> : null}
        {error ? <Panel tone="danger">{error}</Panel> : null}
      </div>
    </Dialog>
  );
}

// --- review and apply ---------------------------------------------------------

function ReviewDialog({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const [job, setJob] = useState<ImportJob | null>(null);
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [fetchedJob, fetchedRows] = await Promise.all([
        imports.get(jobId),
        imports.rows(jobId, { limit: 200 }),
      ]);
      setJob(fetchedJob);
      setRows(fetchedRows.rows);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? describeError(caught.code).message
          : ERRORS.unexpected,
      );
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!job || !TRANSIENT.has(job.status)) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [job, load]);

  async function run(work: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
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

  const pending = job?.rows_pending_decision ?? 0;
  const appliable =
    job !== null && (job.status === 'parsed' || job.status === 'needs_review');

  return (
    <Dialog
      open
      title={`${IMPORTS.reviewTitle} — ${job?.original_filename ?? ''}`}
      {...(busy ? {} : { onDismiss: onClose })}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            {COMMON.close}
          </Button>
          {appliable ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void run(() => imports.cancel(jobId))}
            >
              {IMPORTS.cancelImport}
            </Button>
          ) : null}
          {appliable ? (
            <Button
              variant="primary"
              busy={busy}
              // FR-IMP-007 made visible: disabled while anything is undecided, with the
              // count shown below so the reason is never a mystery.
              disabled={pending > 0}
              onClick={() => setConfirming(true)}
            >
              {IMPORTS.apply}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {job ? (
          <p className="text-sm">
            {STATUS_LABELS[job.status] ?? job.status}
            {job.status === 'applied'
              ? ` — ${IMPORTS.applied(job.rows_applied, job.rows_skipped)}`
              : ''}
          </p>
        ) : null}

        {job?.error_summary ? <Panel tone="warning">{job.error_summary}</Panel> : null}
        {pending > 0 ? (
          <Panel tone="warning">{IMPORTS.pendingExplainer(pending)}</Panel>
        ) : null}
        {error ? <Panel tone="danger">{error}</Panel> : null}
        {notice ? <Panel tone="success">{notice}</Panel> : null}

        {appliable && pending > 0 ? (
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() =>
                void run(() =>
                  imports.decideAll(jobId, {
                    match_status: 'new_product',
                    decision: 'create_new',
                  }),
                )
              }
            >
              {IMPORTS.decideAllNew}
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(() =>
                  imports.decideAll(jobId, {
                    match_status: 'new_product',
                    decision: 'skip',
                  }),
                )
              }
            >
              {IMPORTS.decideAllSkipNew}
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(() =>
                  imports.decideAll(jobId, {
                    match_status: 'invalid',
                    decision: 'skip',
                  }),
                )
              }
            >
              {IMPORTS.decideAllSkipInvalid}
            </Button>
          </div>
        ) : null}

        {rows === null ? (
          <Busy label={COMMON.loading} />
        ) : rows.length === 0 ? (
          <p className="text-sm">{COMMON.emptyList}</p>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">{IMPORTS.reviewCaption}</caption>
              <thead className="sticky top-0 bg-white">
                <tr className="border-b border-slate-300 text-left">
                  <th scope="col" className="py-1">
                    {IMPORTS.colRow}
                  </th>
                  <th scope="col" className="py-1">
                    {IMPORTS.colFromFile}
                  </th>
                  <th scope="col" className="py-1">
                    {IMPORTS.colMatched}
                  </th>
                  <th scope="col" className="py-1 text-right">
                    {IMPORTS.colQuantity}
                  </th>
                  <th scope="col" className="py-1 text-right">
                    {IMPORTS.colPrice}
                  </th>
                  <th scope="col" className="py-1">
                    {IMPORTS.colDecision}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className={
                      row.needs_decision
                        ? 'border-b border-amber-200 bg-amber-50'
                        : 'border-b border-slate-100'
                    }
                  >
                    <td className="py-1">{row.row_index}</td>
                    <td className="py-1">
                      <div>{row.parsed_name ?? '—'}</div>
                      {row.parsed_sku ? (
                        <div className="text-xs text-slate-500">{row.parsed_sku}</div>
                      ) : null}
                    </td>
                    <td className="py-1">
                      <div>{row.matched_product_name ?? '—'}</div>
                      <div className="text-xs text-slate-500">
                        {MATCH_LABELS[row.match_status] ?? row.match_status}
                      </div>
                      {/* The matcher's own reason, shown verbatim. */}
                      {row.apply_error ? (
                        <div className="text-xs text-amber-800">{row.apply_error}</div>
                      ) : null}
                    </td>
                    <td className="py-1 text-right">{row.parsed_quantity ?? '—'}</td>
                    <td className="py-1 text-right">
                      {row.parsed_selling_price ?? row.parsed_unit_cost ?? '—'}
                    </td>
                    <td className="py-1">
                      {job?.status === 'applied' ? (
                        <span>{DECISION_LABELS[row.decision] ?? row.decision}</span>
                      ) : (
                        <RowDecision
                          row={row}
                          disabled={busy}
                          onDecide={(decision) =>
                            void run(async () => {
                              await imports.decide(jobId, row.id, { decision });
                              setNotice(null);
                            })
                          }
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {confirming && job ? (
        <Dialog
          open
          title={IMPORTS.applyTitle}
          onDismiss={() => setConfirming(false)}
          actions={
            <>
              <Button onClick={() => setConfirming(false)}>{COMMON.cancel}</Button>
              <Button
                variant="primary"
                busy={busy}
                onClick={() => {
                  setConfirming(false);
                  void run(async () => {
                    const applied = await imports.apply(jobId, uuidv7());
                    setNotice(
                      IMPORTS.applied(applied.rows_applied, applied.rows_skipped),
                    );
                  });
                }}
              >
                {IMPORTS.apply}
              </Button>
            </>
          }
        >
          {/* Different text per intent, because the consequences genuinely differ. */}
          <p>
            {job.intent === 'price_list'
              ? IMPORTS.applyBodyPriceList
              : IMPORTS.applyBodyReceipt}
          </p>
        </Dialog>
      ) : null}
    </Dialog>
  );
}

function RowDecision({
  row,
  disabled,
  onDecide,
}: {
  row: ImportRow;
  disabled: boolean;
  onDecide: (decision: 'accept_match' | 'create_new' | 'skip') => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {/* "Use the match" only where there is one to use. */}
      {row.matched_product_id ? (
        <Button
          variant={row.decision === 'accept_match' ? 'primary' : 'quiet'}
          disabled={disabled}
          onClick={() => onDecide('accept_match')}
        >
          {IMPORTS.decisionAccept}
        </Button>
      ) : null}
      {/* Never offered for a row that could not be read — there is nothing to create. */}
      {row.match_status !== 'invalid' && row.parsed_name ? (
        <Button
          variant={row.decision === 'create_new' ? 'primary' : 'quiet'}
          disabled={disabled}
          onClick={() => onDecide('create_new')}
        >
          {IMPORTS.decisionCreate}
        </Button>
      ) : null}
      <Button
        variant={row.decision === 'skip' ? 'primary' : 'quiet'}
        disabled={disabled}
        onClick={() => onDecide('skip')}
      >
        {IMPORTS.decisionSkip}
      </Button>
    </div>
  );
}

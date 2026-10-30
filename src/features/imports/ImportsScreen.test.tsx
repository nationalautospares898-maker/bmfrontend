/**
 * The Imports screen, rendered.
 *
 * The rule under test everywhere here is FR-IMP-007: **nothing is created or received
 * from a guess.** On screen that means the apply button is unreachable while any row is
 * undecided, and the count is stated rather than left to be inferred from a greyed-out
 * control.
 *
 * The others:
 *
 * - the intent is **chosen**, and what it will do to stock is said before a file is
 *   picked (FR-IMP-002);
 * - a duplicate file is a **question with a reason attached**, not a dead end
 *   (FR-IMP-004);
 * - "Add as a new item" is never offered for a row that could not be read — there is
 *   nothing to create from it;
 * - the apply confirmation says something **different** for a price list than for a
 *   supplier bill, because the consequences differ.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/errors';
import { ImportsScreen } from './ImportsScreen';

const list = vi.fn();
const get = vi.fn();
const rows = vi.fn();
const upload = vi.fn();
const decide = vi.fn();
const decideAll = vi.fn();
const apply = vi.fn();
const cancel = vi.fn();
const suppliers = vi.fn();

vi.mock('@/api/endpoints', () => ({
  imports: {
    list: (...a: unknown[]) => list(...a) as unknown,
    get: (...a: unknown[]) => get(...a) as unknown,
    rows: (...a: unknown[]) => rows(...a) as unknown,
    upload: (...a: unknown[]) => upload(...a) as unknown,
    decide: (...a: unknown[]) => decide(...a) as unknown,
    decideAll: (...a: unknown[]) => decideAll(...a) as unknown,
    apply: (...a: unknown[]) => apply(...a) as unknown,
    cancel: (...a: unknown[]) => cancel(...a) as unknown,
  },
  purchases: { suppliers: (...a: unknown[]) => suppliers(...a) as unknown },
}));

function job(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'j1',
    intent: 'price_list',
    status: 'needs_review',
    original_filename: 'balaji-prices.csv',
    file_size_bytes: 2048,
    supplier_id: null,
    row_count: 2,
    rows_applied: 0,
    rows_skipped: 0,
    rows_failed: 0,
    rows_pending_decision: 1,
    error_summary: null,
    created_purchase_id: null,
    duplicate_of_job_id: null,
    created_at: '2026-10-30T10:00:00Z',
    applied_at: null,
    ...overrides,
  };
}

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'r1',
    row_index: 1,
    raw_values: { 'Part No': 'TT-407-BS' },
    parsed_name: 'Tie Rod End',
    parsed_sku: 'TT-407-BS',
    parsed_quantity: null,
    parsed_unit_cost: '340.0000',
    parsed_selling_price: '480.0000',
    match_status: 'exact_sku',
    matched_product_id: 'p1',
    matched_product_name: 'Tie Rod End Bolero',
    candidate_product_ids: [],
    match_confidence: '1.0000',
    decision: 'pending',
    apply_result: null,
    apply_error: null,
    needs_decision: false,
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of [
    list,
    get,
    rows,
    upload,
    decide,
    decideAll,
    apply,
    cancel,
    suppliers,
  ]) {
    fn.mockReset();
  }
  list.mockResolvedValue({ jobs: [job()] });
  get.mockResolvedValue(job());
  rows.mockResolvedValue({ rows: [row(), row({ id: 'r2', row_index: 2 })] });
  suppliers.mockResolvedValue({ items: [{ id: 's1', name: 'Sri Balaji', phone: null }] });
  decide.mockResolvedValue({ row: row({ decision: 'skip' }) });
  decideAll.mockResolvedValue(job({ rows_pending_decision: 0 }));
  apply.mockResolvedValue(job({ status: 'applied', rows_applied: 2, rows_skipped: 0 }));
  cancel.mockResolvedValue(job({ status: 'cancelled' }));
});

describe('the import history', () => {
  it('lists uploaded files with their state in words', async () => {
    render(<ImportsScreen />);
    expect(await screen.findByText('balaji-prices.csv')).toBeInTheDocument();
    // Not `needs_review`.
    expect(screen.getByText('Needs your decisions')).toBeInTheDocument();
  });

  it('says what the file is, not just its name', async () => {
    render(<ImportsScreen />);
    expect(await screen.findByText(/update prices only/)).toBeInTheDocument();
  });

  it('says so when nothing has been uploaded', async () => {
    list.mockResolvedValue({ jobs: [] });
    render(<ImportsScreen />);
    expect(await screen.findByText(/No file has been uploaded yet/)).toBeInTheDocument();
  });
});

describe('FR-IMP-002 — the intent is chosen, never inferred', () => {
  it('offers both intents and explains the difference before a file is picked', async () => {
    const user = userEvent.setup();
    render(<ImportsScreen />);
    await screen.findByText('balaji-prices.csv');
    await user.click(screen.getByRole('button', { name: 'Upload a file' }));

    expect(screen.getByLabelText(/update prices only/)).toBeInTheDocument();
    expect(screen.getByLabelText(/may add stock/)).toBeInTheDocument();
    expect(screen.getByText(/A price list never changes stock/)).toBeInTheDocument();
  });

  it('asks which supplier a supplier-bill import is from', async () => {
    const user = userEvent.setup();
    render(<ImportsScreen />);
    await screen.findByText('balaji-prices.csv');
    await user.click(screen.getByRole('button', { name: 'Upload a file' }));
    await user.click(screen.getByLabelText(/may add stock/));

    expect(await screen.findByRole('combobox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
  });

  it('will not upload without a file', async () => {
    const user = userEvent.setup();
    render(<ImportsScreen />);
    await screen.findByText('balaji-prices.csv');
    await user.click(screen.getByRole('button', { name: 'Upload a file' }));

    expect(screen.getByText('Choose a file first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('FR-IMP-004 — a duplicate file is a question, not a failure', () => {
  it('asks for a reason and only then offers to upload it again', async () => {
    upload.mockRejectedValueOnce(
      new ApiError(409, {
        error: {
          code: 'DUPLICATE_FILE',
          message: 'already uploaded',
          details: {},
          request_id: 'r',
          retryable: false,
        },
      }),
    );
    const user = userEvent.setup();
    render(<ImportsScreen />);
    await screen.findByText('balaji-prices.csv');
    await user.click(screen.getByRole('button', { name: 'Upload a file' }));
    await user.upload(
      screen.getByLabelText('Choose a file'),
      new File(['Part No,MRP\nX,1\n'], 'again.csv', { type: 'text/csv' }),
    );
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByText(/uploaded before/)).toBeInTheDocument();
    // A reason is required before the override is offered (FR-IMP-004).
    const again = screen.getByRole('button', { name: 'Upload it again' });
    expect(again).toBeDisabled();

    await user.type(
      screen.getByLabelText('Why upload it again?'),
      'Supplier corrected two prices',
    );
    expect(screen.getByRole('button', { name: 'Upload it again' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Upload it again' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    const [, options] = upload.mock.calls[1] as [File, Record<string, unknown>];
    expect(options.allowDuplicate).toBe(true);
    expect(options.duplicateReason).toBe('Supplier corrected two prices');
  });
});

describe('FR-IMP-007 — nothing is applied from a guess', () => {
  it('disables apply while any row is undecided, and says how many', async () => {
    const user = userEvent.setup();
    render(<ImportsScreen />);
    await screen.findByText('balaji-prices.csv');
    await user.click(screen.getByRole('button', { name: 'Open' }));

    expect(
      await screen.findByText(/1 row still needs your decision/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply this import' })).toBeDisabled();
  });

  it('enables apply once nothing is pending', async () => {
    get.mockResolvedValue(job({ status: 'parsed', rows_pending_decision: 0 }));
    const user = userEvent.setup();
    render(<ImportsScreen />);
    await screen.findByText('balaji-prices.csv');
    await user.click(screen.getByRole('button', { name: 'Open' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Apply this import' })).toBeEnabled(),
    );
    expect(screen.queryByText(/still needs your decision/)).not.toBeInTheDocument();
  });

  it('never offers "add as a new item" for a row that could not be read', async () => {
    rows.mockResolvedValue({
      rows: [
        row({
          id: 'bad',
          match_status: 'invalid',
          matched_product_id: null,
          matched_product_name: null,
          parsed_name: null,
          needs_decision: true,
          apply_error: 'price: ‘about 500’ is not a number',
        }),
      ],
    });
    const user = userEvent.setup();
    render(<ImportsScreen />);
    await screen.findByText('balaji-prices.csv');
    await user.click(screen.getByRole('button', { name: 'Open' }));

    expect(await screen.findByText('Could not be read')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add as a new item' }),
    ).not.toBeInTheDocument();
    // Skipping is always available — it is the one honest answer for an unreadable row.
    expect(screen.getByRole('button', { name: 'Leave it out' })).toBeInTheDocument();
  });

  it('shows the matcher’s own reason verbatim', async () => {
    rows.mockResolvedValue({
      rows: [
        row({
          match_status: 'ambiguous',
          matched_product_id: null,
          needs_decision: true,
          apply_error: 'Several products match this name about equally well.',
        }),
      ],
    });
    const user = userEvent.setup();
    render(<ImportsScreen />);
    await screen.findByText('balaji-prices.csv');
    await user.click(screen.getByRole('button', { name: 'Open' }));

    expect(
      await screen.findByText('Several products match this name about equally well.'),
    ).toBeInTheDocument();
  });

  it('records a per-row decision', async () => {
    const user = userEvent.setup();
    render(<ImportsScreen />);
    await screen.findByText('balaji-prices.csv');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    // Two rows, both matched to the same product, so `findAllByText`.
    await screen.findAllByText('Tie Rod End Bolero');

    await user.click(screen.getAllByRole('button', { name: 'Leave it out' })[0]!);
    await waitFor(() => expect(decide).toHaveBeenCalled());
    expect(decide).toHaveBeenCalledWith('j1', 'r1', { decision: 'skip' });
  });

  it('offers a bulk decision per status, so 400 rows are not clicked one at a time', async () => {
    const user = userEvent.setup();
    render(<ImportsScreen />);
    await screen.findByText('balaji-prices.csv');
    await user.click(screen.getByRole('button', { name: 'Open' }));

    await user.click(
      await screen.findByRole('button', { name: 'Add all the new items' }),
    );
    await waitFor(() => expect(decideAll).toHaveBeenCalled());
    expect(decideAll).toHaveBeenCalledWith('j1', {
      match_status: 'new_product',
      decision: 'create_new',
    });
  });
});

describe('applying', () => {
  it('says stock will not change for a price list', async () => {
    get.mockResolvedValue(
      job({ status: 'parsed', rows_pending_decision: 0, intent: 'price_list' }),
    );
    const user = userEvent.setup();
    render(<ImportsScreen />);
    await screen.findByText('balaji-prices.csv');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(await screen.findByRole('button', { name: 'Apply this import' }));

    expect(
      await screen.findByText('This updates prices. Stock will not change.'),
    ).toBeInTheDocument();
  });

  it('says stock will change for a supplier bill', async () => {
    get.mockResolvedValue(
      job({ status: 'parsed', rows_pending_decision: 0, intent: 'purchase_receipt' }),
    );
    const user = userEvent.setup();
    render(<ImportsScreen />);
    await screen.findByText('balaji-prices.csv');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(await screen.findByRole('button', { name: 'Apply this import' }));

    expect(await screen.findByText(/adds the quantities/)).toBeInTheDocument();
  });

  it('sends an idempotency key with the apply', async () => {
    get.mockResolvedValue(job({ status: 'parsed', rows_pending_decision: 0 }));
    const user = userEvent.setup();
    render(<ImportsScreen />);
    await screen.findByText('balaji-prices.csv');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(await screen.findByRole('button', { name: 'Apply this import' }));

    // The confirmation is a nested dialog, and it renders inside the parent dialog's
    // children — so it appears *before* the parent's action buttons in the DOM. Taking
    // the last matching button would press the parent's again; scoping to the
    // confirmation dialog is what actually reaches the one that applies.
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(2);
    const confirmation = within(dialogs[1]!);
    await user.click(confirmation.getByRole('button', { name: 'Apply this import' }));

    await waitFor(() => expect(apply).toHaveBeenCalled());
    const [, key] = apply.mock.calls[0] as [string, string];
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports what was applied and what was left out', async () => {
    get.mockResolvedValue(
      job({
        status: 'applied',
        rows_pending_decision: 0,
        rows_applied: 7,
        rows_skipped: 3,
      }),
    );
    const user = userEvent.setup();
    render(<ImportsScreen />);
    await screen.findByText('balaji-prices.csv');
    await user.click(screen.getByRole('button', { name: 'Open' }));

    // "7 applied" alone would hide exactly what the reader needs to check.
    expect(await screen.findByText(/Applied 7 rows\. Left out 3\./)).toBeInTheDocument();
  });

  it('offers neither apply nor cancel once the job is applied', async () => {
    get.mockResolvedValue(job({ status: 'applied', rows_pending_decision: 0 }));
    const user = userEvent.setup();
    render(<ImportsScreen />);
    await screen.findByText('balaji-prices.csv');
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByText(/Applied/);

    expect(
      screen.queryByRole('button', { name: 'Apply this import' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Cancel this import' }),
    ).not.toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('has no axe violations on the list', async () => {
    const { container } = render(<ImportsScreen />);
    await screen.findByText('balaji-prices.csv');
    const results = await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
    });
    expect(results.violations).toEqual([]);
  });
});

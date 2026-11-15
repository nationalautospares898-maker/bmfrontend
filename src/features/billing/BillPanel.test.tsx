/**
 * `CompletionCard` (NAS-CORRECTION-02, owner request, 2026-11-14).
 *
 * The owner tried the full confirmation panel — title, Total/Outstanding/Due — and
 * asked for it gone. What stays is the one sentence FR-CREDIT-013/026 names
 * explicitly, as plain text with no panel and no numbers: everything these assert.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { FinalizeResponse } from '@/api/types';
import { CompletionCard } from './BillPanel';

function response(isCredit: boolean): FinalizeResponse {
  return { invoice: { is_credit: isCredit } } as unknown as FinalizeResponse;
}

describe('CompletionCard', () => {
  it.each([
    ['a credit bill', true],
    ['a cash bill', false],
  ])('says stock has been updated for %s, as plain text with no panel', (_label, isCredit) => {
    render(<CompletionCard response={response(isCredit)} />);

    expect(screen.getByText('Stock has been updated.')).toBeInTheDocument();
    // Not the old confirmation panel: no title, no alert role, no figures.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Credit bill completed')).not.toBeInTheDocument();
    expect(screen.queryByText('Bill completed')).not.toBeInTheDocument();
    expect(screen.queryByText('Total')).not.toBeInTheDocument();
    expect(screen.queryByText('Outstanding')).not.toBeInTheDocument();
  });
});

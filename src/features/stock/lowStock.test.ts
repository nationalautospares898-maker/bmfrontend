/**
 * The low-stock rule's boundary.
 *
 * This file exists because the rule changed on 2026-11-22 by owner decision — from `<`
 * to `<=` — and because the rule is implemented six times across two repositories. Five
 * of those are server-side and covered by `bmbackend/tests/api/test_low_stock_threshold.py`;
 * this is the sixth, the client-side badge, and it has to agree with them exactly.
 *
 * The three cases the owner named are asserted by name, not buried in a table: 9/10 low,
 * **10/10 low**, 11/10 not low.
 */

import { describe, expect, it } from 'vitest';

import type { StockBalance } from '@/api/types';
import { isLow } from './lowStock';

function row(quantity: string, reorderLevel: string | null): StockBalance {
  return {
    product_id: 'p-1',
    name: 'Brake Shoe Set',
    quantity,
    reorder_level: reorderLevel,
    sku: 'BS-1',
    default_selling_price: '100.0000',
  };
}

describe('isLow — the owner-settled boundary', () => {
  it('9 against a minimum of 10 is low', () => {
    expect(isLow(row('9.000', '10.000'))).toBe(true);
  });

  it('10 against a minimum of 10 IS low', () => {
    // The case the whole `<=`/`<` question turns on, and the one that changed.
    // `reorder_level` means "reorder when you reach this", so reaching it counts.
    expect(isLow(row('10.000', '10.000'))).toBe(true);
  });

  it('11 against a minimum of 10 is not low', () => {
    expect(isLow(row('11.000', '10.000'))).toBe(false);
  });
});

describe('isLow — the rest of the rule, unchanged', () => {
  it('zero is low', () => {
    expect(isLow(row('0.000', '10.000'))).toBe(true);
  });

  it('a product with no minimum set is never low', () => {
    // A missing minimum is not a minimum of zero — the screen renders "Not set".
    expect(isLow(row('0.000', null))).toBe(false);
    expect(isLow(row('500.000', null))).toBe(false);
  });

  it('compares on the quantity scale, not by string length', () => {
    // '9.000' > '10.000' lexically; the rule is numeric.
    expect(isLow(row('9.000', '10.000'))).toBe(true);
    expect(isLow(row('100.000', '10.000'))).toBe(false);
  });

  it('a hair above the minimum is not low', () => {
    expect(isLow(row('10.001', '10.000'))).toBe(false);
  });

  it('a hair below the minimum is low', () => {
    expect(isLow(row('9.999', '10.000'))).toBe(true);
  });
});

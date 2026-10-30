/**
 * `src/lib/money.ts` requires **100% branch coverage** (§12).
 *
 * It is the one file where an untested branch is a wrong number on a customer's bill,
 * and the preview it produces has to agree with what the server will compute — so the
 * ordering and rejection rules are asserted against the same cases as the backend's
 * `tests/unit/test_money.py`.
 */

import Decimal from 'decimal.js-light';
import { describe, expect, it } from 'vitest';

import {
  type MoneyPolicy,
  MoneyFormatError,
  ZERO,
  formatForPrint,
  formatForScreen,
  formatQuantity,
  isIntegral,
  lineExtension,
  parseMoney,
  previewTotal,
  toApiString,
  tryParseMoney,
  violatesWholeRupeeRule,
} from '@/lib/money';

const D = (value: string) => new Decimal(value);

/** The v1 policy the backend publishes at `GET /sync/bootstrap`. */
const V1_POLICY: MoneyPolicy = {
  version: 1,
  currency: 'INR',
  amount_scale: 2,
  unit_price_scale: 4,
  quantity_scale: 3,
  percent_scale: 3,
  rounding_mode: 'reject_fractional',
  round_grand_total_to_rupee: false,
  require_integral_amounts: true,
  display_decimal_places: 0,
};

const TWO_PLACE_POLICY: MoneyPolicy = {
  ...V1_POLICY,
  version: 98,
  display_decimal_places: 2,
};

describe('parseMoney', () => {
  it('accepts a decimal string', () => {
    expect(parseMoney('1250.00').toString()).toBe('1250');
  });

  it('passes a Decimal straight through', () => {
    const value = D('42');
    expect(parseMoney(value)).toBe(value);
  });

  it('rejects a number, because it has already lost precision', () => {
    expect(() => parseMoney(1250.5)).toThrow(MoneyFormatError);
  });

  it.each(['', '   ', 'abc', '12.3.4', '1,250.00', '1e3', 'Infinity', 'NaN'])(
    'rejects %s',
    (raw) => {
      expect(() => parseMoney(raw)).toThrow(MoneyFormatError);
    },
  );

  it('accepts a negative value, leaving the sign rule to the caller', () => {
    expect(parseMoney('-50').toString()).toBe('-50');
  });
});

describe('tryParseMoney', () => {
  it('returns a Decimal for valid input', () => {
    expect(tryParseMoney('240')?.toString()).toBe('240');
  });

  it('returns null rather than throwing while the user is still typing', () => {
    expect(tryParseMoney('24a')).toBeNull();
  });
});

describe('isIntegral', () => {
  it.each([
    ['5', true],
    ['5.00', true],
    ['5.01', false],
    ['0', true],
  ] as const)('%s -> %s', (value, expected) => {
    expect(isIntegral(D(value))).toBe(expected);
  });
});

describe('lineExtension', () => {
  it('multiplies quantity by unit price exactly', () => {
    expect(lineExtension({ quantity: D('2'), unitPrice: D('1250') }).toString()).toBe(
      '2500',
    );
  });

  it('applies a percentage discount', () => {
    const net = lineExtension({
      quantity: D('1'),
      unitPrice: D('1000'),
      discountPercent: D('10'),
    });
    expect(net.toString()).toBe('900');
  });

  it('applies the monetary discount after the percentage one, matching the server', () => {
    const net = lineExtension({
      quantity: D('1'),
      unitPrice: D('1000'),
      discountPercent: D('10'),
      discountAmount: D('50'),
    });
    expect(net.toString()).toBe('850');
  });

  it('clamps at zero rather than going negative', () => {
    const net = lineExtension({
      quantity: D('1'),
      unitPrice: D('100'),
      discountAmount: D('150'),
    });
    expect(net.toString()).toBe('0');
  });

  it('keeps a value binary floating point cannot represent exact', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754.
    const total = previewTotal([
      lineExtension({ quantity: D('1'), unitPrice: D('0.1') }),
      lineExtension({ quantity: D('1'), unitPrice: D('0.2') }),
    ]);
    expect(total.toString()).toBe('0.3');
  });
});

describe('previewTotal', () => {
  it('sums line extensions', () => {
    expect(previewTotal([D('100'), D('250'), D('33')]).toString()).toBe('383');
  });

  it('is zero for an empty bill', () => {
    expect(previewTotal([]).eq(ZERO)).toBe(true);
  });
});

describe('formatForPrint', () => {
  it.each([
    ['240.00', '240'],
    ['3850.00', '3850'],
    ['0.00', '0'],
    ['1234567.00', '1234567'],
  ])('renders %s as %s with no decimals or separators', (stored, printed) => {
    expect(formatForPrint(D(stored), V1_POLICY)).toBe(printed);
  });

  it('round-trips, so the figure on paper is the figure in the database', () => {
    for (const raw of ['0.00', '1.00', '240.00', '3850.00']) {
      const stored = D(raw);
      expect(D(formatForPrint(stored, V1_POLICY)).eq(stored)).toBe(true);
    }
  });

  it('throws rather than rounding a value with paise', () => {
    // Addendum §3.5: printing a figure that disagrees with the record is worse than
    // showing an error, because nobody downstream can tell it happened.
    expect(() => formatForPrint(D('240.50'), V1_POLICY)).toThrow(MoneyFormatError);
    expect(() => formatForPrint(D('240.50'), V1_POLICY)).toThrow(/must not be printed/);
  });

  it('honours a policy that permits decimal places', () => {
    expect(formatForPrint(D('240.5'), TWO_PLACE_POLICY)).toBe('240.50');
  });
});

describe('formatForScreen', () => {
  it('shows a whole amount without decimals', () => {
    expect(formatForScreen(D('240.00'))).toBe('240');
  });

  it('shows paise on screen so the cashier can see what the server will refuse', () => {
    expect(formatForScreen(D('240.50'))).toBe('240.50');
  });
});

describe('formatQuantity', () => {
  it.each([
    ['2.000', '2'],
    ['1.500', '1.5'],
    ['0.250', '0.25'],
    ['100.000', '100'],
  ])('renders %s as %s', (stored, printed) => {
    expect(formatQuantity(D(stored))).toBe(printed);
  });
});

describe('toApiString', () => {
  it('emits a string at the declared scale, never a JSON number', () => {
    expect(toApiString(D('2500'), 2)).toBe('2500.00');
    expect(toApiString(D('1250'), 4)).toBe('1250.0000');
  });
});

describe('violatesWholeRupeeRule', () => {
  it('flags paise under the v1 policy, before the cashier presses Print Bill', () => {
    expect(violatesWholeRupeeRule(D('240.50'), V1_POLICY)).toBe(true);
  });

  it('passes a whole amount', () => {
    expect(violatesWholeRupeeRule(D('240'), V1_POLICY)).toBe(false);
  });

  it('does not flag anything when the policy permits paise', () => {
    const relaxed: MoneyPolicy = { ...V1_POLICY, require_integral_amounts: false };
    expect(violatesWholeRupeeRule(D('240.50'), relaxed)).toBe(false);
  });
});

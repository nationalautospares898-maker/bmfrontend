/**
 * The only place money arithmetic happens in this client (ADR-013).
 *
 * `parseFloat`, `Number()` and `+`/`-`/`*` on money outside this file are lint errors,
 * and a structural test asserts the same thing independently. The reason is narrow and
 * concrete: IEEE-754 cannot represent every rupee value exactly, so a single
 * `Number(price) * qty` in a component is a wrong total on a customer's bill with no
 * way to notice afterwards.
 *
 * **The server owns money.** Everything here produces a *preview*, labelled as such on
 * screen. `client_computed_total` is sent only as a cross-check and the server answers
 * `422 TOTAL_MISMATCH` if it disagrees (ADR-032, FR-SALE-003).
 *
 * The rounding and whole-rupee rules come from the money policy in
 * `GET /sync/bootstrap` and are **never hardcoded here** (rule 15): the backend is
 * authoritative, and a client that decided its own rounding would eventually disagree
 * with the invoice it is previewing.
 */

import Decimal from 'decimal.js-light';

/** Mirrors `bm.domain.shared.money.RoundingMode`. */
export type RoundingMode = 'reject_fractional' | 'line_half_up';

/** The money policy object published by `GET /sync/bootstrap`. */
export interface MoneyPolicy {
  readonly version: number;
  readonly currency: string;
  readonly amount_scale: number;
  readonly unit_price_scale: number;
  readonly quantity_scale: number;
  readonly percent_scale: number;
  readonly rounding_mode: RoundingMode;
  readonly round_grand_total_to_rupee: boolean;
  readonly require_integral_amounts: boolean;
  readonly display_decimal_places: number;
}

export class MoneyFormatError extends Error {}

/**
 * Parse a decimal string from the API or an input field.
 *
 * Rejects what the backend rejects, for the same reasons: a `number` has already lost
 * precision, and exponent notation has ambiguous precision.
 */
export function parseMoney(raw: string | number | Decimal): Decimal {
  if (raw instanceof Decimal) return raw;
  if (typeof raw === 'number') {
    throw new MoneyFormatError(
      'Money must be a decimal string, not a number — numbers lose precision.',
    );
  }
  const text = raw.trim();
  if (text === '') throw new MoneyFormatError('Money must be a decimal string.');
  const lowered = text.toLowerCase();
  if (lowered.includes('e') || lowered.includes('inf') || lowered.includes('nan')) {
    throw new MoneyFormatError(
      'Exponent notation and non-finite values are not accepted.',
    );
  }
  if (!/^-?\d*\.?\d+$/.test(text)) {
    throw new MoneyFormatError('Money must be a decimal string.');
  }
  return new Decimal(text);
}

/** Parse a value the user typed, returning `null` rather than throwing on nonsense. */
export function tryParseMoney(raw: string): Decimal | null {
  try {
    return parseMoney(raw);
  } catch {
    return null;
  }
}

export const ZERO = new Decimal(0);

export function isIntegral(value: Decimal): boolean {
  return value.eq(value.toDecimalPlaces(0));
}

/** `quantity × unit_price`, less discounts. Exact — this is a preview, never rounded. */
export function lineExtension(input: {
  quantity: Decimal;
  unitPrice: Decimal;
  discountPercent?: Decimal;
  discountAmount?: Decimal;
}): Decimal {
  const gross = input.quantity.times(input.unitPrice);
  const percent = input.discountPercent ?? ZERO;
  const flat = input.discountAmount ?? ZERO;
  // Same order as the server: percentage first, then the monetary discount. A
  // different order here would make the preview disagree with the invoice.
  const afterPercent = gross.minus(gross.times(percent).dividedBy(100));
  const net = afterPercent.minus(flat);
  return net.lt(ZERO) ? ZERO : net;
}

/** Sum line extensions for the on-screen preview total. */
export function previewTotal(lines: readonly Decimal[]): Decimal {
  return lines.reduce<Decimal>((sum, line) => sum.plus(line), ZERO);
}

/**
 * Render an amount the way the printed bill shows it.
 *
 * With `display_decimal_places: 0` (the owner's requirement, OD-23) the output is an
 * ungrouped integer: `240`, `3850`. No separators, no currency symbol.
 *
 * A non-integral value **throws**. The client never rounds to satisfy a display rule
 * (addendum §3.5): the server has already refused to finalise such a value, so one
 * reaching here means something is wrong, and printing a figure that disagrees with the
 * record is worse than showing an error.
 */
export function formatForPrint(value: Decimal, policy: MoneyPolicy): string {
  if (policy.display_decimal_places === 0) {
    if (!isIntegral(value)) {
      throw new MoneyFormatError(
        `${value.toString()} cannot be shown on a whole-rupee bill. ` +
          'This bill must not be printed until the amount is corrected.',
      );
    }
    return value.toDecimalPlaces(0).toString();
  }
  return value.toFixed(policy.display_decimal_places);
}

/**
 * Render an amount for the screen.
 *
 * Deliberately **independent of the print policy**: the screen always shows paise when
 * a value has them, so a cashier can see exactly what the server is going to refuse.
 * Showing `240` on screen for a stored `240.50` would hide the very problem they need
 * to fix, which is why this takes no policy argument.
 */
export function formatForScreen(value: Decimal): string {
  return isIntegral(value) ? value.toDecimalPlaces(0).toString() : value.toFixed(2);
}

/** Quantities print in their shortest exact form: `2.000` as `2`, `1.500` as `1.5`. */
export function formatQuantity(value: Decimal): string {
  return value.toString();
}

/** The string sent to the API. Always a string, never a JSON number (ADR-013). */
export function toApiString(value: Decimal, scale: number): string {
  return value.toFixed(scale);
}

/**
 * Whether the preview can be finalised under the current policy.
 *
 * Checked client-side purely so the cashier is told *before* pressing `Print Bill`
 * rather than after. The server revalidates everything regardless — client validation
 * never replaces server validation.
 */
export function violatesWholeRupeeRule(value: Decimal, policy: MoneyPolicy): boolean {
  return policy.require_integral_amounts && !isIntegral(value);
}

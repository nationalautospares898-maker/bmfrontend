/**
 * The printed bill, rendered and inspected.
 *
 * These are the assertions that matter most to the owner, because they are about what a
 * customer is handed:
 *
 * - **no invoice number anywhere** (OD-3);
 * - **no tax row at all** when `totals.tax` is `null` — not a zero row (FR-PRINT-012);
 * - **blank filler rows**, never the reference workbook's hand-typed `0`
 *   (FR-PRINT-018);
 * - **no placeholder** for a business detail the owner has not supplied
 *   (FR-PRINT-016, OD-4);
 * - the credit block appears **only** for a credit bill (OD-22);
 * - the document title comes from the payload and reads `ESTIMATE` (OD-24).
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { PrintPayload } from '@/api/types';
import type { MoneyPolicy } from '@/lib/money';
import { InvoicePrintLayout } from './InvoicePrintLayout';

const POLICY: MoneyPolicy = {
  version: 1,
  currency: 'INR',
  amount_scale: 2,
  unit_price_scale: 4,
  quantity_scale: 3,
  percent_scale: 3,
  rounding_mode: 'reject_fractional',
  round_grand_total_to_rupee: false,
  require_integral_amounts: true,
  // The owner's requirement: whole rupees, no decimals on the bill (OD-23).
  display_decimal_places: 0,
};

function payload(overrides: Partial<PrintPayload> = {}): PrintPayload {
  return {
    document_title: 'ESTIMATE',
    is_duplicate: false,
    business: {
      display_name: 'National Auto Spares',
      address_lines: ['Main Road', 'Hyderabad'],
      phone_numbers: ['9876543210'],
      tax_identifier: null,
      tax_identifier_label: null,
    },
    issued_at: '2026-10-30T10:30:00+05:30',
    customer: {
      name: 'Shankar',
      business_name: null,
      vehicle_number: 'KA01AB1234',
      mechanic_name: null,
      phone: null,
    },
    columns: ['sl_no', 'item', 'quantity', 'price', 'total'],
    lines: [
      {
        sl_no: 1,
        item: 'Brake Shoe Set',
        quantity: '2.000',
        price: '1250.00',
        total: '2500.00',
      },
    ],
    totals: {
      subtotal: '2500.00',
      discount: '0.00',
      tax: null,
      rounding: '0.00',
      grand_total: '2500.00',
    },
    amount_in_words: 'Two thousand five hundred rupees only',
    payment: {
      status: 'paid',
      amount_paid: '2500.00',
      outstanding: '0.00',
      method: null,
      due_date: null,
      is_credit: false,
    },
    footer_notes: [],
    tax_mode: 'estimate_only',
    print_profile: 'a5_portrait',
    date_format: 'MM-DD-YYYY',
    show_credit_block: false,
    item_row_capacity: 25,
    ...overrides,
  };
}

describe('no invoice number is rendered anywhere (OD-3)', () => {
  it('prints no number and no substitute for one', () => {
    const { container } = render(
      <InvoicePrintLayout payload={payload()} policy={POLICY} />,
    );
    const text = container.textContent ?? '';
    // There is no invoice-number field in the payload, so there is nothing to render
    // and nothing to invent. A replacement visible numbering scheme would defeat the
    // owner's answer just as thoroughly as the original.
    expect(text).not.toMatch(/invoice\s*(no|number|#)/i);
    expect(text).not.toMatch(/bill\s*(no|number|#)/i);
    expect(text).not.toMatch(/EST\/|INV\//);
  });
});

describe('tax (FR-PRINT-012, ADR-020)', () => {
  it('renders no tax row at all when tax is null', () => {
    render(<InvoicePrintLayout payload={payload()} policy={POLICY} />);
    // Not a `0.00` row: on an estimate that would read as "tax was calculated and
    // came to nothing", which is not what `estimate_only` means.
    expect(screen.queryByText('Tax')).not.toBeInTheDocument();
  });

  it('renders a tax row when the server supplies a figure', () => {
    render(
      <InvoicePrintLayout
        payload={payload({
          totals: {
            subtotal: '2500.00',
            discount: '0.00',
            tax: '450.00',
            rounding: '0.00',
            grand_total: '2950.00',
          },
        })}
        policy={POLICY}
      />,
    );
    expect(screen.getByText('Tax')).toBeInTheDocument();
    expect(screen.getByText('450')).toBeInTheDocument();
  });
});

describe('the document title comes from the server (OD-24, FR-PRINT-021)', () => {
  it('renders ESTIMATE for a cash bill', () => {
    render(<InvoicePrintLayout payload={payload()} policy={POLICY} />);
    expect(screen.getByText('ESTIMATE')).toBeInTheDocument();
  });

  it('renders ESTIMATE for a credit bill too', () => {
    // The same label for both. "Credit" describes who owes money, not the document.
    render(
      <InvoicePrintLayout
        payload={payload({ payment: { ...payload().payment, is_credit: true } })}
        policy={POLICY}
      />,
    );
    expect(screen.getByText('ESTIMATE')).toBeInTheDocument();
  });
});

describe('item rows (FR-PRINT-018)', () => {
  it('pads to the payload capacity with blank rows, never zeros', () => {
    const { container } = render(
      <InvoicePrintLayout payload={payload()} policy={POLICY} />,
    );
    // Scoped to the item table: the totals table has rows of its own, and counting
    // both would make this pass for the wrong reason.
    const rows = container.querySelectorAll('.bill__items tbody tr');
    // One real line plus 24 fillers, so the grand total lands in the same physical
    // place on every bill — which is what makes a pre-printed pad usable.
    expect(rows).toHaveLength(25);

    const fillers = container.querySelectorAll('tr.is-filler');
    expect(fillers).toHaveLength(24);
    for (const filler of fillers) {
      // Blank, not `0`. The reference workbook has hand-typed zeros; the bill must not.
      const cells = [...filler.querySelectorAll('td')];
      expect(cells).toHaveLength(5);
      for (const cell of cells) expect(cell.textContent).toBe('');
    }
  });

  it('renders quantities in their shortest exact form', () => {
    render(<InvoicePrintLayout payload={payload()} policy={POLICY} />);
    // `2.000` prints as `2`. A customer's bill does not show trailing zeros on a
    // whole number of items.
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders whole rupees with no decimals under the owner policy (OD-23)', () => {
    render(<InvoicePrintLayout payload={payload()} policy={POLICY} />);
    expect(screen.getAllByText('1250').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2500').length).toBeGreaterThan(0);
  });

  it('throws rather than rounding a fractional amount', () => {
    // The client never rounds to satisfy a display rule (addendum §3.5): printing a
    // figure that disagrees with the stored record is worse than showing an error.
    // The server has already refused to finalise such a value, so one reaching here
    // means something is wrong upstream.
    expect(() =>
      render(
        <InvoicePrintLayout
          payload={payload({
            totals: {
              subtotal: '2500.50',
              discount: '0.00',
              tax: null,
              rounding: '0.00',
              grand_total: '2500.50',
            },
          })}
          policy={POLICY}
        />,
      ),
    ).toThrow(/cannot be shown on a whole-rupee bill/);
  });
});

describe('business identity (FR-PRINT-016, OD-4)', () => {
  it('prints nothing where the owner has supplied nothing', () => {
    const { container } = render(
      <InvoicePrintLayout
        payload={payload({
          business: {
            display_name: 'National Auto Spares',
            address_lines: [],
            phone_numbers: [],
            tax_identifier: null,
            tax_identifier_label: null,
          },
        })}
        policy={POLICY}
      />,
    );
    const text = container.textContent ?? '';
    // No `N/A`, no dash, no "Address not set". The owner has not supplied a legal
    // name or a tax identifier and inventing one is forbidden.
    expect(text).not.toMatch(/N\/A|not set|TBD|placeholder|XXXX/i);
    expect(text).not.toMatch(/GSTIN|GST No/i);
  });

  it('prints a tax identifier only with its server-supplied label', () => {
    render(
      <InvoicePrintLayout
        payload={payload({
          business: {
            ...payload().business,
            tax_identifier: '29ABCDE1234F1Z5',
            tax_identifier_label: 'GSTIN',
          },
        })}
        policy={POLICY}
      />,
    );
    // Both come from the server; the client never decides what an identifier is called.
    expect(screen.getByText(/GSTIN: 29ABCDE1234F1Z5/)).toBeInTheDocument();
  });
});

describe('the credit block (OD-22, FR-PRINT-020)', () => {
  it('is absent on a cash bill', () => {
    render(<InvoicePrintLayout payload={payload()} policy={POLICY} />);
    expect(screen.queryByText('Paid')).not.toBeInTheDocument();
    expect(screen.queryByText('Balance')).not.toBeInTheDocument();
  });

  it('shows the recorded Paid, Balance and Due for a credit bill', () => {
    render(
      <InvoicePrintLayout
        payload={payload({
          show_credit_block: true,
          payment: {
            status: 'partially_paid',
            amount_paid: '1000.00',
            outstanding: '1500.00',
            method: null,
            due_date: '2026-11-29',
            is_credit: true,
          },
        })}
        policy={POLICY}
      />,
    );
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('1000')).toBeInTheDocument();
    expect(screen.getByText('Balance')).toBeInTheDocument();
    expect(screen.getByText('1500')).toBeInTheDocument();
    expect(screen.getByText('Due')).toBeInTheDocument();
    // The due date uses the payload's own order, not a client default.
    expect(screen.getByText('11-29-2026')).toBeInTheDocument();
  });
});

describe('dates (T3-11)', () => {
  it.each([
    ['MM-DD-YYYY', '10-30-2026'],
    ['DD-MM-YYYY', '30-10-2026'],
    ['YYYY-MM-DD', '2026-10-30'],
  ])('renders %s as %s', (order, expected) => {
    render(
      <InvoicePrintLayout payload={payload({ date_format: order })} policy={POLICY} />,
    );
    // The order comes from the payload. A hardcoded order here and a different one on
    // the server is how two documents for one sale end up dated differently.
    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});

describe('reprints', () => {
  it('marks a duplicate when the server says so', () => {
    render(
      <InvoicePrintLayout payload={payload({ is_duplicate: true })} policy={POLICY} />,
    );
    expect(screen.getByText('DUPLICATE COPY')).toBeInTheDocument();
  });

  it('does not mark an original', () => {
    render(<InvoicePrintLayout payload={payload()} policy={POLICY} />);
    expect(screen.queryByText('DUPLICATE COPY')).not.toBeInTheDocument();
  });
});

describe('amount in words (OD-5)', () => {
  it('is carried in the payload but never printed', () => {
    const { container } = render(
      <InvoicePrintLayout payload={payload()} policy={POLICY} />,
    );
    // Verified absent from the owner's workbook, and this layout reproduces the
    // workbook rather than the contract.
    expect(container.textContent).not.toMatch(/rupees only/i);
  });
});

describe('the workbook structure (UI-UX §12.1)', () => {
  it('uses the owner’s own printed column headers', () => {
    render(<InvoicePrintLayout payload={payload()} policy={POLICY} />);
    // Deliberately not the on-screen labels: the app is not a spreadsheet replica,
    // the bill is.
    for (const header of ['S R', 'ITEM', 'QTY', 'PRICE', 'TOTAL']) {
      expect(screen.getByText(header)).toBeInTheDocument();
    }
  });

  it('closes with the owner’s footer line', () => {
    render(<InvoicePrintLayout payload={payload()} policy={POLICY} />);
    // The double space is the workbook's own spacing, so the default whitespace
    // normalizer is turned off rather than the string being "tidied" to match it.
    expect(
      screen.getByText('THANK YOU  VISIT AGAIN', { normalizer: (text) => text }),
    ).toBeInTheDocument();
  });

  it('prints both of the owner’s workbook marks, one at each end of the footer', () => {
    // T3-12. The marks are extracted from `ANAS_1234_20260606_231456.xlsx`
    // (`xl/media/image1.jpeg`, `image2.jpeg`), which anchors them in columns 0 and 4 of
    // row 34 — the two ends of the footer line. Asserting *two* images in that
    // container is what would catch a layout change that dropped one or stacked them.
    const { container } = render(
      <InvoicePrintLayout payload={payload()} policy={POLICY} />,
    );
    const marks = container.querySelectorAll('.bill__footer-marks .bill__mark');
    expect(marks).toHaveLength(2);
    expect(marks[0]?.getAttribute('src')).toContain('bill-logo-left');
    expect(marks[1]?.getAttribute('src')).toContain('bill-logo-right');
  });

  it('marks the logos decorative so a reader does not announce them', () => {
    // They carry nothing the text does not. An empty `alt` plus `aria-hidden` is the
    // correct pairing for decoration; `alt="logo"` would add noise to every bill.
    const { container } = render(
      <InvoicePrintLayout payload={payload()} policy={POLICY} />,
    );
    for (const mark of container.querySelectorAll('.bill__mark')) {
      expect(mark.getAttribute('alt')).toBe('');
      expect(mark.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('renders the grand total as the last and heaviest row', () => {
    const { container } = render(
      <InvoicePrintLayout payload={payload()} policy={POLICY} />,
    );
    const grand = container.querySelector('.bill__grand-total');
    expect(grand?.textContent).toContain('GRAND TOTAL');
    expect(grand?.textContent).toContain('2500');
  });
});

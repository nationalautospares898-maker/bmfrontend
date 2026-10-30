/**
 * The printed bill.
 *
 * **This component renders `print_payload` and nothing else.** It computes no total,
 * invents no header text, adds no field and hardcodes no document title
 * (FR-PRINT-010/011). Every string on a customer's bill comes from the server, which is
 * what makes the printed output auditable: there is one place the content is decided,
 * and it is not here.
 *
 * Three rules are visible in the code below because they were each a decision:
 *
 * - **No invoice number.** `print_payload` carries none (OD-3 re-answered), the type has
 *   no field for one, and nothing here invents a substitute. A structural test asserts
 *   the source does not read one.
 * - **`totals.tax === null` renders no tax row at all** — not a zero row (FR-PRINT-012).
 *   A `0.00` tax line on an estimate reads as "tax was calculated and came to nothing",
 *   which is not true while `tax.mode = estimate_only`.
 * - **Unused item rows print blank.** The capacity comes from the payload and the
 *   fillers keep the grand total in the same physical place on every bill; they are
 *   never the reference workbook's hand-typed `0` (FR-PRINT-018).
 */

import type { PrintPayload } from '@/api/types';
import logoLeft from '@/assets/bill-logo-left.jpeg';
import logoRight from '@/assets/bill-logo-right.jpeg';
import { formatForPrint, parseMoney, type MoneyPolicy } from '@/lib/money';
import { PRINT } from '@/lib/strings';

export interface InvoicePrintLayoutProps {
  payload: PrintPayload;
  policy: MoneyPolicy;
}

/**
 * Render an amount the way the bill shows it.
 *
 * A non-integral value under the whole-rupee policy **throws** inside `formatForPrint`,
 * and that is deliberate (addendum §3.5): the client never rounds to satisfy a display
 * rule, because printing a figure that disagrees with the stored record is worse than
 * showing an error. The server has already refused to finalise such a value, so one
 * arriving here means something is wrong upstream.
 */
function amount(value: string, policy: MoneyPolicy): string {
  return formatForPrint(parseMoney(value), policy);
}

/** Quantities print in their shortest exact form: `2.000` as `2`. */
function quantity(value: string): string {
  return parseMoney(value).toString();
}

/**
 * The date, in the owner's order.
 *
 * `date_format` comes from the payload (T3-11). The client carries no default of its
 * own: a hardcoded order here and a different one on the server is how two documents
 * for the same sale end up dated differently.
 */
function formatIssuedAt(iso: string, order: string): string {
  const date = new Date(iso);
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = String(date.getFullYear());
  if (order === 'DD-MM-YYYY') return `${dd}-${mm}-${yyyy}`;
  if (order === 'YYYY-MM-DD') return `${yyyy}-${mm}-${dd}`;
  // The workbook's own order, and the configured default.
  return `${mm}-${dd}-${yyyy}`;
}

export function InvoicePrintLayout({ payload, policy }: InvoicePrintLayoutProps) {
  const fillerCount = Math.max(0, payload.item_row_capacity - payload.lines.length);
  const customerRows: Array<[string, string | null]> = [
    ['Name', payload.customer.name],
    ['Firm', payload.customer.business_name],
    ['Vehicle', payload.customer.vehicle_number],
    ['Mechanic', payload.customer.mechanic_name],
    ['Phone', payload.customer.phone],
  ];

  return (
    <article className={`bill print-profile-${payload.print_profile.toLowerCase()}`}>
      {/* A reprint says so. The server decides when, from `print.mark_reprints_duplicate`. */}
      {payload.is_duplicate ? (
        <div className="bill__duplicate">{PRINT.duplicateCopy}</div>
      ) : null}

      <header className="bill__business">
        <div className="bill__business-name">{payload.business.display_name}</div>
        {payload.business.address_lines.map((line, index) => (
          <div className="bill__business-line" key={`address-${index}`}>
            {line}
          </div>
        ))}
        {payload.business.phone_numbers.length > 0 ? (
          <div className="bill__business-line">
            {payload.business.phone_numbers.join(', ')}
          </div>
        ) : null}
        {/* The label and the value both come from the server, and both are absent until
            the owner supplies an identifier (OD-4). Nothing is invented. */}
        {payload.business.tax_identifier && payload.business.tax_identifier_label ? (
          <div className="bill__business-line">
            {payload.business.tax_identifier_label}: {payload.business.tax_identifier}
          </div>
        ) : null}
      </header>

      {/* Server-decided, never a client literal. It is `ESTIMATE` for cash and credit
          alike and can never read otherwise until the FR-TAX-003 gate passes. */}
      <div className="bill__title">{payload.document_title}</div>

      <section className="bill__customer">
        <div className="bill__customer-row">Date</div>
        <div className="bill__customer-row">
          {formatIssuedAt(payload.issued_at, payload.date_format)}
        </div>
        {customerRows.map(([label, value]) =>
          value ? (
            <div key={label} style={{ display: 'contents' }}>
              <div className="bill__customer-row">{label}</div>
              <div className="bill__customer-row">{value}</div>
            </div>
          ) : null,
        )}
      </section>

      <table className="bill__items">
        <thead>
          <tr>
            {/* The owner's own column headers, from `lib/strings.ts`, deliberately not
                the on-screen labels: the app is not a spreadsheet replica, the bill is. */}
            <th scope="col">{PRINT.columnSerial}</th>
            <th scope="col">{PRINT.columnItem}</th>
            <th scope="col">{PRINT.columnQuantity}</th>
            <th scope="col">{PRINT.columnPrice}</th>
            <th scope="col">{PRINT.columnTotal}</th>
          </tr>
        </thead>
        <tbody>
          {payload.lines.map((line) => (
            <tr key={line.sl_no}>
              <td>{line.sl_no}</td>
              <td>{line.item}</td>
              <td>{quantity(line.quantity)}</td>
              <td>{amount(line.price, policy)}</td>
              <td>{amount(line.total, policy)}</td>
            </tr>
          ))}
          {Array.from({ length: fillerCount }, (_, index) => (
            <tr className="is-filler" key={`filler-${index}`}>
              {/* Five empty cells. Blank, not zero. */}
              <td />
              <td />
              <td />
              <td />
              <td />
            </tr>
          ))}
        </tbody>
      </table>

      <table className="bill__totals">
        <tbody>
          {/* A zero discount row is noise on a bill that has no discount. */}
          {parseMoney(payload.totals.discount).gt(0) ? (
            <tr>
              <td>Discount</td>
              <td>{amount(payload.totals.discount, policy)}</td>
            </tr>
          ) : null}
          {/* `null` means no tax row **at all** (FR-PRINT-012). */}
          {payload.totals.tax !== null ? (
            <tr>
              <td>Tax</td>
              <td>{amount(payload.totals.tax, policy)}</td>
            </tr>
          ) : null}
          {parseMoney(payload.totals.rounding).isZero() ? null : (
            <tr>
              <td>Rounding</td>
              <td>{amount(payload.totals.rounding, policy)}</td>
            </tr>
          )}
          <tr className="bill__grand-total">
            <td>{PRINT.grandTotal}</td>
            <td>{amount(payload.totals.grand_total, policy)}</td>
          </tr>
        </tbody>
      </table>

      {/* The credit block: Paid, Balance, Due. Shown only when the server says so, and
          the figures are the **true recorded** ones, never recomputed here
          (FR-PRINT-020, OD-22). A cash bill omits the block entirely. */}
      {payload.show_credit_block ? (
        <section className="bill__credit">
          <div className="bill__credit-row">
            <span>{PRINT.paid}</span>
            <span>{amount(payload.payment.amount_paid, policy)}</span>
          </div>
          <div className="bill__credit-row">
            <span>{PRINT.balance}</span>
            <span>{amount(payload.payment.outstanding, policy)}</span>
          </div>
          {payload.payment.due_date ? (
            <div className="bill__credit-row">
              <span>{PRINT.due}</span>
              <span>{formatIssuedAt(payload.payment.due_date, payload.date_format)}</span>
            </div>
          ) : null}
        </section>
      ) : null}

      <footer className="bill__footer">
        {payload.footer_notes.map((note, index) => (
          <div key={`note-${index}`}>{note}</div>
        ))}
        <div className="bill__footer-marks">
          {/*
            T3-12. The two marks from the owner's own workbook, at the size and position
            the workbook gives them: `xl/media/image1.jpeg` and `image2.jpeg`, anchored
            at row 34 in columns 0 and 4 — bottom-left and bottom-right of the bill —
            with `xdr:ext` of 252615x264566 and 267485x297154 EMU, which at 36 000 EMU
            per millimetre is 7.02x7.35mm and 7.43x8.25mm. Those figures are in
            `print.css`, not guessed.

            They are decorative, so `alt` is empty and `aria-hidden` is set: a screen
            reader announcing "image" twice at the end of a bill adds nothing, and these
            carry no information the text does not.
          */}
          <img className="bill__mark" src={logoLeft} alt="" aria-hidden="true" />
          <div className="bill__thanks">{PRINT.thankYou}</div>
          <img
            className="bill__mark bill__mark--right"
            src={logoRight}
            alt=""
            aria-hidden="true"
          />
        </div>
      </footer>

      {/*
        `payload.amount_in_words` is deliberately **not rendered**. It is carried in the
        contract, but an amount-in-words line is verified absent from the owner's
        workbook (OD-5), and this layout reproduces the workbook.
      */}
    </article>
  );
}

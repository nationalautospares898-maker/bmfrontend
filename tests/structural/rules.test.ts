/**
 * Structural rules (§12). These enforce `CLAUDE.md §5` rules 1, 2, 3, 9, 10, 14, 16
 * and 17 by reading the source, because each one is invisible at runtime until it has
 * already caused harm:
 *
 * - a token in `localStorage` only matters once there is an XSS;
 * - `Number(price)` only matters once a total is wrong on a bill;
 * - a cached `/api/` response only matters once a stale stock figure sells something
 *   twice.
 *
 * Keep these passing rather than weakening them (§13).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');

function sourceFiles(dir: string, extensions = ['.ts', '.tsx']): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Generated API types are never hand-edited and are excluded from these rules.
      if (entry === 'generated' || entry === 'node_modules') continue;
      found.push(...sourceFiles(full, extensions));
    } else if (extensions.some((ext) => entry.endsWith(ext))) {
      found.push(full);
    }
  }
  return found;
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/**
 * Source with comments removed.
 *
 * Several rules below forbid a *renderable literal* — `Tax Invoice`, `BILL`,
 * `INVOICE`. A comment explaining why the literal is forbidden must not itself trip the
 * rule, or the rule becomes impossible to document and the next person deletes the
 * explanation instead of keeping it. Stripping comments first makes the check mean what
 * it says: no such string can reach a customer's screen or bill.
 */
function readCode(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const ALL_SOURCES = sourceFiles(SRC);
const NON_TEST_SOURCES = ALL_SOURCES.filter((f) => !/\.test\.tsx?$/.test(f));

describe('rule 3 — money arithmetic lives only in src/lib/money.ts (ADR-013)', () => {
  it('no other file parses money with parseFloat or Number()', () => {
    const offenders = NON_TEST_SOURCES.filter(
      (file) => !file.endsWith(join('lib', 'money.ts')),
    ).filter((file) => /\bparseFloat\s*\(|\bNumber\s*\(/.test(read(file)));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('no other file imports the decimal library directly', () => {
    const offenders = NON_TEST_SOURCES.filter(
      (file) => !file.endsWith(join('lib', 'money.ts')),
    ).filter((file) => /from\s+['"]decimal\.js/.test(read(file)));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});

describe('rule 1 — no secret may exist in this repository (NFR-SEC-012)', () => {
  it('only the four allow-listed VITE_ variables are referenced', () => {
    const allowed = new Set([
      'VITE_API_BASE_URL',
      'VITE_APP_VERSION',
      'VITE_SENTRY_DSN',
      'VITE_ENABLE_DEVTOOLS',
    ]);
    const referenced = new Set<string>();
    for (const file of [...ALL_SOURCES, join(ROOT, 'vite.config.ts')]) {
      for (const match of read(file).matchAll(/VITE_[A-Z0-9_]+/g)) {
        referenced.add(match[0]);
      }
    }
    expect([...referenced].filter((name) => !allowed.has(name))).toEqual([]);
  });

  it('no database URL, signing key or storage credential appears anywhere', () => {
    const forbidden =
      /DATABASE_URL|JWT_SIGNING_KEY|PASSWORD_PEPPER|IP_HASH_PEPPER|postgres(ql)?:\/\/|AWS_SECRET|PRIVATE_KEY/;
    const offenders = ALL_SOURCES.filter((file) => forbidden.test(read(file)));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});

describe('rule 3 of §4 — the access token is never persisted', () => {
  it('no source writes to localStorage or sessionStorage', () => {
    // `readCode`, for the reason this file already gives above: a comment in
    // `api/session.ts` explaining that the token is never put in `localStorage` must
    // not itself trip the rule, or the next person deletes the explanation instead of
    // keeping it. The check still means exactly what it says — no source may *use*
    // either API.
    const offenders = NON_TEST_SOURCES.filter((file) =>
      /\b(localStorage|sessionStorage)\b/.test(readCode(file)),
    );
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});

describe('rule 14 — every request goes through src/api/', () => {
  it('no fetch or axios call originates outside src/api/', () => {
    const apiDir = join('src', 'api');
    const offenders = NON_TEST_SOURCES.filter(
      (file) => !relative(ROOT, file).startsWith(apiDir),
    ).filter((file) => /\bfetch\s*\(|from\s+['"]axios['"]/.test(read(file)));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});

describe('rule 10 — the literal "Tax Invoice" must not appear in src/', () => {
  it('no document title is invented client-side', () => {
    // The title comes from `print_payload.document_title`, and the server cannot emit
    // `TAX INVOICE` until the FR-TAX-003 gate passes (ADR-020, FR-PRINT-021).
    const forbidden = /Tax Invoice|TAX INVOICE/;
    const offenders = NON_TEST_SOURCES.filter((file) => forbidden.test(readCode(file)));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('BILL and INVOICE do not appear as document-title literals', () => {
    // FR-PRINT-021 / OD-24: the label is `ESTIMATE` for cash and credit alike.
    const offenders = NON_TEST_SOURCES.filter((file) =>
      /['"`](BILL|INVOICE)['"`]/.test(readCode(file)),
    );
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});

describe('rule 9 / ADR-022 — there is no paid control anywhere', () => {
  it('no source renders a paid/unpaid toggle, checkbox or input', () => {
    // `payment_status` is derived, written only in the same transaction as the
    // allocations. There is no "mark as paid" endpoint and no checkbox for it.
    const offenders = NON_TEST_SOURCES.filter((file) =>
      /(markAsPaid|setPaid|isPaidInput|paidCheckbox|togglePaid)/i.test(readCode(file)),
    );
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});

describe('OD-3 — no invoice number is ever rendered', () => {
  it('no source reads an invoice number from the print payload', () => {
    // T3-06: `print_payload` carries none, the client renders none, and no replacement
    // visible numbering scheme is invented. The internal reference stays on the invoice
    // resource for audit and appears only on a detail view, labelled as internal.
    const offenders = NON_TEST_SOURCES.filter((file) =>
      /print_payload[\s\S]{0,80}invoice_number|printPayload[\s\S]{0,80}invoiceNumber/.test(
        readCode(file),
      ),
    );
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});

describe('rule 17 / ADR-031 — the service worker caches the app shell only', () => {
  const viteConfig = read(join(ROOT, 'vite.config.ts'));

  it('no /api/ route appears in the service-worker cache configuration', () => {
    // A cached stock figure is how something gets sold twice.
    const runtimeCaching = /runtimeCaching:\s*\[\s*\]/.test(viteConfig);
    expect(runtimeCaching).toBe(true);
  });

  it('api routes are explicitly excluded from the navigation fallback', () => {
    expect(viteConfig).toMatch(/navigateFallbackDenylist/);
    expect(viteConfig).toMatch(/\^\\\/api\\\//);
  });

  it('the service worker does not claim clients or skip waiting silently', () => {
    // A stale cached client must not persist indefinitely after a security fix, but the
    // update has to be a deliberate prompt rather than a reload mid-sale.
    expect(viteConfig).toMatch(/skipWaiting:\s*false/);
    expect(viteConfig).toMatch(/clientsClaim:\s*false/);
    expect(viteConfig).toMatch(/registerType:\s*'prompt'/);
  });
});

describe('OD-14 — exactly four primary actions, and no fifth', () => {
  it('the labels are the owner-decided strings', () => {
    const strings = read(join(SRC, 'lib', 'strings.ts'));
    expect(strings).toMatch(/printBill: 'Print Bill'/);
    expect(strings).toMatch(/creditBill: 'Credit Bill'/);
    expect(strings).toMatch(/saveDraft: 'Save a Draft'/);
    expect(strings).toMatch(/clearDraft: 'Clear Draft'/);
  });

  it('no rejected credit-details component is reinstated', () => {
    // An earlier Phase 1 draft specified a mandatory credit-details form. That design
    // is superseded (OD-21, ADR-033, audit CF-4) — `Credit Bill` finalises in one
    // request with no intermediate dialog. Any surviving mention is a rejected design,
    // never an instruction.
    const offenders = ALL_SOURCES.filter((file) =>
      /CreditDetailsForm|CreditDetailsPage|credit-details/i.test(readCode(file)),
    );
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});

describe('§10 — no HTTP status code or jargon is shown to a counter user', () => {
  it('user-facing strings contain no status codes or stack-trace wording', () => {
    const strings = readCode(join(SRC, 'lib', 'strings.ts'));
    expect(strings).not.toMatch(/\b(400|401|403|404|409|422|429|500|503)\b/);
    expect(strings).not.toMatch(/Traceback|stack trace|exception/i);
  });

  it('every error string says what to do next, not only what failed', () => {
    // A message a cashier cannot act on is the same as no message while a customer
    // waits.
    const strings = read(join(SRC, 'lib', 'strings.ts'));
    for (const phrase of [
      'Ask a supervisor',
      'Try again',
      'check Daily Bills',
      'Reload',
    ]) {
      expect(strings).toContain(phrase);
    }
  });
});

describe('ADR-028 — the print layout is isolated from application styling', () => {
  it('index.html provides a dedicated print root', () => {
    expect(read(join(ROOT, 'index.html'))).toMatch(/id="print-root"/);
  });

  it('a strict CSP is declared', () => {
    const html = read(join(ROOT, 'index.html'));
    expect(html).toMatch(/Content-Security-Policy/);
    expect(html).toMatch(/default-src 'self'/);
    expect(html).toMatch(/frame-ancestors 'none'/);
  });

  it('dangerouslySetInnerHTML is never used', () => {
    const offenders = ALL_SOURCES.filter((file) =>
      /dangerouslySetInnerHTML/.test(read(file)),
    );
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});

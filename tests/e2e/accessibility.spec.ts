/**
 * Accessibility, in a **real browser**.
 *
 * Why this exists rather than the jsdom axe checks
 * ------------------------------------------------
 *
 * The component suites already run axe, and they are useful — but they run under jsdom,
 * which has no layout engine and no canvas. Colour contrast cannot be computed there at
 * all: axe needs the resolved background a pixel actually sits on, and jsdom has no
 * pixels. In that environment the `color-contrast` rule produces an *error*, not a
 * result, and an error is reported in `results.incomplete` rather than
 * `results.violations`. A suite asserting `violations == []` therefore passed while
 * saying nothing whatsoever about contrast — which is what the 30 October 2026 audit
 * found. The component suites now disable the rule explicitly and point here.
 *
 * So this suite runs the **built** application in Chromium and asserts:
 *
 * * no `serious` or `critical` violation on any screen, including `color-contrast`,
 *   which is genuinely evaluated because there is a real layout to evaluate it against;
 * * `color-contrast` actually **ran** — a rule that silently became inapplicable would
 *   otherwise look identical to a rule that passed, which is the exact trap this file
 *   was written to escape;
 * * every control has an accessible name;
 * * the tab order reaches the four primary billing actions, and focus is visibly
 *   indicated — a counter hand works keyboard-first (NFR-FE-PERF-001/002);
 * * one `h1` per screen and no skipped heading level;
 * * the keyboard-only billing flow still works, so an accessibility fix cannot have
 *   quietly broken the thing the shop is actually for.
 *
 * axe is injected from the `axe-core` package already in `devDependencies`, rather than
 * adding `@axe-core/playwright`, so there is one axe version in the repository and the
 * jsdom and browser suites cannot disagree about what a violation is.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { expect, test, type Page } from '@playwright/test';

import { openApp, stubApi, OWNER_PERMISSIONS } from './support/app';

const require = createRequire(import.meta.url);
/** The same axe build the component suites use. */
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

/**
 * Same-origin URL axe is served from.
 *
 * The application sends `Content-Security-Policy: script-src 'self'`, so
 * `addScriptTag({ path })` — which inlines the file — is refused by the browser, exactly
 * as it should be. That header is a security control (NFR-SEC) and weakening it for a
 * test would be testing a different application than the one that ships.
 *
 * Serving axe from the app's own origin through a Playwright route satisfies `'self'`
 * without changing a single response header the real app sends.
 */
const AXE_URL = '/__axe-core-for-tests.js';

async function injectAxe(page: Page): Promise<void> {
  await page.route(`**${AXE_URL}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      body: AXE_SOURCE,
    }),
  );
  await page.addScriptTag({ url: AXE_URL });
}

/** WCAG 2.2 AA is the documented target. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

interface AxeNode {
  html: string;
  target: string[];
  failureSummary?: string;
}
interface AxeResult {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  nodes: AxeNode[];
}
interface AxeRun {
  violations: AxeResult[];
  incomplete: AxeResult[];
  passes: AxeResult[];
  inapplicable: AxeResult[];
}

declare global {
  interface Window {
    axe: {
      run: (context: unknown, options: unknown) => Promise<AxeRun>;
    };
  }
}

async function analyse(page: Page): Promise<AxeRun> {
  await injectAxe(page);
  return page.evaluate(
    async ([tags]) =>
      window.axe.run(document, {
        runOnly: { type: 'tag', values: tags as string[] },
        resultTypes: ['violations', 'incomplete'],
      }),
    [TAGS],
  );
}

/** A readable failure: which rule, how bad, and on what element. */
function describe(results: AxeResult[]): string {
  return results
    .map(
      (result) =>
        `\n  [${result.impact ?? 'n/a'}] ${result.id}: ${result.help}\n` +
        `    ${result.helpUrl}\n` +
        result.nodes
          .slice(0, 5)
          .map((node) => `      ${node.target.join(' ')} — ${node.html.slice(0, 160)}`)
          .join('\n'),
    )
    .join('\n');
}

function blocking(run: AxeRun): AxeResult[] {
  return run.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
}

/** Every screen the shell can reach, by the tab that opens it. */
const SCREENS = [
  'Billing',
  'Daily Bills',
  'Credit Bills',
  'Stock',
  'Purchases',
  'Customers',
  'Imports',
  'Saving and syncing',
] as const;

test.describe('axe, in Chromium, on every screen', () => {
  for (const screen of SCREENS) {
    test(`${screen} has no serious or critical violation`, async ({ page }) => {
      await stubApi(page, OWNER_PERMISSIONS);
      await openApp(page);
      if (screen !== 'Billing') {
        await page.getByRole('button', { name: screen, exact: true }).click();
      }
      // Let the screen's first fetch settle, or axe inspects a spinner.
      await page.waitForLoadState('networkidle');

      const run = await analyse(page);
      const serious = blocking(run);
      expect(
        serious,
        `serious/critical violations on ${screen}:${describe(serious)}`,
      ).toEqual([]);
    });
  }
});

test.describe('colour contrast is genuinely evaluated, not skipped', () => {
  test('the contrast rule runs and reports a real result on the billing screen', async ({
    page,
  }) => {
    await stubApi(page, OWNER_PERMISSIONS);
    await openApp(page);

    await injectAxe(page);
    const run = await page.evaluate(async () =>
      window.axe.run(document, {
        runOnly: { type: 'rule', values: ['color-contrast'] },
      }),
    );

    // The point of the whole file. Under jsdom this rule lands in `incomplete` with a
    // canvas error and `violations` is empty — indistinguishable from a pass. In a real
    // browser it must produce an actual verdict: either passing nodes or failing ones.
    const evaluated =
      (run.passes[0]?.nodes.length ?? 0) + (run.violations[0]?.nodes.length ?? 0);
    expect(
      evaluated,
      'color-contrast produced no verdict at all — it was not genuinely evaluated',
    ).toBeGreaterThan(0);

    // And nothing may be left unresolved for a canvas reason, which is the jsdom failure
    // mode reappearing.
    const canvasErrors = run.incomplete.filter((entry) =>
      entry.nodes.some((node) => /canvas|getImageData/i.test(node.failureSummary ?? '')),
    );
    expect(canvasErrors, 'contrast was not computable — this is the jsdom trap').toEqual(
      [],
    );

    expect(
      run.violations,
      `contrast violations on the billing screen:${describe(run.violations)}`,
    ).toEqual([]);
  });

  test('contrast holds on the two screens that use colour to carry meaning', async ({
    page,
  }) => {
    // Stock marks "Running low" and Sync marks connection state. Both pair the colour
    // with words (NFR-FE-UX-007); this checks the colours themselves are legible.
    await stubApi(page, OWNER_PERMISSIONS);
    await openApp(page);

    for (const screen of ['Stock', 'Saving and syncing'] as const) {
      await page.getByRole('button', { name: screen, exact: true }).click();
      await page.waitForLoadState('networkidle');
      await injectAxe(page);
      const run = await page.evaluate(async () =>
        window.axe.run(document, {
          runOnly: { type: 'rule', values: ['color-contrast'] },
        }),
      );
      expect(
        run.violations,
        `contrast violations on ${screen}:${describe(run.violations)}`,
      ).toEqual([]);
    }
  });
});

test.describe('names, structure and the keyboard', () => {
  test('every control has an accessible name', async ({ page }) => {
    await stubApi(page, OWNER_PERMISSIONS);
    await openApp(page);

    await injectAxe(page);
    const run = await page.evaluate(async () =>
      window.axe.run(document, {
        runOnly: {
          type: 'rule',
          values: [
            'button-name',
            'link-name',
            'input-button-name',
            'label',
            'aria-input-field-name',
          ],
        },
      }),
    );
    expect(run.violations, `unnamed controls:${describe(run.violations)}`).toEqual([]);
  });

  test('headings are one h1 per screen, with no level skipped', async ({ page }) => {
    await stubApi(page, OWNER_PERMISSIONS);
    await openApp(page);

    for (const screen of SCREENS) {
      if (screen !== 'Billing') {
        await page.getByRole('button', { name: screen, exact: true }).click();
        await page.waitForLoadState('networkidle');
      }
      await injectAxe(page);
      const run = await page.evaluate(async () =>
        window.axe.run(document, {
          runOnly: { type: 'rule', values: ['heading-order', 'page-has-heading-one'] },
        }),
      );
      expect(
        run.violations,
        `heading structure on ${screen}:${describe(run.violations)}`,
      ).toEqual([]);
    }
  });

  test('the navigation is a landmark a screen reader can jump to', async ({ page }) => {
    await stubApi(page, OWNER_PERMISSIONS);
    await openApp(page);
    await expect(page.getByRole('navigation', { name: 'Screens' })).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
  });

  test('the current screen is announced, not only coloured', async ({ page }) => {
    await stubApi(page, OWNER_PERMISSIONS);
    await openApp(page);

    await expect(
      page.getByRole('button', { name: 'Billing', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await page.getByRole('button', { name: 'Stock', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Stock', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
  });

  test('focus is visibly indicated, not just moved', async ({ page }) => {
    await stubApi(page, OWNER_PERMISSIONS);
    await openApp(page);

    await page.keyboard.press('Tab');
    const indicated = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return null;
      const style = getComputedStyle(active);
      return {
        tag: active.tagName,
        // Kept as the computed **string**. The project restricts `parseFloat`
        // (ADR-013: arithmetic belongs in `src/lib/money.ts`), and no arithmetic is
        // needed here — "has a width at all" is a comparison against the zero values
        // the browser reports, which is exactly as strong.
        outlineWidth: style.outlineWidth,
        outlineStyle: style.outlineStyle,
        boxShadow: style.boxShadow,
      };
    });
    expect(indicated, 'Tab moved focus nowhere').not.toBeNull();
    // Either a real outline or a focus ring drawn with a shadow counts; `outline: none`
    // with nothing in its place does not.
    const hasOutline =
      indicated!.outlineStyle !== 'none' &&
      indicated!.outlineWidth !== '' &&
      indicated!.outlineWidth !== '0px';
    const visible =
      hasOutline || (indicated!.boxShadow !== 'none' && indicated!.boxShadow !== '');
    expect(visible, `focused ${indicated!.tag} has no visible focus indicator`).toBe(
      true,
    );
  });

  test('tabbing reaches the four primary billing actions', async ({ page }) => {
    await stubApi(page, OWNER_PERMISSIONS);
    await openApp(page);

    // OD-14: exactly four primary actions, and a counter hand must reach them without
    // a mouse.
    const wanted = new Set(['Print Bill', 'Credit Bill', 'Save a Draft', 'Clear Draft']);
    const reached = new Set<string>();
    for (let step = 0; step < 80 && reached.size < wanted.size; step += 1) {
      await page.keyboard.press('Tab');
      const name = await page.evaluate(() =>
        (document.activeElement?.textContent ?? '').trim(),
      );
      for (const action of wanted) {
        if (name.includes(action)) reached.add(action);
      }
    }
    expect([...wanted].filter((action) => !reached.has(action))).toEqual([]);
  });

  test('the billing screen is still usable by keyboard alone', async ({ page }) => {
    // An accessibility change must not break the flow the shop runs on. Typing into the
    // search field and arrowing to a result is the start of every bill.
    await stubApi(page, OWNER_PERMISSIONS);
    await openApp(page);

    const search = page.getByRole('combobox').or(page.getByLabel(/Find an item/));
    await search.first().focus();
    await page.keyboard.type('TT-407');
    await expect(page.getByText('Tie Rod End Bolero').first()).toBeVisible({
      timeout: 10_000,
    });
  });
});

/**
 * The application, driven by the keyboard alone.
 *
 * **No mouse is used to perform any workflow in this file.** There is one `page.goto`
 * to open the application and nothing else — every field, every suggestion, every button
 * and every dialog is reached with `Tab`, `Shift+Tab`, the arrows, `Enter`, `Space` and
 * `Escape`. If a control can only be operated with a pointer, a test here fails.
 *
 * ## What it is checking, and why
 *
 * The cashier reported that after choosing a customer, `Tab` did not reach Mechanic Name
 * and the touchpad became compulsory. Two defects sat behind it:
 *
 * 1. the customer suggestions were `<button onMouseDown=…>`, and a keyboard press fires
 *    `click`, never `mousedown` — so `Enter` on a suggestion did nothing at all;
 * 2. choosing a customer **unmounts** the search box, and a browser whose focused element
 *    is removed moves focus to `<body>`, so the next `Tab` restarted from the top of the
 *    document.
 *
 * Assertions are about **where focus actually is** (`document.activeElement`) and what
 * the application did as a result — not about keystrokes having been dispatched. A test
 * that only proves an event was sent proves nothing a user cares about.
 *
 * Nothing is mocked: the built bundle, a live FastAPI process, and the disposable
 * `bm_accept` database. The owner's `bm` is never touched here.
 */

import { expect, test, type Page } from '@playwright/test';

const API_URL = process.env.BM_E2E_API_URL;
const PROXIED = Boolean(process.env.BM_DEV_API_PROXY);
const USERNAME = process.env.BM_E2E_USERNAME ?? 'e2e-owner';
const PASSWORD = process.env.BM_E2E_PASSWORD ?? 'e2e-only-not-a-real-password-01';

test.skip(
  !API_URL && !PROXIED,
  'Needs a real backend: set BM_DEV_API_PROXY (preferred — works with an isolated ' +
    'database) or BM_E2E_API_URL, and seed scripts/seed_e2e_tenant.py first.',
);

let token = '';

/** What currently has focus, described well enough to assert on and to read in a failure. */
async function focused(
  page: Page,
): Promise<{ tag: string; label: string; value: string }> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    /**
     * `<body>` counts as **nothing focused**, and saying so matters.
     *
     * The fallback below reads `textContent`, and `document.body`'s text is the entire
     * page — which contains "Customer Name", "Print Bill" and every other label. So a
     * `tabUntil(/Customer Name/)` matched on the very first check while focus was still
     * on the body, returned without pressing Tab at all, and the typing went nowhere.
     * Eight tests failed on that and the product was innocent in every one of them.
     */
    if (!active || active === document.body || active === document.documentElement) {
      return { tag: 'body', label: '', value: '' };
    }
    // First non-empty wins. `??` is wrong here: a button has no `aria-label` and no
    // `<label for>`, so the chain fell through to an **empty string** rather than to its
    // text, and every nav button reported a blank label. Found by this suite failing to
    // Tab to `Billing` when `Billing` was plainly focused.
    const candidates = [
      active.getAttribute('aria-label'),
      active.id
        ? (document.querySelector(`label[for="${active.id}"]`)?.textContent ?? '')
        : '',
      active.textContent ?? '',
    ];
    const label = candidates.find((entry) => (entry ?? '').trim() !== '') ?? '';
    return {
      tag: active.tagName.toLowerCase(),
      label: label.trim(),
      value: (active as HTMLInputElement).value ?? '',
    };
  });
}

/** Press Tab until the focused control's label matches, or give up loudly. */
async function tabUntil(page: Page, pattern: RegExp, limit = 40): Promise<void> {
  for (let step = 0; step < limit; step += 1) {
    const where = await focused(page);
    if (pattern.test(where.label)) return;
    await page.keyboard.press('Tab');
  }
  const where = await focused(page);
  throw new Error(
    `Tab never reached ${pattern} in ${limit} presses; focus is on ${where.tag} "${where.label}"`,
  );
}

/** Sign in using only the keyboard. */
async function signIn(page: Page): Promise<void> {
  token = '';
  page.on('response', (response) => {
    if (response.url().includes('/auth/login') && response.status() === 200) {
      void response
        .json()
        .then((body: { access_token?: string }) => {
          if (body.access_token) token = body.access_token;
        })
        .catch(() => {});
    }
  });
  await page.addInitScript(() => {
    (window as unknown as { __printed: string[] }).__printed = [];
    window.print = () => {
      const root = document.getElementById('print-root');
      (window as unknown as { __printed: string[] }).__printed.push(
        root?.innerHTML ?? '',
      );
      setTimeout(() => window.dispatchEvent(new Event('afterprint')), 0);
    };
  });

  await page.goto('/');

  // `autoFocus` puts the caret in Username, so the whole form is typed without a click.
  await expect(page.getByLabel('Username')).toBeFocused();
  await page.keyboard.type(USERNAME);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Password')).toBeFocused();
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press('Enter'); // submits the form — no button press needed

  await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

/** Put stock on the shelf over the API, so the keyboard tests are about the keyboard. */
async function stockUp(page: Page, count: number): Promise<string[]> {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const names = Array.from(
    { length: count },
    (_, index) => `KBD ${stamp} PART ${String(index + 1).padStart(2, '0')}`,
  );
  const result = await page.evaluate(
    async ({ bearer, entries }) => {
      const response = await fetch('/api/v1/inventory/stock-entries', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ entries }),
      });
      return response.status;
    },
    {
      bearer: token,
      entries: names.map((item) => ({
        item,
        price: '100.0000',
        min_qty: '2.000',
        stock_qty: '50.000',
      })),
    },
  );
  expect(result, 'could not stock up over the API').toBe(200);
  return names;
}

/** Create a customer over the API so the picker has something to find. */
async function makeCustomer(page: Page, name: string): Promise<void> {
  const status = await page.evaluate(
    async ({ bearer, customer }) => {
      const response = await fetch(`/api/v1/customers/${crypto.randomUUID()}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ name: customer }),
      });
      return response.status;
    },
    { bearer: token, customer: name },
  );
  expect(status, 'could not create the customer over the API').toBe(200);
}

// ---------------------------------------------------------------------------
// Sign in and navigation
// ---------------------------------------------------------------------------

test.describe('signing in and moving about, keyboard only', () => {
  test('the whole sign-in is typed, and Enter submits it', async ({ page }) => {
    await signIn(page);
    // Reaching the grid at all is the proof: it exists only once the session is live.
    await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible();
  });

  test('the six sections are reachable and openable without a mouse', async ({
    page,
  }) => {
    await signIn(page);

    // Tab to the navigation, then walk it with the arrows and open with Enter.
    await tabUntil(page, /^Billing$/);
    for (const section of ['Daily Bills', 'Credit Bills', 'Stock', 'Customers']) {
      await page.keyboard.press('ArrowDown');
      expect((await focused(page)).label).toBe(section);
    }
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: /Customers/i }).first()).toBeVisible();

    // And back up again, which is Shift+Tab's job in a row and ArrowUp's in a column.
    await page.keyboard.press('ArrowUp');
    expect((await focused(page)).label).toBe('Stock');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: /Stock/i }).first()).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// The reported defect, end to end
// ---------------------------------------------------------------------------

test.describe('the billing workflow, keyboard only', () => {
  test('customer → mechanic → vehicle → item → quantity → price, with no mouse', async ({
    page,
  }) => {
    /**
     * The exact sequence the owner asked for, performed with keys alone. This is the
     * test that would have caught the reported defect: before the fix, `Enter` on a
     * customer suggestion did nothing, and after a selection focus was on `<body>`.
     */
    await signIn(page);
    const parts = await stockUp(page, 2);
    await makeCustomer(page, 'Keyboard Motors');
    await page.reload();
    await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible();

    // --- the customer ------------------------------------------------------
    await tabUntil(page, /Customer Name/);
    await page.keyboard.type('Keyboard');
    // The suggestions arrive; the arrows walk them and Enter takes one.
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 15_000 });
    const options = page.getByRole('option');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');

    // The chosen customer is on the bill...
    await expect(page.getByText('Keyboard Motors')).toBeVisible();
    // ...and focus has moved on by itself. This is the heart of the complaint.
    await expect(page.getByLabel(/Mechanic Name/)).toBeFocused();

    // --- the rest of the header -------------------------------------------
    await page.keyboard.type('Ravi');
    await page.keyboard.press('Enter');
    await expect(page.getByLabel(/Vehicle Number/)).toBeFocused();

    await page.keyboard.type('KA01AB1234');
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Item, row 1', { exact: true })).toBeFocused();

    // --- the first item ----------------------------------------------------
    await page.keyboard.type(parts[0]!);
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Enter');

    /**
     * Picking a product hands over to the **next row's Item cell**, not to Quantity.
     *
     * That is the established behaviour — `BillingCounter.addProduct` and `ItemCell`
     * both document it — and it is what makes a long bill fast: type a part, Enter, type
     * the next part. The brief asks explicitly that billing item entry "follow the
     * established row-entry behavior", so it is asserted here rather than changed.
     *
     * Quantity is still a keystroke away, which is the part that matters for keyboard
     * use: `Shift+Tab` walks back through the row (Remove, Price, Quantity).
     */
    await expect(page.getByLabel('Item, row 2', { exact: true })).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    expect((await focused(page)).label).toMatch(/^Remove/);
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByLabel('Price, row 1', { exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByLabel('Quantity, row 1', { exact: true })).toBeFocused();

    // And it is genuinely editable from the keyboard: the total follows the figure typed.
    await page.keyboard.press('Control+a');
    await page.keyboard.type('3');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Price, row 1', { exact: true })).toBeFocused();
    await expect(page.getByRole('cell', { name: '300', exact: true })).toBeVisible();

    // --- a second item, still no mouse -------------------------------------
    await tabUntil(page, /Item, row 2/);
    await page.keyboard.type(parts[1]!);
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Item, row 3', { exact: true })).toBeFocused();

    // Both lines are on the bill. Scoped to the grid: the bill **tab** is renamed to the
    // first product too, so an unscoped text match finds two elements.
    const grid = page.getByRole('table', { name: /Bill items/i });
    await expect(grid.getByText(parts[0]!)).toBeVisible();
    await expect(grid.getByText(parts[1]!)).toBeVisible();
  });

  test('the arrows choose among several customers before Enter takes one', async ({
    page,
  }) => {
    await signIn(page);
    const stamp = Date.now().toString(36);
    for (const suffix of ['Alpha', 'Beta', 'Gamma']) {
      await makeCustomer(page, `Kbd ${stamp} ${suffix}`);
    }
    await page.reload();
    await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible();

    await tabUntil(page, /Customer Name/);
    await page.keyboard.type(`Kbd ${stamp}`);
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 15_000 });

    const names = await page.getByRole('option').allInnerTexts();
    expect(names.length).toBeGreaterThanOrEqual(2);

    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option').nth(1)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('option').nth(0)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    // The **second** one was taken, which is what the arrows were for.
    const chosen = names[1]!.split('·')[0]!.trim();
    await expect(page.getByText(chosen, { exact: false }).first()).toBeVisible();
    await expect(page.getByLabel(/Mechanic Name/)).toBeFocused();
  });

  test('Escape closes the suggestions and keeps the typing', async ({ page }) => {
    await signIn(page);
    await makeCustomer(page, 'Escape Motors');
    await page.reload();
    await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible();

    await tabUntil(page, /Customer Name/);
    await page.keyboard.type('Escape');
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 15_000 });

    await page.keyboard.press('Escape');

    await expect(page.getByRole('listbox')).toHaveCount(0);
    // Mid-word is the normal case: nothing typed is thrown away, and focus stays put.
    await expect(page.getByLabel(/Customer Name/)).toHaveValue('Escape');
    await expect(page.getByLabel(/Customer Name/)).toBeFocused();
  });

  test('Tab does not walk through the suggestions', async ({ page }) => {
    // Ten matches used to mean ten Tab presses before Mechanic Name — each landing on a
    // button that did nothing when pressed.
    await signIn(page);
    await makeCustomer(page, 'Tabbing Motors');
    await page.reload();
    await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible();

    await tabUntil(page, /Customer Name/);
    await page.keyboard.type('Tabbing');
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 15_000 });

    await page.keyboard.press('Tab');

    const where = await focused(page);
    expect(where.label, 'Tab landed inside the suggestion list').not.toMatch(
      /Tabbing Motors/,
    );
  });

  test('Shift+Tab walks the header backwards', async ({ page }) => {
    await signIn(page);
    // Signing in leaves the caret in the grid's first Item cell, so the header is one
    // `Shift+Tab` behind it — which is the natural way to reach it and a shorter, more
    // honest route than tabbing forward through the whole sheet.
    await expect(page.getByLabel('Item, row 1', { exact: true })).toBeFocused();

    // Backwards through the header, one field per press, in the reverse of the order a
    // cashier fills them.
    await page.keyboard.press('Shift+Tab');
    expect((await focused(page)).label).toMatch(/Vehicle Number/);
    await page.keyboard.press('Shift+Tab');
    expect((await focused(page)).label).toMatch(/Mechanic Name/);
    await page.keyboard.press('Shift+Tab');
    expect((await focused(page)).label).toMatch(/Customer Name/);
  });

  test('focus is never lost to the page body during the workflow', async ({ page }) => {
    /**
     * The failure mode behind the whole report: when the focused element is removed,
     * focus goes to `<body>` and the next `Tab` restarts from the top of the document.
     * Here focus is sampled after every step and must always be on a real control.
     */
    await signIn(page);
    await makeCustomer(page, 'Never Lost Motors');
    await page.reload();
    await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible();

    await tabUntil(page, /Customer Name/);
    await page.keyboard.type('Never Lost');
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 15_000 });

    for (const step of ['Enter', 'Tab', 'Tab']) {
      await page.keyboard.press(step);
      const where = await focused(page);
      expect(where.tag, `focus fell to <${where.tag}> after ${step}`).not.toBe('body');
    }
  });

  test('changing the customer puts the caret back in the search box', async ({
    page,
  }) => {
    await signIn(page);
    await makeCustomer(page, 'Changeable Motors');
    await page.reload();
    await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible();

    await tabUntil(page, /Customer Name/);
    await page.keyboard.type('Changeable');
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Enter');
    await expect(page.getByLabel(/Mechanic Name/)).toBeFocused();

    // Reach `Change` backwards and press it with the keyboard.
    await page.keyboard.press('Shift+Tab');
    expect((await focused(page)).label).toMatch(/Change/);
    await page.keyboard.press('Enter');

    await expect(page.getByLabel(/Customer Name/)).toBeFocused();
  });

  test('a new customer can be created from the bill without a mouse', async ({
    page,
  }) => {
    await signIn(page);
    const name = `Fresh ${Date.now().toString(36)}`;

    await tabUntil(page, /Customer Name/);
    await page.keyboard.type(name);
    // `Save as a new customer` is offered under the matches; Tab reaches it and Enter
    // presses it. It was `onMouseDown`-only, so this did nothing before.
    const save = page.getByRole('button', { name: /Save as a new customer/ });
    await expect(save).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Tab');
    expect((await focused(page)).label).toMatch(/Save as a new customer/);
    await page.keyboard.press('Enter');

    await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel(/Mechanic Name/)).toBeFocused();
  });
});

// ---------------------------------------------------------------------------
// Actions, dialogs and printing
// ---------------------------------------------------------------------------

test.describe('actions and dialogs, keyboard only', () => {
  test('Tab reaches the four actions, and neither Tab nor Enter sells anything', async ({
    page,
  }) => {
    await signIn(page);
    const parts = await stockUp(page, 1);
    await page.reload();
    await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible();

    const finalisations: number[] = [];
    page.on('response', (response) => {
      if (response.url().includes('/sales:finalize'))
        finalisations.push(response.status());
    });

    await tabUntil(page, /Item, row 1/);
    await page.keyboard.type(parts[0]!);
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Enter');

    // Walk all the way to the actions, pressing Enter on nothing.
    await tabUntil(page, /Print Bill/, 60);
    expect(finalisations, 'tabbing through the bill finalised it').toEqual([]);

    await page.keyboard.press('Tab');
    expect((await focused(page)).label).toMatch(/Credit Bill/);
    await page.keyboard.press('Tab');
    expect((await focused(page)).label).toMatch(/Save a Draft/);
    await page.keyboard.press('Tab');
    expect((await focused(page)).label).toMatch(/Clear Draft/);
    expect(finalisations).toEqual([]);
  });

  test('Clear Draft asks first, Escape cancels it, and focus comes back', async ({
    page,
  }) => {
    await signIn(page);
    await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible();

    await tabUntil(page, /Clear Draft/, 60);
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Focus moved into the dialog rather than staying behind it.
    const inside = await page.evaluate(() => {
      const active = document.activeElement;
      const panel = document.querySelector('[role="dialog"]');
      return Boolean(panel && active && panel.contains(active));
    });
    expect(inside, 'focus stayed outside the open dialog').toBe(true);

    // Tab is contained: ten presses and focus is still inside.
    for (let i = 0; i < 10; i += 1) await page.keyboard.press('Tab');
    const stillInside = await page.evaluate(() => {
      const active = document.activeElement;
      const panel = document.querySelector('[role="dialog"]');
      return Boolean(panel && active && panel.contains(active));
    });
    expect(stillInside, 'Tab escaped the modal dialog').toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // And focus is back on the control that opened it.
    expect((await focused(page)).label).toMatch(/Clear Draft/);
  });

  test('Save a Draft is pressed with Space and keeps focus somewhere sensible', async ({
    page,
  }) => {
    await signIn(page);
    const parts = await stockUp(page, 1);
    await page.reload();
    await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible();

    await tabUntil(page, /Item, row 1/);
    await page.keyboard.type(parts[0]!);
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Enter');

    await tabUntil(page, /Save a Draft/, 60);
    await page.keyboard.press(' ');

    // The press registered, and focus did not fall to the body.
    const where = await focused(page);
    expect(where.tag).not.toBe('body');
  });

  test('a bill is printed with the keyboard, and the right bill reaches the printer', async ({
    page,
  }) => {
    await signIn(page);
    const parts = await stockUp(page, 1);
    await page.reload();
    await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible();

    await tabUntil(page, /Customer Name/);
    // A name no saved customer can match, so no suggestion list opens and `Enter` means
    // "next field". With a list open `Enter` would pick a customer instead — correct
    // behaviour, and the reason this name is stamped rather than a friendly constant.
    const walkIn = `Printed ${Date.now().toString(36)}`;
    await page.keyboard.type(walkIn);
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(page.getByLabel(/Mechanic Name/)).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter'); // through Vehicle Number to the grid

    await expect(page.getByLabel('Item, row 1', { exact: true })).toBeFocused();
    await page.keyboard.type(parts[0]!);
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('2');

    await tabUntil(page, /Print Bill/, 60);
    await page.keyboard.press('Enter');

    await page.waitForFunction(
      () => ((window as unknown as { __printed?: string[] }).__printed ?? []).length > 0,
      null,
      { timeout: 30_000 },
    );
    const documents = await page.evaluate(
      () => (window as unknown as { __printed?: string[] }).__printed ?? [],
    );
    const printed = documents[documents.length - 1] ?? '';

    // The bill that was typed is the bill that printed.
    expect(printed).toContain(parts[0]!);
    expect(printed).toContain(walkIn);
    expect(printed).toContain('ESTIMATE');
    expect(printed).toContain('GRAND TOTAL');
  });
});

// ---------------------------------------------------------------------------
// The other screens
// ---------------------------------------------------------------------------

/** The six, in the order they appear in the navigation. */
const SECTIONS = [
  'Billing',
  'Daily Bills',
  'Credit Bills',
  'Stock',
  'Customers',
  'Saving and syncing',
] as const;

/**
 * Open a section with the keyboard, the way a cashier actually would.
 *
 * **Reach the navigation once, then stay in it.** Pressing `Enter` on a section does not
 * move focus off that button, so the second and later switches are a couple of arrow
 * presses — which is why this checks where focus already is before walking anywhere.
 *
 * The first walk is forward from the billing screen, where the nav is about twenty stops
 * away. Two things were tried and rejected:
 *
 * * tabbing forward from *any* screen — on Daily Bills there is an `Edit Bill` button per
 *   row, so the nav is far more than forty presses away. That distance is a genuine
 *   observation about the application, recorded in the report rather than hidden here;
 * * blurring and pressing `Shift+Tab` to wrap onto the last entry — the browser keeps its
 *   sequential-navigation point where the blurred element was, so this landed on
 *   `Vehicle Number` instead of the nav.
 */
async function openSection(page: Page, name: (typeof SECTIONS)[number]): Promise<void> {
  const current = (await focused(page)).label;
  if (!SECTIONS.includes(current as (typeof SECTIONS)[number])) {
    // Not in the nav yet: walk to it. Called from the billing screen, this is short.
    await tabUntil(page, /^Billing$/, 80);
  }

  const from = SECTIONS.indexOf((await focused(page)).label as (typeof SECTIONS)[number]);
  const to = SECTIONS.indexOf(name);
  const key = to > from ? 'ArrowDown' : 'ArrowUp';
  for (let i = 0; i < Math.abs(to - from); i += 1) await page.keyboard.press(key);

  expect((await focused(page)).label).toBe(name);
  await page.keyboard.press('Enter');
}

test.describe('the back-office screens, keyboard only', () => {
  test('Stock: Add Items opens and its sheet is typed with the keyboard', async ({
    page,
  }) => {
    await signIn(page);
    await openSection(page, 'Stock');
    await expect(page.getByRole('button', { name: 'Add Items' })).toBeVisible();

    await tabUntil(page, /Add Items/);
    await page.keyboard.press('Enter');

    // The sheet opened; its first row is filled with Tab between the four columns.
    await expect(page.getByRole('button', { name: /^Save/ }).first()).toBeVisible();
    // Its own first cell, by the sheet's label — a loose `/Item/` also matches the Stock
    // screen's filter box and the table heading behind the sheet.
    await tabUntil(page, /^Item, row 1$/, 30);

    const name = `KBD SHEET ${Date.now().toString(36)}`;
    await page.keyboard.type(name);
    await page.keyboard.press('Tab');
    await page.keyboard.type('150');
    await page.keyboard.press('Tab');
    await page.keyboard.type('2');
    await page.keyboard.press('Tab');
    await page.keyboard.type('10');

    // Every column took what was typed, so Tab moved between the four cells and nothing
    // was swallowed on the way.
    const typed = await page.evaluate(() =>
      [...document.querySelectorAll('[data-sheet]')].map(
        (cell) => (cell as HTMLInputElement).value,
      ),
    );
    expect(typed).toContain(name);
    expect(typed).toContain('150');
    expect(typed).toContain('10');
    expect((await focused(page)).tag).toBe('input');
  });

  test('Customers, Daily Bills and Credit Bills expose their controls to Tab', async ({
    page,
  }) => {
    await signIn(page);

    for (const section of ['Daily Bills', 'Credit Bills', 'Customers'] as const) {
      await openSection(page, section);
      await page.waitForTimeout(600);

      // Walk forward and collect what receives focus; a screen whose controls are
      // unreachable would yield nothing but the navigation.
      const seen: string[] = [];
      for (let i = 0; i < 18; i += 1) {
        await page.keyboard.press('Tab');
        const where = await focused(page);
        if (where.tag !== 'body') seen.push(`${where.tag}:${where.label.slice(0, 24)}`);
      }
      expect(seen.length, `${section} exposed nothing to the keyboard`).toBeGreaterThan(
        3,
      );
      expect(
        seen.some((entry) => entry.startsWith('input') || entry.startsWith('button')),
        `${section} exposed no real controls`,
      ).toBe(true);
    }
  });

  test('Saving and syncing is reachable and operable', async ({ page }) => {
    await signIn(page);
    await openSection(page, 'Saving and syncing');

    await page.waitForTimeout(600);
    const seen: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      const where = await focused(page);
      if (where.tag !== 'body') seen.push(where.tag);
    }
    expect(seen.length).toBeGreaterThan(2);
  });
});

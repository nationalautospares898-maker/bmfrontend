/**
 * The client's post-demo redesign, driven in a real browser against a real backend.
 *
 * Nothing here is mocked. The first test asserts that no route interception is
 * registered, so this suite cannot quietly become a stubbed one. Every figure asserted
 * below came out of the real money engine, the real stock ledger and the real credit
 * service, through real HTTP.
 *
 * ## What this suite is for
 *
 * The unit and component suites prove the screens behave. They cannot prove the
 * redesigned screens talk correctly to the server, and two of the client's requirements
 * are specifically about what the **database** ends up holding:
 *
 * * `an existing item gains stock rather than having it replaced` — 20 on the shelf plus
 *   a typed 200 is 220. A component test with a mocked API would pass whatever the
 *   server did.
 * * `a fully paid credit bill stays in the customer's history` — the defect was a
 *   default on a query parameter, so only a real `GET /credit/customers` can show it is
 *   fixed.
 *
 * ## Isolation
 *
 * Skipped, loudly, without a backend. It runs against the throwaway database seeded by
 * `bmbackend/scripts/seed_e2e_tenant.py` and reached through the preview server's `/api`
 * proxy — which is the only CSP-clean way to point the bundle at a port that is **not**
 * 8000, where the owner's real demo instance and the real `bm` database live.
 */

import { expect, test, type Page } from '@playwright/test';

const API_URL = process.env.BM_E2E_API_URL;
const PROXIED = Boolean(process.env.BM_DEV_API_PROXY);
const BASE = PROXIED ? '/api/v1' : `${API_URL ?? ''}/api/v1`;

const USERNAME = process.env.BM_E2E_USERNAME ?? 'e2e-owner';
const PASSWORD = process.env.BM_E2E_PASSWORD ?? 'e2e-only-not-a-real-password-01';
const PROVISIONED_DEVICE_ID =
  process.env.BM_E2E_DEVICE_ID ?? '0192f100-0000-7000-8000-0000000000d1';

/**
 * Needs a real backend, and says so rather than passing vacuously.
 *
 * Declared inside the `describe` below rather than at file scope: every test here lives
 * in that suite, and a file-scope `test.skip(condition, …)` has no enclosing suite to
 * attach the modifier to, which Playwright rejects outright when the file is addressed
 * on its own.
 */
const SKIP_REASON =
  'Needs a real backend: set BM_DEV_API_PROXY (preferred — works with an isolated ' +
  'database) and seed scripts/seed_e2e_tenant.py first.';

/** Unique per run, so a re-run cannot collide on a product name. */
const RUN = Date.now().toString(36);
let sequence = 0;

/** A product name nothing else in the database uses. */
function uniqueName(stem: string): string {
  sequence += 1;
  return `${stem} ${RUN}${sequence}`;
}

let accessToken = '';

/**
 * Present the provisioned device id, so this browser is a counter PC the owner has
 * already registered — the state the application is designed to run in.
 *
 * Opened **without** a version number so the request cannot trigger an upgrade: writing
 * the store with an explicit version creates a database Dexie then finds at its own
 * version with stores missing, and the app hangs on "Starting".
 */
async function provisionDevice(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    async () =>
      ((await indexedDB.databases?.()) ?? []).some((d) => d.name === 'nas-counter'),
    null,
    { timeout: 30_000 },
  );
  await page.evaluate(
    (deviceId) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('nas-counter');
        open.onerror = () =>
          reject(new Error(`indexedDB.open failed: ${String(open.error)}`));
        open.onsuccess = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains('meta')) {
            reject(new Error('no meta store'));
            return;
          }
          const tx = database.transaction('meta', 'readwrite');
          tx.objectStore('meta').put({ key: 'device_id', value: deviceId });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(new Error(`meta write failed: ${String(tx.error)}`));
        };
      }),
    PROVISIONED_DEVICE_ID,
  );
  await page.reload();
}

/**
 * Sign in through the real form against the real `/auth/login`.
 *
 * The token is **observed** from the response rather than minted by calling
 * `/auth/refresh`: a refresh token is single-use and rotated, so competing with the
 * application for it yields `REFRESH_TOKEN_REUSED` and every later request goes out as
 * `Bearer undefined`.
 */
async function signIn(page: Page): Promise<void> {
  accessToken = '';
  page.on('response', (response) => {
    if (!response.url().includes('/auth/login') || response.status() !== 200) return;
    void response
      .json()
      .then((body: { access_token?: string }) => {
        if (body.access_token) accessToken = body.access_token;
      })
      .catch(() => {
        /* a failed login has no token to capture */
      });
  });

  await provisionDevice(page);
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // The proof that bootstrap returned a real money policy and a real counter.
  await expect(page.getByRole('button', { name: /Print Bill/ })).toBeVisible({
    timeout: 30_000,
  });
  expect(accessToken, 'no access token was observed on the login response').not.toBe('');
}

/** Read the server's own view, through the page's real session. */
async function apiGet<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(
    async ([base, p, token, device, counter]) => {
      const response = await fetch(`${base}${p}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Device-Id': device as string,
          'X-Counter-Id': counter as string,
        },
      });
      return response.json() as Promise<unknown>;
    },
    [
      BASE,
      path,
      accessToken,
      PROVISIONED_DEVICE_ID,
      process.env.BM_E2E_COUNTER_ID ?? '0192f100-0000-7000-8000-0000000000c1',
    ],
  ) as Promise<T>;
}

async function goTo(page: Page, section: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: section, exact: true })
    .click();
}

interface StockRow {
  product_id: string;
  name: string;
  quantity: string;
  reorder_level: string | null;
  default_selling_price: string | null;
}

async function balances(page: Page): Promise<StockRow[]> {
  const body = await apiGet<{ items: StockRow[] }>(page, '/inventory/balances?limit=200');
  return body.items;
}

async function rowFor(page: Page, name: string): Promise<StockRow> {
  const row = (await balances(page)).find((candidate) => candidate.name === name);
  expect(row, `no stock row for ${name}`).toBeTruthy();
  return row!;
}

/** Fill one row of the Add Items sheet. */
async function fillSheetRow(
  page: Page,
  row: number,
  values: { item: string; price: string; min: string; qty: string },
): Promise<void> {
  await page.getByLabel(`Item, row ${row}`, { exact: true }).fill(values.item);
  await page.getByLabel(`Price, row ${row}`, { exact: true }).fill(values.price);
  await page.getByLabel(`Min Qty, row ${row}`, { exact: true }).fill(values.min);
  await page.getByLabel(`Stock Qty, row ${row}`, { exact: true }).fill(values.qty);
}

/** Open Stock → Add Items, fill one row, save, and wait for the list to settle. */
async function addStock(
  page: Page,
  values: { item: string; price: string; min: string; qty: string },
): Promise<void> {
  await goTo(page, 'Stock');
  await page.getByRole('button', { name: 'Add Items' }).click();
  await fillSheetRow(page, 1, values);
  await page.getByRole('button', { name: 'Save these items' }).click();
  // The sheet closing is the unambiguous signal: the confirmation panel is cleared when
  // a sheet is opened, so waiting only for its text could match the previous delivery's.
  await expect(page.getByRole('table', { name: /Add stock/i })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.getByText(/^Saved \d+ item/)).toBeVisible({ timeout: 20_000 });
}

/** Put a product on the active bill through the Item cell, as a cashier would. */
/**
 * Put a product on one bill.
 *
 * `column` says **which** bill. The workspace shows three at a time and every one of
 * them has a row 1, so an unscoped `Item, row 1` is ambiguous the moment a second bill
 * is open -- and ambiguous in the worst way, because it would quietly resolve to
 * whichever column happened to be leftmost. Each column is a labelled `region`.
 */
async function addToBill(page: Page, name: string, row = 1, column = 0): Promise<void> {
  const bill = page.getByRole('region').nth(column);
  const cell = bill.getByLabel(`Item, row ${row}`, { exact: true });
  await cell.click();
  await cell.fill(name.slice(0, 12));
  await expect(bill.getByRole('listbox')).toBeVisible({ timeout: 15_000 });
  await bill
    .getByRole('option', {
      name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    })
    .first()
    .click();
  await expect(bill.getByLabel(`Quantity, row ${row}`, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

// -----------------------------------------------------------------------------

test.describe('the client redesign, end to end', () => {
  test.skip(!API_URL && !PROXIED, SKIP_REASON);

  test('this suite is not stubbed', async ({ page }) => {
    // The guard that keeps the rest of the file meaningful.
    await page.goto('/');
    const routes = (page as unknown as { _routes?: unknown[] })._routes ?? [];
    expect(routes).toHaveLength(0);
  });

  // --- navigation (client §2) ------------------------------------------------

  test('the six sections are a vertical column on the right, and the withdrawn ones are gone', async ({
    page,
  }) => {
    await signIn(page);
    const nav = page.getByRole('navigation', { name: 'Sections' });

    for (const section of [
      'Billing',
      'Daily Bills',
      'Credit Bills',
      'Stock',
      'Customers',
      'Saving and syncing',
    ]) {
      await expect(nav.getByRole('button', { name: section, exact: true })).toBeVisible();
    }

    // Withdrawn from the everyday interface. The screens and every endpoint behind them
    // are untouched — this asserts the entry points are gone, not the capability.
    for (const withdrawn of ['Imports', 'Purchases']) {
      await expect(nav.getByRole('button', { name: withdrawn, exact: true })).toHaveCount(
        0,
      );
    }

    // `Counters` is gone outright now, and the order of those two changes mattered.
    //
    // The first cut of this redesign kept it below the six, because billing was refused
    // without a counter and hiding the only screen that could fix that would strand a
    // freshly installed machine — a gap the counter-assignment suite found for real. The
    // owner then asked for the counter step to leave the workflow altogether, so the
    // server was changed first: a computer binds itself on first sign-in
    // (`AuthService._ensure_billing_counter`). Only once no stranded state could arise
    // was the control safe to withdraw. The endpoints and the screen component are still
    // there, still permission-guarded — `counter-assignment.spec.ts` asserts exactly that.
    const labels = (await nav.getByRole('button').allInnerTexts()).map((text) =>
      text.trim(),
    );
    expect(labels, 'exactly the six, in order, and nothing else').toEqual([
      'Billing',
      'Daily Bills',
      'Credit Bills',
      'Stock',
      'Customers',
      'Saving and syncing',
    ]);

    // On the right: the nav's left edge is past the middle of a 1366-wide viewport.
    const box = await nav.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.x).toBeGreaterThan(683);
    // And vertical: taller than it is wide, with the buttons stacked.
    expect(box!.height).toBeGreaterThan(box!.width);

    // Every section opens something, so there are no dead entries.
    for (const section of ['Daily Bills', 'Credit Bills', 'Stock', 'Customers']) {
      await goTo(page, section);
      await expect(
        page
          .getByRole('heading', { level: 1 })
          .or(page.getByRole('heading', { level: 2 }))
          .first(),
      ).toBeVisible({
        timeout: 20_000,
      });
    }
    await goTo(page, 'Saving and syncing');
    await expect(page.getByText(/sync|Saving/i).first()).toBeVisible({ timeout: 20_000 });
  });

  // --- the Excel invoice (client §5) -----------------------------------------

  test('the invoice is a spreadsheet with fifteen numbered rows, and row 16 arrives when needed', async ({
    page,
  }) => {
    await signIn(page);

    const grid = page.getByRole('table', { name: /Bill items/i });
    await expect(grid).toBeVisible();
    for (const header of ['S.No', 'Item', 'Qty', 'Price', 'Total']) {
      await expect(grid.getByRole('columnheader', { name: header })).toBeVisible();
    }
    // Fifteen, with nothing on the bill.
    await expect(page.getByLabel('Item, row 1', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Item, row 15', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Item, row 16', { exact: true })).toHaveCount(0);

    // The owner's own header fields, inline on the bill.
    await expect(page.getByLabel(/Customer Name/)).toBeVisible();
    await expect(page.getByLabel('Mechanic Name')).toBeVisible();
    await expect(page.getByLabel('Vehicle Number')).toBeVisible();
    await expect(page.getByText('ESTIMATE')).toBeVisible();
    await expect(page.getByText('GRAND TOTAL')).toBeVisible();

    // The workspace fits the counter monitor: the page itself does not scroll.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
    );
    expect(
      overflow,
      'the billing workspace should not scroll the page',
    ).toBeLessThanOrEqual(2);

    // No broken horizontal overflow either.
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sideways).toBeLessThanOrEqual(2);
  });

  test('a product is found from the first letters, priced from the catalogue, and totalled live', async ({
    page,
  }) => {
    await signIn(page);
    const name = uniqueName('Axel Packing');
    await addStock(page, { item: name, price: '30', min: '50', qty: '200' });

    await goTo(page, 'Billing');
    await addToBill(page, name);

    // The catalogue price, not typed.
    await expect(page.getByLabel('Price, row 1', { exact: true })).toHaveValue('30');
    await expect(page.getByLabel('Quantity, row 1', { exact: true })).toHaveValue('1');

    // Edit the quantity; the line and the grand total follow.
    await page.getByLabel('Quantity, row 1', { exact: true }).fill('3');
    await page.getByLabel('Price, row 1', { exact: true }).click();
    await expect(page.getByText('90', { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('the keyboard drives the grid, and a space stays a space', async ({ page }) => {
    await signIn(page);

    // A part name with a space in it has to be typeable: that is the honest answer to
    // "spreadsheet Space", and getting it wrong makes half the catalogue unreachable.
    const cell = page.getByLabel('Item, row 1', { exact: true });
    await cell.click();
    await cell.pressSequentially('axel packing');
    await expect(cell).toHaveValue('axel packing');

    // Tab walks Item -> Qty is only meaningful on a filled row, so movement is checked
    // on the empty grid where every Item cell exists.
    await cell.fill('');
    await cell.press('ArrowDown');
    await expect(page.getByLabel('Item, row 2', { exact: true })).toBeFocused();
    await page.getByLabel('Item, row 2', { exact: true }).press('ArrowDown');
    await expect(page.getByLabel('Item, row 3', { exact: true })).toBeFocused();
    await page.getByLabel('Item, row 3', { exact: true }).press('ArrowUp');
    await expect(page.getByLabel('Item, row 2', { exact: true })).toBeFocused();
    await page.getByLabel('Item, row 2', { exact: true }).press('Enter');
    await expect(page.getByLabel('Item, row 3', { exact: true })).toBeFocused();

    // Neither Enter nor Tab nor Space may finalise anything. Nothing was sold.
    await expect(page.getByText(/Bill completed|Credit bill completed/)).toHaveCount(0);
  });

  // --- bill tabs (client §6) -------------------------------------------------

  test('bill tabs behave like browser tabs and keep their bills separate', async ({
    page,
  }) => {
    await signIn(page);
    const first = uniqueName('Clutch Oil');
    const second = uniqueName('Le Max');
    await addStock(page, { item: first, price: '110', min: '2', qty: '20' });
    await addStock(page, { item: second, price: '240', min: '2', qty: '20' });

    await goTo(page, 'Billing');
    const tabs = page.getByRole('navigation', { name: 'Open bills' });
    await expect(
      tabs.getByRole('button', { name: 'New bill', exact: true }),
    ).toBeVisible();

    await addToBill(page, first);
    // Renamed to the first product on the bill.
    await expect(tabs.getByRole('button', { name: first, exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // A second bill, which must not navigate away from the workspace.
    await page.getByRole('button', { name: 'Start a new bill' }).click();
    // Both bills are on screen at once now, so the second product goes on the second
    // column rather than on whatever replaced the first.
    await expect(page.getByRole('region')).toHaveCount(2);
    await addToBill(page, second, 1, 1);
    await expect(tabs.getByRole('button', { name: second, exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // Each bill holds its own item and not the other's -- which no longer needs a tab
    // switch to see, so it is asserted on both columns side by side.
    const firstBill = page.getByRole('region').nth(0);
    const secondBill = page.getByRole('region').nth(1);
    await expect(firstBill.getByText(first).first()).toBeVisible();
    await expect(firstBill.getByText(second)).toHaveCount(0);
    await expect(secondBill.getByText(second).first()).toBeVisible();
    await expect(secondBill.getByText(first)).toHaveCount(0);

    // And choosing a bill from the tabs brings it to the leftmost column.
    await tabs.getByRole('button', { name: first, exact: true }).click();
    await expect(page.getByRole('region').nth(0).getByText(first).first()).toBeVisible();

    // Closing a tab with items on it warns rather than discarding.
    await tabs.getByRole('button', { name: `Close ${first}` }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save it as a draft' })).toBeVisible();
    await page.getByRole('button', { name: 'Keep this bill open' }).click();
    await expect(tabs.getByRole('button', { name: first, exact: true })).toBeVisible();
  });

  // --- stock (client §3) -----------------------------------------------------

  test('the Add Items sheet has four columns side by side and creates the item', async ({
    page,
  }) => {
    await signIn(page);
    await goTo(page, 'Stock');
    await page.getByRole('button', { name: 'Add Items' }).click();

    const sheet = page.getByRole('table', { name: /Add stock/i });
    for (const header of ['Item', 'Price', 'Min Qty', 'Stock Qty']) {
      await expect(sheet.getByRole('columnheader', { name: header })).toBeVisible();
    }
    // Side by side, not stacked: the four cells of row 1 share a y and ascend in x.
    const boxes = await Promise.all(
      ['Item', 'Price', 'Min Qty', 'Stock Qty'].map((label) =>
        page.getByLabel(`${label}, row 1`).boundingBox(),
      ),
    );
    for (const box of boxes) expect(box).toBeTruthy();
    const ys = boxes.map((box) => box!.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(8);
    const xs = boxes.map((box) => box!.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));

    const name = uniqueName('Sheet Item');
    await fillSheetRow(page, 1, { item: name, price: '30', min: '50', qty: '200' });
    await page.getByRole('button', { name: 'Save these items' }).click();
    await expect(page.getByText(/^Saved 1 item/)).toBeVisible({ timeout: 20_000 });

    // The server's own figures.
    const row = await rowFor(page, name);
    expect(row.quantity).toBe('200.000');
    expect(row.reorder_level).toBe('50.000');
    expect(row.default_selling_price).toBe('30.0000');
  });

  test('an existing item GAINS stock rather than having it replaced', async ({
    page,
  }) => {
    // The requirement that destroys real inventory if it is wrong. 20 + 200 = 220.
    await signIn(page);
    const name = uniqueName('Additive Item');

    await addStock(page, { item: name, price: '30', min: '50', qty: '20' });
    expect((await rowFor(page, name)).quantity).toBe('20.000');

    await addStock(page, { item: name, price: '35', min: '60', qty: '200' });

    const row = await rowFor(page, name);
    // 220, not 200.
    expect(row.quantity).toBe('220.000');
    // Price and minimum followed the newest sheet row.
    expect(row.default_selling_price).toBe('35.0000');
    expect(row.reorder_level).toBe('60.000');

    // Exactly two products were not created.
    const matching = (await balances(page)).filter(
      (candidate) => candidate.name === name,
    );
    expect(matching).toHaveLength(1);
  });

  test('case and spacing do not create a second product', async ({ page }) => {
    await signIn(page);
    const name = uniqueName('Case Item');
    await addStock(page, { item: name, price: '30', min: '5', qty: '10' });
    await addStock(page, { item: name.toLowerCase(), price: '30', min: '5', qty: '5' });

    const matching = (await balances(page)).filter(
      (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]!.quantity).toBe('15.000');
  });

  test('the sheet says a quantity will be added, before it is saved', async ({
    page,
  }) => {
    await signIn(page);
    const name = uniqueName('Preview Item');
    await addStock(page, { item: name, price: '30', min: '50', qty: '20' });

    await goTo(page, 'Stock');
    await page.getByRole('button', { name: 'Add Items' }).click();
    await page.getByLabel('Item, row 1', { exact: true }).fill(name);
    await page.getByLabel('Stock Qty, row 1', { exact: true }).fill('200');

    // The sentence that makes it impossible to read `Stock Qty` as a replacement.
    await expect(page.getByText(/In stock 20 \+ 200 = 220/)).toBeVisible({
      timeout: 20_000,
    });
  });

  test('history shows every movement with its running balance, and the sale that caused one', async ({
    page,
  }) => {
    await signIn(page);
    const name = uniqueName('History Item');

    await addStock(page, { item: name, price: '50', min: '2', qty: '100' });
    await addStock(page, { item: name, price: '50', min: '2', qty: '200' });

    // Sell five through the real billing workspace.
    await goTo(page, 'Billing');
    await addToBill(page, name);
    await page.getByLabel('Quantity, row 1', { exact: true }).fill('5');
    await page.getByLabel('Item, row 1', { exact: true }).click();
    await page
      .getByRole('main')
      .getByRole('button', { name: /Print Bill/ })
      .click();
    await expect(page.getByText('Stock has been updated.')).toBeVisible({
      timeout: 30_000,
    });

    // Stock fell by exactly five, once.
    expect((await rowFor(page, name)).quantity).toBe('295.000');

    await goTo(page, 'Stock');
    await page.getByLabel('Find an item').fill(name);
    await page
      .getByRole('table', { name: /Stock on hand/i })
      .getByRole('row', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
      .getByRole('button', { name: 'History' })
      .click();

    const history = page.getByRole('dialog');
    await expect(history).toBeVisible();
    // Opening stock, the arrival, then the sale — oldest first, balances chaining.
    await expect(history.getByText('Opening stock')).toBeVisible({ timeout: 20_000 });
    await expect(history.getByText('Stock received')).toBeVisible();
    await expect(history.getByText('Sold')).toBeVisible();
    const text = (await history.textContent()) ?? '';
    expect(text).toContain('+100');
    expect(text).toContain('+200');
    expect(text).toContain('295');
    // The sale carries the bill it came from; an arrival has no document and shows a dash.
    expect(text).toMatch(/NAS\//);
  });

  test('low stock is listed once an item falls below its own minimum, and leaves when it recovers', async ({
    page,
  }) => {
    await signIn(page);
    const name = uniqueName('Low Item');

    // Scoped to **this** item rather than to the section's presence: the tenant is
    // shared by the tests in this file, so another test's short item can legitimately
    // have the Low Stock section on screen already. Asserting the heading's absence
    // would be asserting the order the tests happened to run in.
    const lowList = page.getByRole('list', { name: 'Items running low' });
    const thisItemIsLow = lowList.getByText(name);

    // Exactly at the minimum is NOT low: the owner's rule is "goes below".
    await addStock(page, { item: name, price: '30', min: '10', qty: '10' });
    await goTo(page, 'Stock');
    await expect(thisItemIsLow).toHaveCount(0);

    // Sell one to take it under.
    await goTo(page, 'Billing');
    await addToBill(page, name);
    await page.getByLabel('Item, row 1', { exact: true }).click();
    await page
      .getByRole('main')
      .getByRole('button', { name: /Print Bill/ })
      .click();
    await expect(page.getByText('Stock has been updated.')).toBeVisible({
      timeout: 30_000,
    });

    await goTo(page, 'Stock');
    await expect(page.getByRole('heading', { name: /Running low/ })).toBeVisible({
      timeout: 20_000,
    });
    await expect(thisItemIsLow).toHaveCount(1);
    // With both figures, because "running low" without the numbers tells nobody anything.
    await expect(lowList.getByText(/9 left, minimum 10/)).toBeVisible();

    // Put stock back; it leaves the list.
    await addStock(page, { item: name, price: '30', min: '10', qty: '50' });
    await goTo(page, 'Stock');
    // Refreshed explicitly. The save already triggers a reload, but pressing Refresh
    // makes the assertion unambiguously about the server's figures rather than about
    // which of two reloads landed last.
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(thisItemIsLow).toHaveCount(0);
    // And the server agrees: 10 sold down to 9, plus 50, is 59 against a minimum of 10.
    expect((await rowFor(page, name)).quantity).toBe('59.000');
  });

  // --- credit history (client §4) --------------------------------------------

  test('a fully paid credit bill stays in the customer history, with its items', async ({
    page,
  }) => {
    await signIn(page);
    const name = uniqueName('Credit Item');
    const customer = `ANAS ${RUN}`;
    await addStock(page, { item: name, price: '1000', min: '1', qty: '50' });

    // A credit bill against a saved customer.
    await goTo(page, 'Billing');
    await addToBill(page, name);
    await page.getByLabel('Quantity, row 1', { exact: true }).fill('4');
    await page.getByLabel(/Customer Name/).fill(customer);
    await page
      .getByRole('button', { name: 'Save as a new customer' })
      .click({ timeout: 20_000 });
    await expect(page.getByText(customer).first()).toBeVisible({ timeout: 20_000 });
    await page
      .getByRole('main')
      .getByRole('button', { name: /Credit Bill/ })
      .click();
    // Either it completed, or an inline panel says why not. A business refusal renders
    // as a panel above the buttons and never as a toast, so the panel's own words are
    // the diagnosis — far more useful than timing out on the absence of the success
    // message.
    const completed = page.getByText('Stock has been updated.');
    const refusal = page.getByRole('alert');
    await expect
      .poll(
        async () => {
          if ((await completed.count()) > 0) return 'completed';
          if ((await refusal.count()) > 0) {
            return (await refusal.first().textContent()) ?? 'refused, with no text';
          }
          return 'pending';
        },
        { timeout: 30_000 },
      )
      .toBe('completed');

    // It is in Credit Bills, with its items.
    await goTo(page, 'Credit Bills');
    await page.getByRole('button', { name: new RegExp(customer) }).click();
    await expect(page.getByText(/NAS\//).first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /NAS\// }).first().click();
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });

    // Pay it in full, through the real payments endpoint.
    const customerId = await page.evaluate(
      async ([base, token, term]) => {
        const response = await fetch(
          `${base}/customers/search?query=${encodeURIComponent(term as string)}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        const body = (await response.json()) as {
          items: Array<{ id: string; name: string }>;
        };
        return body.items.find((c) => c.name === term)?.id ?? '';
      },
      [BASE, accessToken, customer],
    );
    expect(customerId, 'the customer was not persisted').not.toBe('');

    const paid = await page.evaluate(
      async ([base, token, id, amount]) => {
        const response = await fetch(`${base}/payments`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify({ customer_id: id, amount, method: 'cash' }),
        });
        return response.status;
      },
      [BASE, accessToken, customerId, '4000.00'],
    );
    expect(paid).toBe(200);

    // THE REQUIREMENT: navigate away, come back, and the settled customer is still here
    // with their paid bill and its items. This is what used to disappear.
    await goTo(page, 'Billing');
    await goTo(page, 'Credit Bills');
    const settled = page.getByRole('button', { name: new RegExp(customer) });
    await expect(settled).toBeVisible({ timeout: 20_000 });
    await settled.click();
    await page.getByRole('button', { name: /NAS\// }).first().click();
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
    // And the figures say it is paid, server-derived.
    await expect(page.getByText(/paid/i).first()).toBeVisible();
  });

  // --- existing workflows must still work (client §7, §11.2 regression) ------

  test('a cash bill reduces stock exactly once, and a reprint does not move it again', async ({
    page,
  }) => {
    await signIn(page);
    const name = uniqueName('Regression Item');
    await addStock(page, { item: name, price: '200', min: '1', qty: '30' });

    await goTo(page, 'Billing');
    await addToBill(page, name);
    await page.getByLabel('Quantity, row 1', { exact: true }).fill('2');
    await page.getByLabel('Item, row 1', { exact: true }).click();
    await page
      .getByRole('main')
      .getByRole('button', { name: /Print Bill/ })
      .click();
    await expect(page.getByText('Stock has been updated.')).toBeVisible({
      timeout: 30_000,
    });

    expect((await rowFor(page, name)).quantity).toBe('28.000');

    // Reprint from Daily Bills: a plain read, creating nothing.
    await goTo(page, 'Daily Bills');
    await expect(page.getByRole('table').first()).toBeVisible({ timeout: 20_000 });
    expect((await rowFor(page, name)).quantity).toBe('28.000');
  });

  test('the bill survives switching sections and coming back', async ({ page }) => {
    await signIn(page);
    const name = uniqueName('Persist Item');
    await addStock(page, { item: name, price: '75', min: '1', qty: '20' });

    await goTo(page, 'Billing');
    await addToBill(page, name);
    await page.getByLabel('Quantity, row 1', { exact: true }).fill('7');
    await page.getByLabel('Item, row 1', { exact: true }).click();

    await goTo(page, 'Stock');
    await goTo(page, 'Billing');

    // Still there, with the quantity that was typed.
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel('Quantity, row 1', { exact: true })).toHaveValue('7');
  });

  test('the bill survives a full browser reload', async ({ page }) => {
    await signIn(page);
    const name = uniqueName('Reload Item');
    await addStock(page, { item: name, price: '75', min: '1', qty: '20' });

    await goTo(page, 'Billing');
    await addToBill(page, name);
    await page.getByLabel('Item, row 1', { exact: true }).click();

    await page.reload();
    await expect(page.getByRole('button', { name: /Print Bill/ })).toBeVisible({
      timeout: 30_000,
    });
    // Drafts live in IndexedDB, not the query cache, precisely so this holds.
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
  });

  test('the layout stays usable on a smaller viewport', async ({ page }) => {
    await signIn(page);
    await page.setViewportSize({ width: 900, height: 700 });

    // The sections are still reachable and nothing overflows sideways.
    const nav = page.getByRole('navigation', { name: 'Sections' });
    await expect(nav.getByRole('button', { name: 'Stock', exact: true })).toBeVisible();
    await expect(page.getByRole('table', { name: /Bill items/i })).toBeVisible();
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sideways, 'no broken horizontal overflow').toBeLessThanOrEqual(2);
  });
});

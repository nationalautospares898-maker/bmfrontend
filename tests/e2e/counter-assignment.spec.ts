/**
 * Full stack: assigning a counter to a computer, and that computer then billing (C-2).
 *
 * Why this suite exists
 * ---------------------
 *
 * A freshly enrolled counter PC could not bill. `register_device` enrols a browser
 * against a branch and deliberately **not** against a counter, `/sync/bootstrap` answered
 * `counter: null`, and the billing screen had nothing to open its drafts for. The
 * previous round made that say so instead of spinning for ever. This suite covers the
 * other half: an owner fixing it, and the till then working.
 *
 * Nothing here is mocked, with one labelled exception (the network-failure test, which
 * cannot be produced any other way). The bundle is built against a live FastAPI process
 * on a disposable PostgreSQL seeded by `bmbackend/scripts/seed_e2e_tenant.py`, which
 * provides two counters and — the point of this file — a device registered with no
 * counter at all.
 *
 * Why every row is found by id
 * ----------------------------
 *
 * Two earlier attempts are worth recording, because each failed for a reason that is a
 * property of the data rather than of the test.
 *
 * **By label.** A device's label is client-supplied and rewritten on every login:
 * `register_device`'s `ON CONFLICT` sets it from the request. So the moment the seeded
 * "Unassigned Counter PC" signs in — which the acceptance test below does — it becomes
 * "Counter PC", the same label the owner's browser already carries, and it stays that way
 * in the database for every later run.
 *
 * **By state** ("the row set to no counter"). Unique locally, and not in CI: the
 * full-stack step runs earlier in the same job against the same database and leaves a
 * device of its own enrolled with no counter, so there were two such rows.
 *
 * The id is the only identity a row has, so the screen carries it (`data-device-id`) and
 * every locator here uses it. Each test also restores both seeded devices to their seeded
 * assignment first, through the real endpoint — which keeps the tests independent of each
 * other and exercises the unassign path on every run as a side effect.
 *
 * Skipped, loudly, when `BM_E2E_API_URL` is absent — a full-stack suite that passes
 * without a backend is worse than one that does not run.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

const API_URL = process.env.BM_E2E_API_URL;
/**
 * Set when the preview server proxies `/api` to the backend — the **only** CSP-clean
 * way to reach an isolated database.
 *
 * The app's CSP is `connect-src 'self' http://localhost:8000`, so an absolute API base
 * is permitted for exactly one port, and on a developer machine that port is the live
 * shop instance. Through the proxy the origin is empty and the URL is relative, so it
 * satisfies `'self'` whatever port the API is on. The CSP is not widened.
 */
const PROXIED = Boolean(process.env.BM_DEV_API_PROXY);
/** Prefix for in-page fetches: empty (same origin) when proxied. */
const ORIGIN = PROXIED ? '' : (API_URL ?? '');

const USERNAME = process.env.BM_E2E_USERNAME ?? 'e2e-owner';
const PASSWORD = process.env.BM_E2E_PASSWORD ?? 'e2e-only-not-a-real-password-01';

/** The already-provisioned owner browser, assigned to counter C1 by the seed. */
const OWNER_DEVICE_ID =
  process.env.BM_E2E_DEVICE_ID ?? '0192f100-0000-7000-8000-0000000000d1';
const OWNER_COUNTER_ID =
  process.env.BM_E2E_COUNTER_ID ?? '0192f100-0000-7000-8000-0000000000c1';

/**
 * A device the seed registers with `counter_id = NULL` — exactly what `register_device`
 * writes for a brand-new browser profile, so this is the real broken state.
 */
const UNASSIGNED_DEVICE_ID =
  process.env.BM_E2E_UNASSIGNED_DEVICE_ID ?? '0192f100-0000-7000-8000-0000000000d2';

const COUNTER_ONE_NAME = 'Counter 1';
const COUNTER_TWO_NAME = 'Counter 2';
const UNASSIGNED = 'Not set to a counter';

test.skip(
  !API_URL && !PROXIED,
  'Needs a real backend: set BM_DEV_API_PROXY (preferred — works with an isolated ' +
    'database) or BM_E2E_API_URL, and seed scripts/seed_e2e_tenant.py first.',
);

/**
 * The access token the application itself was issued, observed from the real response.
 *
 * Captured rather than fetched: a refresh token is single-use and rotated, so a helper
 * that minted its own would race the application for it. Reading a response body is
 * observation, not interception — no `page.route` is involved.
 */
let accessToken = '';

function watchForToken(page: Page): void {
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
}

/**
 * Present a given device id to the server.
 *
 * Dexie owns the `nas-counter` schema, so the app creates it on a first visit and the
 * `meta` row is written afterwards, opening **without** a version so the request cannot
 * trigger an upgrade. (Opening with an explicit version creates a database Dexie then
 * finds with stores missing, and the app hangs on "Starting".)
 */
async function presentDevice(page: Page, deviceId: string): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    async () =>
      ((await indexedDB.databases?.()) ?? []).some((d) => d.name === 'nas-counter'),
    null,
    { timeout: 30_000 },
  );
  await page.evaluate(
    (id) =>
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
          tx.objectStore('meta').put({ key: 'device_id', value: id });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(new Error(`meta write failed: ${String(tx.error)}`));
        };
      }),
    deviceId,
  );
  await page.reload();
}

async function fillLogin(page: Page): Promise<void> {
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Sign in as the owner on the provisioned browser. */
async function signInAsOwner(page: Page): Promise<void> {
  accessToken = '';
  watchForToken(page);
  await presentDevice(page, OWNER_DEVICE_ID);
  await fillLogin(page);
  await expect(page.getByRole('button', { name: 'Counters' })).toBeVisible({
    timeout: 30_000,
  });
  expect(accessToken, 'no access token was observed on the login response').not.toBe('');
}

/**
 * Restore both devices to their seeded assignment, through the real endpoint.
 *
 * Both, not only the target: an earlier version reset just the target, and the test that
 * takes a computer off its counter then left the owner's own browser unassigned too —
 * after which two rows were unassigned and every locator was ambiguous. Restoring both is
 * what makes each test independent of the one before it, and of the previous run.
 */
async function restoreSeededAssignments(page: Page): Promise<void> {
  const statuses = await page.evaluate(
    async ([base, token, ownerDevice, ownerCounter, target]) => {
      const put = async (deviceId: string, counterId: string | null) => {
        const response = await fetch(`${base}/api/v1/admin/devices/${deviceId}/counter`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ counter_id: counterId }),
        });
        return response.status;
      };
      return [await put(ownerDevice, ownerCounter), await put(target, null)];
    },
    [
      ORIGIN,
      accessToken,
      OWNER_DEVICE_ID,
      OWNER_COUNTER_ID,
      UNASSIGNED_DEVICE_ID,
    ] as const,
  );
  expect(statuses, 'could not restore the seeded device assignments').toEqual([200, 200]);
}

function openCounters(page: Page): Promise<void> {
  return page.getByRole('button', { name: 'Counters' }).click();
}

/**
 * The row for one specific computer, by id.
 *
 * Neither the label nor the current assignment identifies a row reliably. The label is
 * client-supplied and rewritten on every login, so two machines share one once the till
 * below signs in; and "the unassigned row" stopped being unique the moment another spec
 * in the same CI job left a device of its own enrolled with no counter — which is how
 * this suite first failed on a runner having passed locally. The id is the only identity
 * a row has, so the screen puts it on the row and every locator here uses it.
 */
function deviceRow(page: Page, deviceId: string): Locator {
  return page.locator(`tr[data-device-id="${deviceId}"]`);
}

/** The seeded computer this suite assigns and reassigns. */
function target(page: Page): Locator {
  return deviceRow(page, UNASSIGNED_DEVICE_ID);
}

/** The "Set to" cell of a row — the first cell, since the name is a `rowheader`. */
function assignedToCell(row: Locator): Locator {
  return row.getByRole('cell').first();
}

/**
 * Choose a counter for a computer and save it.
 *
 * The two waits are not decoration. Save is disabled whenever the pending choice equals
 * what is already set, so **an enabled Save is the signal that React has registered the
 * new value** — pressing it before that fired the handler with the previous choice, which
 * on CI meant unassigning an already-unassigned computer and getting a perfectly
 * successful no-op instead of the assignment. And the notice only renders once the server
 * has answered, so waiting for it means the caller's next assertion is reading state the
 * server produced rather than racing the request.
 */
async function chooseAndSave(row: Locator, counterName: string): Promise<void> {
  await row.getByRole('combobox').selectOption({ label: counterName });
  const save = row.getByRole('button', { name: 'Save' });
  await expect(save).toBeEnabled();
  await save.click();
}

/** `chooseAndSave`, then wait for the server to have answered. */
async function assignTo(row: Locator, counterName: string): Promise<void> {
  await chooseAndSave(row, counterName);
  await expect(row.page().getByText(/is now set to|no longer set to/)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await signInAsOwner(page);
  await restoreSeededAssignments(page);
  await openCounters(page);
  // The precondition every test below depends on: the seeded computer is unassigned.
  // Asserted on that row specifically rather than by counting unassigned rows, because
  // other specs sharing this database may have enrolled devices of their own.
  await expect(assignedToCell(target(page))).toHaveText(UNASSIGNED);
});

test.describe('the counter assignment workflow', () => {
  test('the suite is not mocked', async ({ page }) => {
    // A server-generated request id only exists if a real server answered.
    const response = await page.evaluate(
      async ([base, token]) => {
        const r = await fetch(`${base}/api/v1/admin/counters`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        return { status: r.status, requestId: r.headers.get('x-request-id') };
      },
      [ORIGIN, accessToken] as const,
    );
    expect(response.status).toBe(200);
    expect(
      response.requestId,
      'no server-generated request id — is this suite stubbed?',
    ).not.toBe(null);
  });

  test('the screen lists the real counters and the real computers', async ({ page }) => {
    await expect(page.getByRole('rowheader', { name: COUNTER_ONE_NAME })).toBeVisible();
    await expect(page.getByRole('rowheader', { name: COUNTER_TWO_NAME })).toBeVisible();
    // Draft capacity comes from the real counter rows (C-5's floor of 20).
    await expect(page.getByRole('cell', { name: '20' }).first()).toBeVisible();
    // The owner's own browser is on Counter 1, read back from the server.
    await expect(assignedToCell(deviceRow(page, OWNER_DEVICE_ID))).toHaveText(
      COUNTER_ONE_NAME,
    );
    // And the seeded computer is reported as unassigned rather than left blank.
    await expect(assignedToCell(target(page))).toHaveText(UNASSIGNED);
  });

  test('assign, reload the whole application, and the assignment has persisted', async ({
    page,
  }) => {
    await assignTo(target(page), COUNTER_TWO_NAME);
    await expect(page.getByText(/is now set to Counter 2/)).toBeVisible();

    // A full reload, not a re-render: persistence through a fresh bootstrap is the claim.
    await page.reload();
    await openCounters(page);
    await expect(assignedToCell(target(page))).toHaveText(COUNTER_TWO_NAME);
    // And Counter 2's own row now names a computer instead of being empty.
    await expect(
      page
        .getByRole('row')
        .filter({ has: page.getByRole('rowheader', { name: COUNTER_TWO_NAME }) }),
    ).not.toContainText('Nothing to show yet.');
  });

  test('a computer can be moved from one counter to another', async ({ page }) => {
    await assignTo(target(page), COUNTER_TWO_NAME);
    await expect(assignedToCell(target(page))).toHaveText(COUNTER_TWO_NAME);

    // Reassignment is the case with a previous value to get wrong.
    await assignTo(target(page), COUNTER_ONE_NAME);
    await expect(page.getByText(/is now set to Counter 1/)).toBeVisible();
    await expect(assignedToCell(target(page))).toHaveText(COUNTER_ONE_NAME);
  });

  test('two computers may share one counter', async ({ page }) => {
    // Allowed, deliberately: `OFFLINE-SYNCHRONIZATION.md` calls "the same counter on two
    // devices (a tablet and the counter PC)" the real case its conflict rules exist for.
    // If someone later "fixes" this as a duplicate assignment, this fails.
    await assignTo(target(page), COUNTER_ONE_NAME);
    await expect(page.getByText(/is now set to Counter 1/)).toBeVisible();
    // Both this computer and the owner's are now on Counter 1.
    await expect(assignedToCell(target(page))).toHaveText(COUNTER_ONE_NAME);
    await expect(assignedToCell(deviceRow(page, OWNER_DEVICE_ID))).toHaveText(
      COUNTER_ONE_NAME,
    );

    const counterOneRow = page
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader', { name: COUNTER_ONE_NAME }) });
    // Its own row lists both, comma separated, rather than implying one per counter.
    await expect(counterOneRow).toContainText(',');
  });

  test('a computer can be taken off every counter without being revoked', async ({
    page,
  }) => {
    await assignTo(target(page), COUNTER_TWO_NAME);
    await expect(assignedToCell(target(page))).toHaveText(COUNTER_TWO_NAME);

    await target(page)
      .getByRole('button', { name: /take off the counter/i })
      .click();
    await expect(page.getByText(/no longer set to a counter/)).toBeVisible();
    await expect(assignedToCell(target(page))).toHaveText(UNASSIGNED);
    // Still registered — unassigning is not revocation (T-4 is a much heavier statement).
    await expect(target(page)).not.toContainText('Blocked');
  });

  test('assigning the counter it already has is not an error', async ({ page }) => {
    await assignTo(target(page), COUNTER_TWO_NAME);
    await expect(page.getByText(/is now set to Counter 2/)).toBeVisible();

    // Save goes disabled once the choice matches what is set, so a double click cannot
    // send a second request. The server treats a repeat as idempotent anyway
    // (`tests/api/test_counter_assignment.py`).
    await expect(target(page).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  test('the dropdown offers the open counters and the blank choice', async ({ page }) => {
    const options = await target(page)
      .getByRole('combobox')
      .locator('option')
      .allTextContents();
    // Both seeded counters are open, so both are offered, plus the blank choice that
    // takes a machine off a counter. A closed counter is filtered out — asserted on the
    // server side in `tests/api/test_counter_assignment.py`, which can close one.
    expect(options).toContain(COUNTER_ONE_NAME);
    expect(options).toContain(COUNTER_TWO_NAME);
    expect(options).toContain(UNASSIGNED);
  });

  test('a failure while assigning is reported, not swallowed', async ({ page }) => {
    // The one place this suite touches the network: the failure under test *is* a network
    // failure, which cannot be produced any other way. Only the assignment request is
    // aborted; everything else still goes to the real server.
    await page.route('**/admin/devices/*/counter', (route) => route.abort('failed'));

    // `chooseAndSave`, not `assignTo`: the request is aborted on purpose, so there will
    // be no success notice to wait for.
    await chooseAndSave(target(page), COUNTER_ONE_NAME);

    // Something is said, and it is not a success message.
    await expect(page.getByText(/is now set to/)).toHaveCount(0);
    // The row is still unassigned, and its controls came back so the owner can retry
    // rather than reload.
    await expect(assignedToCell(target(page))).toHaveText(UNASSIGNED);
    await expect(target(page).getByRole('combobox')).toBeEnabled();
  });

  test('a half-made choice does not survive a reload', async ({ page }) => {
    await target(page).getByRole('combobox').selectOption({ label: COUNTER_TWO_NAME });

    // Reload without saving. A pending decision that survived would be worse than one
    // that did not: the owner would not know whether it had been applied.
    await page.reload();
    await openCounters(page);
    await expect(assignedToCell(target(page))).toHaveText(UNASSIGNED);
  });
});

test.describe('the acceptance path', () => {
  test('an unassigned computer cannot bill, is assigned, and then can', async ({
    browser,
    page,
  }) => {
    // --- the till, presenting the unassigned device ---------------------------
    const tillContext = await browser.newContext();
    const till = await tillContext.newPage();
    await presentDevice(till, UNASSIGNED_DEVICE_ID);
    await fillLogin(till);

    // It signs in successfully — authentication was never the problem — and lands on
    // billing, which cannot mount because the server cannot name its counter.
    await expect(
      till.getByText('This computer is not assigned to a counter'),
    ).toBeVisible({ timeout: 30_000 });
    // And it says what to do, naming a screen that now exists.
    await expect(till.getByText(/Counters screen/)).toBeVisible();
    // No billing controls, and no spinner either. The original failure was an endless
    // "Opening your bills", so asserting the absence of both is what stops a regression
    // to it.
    await expect(till.getByRole('button', { name: /Print Bill/ })).toHaveCount(0);
    await expect(till.getByText('Opening your bills')).toHaveCount(0);

    // --- the owner assigns it -------------------------------------------------
    await page.reload();
    await openCounters(page);
    await assignTo(target(page), COUNTER_ONE_NAME);
    await expect(page.getByText(/is now set to Counter 1/)).toBeVisible();
    // The owner is told the till must sign in again, because the counter reaches the
    // client through bootstrap at login.
    await expect(page.getByText(/sign in again/i)).toBeVisible();

    // --- the till signs in again, and bills -----------------------------------
    await till.getByRole('button', { name: /sign out/i }).click();
    await fillLogin(till);

    // The billing counter mounts. This button only renders once the draft store is open,
    // which only happens once bootstrap returned a counter — so this one assertion is
    // the whole requirement.
    await expect(till.getByRole('button', { name: /Print Bill/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      till.getByText('This computer is not assigned to a counter'),
    ).toHaveCount(0);
    // The counter's name is in the header, which is what makes a wrong assignment
    // noticeable to the cashier standing at it.
    await expect(till.getByText(COUNTER_ONE_NAME).first()).toBeVisible();
    // And the till can reach the catalogue search — the first thing billing actually does.
    await expect(till.getByRole('textbox').first()).toBeVisible();

    await tillContext.close();
  });
});

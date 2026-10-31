/**
 * The Counters screen, rendered.
 *
 * The rule under test: **a computer that is not set to a counter cannot bill, and this
 * screen is the only way to change that** (C-2). So the assertions are mostly about the
 * screen being honest about state rather than about the mechanics of a dropdown:
 *
 * - an unassigned computer is named as unassigned, not left blank — it is the condition
 *   the screen exists to resolve, so it has to be findable at a glance;
 * - a **revoked** computer is not offered a counter at all, because revocation is the
 *   control for a stolen till (T-4) and an assignment would be a way back in;
 * - a **closed** counter is not offered;
 * - several computers on one counter render as several, because the counter PC plus a
 *   tablet is a documented arrangement and a UI implying one-per-counter would be lying
 *   about the data model;
 * - the success message tells the owner the till must **sign in again**, since the
 *   counter arrives through `/sync/bootstrap` at login;
 * - without `admin.settings.manage` the screen explains instead of rendering, and makes
 *   **no request at all** — the server enforces the permission, but a screen that asks
 *   and then renders a 403 is worse than one that does not ask.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/errors';

import { CountersScreen } from './CountersScreen';

const list = vi.fn();
const listDevices = vi.fn();
const assignDevice = vi.fn();
const update = vi.fn();

vi.mock('@/api/endpoints', () => ({
  adminCounters: {
    list: (...a: unknown[]) => list(...a) as unknown,
    listDevices: (...a: unknown[]) => listDevices(...a) as unknown,
    assignDevice: (...a: unknown[]) => assignDevice(...a) as unknown,
    update: (...a: unknown[]) => update(...a) as unknown,
  },
}));

const COUNTER_ONE = {
  id: 'ctr-1',
  code: 'C1',
  name: 'Front Counter',
  branch_id: 'br-1',
  max_open_drafts: 20,
  is_active: true,
  devices: [
    { id: 'dev-assigned', label: 'Front PC', status: 'active', last_seen_at: null },
  ],
};

const COUNTER_TWO = {
  id: 'ctr-2',
  code: 'C2',
  name: 'Back Counter',
  branch_id: 'br-1',
  max_open_drafts: 25,
  is_active: true,
  devices: [],
};

const CLOSED_COUNTER = {
  id: 'ctr-closed',
  code: 'C9',
  name: 'Old Counter',
  branch_id: 'br-1',
  max_open_drafts: 20,
  is_active: false,
  devices: [],
};

function device(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dev-new',
    label: 'New PC',
    status: 'active',
    branch_id: 'br-1',
    counter_id: null,
    last_seen_at: null,
    revoked_at: null,
    revoke_reason: null,
    ...overrides,
  };
}

/**
 * Counter names appear twice on this screen — once as a row header in the counters
 * table and once as an option in each computer's dropdown. Every query below says which
 * one it means, because `getByText` would be ambiguous and a test that silently matched
 * the option would stop checking that the table renders at all.
 */
function counterRow(name: string) {
  return screen.findByRole('rowheader', { name: new RegExp(name) });
}

function counterOptions(): (string | null)[] {
  return screen.getAllByRole('option').map((option) => option.textContent);
}

/**
 * "Not set to a counter" appears three times: as the value in the "Set to" column, as
 * the empty dropdown option, and therefore inside the dropdown's own accessible name.
 * Only the first proves the screen *reports* the state, and it is the only one rendered
 * in a `span` — so the selector is what makes this query mean what it says.
 */
function unassignedCell() {
  return screen.findByText(/not set to a counter/i, { selector: 'span' });
}

function apiError(code: string, message = 'refused', status = 422) {
  return new ApiError(status, {
    error: { code, message, details: {}, request_id: 'r1', retryable: false },
  } as never);
}

beforeEach(() => {
  for (const fn of [list, listDevices, assignDevice, update]) fn.mockReset();
  list.mockResolvedValue([COUNTER_ONE, COUNTER_TWO]);
  listDevices.mockResolvedValue([device()]);
  assignDevice.mockResolvedValue(device({ counter_id: 'ctr-1' }));
});

describe('permission gating', () => {
  it('explains instead of rendering when the user cannot manage settings', () => {
    render(<CountersScreen canManage={false} />);
    expect(screen.getByText(/only the owner can change/i)).toBeInTheDocument();
  });

  it('asks the server for nothing when the user cannot manage settings', () => {
    render(<CountersScreen canManage={false} />);
    expect(list).not.toHaveBeenCalled();
    expect(listDevices).not.toHaveBeenCalled();
  });
});

describe('loading, empty and error states', () => {
  it('shows a loading state before the lists arrive', () => {
    list.mockReturnValue(new Promise(() => {}));
    listDevices.mockReturnValue(new Promise(() => {}));
    render(<CountersScreen canManage />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('says so when the shop has no counters', async () => {
    list.mockResolvedValue([]);
    listDevices.mockResolvedValue([]);
    render(<CountersScreen canManage />);
    expect(await screen.findByText(/no counters yet/i)).toBeInTheDocument();
  });

  it('says so when no computer has signed in', async () => {
    listDevices.mockResolvedValue([]);
    render(<CountersScreen canManage />);
    expect(await screen.findByText(/no computer has signed in/i)).toBeInTheDocument();
  });

  it('reports a load failure rather than rendering an empty screen', async () => {
    list.mockRejectedValue(apiError('PERMISSION_DENIED', 'no', 403));
    render(<CountersScreen canManage />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2 })).toBeInTheDocument(),
    );
    expect(await screen.findByText(/permission/i)).toBeInTheDocument();
  });
});

describe('what the screen says about state', () => {
  it('names an unassigned computer as unassigned', async () => {
    render(<CountersScreen canManage />);
    expect(await unassignedCell()).toBeInTheDocument();
  });

  it('shows which computers are on each counter', async () => {
    render(<CountersScreen canManage />);
    await counterRow('Front Counter');
    expect(screen.getByText(/Front PC/)).toBeInTheDocument();
  });

  it('lists every computer on a shared counter, not just one', async () => {
    // The counter PC plus a tablet. A screen that showed one would misrepresent a
    // supported arrangement as a conflict.
    list.mockResolvedValue([
      {
        ...COUNTER_ONE,
        devices: [
          { id: 'd1', label: 'Counter PC', status: 'active', last_seen_at: null },
          { id: 'd2', label: 'Counter Tablet', status: 'active', last_seen_at: null },
        ],
      },
    ]);
    render(<CountersScreen canManage />);
    const cell = await screen.findByText(/Counter PC, Counter Tablet/);
    expect(cell).toBeInTheDocument();
  });

  it('shows the draft capacity, because it is the one counter setting that limits work', async () => {
    render(<CountersScreen canManage />);
    await counterRow('Front Counter');
    expect(screen.getByRole('cell', { name: '20' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '25' })).toBeInTheDocument();
  });

  it('marks a closed counter as closed', async () => {
    list.mockResolvedValue([CLOSED_COUNTER]);
    render(<CountersScreen canManage />);
    await counterRow('Old Counter');
    expect(screen.getByText(/\(Closed\)/)).toBeInTheDocument();
  });
});

describe('assigning a counter', () => {
  it('sends the chosen counter for the chosen computer', async () => {
    const user = userEvent.setup();
    render(<CountersScreen canManage />);
    await unassignedCell();

    await user.selectOptions(screen.getByRole('combobox'), 'ctr-2');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(assignDevice).toHaveBeenCalledWith('dev-new', 'ctr-2'));
  });

  it('tells the owner the computer must sign in again', async () => {
    const user = userEvent.setup();
    render(<CountersScreen canManage />);
    await unassignedCell();

    await user.selectOptions(screen.getByRole('combobox'), 'ctr-1');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // The counter reaches the client through `/sync/bootstrap` at login, so an already
    // open session keeps its old (absent) counter until it signs in again.
    expect(await screen.findByText(/sign in again/i)).toBeInTheDocument();
  });

  it('reloads both lists after a successful assignment', async () => {
    const user = userEvent.setup();
    render(<CountersScreen canManage />);
    await unassignedCell();
    expect(list).toHaveBeenCalledTimes(1);

    await user.selectOptions(screen.getByRole('combobox'), 'ctr-1');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(listDevices).toHaveBeenCalledTimes(2);
  });

  it('does not offer Save until the choice differs from what is already set', async () => {
    listDevices.mockResolvedValue([device({ id: 'dev-assigned', counter_id: 'ctr-1' })]);
    render(<CountersScreen canManage />);
    await counterRow('Front Counter');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('offers a way to take a computer off every counter', async () => {
    const user = userEvent.setup();
    listDevices.mockResolvedValue([device({ counter_id: 'ctr-1' })]);
    render(<CountersScreen canManage />);
    await counterRow('Front Counter');

    await user.click(screen.getByRole('button', { name: /take off the counter/i }));
    await waitFor(() => expect(assignDevice).toHaveBeenCalledWith('dev-new', null));
  });

  it('does not offer to unassign a computer that is already unassigned', async () => {
    render(<CountersScreen canManage />);
    await unassignedCell();
    expect(
      screen.queryByRole('button', { name: /take off the counter/i }),
    ).not.toBeInTheDocument();
  });

  it('does not offer a closed counter as a choice', async () => {
    list.mockResolvedValue([COUNTER_ONE, CLOSED_COUNTER]);
    render(<CountersScreen canManage />);
    await unassignedCell();
    const options = counterOptions();
    expect(options).toContain('Front Counter');
    expect(options).not.toContain('Old Counter');
  });
});

describe('refusals', () => {
  it('does not offer a counter for a revoked computer', async () => {
    listDevices.mockResolvedValue([device({ status: 'revoked', label: 'Stolen PC' })]);
    render(<CountersScreen canManage />);
    await screen.findByText('Stolen PC');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('explains why a revoked computer cannot be used', async () => {
    listDevices.mockResolvedValue([device({ status: 'revoked', label: 'Stolen PC' })]);
    render(<CountersScreen canManage />);
    expect(await screen.findByText(/has been blocked/i)).toBeInTheDocument();
  });

  it('reports a server refusal instead of pretending the assignment worked', async () => {
    const user = userEvent.setup();
    assignDevice.mockRejectedValue(
      apiError('VALIDATION_ERROR', 'That counter is closed.'),
    );
    render(<CountersScreen canManage />);
    await unassignedCell();

    await user.selectOptions(screen.getByRole('combobox'), 'ctr-1');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(assignDevice).toHaveBeenCalled());
    expect(screen.queryByText(/sign in again/i)).not.toBeInTheDocument();
  });

  it('translates a revoked-device refusal into the owner-facing sentence', async () => {
    const user = userEvent.setup();
    assignDevice.mockRejectedValue(apiError('DEVICE_REVOKED', 'no', 403));
    render(<CountersScreen canManage />);
    await unassignedCell();

    await user.selectOptions(screen.getByRole('combobox'), 'ctr-1');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/registered again/i)).toBeInTheDocument();
  });

  it('re-enables the controls after a failure so the owner can try again', async () => {
    const user = userEvent.setup();
    assignDevice.mockRejectedValue(apiError('VALIDATION_ERROR'));
    render(<CountersScreen canManage />);
    await unassignedCell();

    await user.selectOptions(screen.getByRole('combobox'), 'ctr-1');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled());
  });
});

describe('out-of-order responses', () => {
  it('does not let a slow earlier list overwrite a newer one', async () => {
    // Two `load()` calls overlap routinely: one on mount, another the moment an
    // assignment succeeds. If the slower of the two wins, a successful assignment is
    // painted over by the list as it was *before* it — the row reading "Not set to a
    // counter" under a message saying it had just been set. That is exactly what the
    // full-stack suite caught on the runner, intermittently, after passing locally.
    const user = userEvent.setup();
    let releaseFirst: (value: unknown[]) => void = () => {};
    const stale = [{ ...COUNTER_ONE, devices: [] }];

    list
      .mockImplementationOnce(
        () =>
          new Promise<unknown[]>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValue([COUNTER_TWO]);
    listDevices.mockResolvedValue([device()]);

    render(<CountersScreen canManage />);
    // The first load is still in flight; refresh to start a second.
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    // The second has resolved. Now let the first arrive, late.
    releaseFirst(stale);

    // The newer list wins; the stale one is discarded. Queried as row headers, because
    // every counter name also labels an option in each computer's dropdown.
    expect(await counterRow('Back Counter')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole('rowheader', { name: /Front Counter/ }),
      ).not.toBeInTheDocument(),
    );
  });
});

describe('recovery', () => {
  it('can be refreshed by hand', async () => {
    const user = userEvent.setup();
    render(<CountersScreen canManage />);
    await counterRow('Front Counter');
    expect(list).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('has one h2 and does not skip a heading level', async () => {
    render(<CountersScreen canManage />);
    await counterRow('Front Counter');
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
    // The screen's own h1 lives in the shell; this screen starts at h2 and its sections
    // are h3, so nothing is skipped (`heading-order`).
    expect(screen.getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(0);
  });
});

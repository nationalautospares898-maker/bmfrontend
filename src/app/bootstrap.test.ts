/**
 * Application startup — and in particular, how the application is entered.
 *
 * The owner asked for the shop's computer to open straight into billing rather than onto
 * a sign-in form. The change is one step added to startup: when there is no refresh
 * cookie to recover, ask the server whether it lets this machine in without a password.
 *
 * What these assert, in order of what would hurt most if it broke:
 *
 * 1. **The order is unchanged.** An existing session is recovered by the refresh cookie
 *    exactly as before; the new step runs only when that fails, so a working session is
 *    never replaced by a fresh one.
 * 2. **A server that has not opted in behaves exactly as it does today** — the sign-in
 *    form renders, and nothing is reported as an error.
 * 3. **A revoked device does not get in**, which is the control that makes a lost machine
 *    recoverable.
 * 4. **Nothing is attempted without a device id**, because a machine that cannot be
 *    identified should not be let in without a password.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const refreshMock = vi.fn();
const unattendedMock = vi.fn();
const loginMock = vi.fn();
const bootstrapMock = vi.fn();
const refreshSessionMock = vi.fn();
const getDeviceIdMock = vi.fn();
const storageIsUsableMock = vi.fn();
const setSessionMock = vi.fn();

vi.mock('@/api/endpoints', () => ({
  auth: {
    refresh: (...args: unknown[]) => refreshMock(...args) as unknown,
    unattended: (...args: unknown[]) => unattendedMock(...args) as unknown,
    login: (...args: unknown[]) => loginMock(...args) as unknown,
    logout: vi.fn(),
  },
  sync: { bootstrap: (...args: unknown[]) => bootstrapMock(...args) as unknown },
}));

vi.mock('@/api/client', () => ({
  configureAuth: vi.fn(),
  refreshSession: (...args: unknown[]) => refreshSessionMock(...args) as unknown,
}));

vi.mock('@/api/session', () => ({
  clearSession: vi.fn(),
  getDeviceId: (...args: unknown[]) => getDeviceIdMock(...args) as unknown,
  setBusinessToday: vi.fn(),
  setCounter: vi.fn(),
  setDeviceId: vi.fn(),
  setServerTimeOffset: vi.fn(),
  setSession: (...args: unknown[]) => setSessionMock(...args) as unknown,
}));

vi.mock('@/db/meta', () => ({
  ensureDeviceId: () => Promise.resolve('device-1'),
  setLastCounterId: vi.fn(),
}));

vi.mock('@/db/schema', () => ({
  storageIsUsable: (...args: unknown[]) => storageIsUsableMock(...args) as unknown,
}));

const { startApplication } = await import('./bootstrap');

/** The shape `/auth/unattended` and `/auth/login` both return. */
const SESSION_RESPONSE = {
  access_token: 'token-1',
  expires_in: 900,
  token_type: 'bearer',
  user: { id: 'u1', full_name: 'Owner', must_change_password: false },
  business: { id: 'b1', display_name: 'NATIONAL AUTO SPARES' },
  branches: [],
  active_branch_id: 'br1',
  role: 'owner',
  permissions: ['catalog.read', 'billing.sale.finalize'],
  server_time: '2026-11-02T10:00:00Z',
};

const BOOTSTRAP = {
  business_id: 'b1',
  branch_id: 'br1',
  counter: { id: 'c1', code: 'C1', name: 'Counter 1', max_open_drafts: 20 },
  business: {
    display_name: 'NATIONAL AUTO SPARES',
    address_lines: [],
    phone_numbers: [],
  },
  permissions: ['catalog.read'],
  money_policy: {
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
  },
  settings: {},
  sync: {},
  server_time: '2026-11-02T10:00:00Z',
  business_date: '2026-11-02',
};

/** A refusal shaped like the client's `ApiError`, which is what a rejection carries. */
function refusal(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

beforeEach(() => {
  for (const mock of [
    refreshMock,
    unattendedMock,
    loginMock,
    bootstrapMock,
    refreshSessionMock,
    getDeviceIdMock,
    storageIsUsableMock,
    setSessionMock,
  ]) {
    mock.mockReset();
  }
  storageIsUsableMock.mockResolvedValue(true);
  getDeviceIdMock.mockReturnValue('device-1');
  bootstrapMock.mockResolvedValue(BOOTSTRAP);
});

const options = { onSessionLost: vi.fn() };

describe('an existing session is recovered first', () => {
  it('uses the refresh cookie and does not ask for an unattended session', async () => {
    // The order matters: a fresh session would rotate the cookie and start a new refresh
    // family for a machine that already had a perfectly good one.
    refreshSessionMock.mockResolvedValue({ accessToken: 'existing' });

    const result = await startApplication(options);

    expect(result.session).toEqual({ accessToken: 'existing' });
    expect(unattendedMock).not.toHaveBeenCalled();
  });
});

describe('opening without a password', () => {
  it('asks the server for a session when there is no cookie to recover', async () => {
    refreshSessionMock.mockResolvedValue(null);
    unattendedMock.mockResolvedValue(SESSION_RESPONSE);

    const result = await startApplication(options);

    expect(unattendedMock).toHaveBeenCalledWith({
      // The device id is sent exactly as it is on a password login — it is what makes
      // revoking a lost machine meaningful.
      device: { id: 'device-1', label: 'Counter PC' },
    });
    expect(result.session?.accessToken).toBe('token-1');
    expect(result.session?.permissions.has('billing.sale.finalize')).toBe(true);
    // And the application is ready to use, not merely signed in.
    expect(result.bootstrap).toEqual(BOOTSTRAP);
    expect(result.policy?.currency).toBe('INR');
  });

  it('publishes the session so every later request carries it', async () => {
    refreshSessionMock.mockResolvedValue(null);
    unattendedMock.mockResolvedValue(SESSION_RESPONSE);

    await startApplication(options);

    expect(setSessionMock).toHaveBeenCalledOnce();
    expect(setSessionMock.mock.calls[0]?.[0]).toMatchObject({ accessToken: 'token-1' });
  });
});

describe('servers and machines that are not allowed in', () => {
  it('falls back to the sign-in form when the server has not opted in', async () => {
    // The default. Nothing changes for a deployment that has not turned this on.
    refreshSessionMock.mockResolvedValue(null);
    unattendedMock.mockRejectedValue(refusal('PERMISSION_DENIED'));

    const result = await startApplication(options);

    expect(result.session).toBeNull();
    expect(result.bootstrap).toBeNull();
    // A refusal is configuration, not a fault: nothing is reported as a session loss.
    expect(options.onSessionLost).not.toHaveBeenCalled();
  });

  it('falls back when this device has been revoked', async () => {
    // Revocation is the only way to take access away from a machine once it has left the
    // shop, so it has to win here too.
    refreshSessionMock.mockResolvedValue(null);
    unattendedMock.mockRejectedValue(refusal('DEVICE_REVOKED'));

    const result = await startApplication(options);

    expect(result.session).toBeNull();
  });

  it('does not ask at all when there is no device id', async () => {
    // A machine that cannot be identified cannot be revoked either, so it is not let in
    // without a password.
    refreshSessionMock.mockResolvedValue(null);
    getDeviceIdMock.mockReturnValue(null);

    const result = await startApplication(options);

    expect(unattendedMock).not.toHaveBeenCalled();
    expect(result.session).toBeNull();
  });

  it('does not ask when local storage is unusable', async () => {
    // Without Dexie there is no stable device identity for this browser profile.
    refreshSessionMock.mockResolvedValue(null);
    storageIsUsableMock.mockResolvedValue(false);

    const result = await startApplication(options);

    expect(unattendedMock).not.toHaveBeenCalled();
    expect(result.storageUsable).toBe(false);
    expect(result.session).toBeNull();
  });
});

describe('the rest of startup is unchanged', () => {
  it('still reports a session when bootstrap fails, rather than hanging', async () => {
    // The existing behaviour: a session with no bootstrap lets the shell say what is
    // wrong, which beats sitting on a spinner for ever.
    refreshSessionMock.mockResolvedValue(null);
    unattendedMock.mockResolvedValue(SESSION_RESPONSE);
    bootstrapMock.mockRejectedValue(new Error('server down'));

    const result = await startApplication(options);

    expect(result.session?.accessToken).toBe('token-1');
    expect(result.bootstrap).toBeNull();
    expect(result.policy).toBeNull();
  });

  it('loads drafts before any network call by reading storage first', async () => {
    // Order is a requirement, not a convenience (§9): a cashier whose token expired
    // overnight must see yesterday's half-typed bill, not a login screen.
    refreshSessionMock.mockResolvedValue(null);
    unattendedMock.mockResolvedValue(SESSION_RESPONSE);

    await startApplication(options);

    expect(storageIsUsableMock).toHaveBeenCalled();
    const storageOrder = storageIsUsableMock.mock.invocationCallOrder[0] ?? Infinity;
    const networkOrder = unattendedMock.mock.invocationCallOrder[0] ?? -Infinity;
    expect(storageOrder).toBeLessThan(networkOrder);
  });
});

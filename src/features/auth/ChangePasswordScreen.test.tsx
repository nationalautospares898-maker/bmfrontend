/**
 * The form that was entirely missing before this change: without it,
 * `must_change_password` could never become `false`, and every permission-gated
 * endpoint refused forever (`bm/api/deps.py::require`), surfacing as a generic
 * "ask a supervisor" message that had nothing to do with the owner's actual
 * permissions.
 *
 * The behaviour under test that matters most: a successful change calls `onDone`
 * directly, with **no** attempt to recover a fresh session in place. An earlier version
 * of this screen called `refreshSession()` first, on the assumption that only the
 * access token's claims needed updating — a real-backend, real-browser run
 * (`tests/e2e/force-password-change.spec.ts`) caught that this is wrong:
 * `change_own_password` revokes the calling device's refresh tokens in the same
 * transaction as the change, so the refresh cookie this screen is running under is
 * already spent by the time `change-password` returns. There is no session left to
 * recover without a new login, and a mocked unit test alone could not have shown that.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/errors';
import { ChangePasswordScreen } from './ChangePasswordScreen';

const changePassword = vi.fn();

vi.mock('@/api/endpoints', () => ({
  auth: {
    changePassword: (...a: unknown[]) => changePassword(...a) as unknown,
  },
}));

async function fillAndSubmit(
  current: string,
  next: string,
  confirm: string,
): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Current password'), current);
  await user.type(screen.getByLabelText('New password'), next);
  await user.type(screen.getByLabelText('Confirm new password'), confirm);
  await user.click(screen.getByRole('button', { name: 'Set password' }));
}

describe('ChangePasswordScreen', () => {
  beforeEach(() => {
    changePassword.mockReset();
  });

  it('rejects a new password shorter than the server minimum without calling the API', async () => {
    render(<ChangePasswordScreen onDone={vi.fn()} onSignOut={vi.fn()} />);

    await fillAndSubmit('old-pass-123', 'short', 'short');

    expect(screen.getByText(/at least 10 characters/)).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('rejects a confirmation that does not match', async () => {
    render(<ChangePasswordScreen onDone={vi.fn()} onSignOut={vi.fn()} />);

    await fillAndSubmit('old-pass-123', 'brand-new-password', 'something-else-entirely');

    expect(screen.getByText(/do not match/)).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('rejects reusing the current password as the new one', async () => {
    render(<ChangePasswordScreen onDone={vi.fn()} onSignOut={vi.fn()} />);

    await fillAndSubmit('same-password-123', 'same-password-123', 'same-password-123');

    expect(screen.getByText(/have not used here/)).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('on success, calls onDone with no attempt to keep the old session alive', async () => {
    changePassword.mockResolvedValue(undefined);
    const onDone = vi.fn();

    render(<ChangePasswordScreen onDone={onDone} onSignOut={vi.fn()} />);
    await fillAndSubmit('old-pass-123', 'brand-new-password', 'brand-new-password');

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(changePassword).toHaveBeenCalledWith({
      current_password: 'old-pass-123',
      new_password: 'brand-new-password',
    });
  });

  it('shows the server-reported reason inline when the current password is wrong', async () => {
    changePassword.mockRejectedValue(
      new ApiError(401, {
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'nope',
          details: {},
          request_id: 'r1',
          retryable: false,
        },
      }),
    );
    const onDone = vi.fn();
    render(<ChangePasswordScreen onDone={onDone} onSignOut={vi.fn()} />);

    await fillAndSubmit('wrong-current-pw', 'brand-new-password', 'brand-new-password');

    await waitFor(() =>
      expect(screen.getByText('Your current password is incorrect.')).toBeInTheDocument(),
    );
    expect(onDone).not.toHaveBeenCalled();
  });

  it('lets the user sign out instead, without calling the API', async () => {
    const onSignOut = vi.fn();
    render(<ChangePasswordScreen onDone={vi.fn()} onSignOut={onSignOut} />);

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Sign out instead' }));

    expect(onSignOut).toHaveBeenCalled();
    expect(changePassword).not.toHaveBeenCalled();
  });
});

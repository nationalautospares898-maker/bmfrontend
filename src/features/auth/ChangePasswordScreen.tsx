/**
 * The forced password-change screen.
 *
 * `must_change_password` was always enforced correctly on the backend — every
 * permission-gated endpoint refuses while it is set (`bm/api/deps.py::require`). What
 * was missing was a way to clear it: there was no form anywhere in the application, so
 * the flag could never become `false` and every real action failed with a generic
 * "ask a supervisor" message that had nothing to do with permissions.
 *
 * Gates the whole application the same way `LoginScreen` does — a full screen, not a
 * banner alongside one that still renders. `AppShell` renders this instead of the normal
 * shell whenever `session.mustChangePassword` is true, for any role.
 *
 * ## Why this screen always ends at sign-in again, never straight into the app
 *
 * `change_own_password` deliberately revokes every refresh token for **the calling
 * device** in the same transaction as the password change
 * (`domain/auth/service.py::change_own_password`) — a password change is also how a
 * user reacts to suspecting their session was compromised, so the old session dies with
 * the old password, unconditionally, including this one. That means the refresh cookie
 * this screen is running under is already spent by the time `change-password` returns
 * `204`: there is no fresh token to recover without a new login, and attempting one
 * (an earlier version of this screen called `refreshSession()` here) reliably failed
 * and surfaced as a confusing "please sign in again" bounce — caught by the real-backend
 * E2E spec, not by a unit test with a mocked client, because the mock cannot reproduce a
 * real device-scoped token revocation.
 *
 * So success is reported by routing back to sign-in, same as `onSignOut`, with a
 * specific message instead of a generic "session lost" one — the account is fine, the
 * password changed, and typing it once more is the actual next step, not a recovery.
 */

import { useState } from 'react';

import { auth } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import { Button, Field } from '@/components/primitives';
import { AUTH, ERRORS } from '@/lib/strings';
import { UpdateBanner } from '@/app/UpdateBanner';

export interface ChangePasswordScreenProps {
  /** Called once the server confirms the new password. There is no session to hand
   * back — the device's tokens were just revoked by the change itself — so the caller
   * is expected to return to sign-in. */
  onDone: () => void;
  onSignOut: () => void;
}

export function ChangePasswordScreen({ onDone, onSignOut }: ChangePasswordScreenProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Mirrors the server's own checks so the user hears about it before a round trip —
   * the server remains the authority; this only saves a trip for the common mistakes. */
  function localProblem(): string | null {
    if (newPassword.length < 10) return AUTH.tooShort;
    if (newPassword !== confirmPassword) return AUTH.mismatch;
    if (newPassword === currentPassword) return AUTH.sameAsCurrent;
    return null;
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const problem = localProblem();
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.changePassword({
        current_password: currentPassword,
        new_password: newPassword,
      });
      onDone();
    } catch (caught) {
      // `INVALID_CREDENTIALS` means something different here than it does at sign-in.
      // The generic mapping says "sign in again" (right for a stale session, wrong for
      // a mistyped current password mid-form) — this screen knows which one it is, so
      // it overrides the one code where the generic message would mislead.
      if (caught instanceof ApiError && caught.code === 'INVALID_CREDENTIALS') {
        setError(AUTH.currentPasswordWrong);
      } else {
        setError(
          caught instanceof ApiError
            ? describeError(caught.code).message
            : ERRORS.unexpected,
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold text-[#232852]">{AUTH.changePasswordTitle}</h1>
      <UpdateBanner />
      <p className="text-sm text-slate-600">{AUTH.changePasswordIntro}</p>

      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
        <Field
          label={AUTH.currentPasswordLabel}
          type="password"
          value={currentPassword}
          autoComplete="current-password"
          autoFocus
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
        <Field
          label={AUTH.newPasswordLabel}
          type="password"
          value={newPassword}
          autoComplete="new-password"
          onChange={(event) => setNewPassword(event.target.value)}
        />
        <Field
          label={AUTH.confirmPasswordLabel}
          type="password"
          value={confirmPassword}
          autoComplete="new-password"
          onChange={(event) => setConfirmPassword(event.target.value)}
          {...(error ? { error } : {})}
        />
        <Button
          type="submit"
          variant="primary"
          busy={busy}
          disabled={!currentPassword || !newPassword || !confirmPassword}
        >
          {AUTH.submit}
        </Button>
      </form>

      <Button variant="quiet" onClick={onSignOut} disabled={busy}>
        {AUTH.signOutInstead}
      </Button>
    </div>
  );
}

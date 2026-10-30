/**
 * The owned primitives. Deliberately few and deliberately plain.
 *
 * The constraint from NFR-FE-UX-007 is not a style preference: **no gradients, no
 * decorative animation, no icon-only navigation, no card-heavy layouts.** The people
 * using this have little computer experience and are standing at a counter with a
 * customer waiting. Every control is labelled in words, every target is large, and
 * nothing moves unless it has to.
 *
 * Accessibility is built in rather than audited later — a focus ring that is visible on
 * a cheap monitor, `aria-live` on anything that changes without a click, and no control
 * that can only be reached with a mouse.
 */

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { forwardRef, useId } from 'react';

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

// --- Button -------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'quiet';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Renders the busy state and blocks a second press. */
  busy?: boolean;
  /** Shown next to the label, e.g. `Ctrl+Enter`. Never the only affordance. */
  shortcut?: string;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-[#232852] text-white hover:bg-[#1a1e3f] disabled:bg-slate-300',
  secondary:
    'bg-white text-[#232852] border border-[#232852] hover:bg-slate-50 disabled:border-slate-300 disabled:text-slate-400',
  danger:
    'bg-white text-red-700 border border-red-600 hover:bg-red-50 disabled:border-slate-300 disabled:text-slate-400',
  quiet: 'bg-transparent text-slate-700 hover:bg-slate-100 disabled:text-slate-400',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', busy = false, shortcut, children, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      // A busy button is disabled, not merely styled: a double-press on `Print Bill`
      // must not be able to start a second finalisation.
      disabled={rest.disabled || busy}
      aria-busy={busy || undefined}
      className={classes(
        'inline-flex min-h-11 items-center justify-center gap-2 rounded px-4 text-base font-medium',
        // A focus ring that survives a cheap monitor and a bright shop.
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#232852]',
        'disabled:cursor-not-allowed',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      <span>{children}</span>
      {shortcut ? (
        <kbd className="rounded bg-black/10 px-1 text-xs font-normal">{shortcut}</kbd>
      ) : null}
    </button>
  );
});

// --- Field --------------------------------------------------------------------

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** Rendered under the input and wired to `aria-describedby`. */
  hint?: string;
  /** Rendered as an error and wired to `aria-invalid` + `aria-describedby`. */
  error?: string;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, className, id, ...rest },
  ref,
) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;

  return (
    <div className="flex flex-col gap-1">
      {/* Always a real label. A placeholder is not a label — it disappears exactly
          when someone needs it. */}
      <label htmlFor={inputId} className="text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={classes(hint && hintId, error && errorId) || undefined}
        className={classes(
          'min-h-11 rounded border px-3 text-base',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#232852]',
          error ? 'border-red-600' : 'border-slate-300',
          className,
        )}
        {...rest}
      />
      {hint ? (
        <p id={hintId} className="text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
});

// --- Panel --------------------------------------------------------------------

export type PanelTone = 'info' | 'warning' | 'danger' | 'success';

const TONES: Record<PanelTone, string> = {
  info: 'border-slate-300 bg-slate-50 text-slate-800',
  warning: 'border-amber-500 bg-amber-50 text-amber-900',
  danger: 'border-red-600 bg-red-50 text-red-900',
  success: 'border-green-600 bg-green-50 text-green-900',
};

export interface PanelProps {
  tone?: PanelTone;
  title?: string;
  children: ReactNode;
  /** The next step, rendered as real buttons rather than a sentence to interpret. */
  actions?: ReactNode;
}

/**
 * An inline panel. **This, not a toast**, is how a business conflict is shown.
 *
 * A toast can be missed while someone is looking at a customer, and these block a sale
 * (PRD §6.1). The panel sits above the action buttons and stays until it is resolved.
 */
export function Panel({ tone = 'info', title, children, actions }: PanelProps) {
  return (
    <section
      // `assertive` because the user is about to press a button that will not work.
      role="alert"
      aria-live="assertive"
      className={classes('rounded border-l-4 p-4', TONES[tone])}
    >
      {title ? <h3 className="text-base font-semibold">{title}</h3> : null}
      <div className="mt-1 text-sm">{children}</div>
      {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
    </section>
  );
}

// --- StatusDot ----------------------------------------------------------------

export type ConnectionState = 'online' | 'offline' | 'syncing' | 'attention';

const DOTS: Record<ConnectionState, { colour: string; label: string }> = {
  online: { colour: 'bg-green-600', label: 'Connected' },
  offline: { colour: 'bg-amber-500', label: 'Working offline' },
  syncing: { colour: 'bg-blue-600', label: 'Saving to the server' },
  attention: { colour: 'bg-red-600', label: 'Needs attention' },
};

/**
 * Connection state.
 *
 * The colour is never the only signal — the words are always there too. A cashier with
 * colour-blindness, or a monitor with the contrast turned down, still reads the state.
 */
export function StatusDot({ state }: { state: ConnectionState }) {
  const { colour, label } = DOTS[state];
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span className={classes('h-2.5 w-2.5 rounded-full', colour)} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

// --- Dialog -------------------------------------------------------------------

export interface DialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  actions: ReactNode;
  /** Omitted when the user must choose rather than escape (a version conflict). */
  onDismiss?: () => void;
}

/**
 * A modal dialog built on `<dialog>`, so focus trapping and `Escape` come from the
 * platform instead of from code that has to be kept correct.
 *
 * `onDismiss` is optional on purpose: a conflict dialog has no safe default, so it
 * offers no way out except a decision.
 */
export function Dialog({ open, title, children, actions, onDismiss }: DialogProps) {
  const titleId = useId();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-lg rounded bg-white p-6 shadow-lg"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && onDismiss) onDismiss();
        }}
      >
        <h2 id={titleId} className="text-lg font-semibold text-[#232852]">
          {title}
        </h2>
        <div className="mt-3 text-sm text-slate-800">{children}</div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">{actions}</div>
      </div>
    </div>
  );
}

// --- Spinner ------------------------------------------------------------------

/**
 * A busy indicator. Static under `prefers-reduced-motion`, and always paired with
 * words — a spinning shape alone does not tell anyone what is happening.
 */
export function Busy({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-slate-600" role="status">
      <span
        aria-hidden="true"
        className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-[#232852] motion-reduce:animate-none"
      />
      {label}
    </span>
  );
}

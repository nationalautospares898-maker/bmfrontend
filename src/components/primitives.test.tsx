/**
 * The owned primitives.
 *
 * These cover the `Dialog` behaviours that its docstring used to *claim* came from the
 * platform and did not, because it is a `<div role="dialog">` rather than a `<dialog>`:
 * `Escape` dismissing, `Tab` staying inside, and focus going back where it came from.
 * Each one was a real keyboard dead end on the bill-close warning, which is the only
 * dialog in the owner's everyday workflow.
 *
 * There is no test here for "a tall dialog scrolls instead of being clipped": that is
 * `max-h` plus `overflow-y-auto` in a stylesheet jsdom does not lay out, so asserting it
 * here would only be asserting that a class string is present. It is verified in the
 * real browser instead, at a deliberately short viewport.
 */

import React from 'react';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button, Dialog } from './primitives';

/** A dialog with two actions, the shape the close-bill warning actually has. */
function openDialog(onDismiss?: () => void) {
  return render(
    <>
      <button type="button">behind the dialog</button>
      <Dialog
        open
        title="Close this bill?"
        {...(onDismiss ? { onDismiss } : {})}
        actions={
          <>
            <Button>Keep it</Button>
            <Button variant="danger">Discard it</Button>
          </>
        }
      >
        This bill has items on it that have not been saved.
      </Dialog>
    </>,
  );
}

describe('Dialog', () => {
  it('takes focus when it opens, so the keyboard reaches it at all', () => {
    openDialog();
    // The dialog itself, not its first button: a screen reader announces the title and
    // the body before the user is standing on an action.
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('dismisses on Escape', async () => {
    // It did not. The handler sat on the panel, nothing inside had focus, so the
    // keystroke went to `<body>` and never reached the listener.
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    openDialog(onDismiss);

    await user.keyboard('{Escape}');

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('offers no way out when the caller gives none', async () => {
    // A version conflict has no safe default, so it deliberately cannot be escaped —
    // the user has to choose. `onDismiss` being optional is the mechanism.
    const user = userEvent.setup();
    openDialog();

    await user.keyboard('{Escape}');

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('keeps Tab inside the dialog rather than letting it walk onto the screen behind', async () => {
    // The screen behind a modal is still rendered. Without containment the user could
    // focus it, press Enter, and act on the very thing the dialog was asking about.
    const user = userEvent.setup();
    openDialog();

    const keep = screen.getByRole('button', { name: /Keep it/ });
    const discard = screen.getByRole('button', { name: /Discard it/ });
    const behind = screen.getByRole('button', { name: /behind the dialog/ });

    await user.tab();
    expect(document.activeElement).toBe(keep);
    await user.tab();
    expect(document.activeElement).toBe(discard);
    // The wrap: from the last action back to the first, never out to `behind`.
    await user.tab();
    expect(document.activeElement).toBe(keep);
    expect(document.activeElement).not.toBe(behind);
  });

  it('wraps backwards too', async () => {
    const user = userEvent.setup();
    openDialog();

    const keep = screen.getByRole('button', { name: /Keep it/ });
    const discard = screen.getByRole('button', { name: /Discard it/ });

    // Shift+Tab from the dialog itself lands on the last action, not on the page behind.
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(discard);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(keep);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(discard);
  });

  it('puts focus back where it came from when it closes', async () => {
    // Otherwise focus lands on `<body>` and the next Tab starts again from the top of
    // the page — which, on the billing screen, is a long way from the bill.
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Close bill</Button>
          <Dialog
            open={open}
            title="Close this bill?"
            onDismiss={() => setOpen(false)}
            actions={<Button onClick={() => setOpen(false)}>Keep it</Button>}
          >
            Unsaved items.
          </Dialog>
        </>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: /Close bill/ });

    await user.click(opener);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });
});

describe('Button', () => {
  it('is a real button, which is what makes Tab, Enter and Space work for free', async () => {
    // The reason the application needed no global key handler to satisfy "Enter and
    // Space activate the focused control": the platform already does it.
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button onClick={onClick}>Save a Draft</Button>);

    const button = screen.getByRole('button', { name: /Save a Draft/ });
    expect(button.tagName).toBe('BUTTON');

    await user.tab();
    expect(document.activeElement).toBe(button);

    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('refuses a second press while busy', async () => {
    // A double press on `Print Bill` must not be able to start a second finalisation.
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button busy onClick={onClick}>
        Print Bill
      </Button>,
    );

    await user.click(screen.getByRole('button', { name: /Print Bill/ }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

/**
 * The keyboard helpers.
 *
 * The assertions that matter are the **restraint** ones. It is easy to write arrow-key
 * navigation that works; the defects it causes are all in what it does when it should
 * have done nothing — stealing a caret key inside a text field, swallowing the browser's
 * Back shortcut, or blocking the page from scrolling on a key it then ignored. Each of
 * those has its own test below.
 */

import { describe, expect, it, vi } from 'vitest';

import { isUserTyping, navigateWithArrows } from './keyboard';

/** A nav-shaped container with three buttons, plus a text field to type in. */
function group(): {
  container: HTMLElement;
  buttons: HTMLButtonElement[];
  field: HTMLInputElement;
} {
  const container = document.createElement('nav');
  const buttons = ['Billing', 'Stock', 'Customers'].map((label) => {
    const button = document.createElement('button');
    button.textContent = label;
    container.append(button);
    return button;
  });
  const field = document.createElement('input');
  field.type = 'text';
  document.body.replaceChildren(container, field);
  return { container, buttons, field };
}

/**
 * Dispatch a keydown the way React would deliver it, with the pieces the helper reads.
 *
 * A synthetic object rather than a real event: the helper takes a `React.KeyboardEvent`,
 * and the only parts it touches are the key, the modifiers, the target, the container and
 * `preventDefault`. Building that explicitly keeps what is being asserted visible.
 */
function press(
  container: HTMLElement,
  key: string,
  options: {
    target?: EventTarget;
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
  } = {},
): { prevented: boolean } {
  const preventDefault = vi.fn();
  navigateWithArrows({
    key,
    ctrlKey: options.ctrlKey ?? false,
    altKey: options.altKey ?? false,
    metaKey: options.metaKey ?? false,
    shiftKey: options.shiftKey ?? false,
    target: options.target ?? container,
    currentTarget: container,
    preventDefault,
  } as unknown as React.KeyboardEvent<HTMLElement>);
  return { prevented: preventDefault.mock.calls.length > 0 };
}

describe('navigateWithArrows', () => {
  it('moves down and up through the group', () => {
    const { container, buttons } = group();
    buttons[0]!.focus();

    expect(press(container, 'ArrowDown').prevented).toBe(true);
    expect(document.activeElement).toBe(buttons[1]);

    press(container, 'ArrowDown');
    expect(document.activeElement).toBe(buttons[2]);

    press(container, 'ArrowUp');
    expect(document.activeElement).toBe(buttons[1]);
  });

  it('accepts the horizontal arrows too, because the same nav is a row when narrow', () => {
    const { container, buttons } = group();
    buttons[0]!.focus();

    press(container, 'ArrowRight');
    expect(document.activeElement).toBe(buttons[1]);
    press(container, 'ArrowLeft');
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('jumps to the ends with Home and End', () => {
    const { container, buttons } = group();
    buttons[1]!.focus();

    press(container, 'End');
    expect(document.activeElement).toBe(buttons[2]);
    press(container, 'Home');
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('stops at the ends rather than wrapping round', () => {
    // In a six-item list a wrap reads as a glitch, and `Home`/`End` already cover the
    // intent. Nothing moves, so nothing is prevented either.
    const { container, buttons } = group();
    buttons[2]!.focus();

    expect(press(container, 'ArrowDown').prevented).toBe(false);
    expect(document.activeElement).toBe(buttons[2]);

    buttons[0]!.focus();
    expect(press(container, 'ArrowUp').prevented).toBe(false);
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('leaves a text field alone, so typing and the caret still work', () => {
    // The defect this prevents: `ArrowLeft` inside a half-typed product name moving the
    // selection instead of the caret. Worse than the problem it was solving.
    const { container, buttons, field } = group();
    container.append(field);
    field.value = 'brake shoe';
    field.focus();

    expect(press(container, 'ArrowLeft', { target: field }).prevented).toBe(false);
    expect(document.activeElement).toBe(field);
    expect(buttons.includes(document.activeElement as HTMLButtonElement)).toBe(false);
  });

  it('leaves modified keys to the browser', () => {
    // `Alt+ArrowLeft` is Back and `Ctrl+ArrowRight` is a word jump. Neither belongs here.
    const { container, buttons } = group();
    buttons[0]!.focus();

    expect(press(container, 'ArrowDown', { altKey: true }).prevented).toBe(false);
    expect(press(container, 'ArrowDown', { ctrlKey: true }).prevented).toBe(false);
    expect(press(container, 'ArrowDown', { metaKey: true }).prevented).toBe(false);
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('does not block the page on a key it ignores', () => {
    // `preventDefault` on an unhandled key is how "keyboard support" becomes a page that
    // cannot be scrolled with the keyboard.
    const { container, buttons } = group();
    buttons[0]!.focus();

    for (const key of ['PageDown', ' ', 'Enter', 'Tab', 'a']) {
      expect(press(container, key).prevented).toBe(false);
    }
  });

  it('does not teleport focus into the group from outside it', () => {
    // An arrow pressed while focus is elsewhere should do nothing; only the explicit
    // Home/End are allowed to choose an end for the user.
    const { container, buttons, field } = group();
    field.focus();

    expect(press(container, 'ArrowDown').prevented).toBe(false);
    expect(buttons.includes(document.activeElement as HTMLButtonElement)).toBe(false);
  });

  it('skips a disabled control rather than parking focus on it', () => {
    const { container, buttons } = group();
    buttons[1]!.disabled = true;
    buttons[0]!.focus();

    press(container, 'ArrowDown');
    expect(document.activeElement).toBe(buttons[2]);
  });
});

describe('isUserTyping', () => {
  it('is true for a focused text field', () => {
    const { field } = group();
    field.focus();
    expect(isUserTyping()).toBe(true);
  });

  it('is false for a focused button, because pressing one is a finished act', () => {
    // This is what lets the billing screen take focus into the grid after a tab is
    // clicked, while still refusing to take it out of a half-typed customer name.
    const { buttons } = group();
    buttons[0]!.focus();
    expect(isUserTyping()).toBe(false);
  });

  it('is false when nothing is focused', () => {
    group();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(isUserTyping()).toBe(false);
  });
});

/**
 * The explicit "prompt" half of `registerType: 'prompt'`: an update is never applied
 * automatically (ADR-031 — a forced reload mid-sale would be worse than running one
 * version behind), so a human has to press the button.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { UpdateBanner } from './UpdateBanner';

const applyUpdate = vi.fn();
let needsRefresh = false;
let listener: ((value: boolean) => void) | undefined;

vi.mock('./swUpdate', () => ({
  getNeedsRefresh: () => needsRefresh,
  subscribeToUpdate: (l: (value: boolean) => void) => {
    listener = l;
    return () => {
      listener = undefined;
    };
  },
  applyUpdate: (...a: unknown[]) => applyUpdate(...a) as unknown,
}));

describe('UpdateBanner', () => {
  it('renders nothing when no update is pending', () => {
    needsRefresh = false;
    render(<UpdateBanner />);
    expect(screen.queryByText('An update is available')).not.toBeInTheDocument();
  });

  it('shows the banner once notified, and never applies the update without a click', async () => {
    needsRefresh = false;
    render(<UpdateBanner />);

    listener?.(true);

    expect(await screen.findByText('An update is available')).toBeInTheDocument();
    expect(applyUpdate).not.toHaveBeenCalled();

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Reload to update' }));
    expect(applyUpdate).toHaveBeenCalled();
  });
});

/**
 * Reminder management (Feature A.5). Load-bearing assertions:
 *
 * - the two built-in reminders cannot be removed (no "Remove" button for them),
 *   only turned on/off — only a `kind: 'custom'` row offers removal;
 * - adding a reminder with neither trigger filled sends `interval_hours` (the
 *   default radio selection), never both triggers at once.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Reminder } from '@/api/types';
import { RemindersSettings } from './RemindersSettings';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/api/endpoints', () => ({
  reminders: {
    list: mocks.list,
    create: mocks.create,
    update: mocks.update,
    remove: mocks.remove,
  },
}));

const BUILTIN: Reminder = {
  id: 'r-bill',
  kind: 'bill_reminder',
  label: 'Pending bills (8:45 AM)',
  fire_time: '08:45:00',
  interval_hours: null,
  enabled: true,
  last_fired_at: null,
};

const CUSTOM: Reminder = {
  id: 'r-custom',
  kind: 'custom',
  label: 'Call the tyre supplier',
  fire_time: null,
  interval_hours: 4,
  enabled: true,
  last_fired_at: null,
};

beforeEach(() => {
  mocks.list.mockReset();
  mocks.create.mockReset();
  mocks.update.mockReset();
  mocks.remove.mockReset();
});

describe('RemindersSettings', () => {
  it('a built-in reminder cannot be removed, only a custom one can', async () => {
    mocks.list.mockResolvedValue({ items: [BUILTIN, CUSTOM] });
    render(<RemindersSettings open onClose={vi.fn()} />);
    await screen.findByText('Pending bills (8:45 AM)');

    const rows = screen.getAllByRole('row');
    const builtinRow = rows.find((r) => r.textContent?.includes('Pending bills'));
    const customRow = rows.find((r) => r.textContent?.includes('Call the tyre supplier'));

    expect(builtinRow && screen.queryAllByRole('button', { name: 'Remove' })).toBeDefined();
    expect(
      builtinRow?.querySelector('button')?.textContent === 'Remove',
    ).toBe(false);
    expect(customRow?.textContent).toContain('Remove');
  });

  it('turning a reminder off calls update with enabled: false', async () => {
    mocks.list.mockResolvedValue({ items: [BUILTIN] });
    mocks.update.mockResolvedValue({ updated: true });
    render(<RemindersSettings open onClose={vi.fn()} />);
    await screen.findByText('Pending bills (8:45 AM)');

    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith('r-bill', { enabled: false }),
    );
  });

  it('adding a custom reminder defaults to an interval trigger, not a time', async () => {
    mocks.list.mockResolvedValue({ items: [] });
    mocks.create.mockResolvedValue({ id: 'new-id' });
    render(<RemindersSettings open onClose={vi.fn()} />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: 'Add a reminder' }));
    await userEvent.type(
      screen.getByLabelText('What should it say?'),
      'Call the tyre supplier',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add reminder' }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          label: 'Call the tyre supplier',
          fire_time: null,
          interval_hours: 4,
        }),
      ),
    );
  });

  it('removing a custom reminder calls the remove endpoint', async () => {
    mocks.list.mockResolvedValue({ items: [CUSTOM] });
    mocks.remove.mockResolvedValue(undefined);
    render(<RemindersSettings open onClose={vi.fn()} />);
    await screen.findByText('Call the tyre supplier');

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('r-custom'));
  });
});

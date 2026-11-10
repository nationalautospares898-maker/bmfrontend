/**
 * Reminder management (Feature A.5).
 *
 * The owner's two named reminders — the 8:45 bill reminder and the 5:00 stock
 * reminder — are seeded server-side (`domain/reminders/service.py:ensure_defaults`)
 * the first time this list is read, so they are always here without the owner having
 * to set them up. This screen adds the one thing the server does not do on its own:
 * custom reminders, and turning any of the three on or off.
 */

import { useEffect, useState } from 'react';

import { reminders as remindersApi } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import type { Reminder } from '@/api/types';
import { Busy, Button, Dialog, Field, Panel } from '@/components/primitives';
import { COMMON, REMINDERS } from '@/lib/strings';

export interface RemindersSettingsProps {
  open: boolean;
  onClose: () => void;
}

function when(r: Reminder): string {
  if (r.fire_time) return r.fire_time.slice(0, 5);
  if (r.interval_hours) return `every ${r.interval_hours}h`;
  return '—';
}

export function RemindersSettings({ open, onClose }: RemindersSettingsProps) {
  const [items, setItems] = useState<Reminder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [triggerKind, setTriggerKind] = useState<'time' | 'interval'>('interval');
  const [fireTime, setFireTime] = useState('09:00');
  const [intervalHours, setIntervalHours] = useState('4');
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);

  async function load(): Promise<void> {
    try {
      const response = await remindersApi.list();
      setItems(response.items);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? describeError(caught.code).message : COMMON.retry,
      );
    }
  }

  useEffect(() => {
    if (open) void load();
  }, [open]);

  async function toggle(reminder: Reminder): Promise<void> {
    setBusyId(reminder.id);
    try {
      await remindersApi.update(reminder.id, { enabled: !reminder.enabled });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function remove(reminder: Reminder): Promise<void> {
    setBusyId(reminder.id);
    try {
      await remindersApi.remove(reminder.id);
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function addReminder(): Promise<void> {
    setAddError(null);
    if (!label.trim()) {
      setAddError(REMINDERS.addFailed);
      return;
    }
    setAddBusy(true);
    try {
      await remindersApi.create({
        label: label.trim(),
        fire_time: triggerKind === 'time' ? fireTime : null,
        interval_hours:
          triggerKind === 'interval' ? Number.parseInt(intervalHours, 10) : null,
      });
      setLabel('');
      setAdding(false);
      await load();
    } catch (caught) {
      setAddError(
        caught instanceof ApiError
          ? describeError(caught.code).message
          : REMINDERS.addFailed,
      );
    } finally {
      setAddBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title={REMINDERS.title}
      onDismiss={onClose}
      actions={<Button onClick={onClose}>{REMINDERS.close}</Button>}
    >
      <p className="mb-3 text-sm text-slate-600">{REMINDERS.explanation}</p>
      {error ? <Panel tone="danger">{error}</Panel> : null}
      {items === null ? (
        <Busy label={COMMON.loading} />
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-300 text-left">
              <th className="py-1">{REMINDERS.colLabel}</th>
              <th className="py-1">{REMINDERS.colWhen}</th>
              <th className="py-1">{REMINDERS.colStatus}</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id} className="border-b border-slate-100">
                <td className="py-1">{r.label}</td>
                <td className="py-1 text-slate-600">{when(r)}</td>
                <td className="py-1">
                  {r.enabled ? REMINDERS.enabled : REMINDERS.disabled}
                </td>
                <td className="py-1">
                  <div className="flex gap-1">
                    <Button
                      variant="quiet"
                      busy={busyId === r.id}
                      onClick={() => void toggle(r)}
                    >
                      {r.enabled ? REMINDERS.disable : REMINDERS.enable}
                    </Button>
                    {r.kind === 'custom' ? (
                      <Button
                        variant="quiet"
                        busy={busyId === r.id}
                        onClick={() => void remove(r)}
                      >
                        {REMINDERS.remove}
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adding ? (
        <div className="mt-3 flex flex-col gap-2 rounded border border-slate-200 p-3">
          <h4 className="text-sm font-semibold">{REMINDERS.addTitle}</h4>
          <Field
            label={REMINDERS.fieldLabel}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium text-slate-700">
              {REMINDERS.triggerKind}
            </legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={triggerKind === 'interval'}
                onChange={() => setTriggerKind('interval')}
              />
              {REMINDERS.triggerInterval}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                checked={triggerKind === 'time'}
                onChange={() => setTriggerKind('time')}
              />
              {REMINDERS.triggerTime}
            </label>
          </fieldset>
          {triggerKind === 'time' ? (
            <Field
              label={REMINDERS.fieldTime}
              type="time"
              value={fireTime}
              onChange={(e) => setFireTime(e.target.value)}
            />
          ) : (
            <Field
              label={REMINDERS.fieldInterval}
              type="number"
              min={3}
              max={5}
              value={intervalHours}
              onChange={(e) => setIntervalHours(e.target.value)}
            />
          )}
          {addError ? <Panel tone="danger">{addError}</Panel> : null}
          <div className="flex gap-2">
            <Button variant="primary" busy={addBusy} onClick={() => void addReminder()}>
              {REMINDERS.add}
            </Button>
            <Button onClick={() => setAdding(false)}>{COMMON.cancel}</Button>
          </div>
        </div>
      ) : (
        <Button variant="secondary" className="mt-3" onClick={() => setAdding(true)}>
          {REMINDERS.addTitle}
        </Button>
      )}
    </Dialog>
  );
}

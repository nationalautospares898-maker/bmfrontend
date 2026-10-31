/**
 * Counters and computers (C-2).
 *
 * This screen exists because of a dead end. `register_device` enrols a browser against a
 * branch and deliberately **not** against a counter, `/sync/bootstrap` reports
 * `counter: null`, and the billing screen then has no counter to open its drafts for.
 * The previous round made that say so instead of spinning for ever; this is the part that
 * lets the owner actually fix it.
 *
 * Two deliberate restraints:
 *
 * * **The client never invents a counter.** It lists what the server has and writes back
 *   a choice the owner made. A client that picked "the branch's only counter" would, in
 *   a two-till shop, silently attribute one cashier's takings to the other's till.
 * * **A counter may hold several computers, and that is not an error.** The counter PC
 *   and a tablet on the same till is a documented, supported arrangement, so the screen
 *   lists computers per counter rather than offering a single "the computer for this
 *   counter" slot that would imply otherwise.
 *
 * The whole screen is gated on `admin.settings.manage`. That is enforced by the server
 * on all three endpoints — hiding the tab is a courtesy, not the control (NFR-SEC-004).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { adminCounters } from '@/api/endpoints';
import { ApiError, describeError } from '@/api/errors';
import type { AdminDevice, Counter } from '@/api/types';
import { Busy, Button, Panel } from '@/components/primitives';
import { COMMON, COUNTERS, ERRORS } from '@/lib/strings';

export interface CountersScreenProps {
  /** `admin.settings.manage`. Without it the screen explains rather than renders. */
  canManage: boolean;
}

interface Loaded {
  counters: Counter[];
  devices: AdminDevice[];
}

export function CountersScreen({ canManage }: CountersScreenProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  // Per-device pending choice. Keyed by device id so two rows can be mid-edit without
  // one dropdown resetting the other.
  const [choice, setChoice] = useState<Record<string, string>>({});

  // Discards a response that a newer request has already superseded.
  //
  // Two `load()` calls overlap routinely: one on mount, another the moment an assignment
  // succeeds. Without this, the slower of the two wins whichever order they arrive in, so
  // a successful assignment could be painted over by the list as it was *before* it — the
  // row showing "Not set to a counter" under a message saying it had just been set. That
  // is what the full-stack suite caught on the runner, intermittently, after passing
  // locally. `DailyBills` discards a late response for the same reason (FR-RPT-002); this
  // screen should have from the start.
  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    const sequence = latestLoad.current + 1;
    latestLoad.current = sequence;
    setLoaded(null);
    setError(null);
    try {
      const [counters, devices] = await Promise.all([
        adminCounters.list(),
        adminCounters.listDevices(),
      ]);
      if (sequence !== latestLoad.current) return;
      setLoaded({ counters, devices });
    } catch (caught) {
      if (sequence !== latestLoad.current) return;
      setLoaded({ counters: [], devices: [] });
      setError(
        caught instanceof ApiError
          ? describeError(caught.code).message
          : ERRORS.unexpected,
      );
    }
  }, []);

  useEffect(() => {
    if (!canManage) return;
    void load();
  }, [canManage, load]);

  if (!canManage) {
    return (
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-[#232852]">{COUNTERS.title}</h2>
        <Panel tone="warning" title={COUNTERS.title}>
          {COUNTERS.noPermission}
        </Panel>
      </section>
    );
  }

  async function assign(device: AdminDevice, counterId: string | null) {
    setSaving(device.id);
    setError(null);
    setNotice(null);
    try {
      await adminCounters.assignDevice(device.id, counterId);
      const name =
        loaded?.counters.find((counter) => counter.id === counterId)?.name ?? '';
      setNotice(
        counterId === null
          ? COUNTERS.unassigned_ok(device.label)
          : `${COUNTERS.assigned(device.label, name)} ${COUNTERS.signInAgain}`,
      );
      await load();
    } catch (caught) {
      // A refusal is reported verbatim rather than retried. The server knows why — a
      // blocked computer, a closed counter, a counter in another branch — and guessing
      // would give the owner a worse sentence than the one the server already wrote.
      setError(
        caught instanceof ApiError
          ? caught.code === 'DEVICE_REVOKED'
            ? COUNTERS.cannotAssignRevoked
            : describeError(caught.code).message
          : ERRORS.unexpected,
      );
    } finally {
      setSaving(null);
    }
  }

  const counterName = (id: string | null | undefined): string | null =>
    id ? (loaded?.counters.find((counter) => counter.id === id)?.name ?? id) : null;

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-semibold text-[#232852]">{COUNTERS.title}</h2>
        <Button variant="secondary" onClick={() => void load()}>
          {COMMON.refresh}
        </Button>
      </header>

      <Panel tone="info">{COUNTERS.explainer}</Panel>

      {notice ? (
        <Panel tone="success" title={COUNTERS.assignAction}>
          {notice}
        </Panel>
      ) : null}
      {error ? <Panel tone="danger">{error}</Panel> : null}

      {loaded === null ? (
        <Busy label={COMMON.loading} />
      ) : (
        <>
          <h3 className="text-base font-semibold text-[#232852]">
            {COUNTERS.countersHeading}
          </h3>
          {loaded.counters.length === 0 ? (
            <Panel tone="warning">{COUNTERS.noCounters}</Panel>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th scope="col" className="py-1 pr-4">
                      {COUNTERS.colCounter}
                    </th>
                    <th scope="col" className="py-1 pr-4">
                      {COUNTERS.colCapacity}
                    </th>
                    <th scope="col" className="py-1">
                      {COUNTERS.colComputers}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {loaded.counters.map((counter) => (
                    <tr key={counter.id} className="border-t border-slate-200">
                      <th scope="row" className="py-2 pr-4 text-left font-normal">
                        {counter.name}
                        {counter.is_active ? null : (
                          <span className="ml-2 text-xs text-slate-500">
                            ({COUNTERS.closed})
                          </span>
                        )}
                      </th>
                      <td className="py-2 pr-4">{counter.max_open_drafts}</td>
                      <td className="py-2">
                        {counter.devices.length === 0
                          ? COMMON.emptyList
                          : counter.devices.map((device) => device.label).join(', ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3 className="text-base font-semibold text-[#232852]">
            {COUNTERS.devicesHeading}
          </h3>
          {loaded.devices.length === 0 ? (
            <Panel tone="info">{COUNTERS.noDevices}</Panel>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th scope="col" className="py-1 pr-4">
                      {COUNTERS.colComputer}
                    </th>
                    <th scope="col" className="py-1 pr-4">
                      {COUNTERS.colAssignedTo}
                    </th>
                    <th scope="col" className="py-1">
                      {COMMON.actions}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {loaded.devices.map((device) => {
                    const assignedName = counterName(device.counter_id);
                    const isRevoked = device.status === 'revoked';
                    const selected = choice[device.id] ?? device.counter_id ?? '';
                    return (
                      // The id is on the row because a computer's *label* is not an
                      // identity: it is client-supplied and `register_device` rewrites it
                      // on every login, so two machines routinely share one label. The
                      // full-stack suite needs to act on a specific computer, and the
                      // owner reading a bug report needs to be able to say which row they
                      // meant.
                      <tr
                        key={device.id}
                        data-device-id={device.id}
                        className="border-t border-slate-200"
                      >
                        <th scope="row" className="py-2 pr-4 text-left font-normal">
                          {device.label}
                          {isRevoked ? (
                            <span className="ml-2 text-xs text-slate-500">
                              ({COUNTERS.revoked})
                            </span>
                          ) : null}
                        </th>
                        <td className="py-2 pr-4">
                          {assignedName ?? (
                            // Named, not left blank: an unassigned computer is the
                            // condition this screen exists to resolve, so it has to be
                            // findable at a glance.
                            <span className="font-medium text-[#8a1c1c]">
                              {COUNTERS.unassigned}
                            </span>
                          )}
                        </td>
                        <td className="py-2">
                          {isRevoked ? (
                            <span className="text-slate-500">
                              {COUNTERS.cannotAssignRevoked}
                            </span>
                          ) : (
                            <div className="flex flex-wrap items-center gap-2">
                              <label className="flex items-center gap-2">
                                <span className="text-xs text-slate-600">
                                  {COUNTERS.assignLabel}
                                </span>
                                <select
                                  className="rounded border border-slate-300 px-2 py-1"
                                  value={selected}
                                  disabled={saving === device.id}
                                  onChange={(event) =>
                                    setChoice((previous) => ({
                                      ...previous,
                                      [device.id]: event.target.value,
                                    }))
                                  }
                                >
                                  <option value="">{COUNTERS.unassigned}</option>
                                  {loaded.counters
                                    // A closed counter is not offered. The server
                                    // refuses it anyway; not offering it means the owner
                                    // never has to read that refusal.
                                    .filter(
                                      (counter) =>
                                        counter.is_active ||
                                        counter.id === device.counter_id,
                                    )
                                    .map((counter) => (
                                      <option key={counter.id} value={counter.id}>
                                        {counter.name}
                                      </option>
                                    ))}
                                </select>
                              </label>
                              <Button
                                variant="primary"
                                disabled={
                                  saving === device.id ||
                                  selected === (device.counter_id ?? '')
                                }
                                onClick={() => {
                                  void assign(device, selected === '' ? null : selected);
                                }}
                              >
                                {COUNTERS.assignAction}
                              </Button>
                              {device.counter_id ? (
                                <Button
                                  variant="quiet"
                                  disabled={saving === device.id}
                                  onClick={() => {
                                    void assign(device, null);
                                  }}
                                >
                                  {COUNTERS.unassign}
                                </Button>
                              ) : null}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * M1 skeleton.
 *
 * The real shell — routing, protected routes, the permission-aware layout — is M16.
 * This renders the environment self-check so a misconfigured deployment is visible at
 * the counter rather than discovered when someone tries to bill.
 */

import { ACTIONS, COMMON } from '@/lib/strings';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

export function App() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold text-[#232852]">National Auto Spares</h1>
      <p className="mt-2 text-sm text-slate-600">
        Counter application — Phase 3 skeleton. The billing screen arrives with M17.
      </p>

      <section
        className="mt-6 rounded border border-slate-200 p-4"
        aria-labelledby="config"
      >
        <h2 id="config" className="text-sm font-semibold">
          Configuration
        </h2>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">API</dt>
          <dd>{API_BASE_URL || <em>not configured</em>}</dd>
          <dt className="text-slate-500">Version</dt>
          <dd>{import.meta.env.VITE_APP_VERSION ?? COMMON.loading}</dd>
        </dl>
      </section>

      <section
        className="mt-6 rounded border border-slate-200 p-4"
        aria-labelledby="actions"
      >
        <h2 id="actions" className="text-sm font-semibold">
          The four primary actions
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Owner-decided (OD-14). There is no fifth.
        </p>
        <ul className="mt-2 list-inside list-disc text-sm">
          <li>{ACTIONS.printBill}</li>
          <li>{ACTIONS.creditBill}</li>
          <li>{ACTIONS.saveDraft}</li>
          <li>{ACTIONS.clearDraft}</li>
        </ul>
      </section>
    </main>
  );
}

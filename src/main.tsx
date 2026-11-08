/**
 * Application entry point.
 *
 * Two stylesheets, loaded separately on purpose: `app.css` for the screen and
 * `print.css` for the bill (ADR-028). They share no tokens, so restyling the
 * application cannot change what a customer is handed.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { registerSW } from 'virtual:pwa-register';

import { AppShell } from '@/app/AppShell';
import { initUpdatePrompt } from '@/app/swUpdate';
import '@/styles/app.css';
import '@/styles/print.css';

// Registration only. Nothing here decides *whether* to apply an update — that stays an
// explicit action in `AppShell`, never automatic (ADR-031).
initUpdatePrompt(registerSW);

const container = document.getElementById('root');
if (!container) {
  // A missing root is a build or deployment fault, not a runtime condition to recover
  // from. Failing loudly beats rendering nothing and leaving a blank counter screen.
  throw new Error('#root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
);

/**
 * Application entry point.
 *
 * Routing, the API client and the session module land with M16; this is the M1
 * skeleton that proves the toolchain, the strict TypeScript configuration and the
 * structural rules are all enforced before there is code to untangle.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/App';
import '@/styles/app.css';

const container = document.getElementById('root');
if (!container) {
  // A missing root is a build or deployment fault, not a runtime condition to recover
  // from. Failing loudly beats rendering nothing and leaving a blank counter screen.
  throw new Error('#root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

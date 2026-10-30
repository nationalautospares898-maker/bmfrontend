/// <reference types="vite/client" />

/**
 * The **only four** environment variables this repository may have (§5 rule 1).
 *
 * Anything `VITE_`-prefixed is compiled into a publicly readable bundle, so there is no
 * such thing as a secret here: no database URL, no JWT key, no storage credential
 * (NFR-SEC-012). A structural test asserts no other `VITE_` variable is referenced.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_APP_VERSION: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_ENABLE_DEVTOOLS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

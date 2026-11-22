/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * The **only four** environment variables this repository may have (§5 rule 1).
 *
 * Anything `VITE_`-prefixed is compiled into a publicly readable bundle, so there is no
 * such thing as a secret here: no database URL, no JWT key, no storage credential
 * (NFR-SEC-012). A structural test asserts no other `VITE_` variable is referenced.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  /**
   * Base for the three cookie-bearing auth routes only. Unset in production, where they
   * must stay same-origin so the `SameSite=Lax` refresh cookie is sent through
   * `vercel.json`'s rewrite. Set by the acceptance suite, where the app and the API are
   * on different origins with no proxy between them. A public hostname, never a secret.
   */
  readonly VITE_AUTH_BASE_URL?: string;
  readonly VITE_APP_VERSION: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_ENABLE_DEVTOOLS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

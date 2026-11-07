# Vercel configuration — `bmfrontend`

Everything in this document was read out of the source. The short version:

> **One environment variable is read by this application: `VITE_API_BASE_URL`.**
> It is read at **build** time, in exactly one place, `src/api/client.ts:36`.

Three further `VITE_` names are allow-listed in `src/vite-env.d.ts` and have **no reader
in `src/`**. They are listed in §2 so nobody has to grep to establish that, and so nobody
sets one and believes something has been configured.

Related: `../bmbackend/docs/RAILWAY-ENVIRONMENT-VARIABLES.md` (the API half),
`../bmbackend/docs/PRODUCTION-DEPLOYMENT-GUIDE.md` (the order to do things in),
`.env.production.example`.

---

## 0. Before anything else: no secret belongs in this project

Anything `VITE_`-prefixed is **compiled into a JavaScript bundle that anyone can read**.
Not obfuscated, not minified-away — a literal string in a file served to the public.

So there is no such thing as a secret here (NFR-SEC-012), and that is a structural
property rather than a convention:

- `src/vite-env.d.ts` declares the four permitted names, and
  `tests/structural/rules.test.ts` fails the build if a fifth is referenced anywhere in
  `src/` or in `vite.config.ts`.
- The same suite fails on the literals `DATABASE_URL`, `JWT_SIGNING_KEY`,
  `PASSWORD_PEPPER`, `IP_HASH_PEPPER`, `postgres://`, `postgresql://`, `AWS_SECRET` and
  `PRIVATE_KEY` appearing anywhere in `src/`.
- `gitleaks` runs on every push (`.github/workflows/ci.yml`, job `secrets`).

**Never** put a Neon connection string, a JWT signing key, a password or IP pepper, or a
storage credential in a Vercel environment variable for this project — including one
without the `VITE_` prefix. A non-prefixed variable is not exposed to the bundle, but it
is still a production credential sitting in a place with no reason to hold one, readable
by everyone with access to the Vercel project.

---

## 1. `VITE_API_BASE_URL` — the only variable that does anything

| | |
|---|---|
| Mandatory | Effectively yes (falls back to `/api/v1`, which only works behind a proxy) |
| Secret | **No** — it is a public URL, visible in the browser's network tab |
| Read at | **Build** time. Changing it needs a **redeploy**, not a restart |
| Read by | `src/api/client.ts:36` |

```ts
const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(/\/$/, '');
```

**It must include the `/api/v1` path.** `client.ts` appends endpoint paths directly to it
and strips only a trailing slash, so `https://api.example.com` (no path) produces requests
to `https://api.example.com/auth/login` — a 404 on every call.

### Two valid shapes

This is a topology decision, made once.
`../bmbackend/docs/PRODUCTION-DEPLOYMENT-GUIDE.md §10` compares them properly; here is what
each one means for this variable.

**A — absolute. The browser talks to Railway directly.**

```
VITE_API_BASE_URL = https://api.your-domain.com/api/v1
```

Requires, on the Railway side:

- `BM_CORS_ALLOWED_ORIGINS` listing this site's origin. Omit it and `main.py` never
  installs `CORSMiddleware` at all, so every request fails the browser preflight while
  `curl` works perfectly.
- `BM_REFRESH_COOKIE_SAMESITE=none` **if and only if** the two hostnames are on different
  registrable domains. See §4 — this is the one that fails silently.

Requires nothing extra for the CSP: `vite.config.ts` derives the origin from this very
variable and appends it to `connect-src` at build time, so the two cannot drift apart.

**B — relative. Vercel proxies `/api/*` to Railway.**

```
VITE_API_BASE_URL = /api/v1
```

Plus a rewrite in `vercel.json` (§5). Requires **no** CORS entry, **no** CSP widening and
**no** cookie change, because the browser only ever sees one origin.

Costs an extra network hop, and Vercel's proxy limits then apply to this application's two
long/large requests: the 10 MB import upload and the 30-second finalisation timeout. Check
both against your Vercel plan before choosing it for a shop that imports price lists.

### Preview deployments

Vercel gives every preview build a fresh hostname, so it cannot be in
`BM_CORS_ALLOWED_ORIGINS` ahead of time. Pick one:

| Approach | Set `VITE_API_BASE_URL` for Preview to | Trade-off |
|---|---|---|
| Separate staging API | the staging Railway URL | Cleanest. Previews can never write to the shop's data. Costs a second Railway service and a second Neon branch. |
| Point previews at production | the production API URL | You must add each preview origin to `BM_CORS_ALLOWED_ORIGINS` by hand while testing it, and a preview build can then write real invoices. |
| Leave Preview unset | *(falls back to `/api/v1`)* | Preview builds have no backend and fail at sign-in. Safe, and honest about it. |

🔴 **Never** widen `BM_CORS_ALLOWED_ORIGINS` to a wildcard to make previews work. The API
sets `allow_credentials=True`, so a wildcard would let any site on the internet make
credentialed requests to the shop's billing API.

### Setting it

Vercel → Project → Settings → Environment Variables:

| Key | Value | Environments |
|---|---|---|
| `VITE_API_BASE_URL` | `https://api.your-domain.com/api/v1` | **Production** |
| `VITE_API_BASE_URL` | per the table above | Preview |
| *(do not set)* | — | Development — `.env.local` already has it |

Leave "Sensitive" off. Marking a public URL sensitive hides it from the dashboard without
hiding it from the bundle, which buys nothing and makes the value harder to check.

After changing it: **Redeploy**. A restart is not enough — the value is baked into the
bundle at build time.

---

## 2. Allow-listed and read by nothing

Declared in `src/vite-env.d.ts` and permitted by the structural test. Verified by grepping
`import.meta.env` across `src/` and `tests/`: there is exactly one hit, and it is
`VITE_API_BASE_URL`.

| Variable | Status | What to do |
|---|---|---|
| `VITE_APP_VERSION` | Declared, no reader in `src/` | Leave unset. The release identifier the running system actually reports comes from the backend: `BM_RELEASE` → `GET /api/v1/meta`. |
| `VITE_SENTRY_DSN` | Declared, no reader; no Sentry SDK in `package.json` | Leave unset. |
| `VITE_ENABLE_DEVTOOLS` | Declared, no reader | Leave unset. Must never be set in production regardless. |

A fifth `VITE_` name would fail `tests/structural/rules.test.ts`, which runs in the
`checks` CI job. That is the intended behaviour — adding one is a deliberate change to the
allow-list in `src/vite-env.d.ts`, not a configuration step.

---

## 3. Build-time variables that are *not* `VITE_`-prefixed

`vite.config.ts` reads one: `BM_DEV_API_PROXY`. It is a local-development and
browser-acceptance-test affordance — when set, Vite proxies `/api` to the given target so
an acceptance run can use a throwaway API without touching a developer's instance on 8000.

**Do not set it on Vercel.** Vite's `server`/`preview` proxies do not exist in a static
production build; it would be inert, and present in the project settings as something that
looks like it configures the production API and does not.

---

## 4. 🔴 The failure that looks like success

Read this before the first deploy. It is the one problem in this stack that produces a
perfect-looking deployment and then breaks at the counter a quarter of an hour later.

The refresh token is an `HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth` cookie
(`../bmbackend/src/bm/api/v1/auth.py`). `SameSite` compares the **registrable domain**, not
the origin. And both `vercel.app` and `up.railway.app` are public suffixes — so
`nas.vercel.app` and `nas-api.up.railway.app` are **cross-site**, and a `Lax` cookie is
never sent across them.

What that looks like in use, in order:

1. Sign-in works. Everything works.
2. Reload the page, or open it the next morning: the sign-in form again. `bootstrap.ts`
   calls `refreshSession()` on every cold start, the cookie is not sent, there is nothing
   to recover a token from.
3. **Fifteen minutes after each sign-in** — `BM_ACCESS_TOKEN_TTL_SECONDS=900` — the access
   token expires, the client's one transparent refresh-and-retry gets no cookie either, and
   the cashier is signed out. Possibly mid-bill. Drafts survive (they are in IndexedDB and
   are never cleared on an auth error), but the bill cannot be finalised until somebody
   signs in again.

There is nothing in a build log, a health check or a smoke test that shows this. Only
sitting on the page for fifteen minutes does.

**Two fixes. Pick one before you deploy:**

| Fix | What to do | Cost |
|---|---|---|
| **Custom domain** *(recommended)* | Front end on `app.your-domain.com` (Vercel), API on `api.your-domain.com` (Railway). Same registrable domain → same-site → `Lax` works. | You need a domain. Keeps the cookie's CSRF property intact. |
| **`SameSite=None`** | Set `BM_REFRESH_COOKIE_SAMESITE=none` on Railway. Requires `Secure`, which `BM_ENV=production` already sets. | Relaxes the CSRF control the cookie was designed around. Still bounded: every other endpoint authenticates with a bearer header, and `/auth/refresh` is additionally bound to `X-Device-Id`. |

Topology B (the Vercel proxy, §1) sidesteps it entirely — same origin, so same-site.

---

## 5. `vercel.json`

Committed at the repository root. JSON permits no comments, so here is what each block is
for.

```jsonc
"framework": "vite",
"buildCommand": "npm run build",      // tsc -b && vite build — the typecheck is part of it
"outputDirectory": "dist",
"installCommand": "npm ci",           // lockfile-exact, like CI
```

`npm run build` is `tsc -b && vite build`, so a type error fails the Vercel build. That is
deliberate: this client renders money and stock figures, `strict` is a hard requirement
(ADR-023), and a deploy that skipped the typecheck would be the one place in the pipeline
that did.

```jsonc
"rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
```

The SPA fallback. Vercel applies `rewrites` **after** the filesystem check, so real files
— `/assets/*`, `/sw.js`, `/manifest.webmanifest`, `/workbox-*.js` — are served normally
and only unmatched paths fall through to `index.html`. Without it, a deep link like
`/reports/stock-movement` is a 404 on first visit; the service worker's
`navigateFallback` only covers it once the worker is installed, which is not true of a
first visit or a hard reload.

```jsonc
"headers": [ … ]
```

- `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` —
  the same four the API sets on its own responses (`api/middleware.py`). Set here too
  because these are *document* responses from Vercel, which that middleware never sees.
- `Strict-Transport-Security` — Vercel is HTTPS-only; this makes the browser enforce it.
- `/assets/(.*)` → `immutable`, one year. Vite content-hashes those filenames, so a change
  produces a new name and a stale cache is impossible.
- `/sw.js`, `/registerSW.js`, `/index.html` → `no-cache, must-revalidate`. A cached
  service worker would pin the shop to an old build indefinitely, including past a
  security fix. The update is still a deliberate prompt rather than a reload mid-sale
  (`registerType: 'prompt'`, `skipWaiting: false`, `clientsClaim: false` — asserted by
  `tests/structural/rules.test.ts`).

### No CSP header, deliberately

The Content-Security-Policy stays in `index.html`'s `<meta>` tag.

A header and a meta tag are **both** enforced, and the effective policy is their
intersection. Declaring the policy in two places means the stricter one silently wins, so
the next person to widen the one they can find gets no effect and no error. One source,
and it is the one `tests/structural/rules.test.ts` reads.

`connect-src` is handled at build time: `vite.config.ts`'s `bm-csp-connect-src` plugin
appends the origin of `VITE_API_BASE_URL` to the directive. It is an append, not a
substitution — `http://localhost:8000` stays in the literal, so local development,
`vite preview` and the Playwright suites are unaffected, and a relative base adds nothing
because `'self'` already covers it. Verify it landed by viewing source on the deployed
page and reading the `connect-src` directive.

### The `api/*` rewrite for topology B

Not in the committed `vercel.json`, because it is only correct for one of the two
topologies and a wrong proxy target is worse than none. If you chose B, add it:

```jsonc
"rewrites": [
  { "source": "/api/:path*", "destination": "https://<your-railway-domain>/api/:path*" },
  { "source": "/(.*)",       "destination": "/index.html" }
]
```

Order matters — the `/api/` rule must come first, or the catch-all swallows it. And set
`VITE_API_BASE_URL=/api/v1` to match.

---

## 6. Vercel project settings

| Setting | Value | Note |
|---|---|---|
| Framework Preset | **Vite** | |
| Root Directory | **`.`** (repository root) | This repository *is* the front end — there is no `frontend/` subdirectory. Leave it empty or `.`. |
| Build Command | `npm run build` | From `vercel.json`. Includes `tsc -b`. |
| Output Directory | `dist` | From `vercel.json`. |
| Install Command | `npm ci` | From `vercel.json`. Lockfile-exact. |
| Node.js Version | **22.x** | `package.json` requires `>=20.19`; CI uses 22. Match CI. |
| Production Branch | `main` | |
| Include source maps | **your choice** | `vite.config.ts` sets `sourcemap: true`, so `dist/assets/*.map` is produced either way. There is no secret in this bundle to protect, and a readable stack trace from a counter PC is worth more than the obscurity. |

### What you do **not** need

- **No `api/` directory and no serverless functions.** This is a static SPA. The backend is
  a separate Railway service.
- **No `VITE_` variable for anything else.** §1 and §2.
- **No Vercel Postgres, KV, Blob or any other Vercel storage.** State lives in Neon and in
  the browser's IndexedDB.
- **No `.env.production` in the repository.** Vercel's project settings are the source, and
  an inline `VITE_`-prefixed variable takes precedence over every `.env*` file in Vite
  anyway. The committed `.env.production.example` exists so the intended value is
  reviewable and a local `vite build --mode production` is reproducible.

---

## 7. After the first deploy — what to actually check

In this order. Each one catches something the previous one cannot.

1. **The site loads.** `https://<domain>/` renders the sign-in form, not a blank page. A
   blank page with console errors is usually the CSP: view source, read `connect-src`,
   confirm your API origin is in it.
2. **A deep link loads.** `https://<domain>/reports` directly, in a fresh tab. Tests the
   SPA rewrite.
3. **The API is reachable.** DevTools → Network → sign in. The request should go to the
   host you expect, and return 200. A CORS failure here reads as
   "blocked by CORS policy" and means `BM_CORS_ALLOWED_ORIGINS` on Railway does not list
   this exact origin — compare them character by character, including `https://` and any
   `www.`.
4. **`Set-Cookie` arrives on the login response.** Network → the `login` request →
   Response Headers → `set-cookie: bm_refresh=…; HttpOnly; Secure; SameSite=…`. Check
   `SameSite` is the value §4 says it should be for your topology.
5. **🔴 The session survives a reload.** Sign in, then hard-reload. If you land back on the
   sign-in form, the refresh cookie is not being sent — go to §4. **This is the check that
   catches the SameSite problem, and nothing else does.**
6. **The session survives 16 minutes.** Sign in, leave the tab open and idle for 16+
   minutes, then use the app. If you are signed out, same cause.
7. **The service worker registers.** Application → Service Workers → `sw.js` active. Then
   Cache Storage: confirm it holds the app shell only, and **no `/api/` response**
   (ADR-031 — a cached stock figure is how something gets sold twice).
8. **Offline is honest.** DevTools → Network → Offline. Drafts must still open and edit;
   `Print Bill` and `Credit Bill` must be visibly disabled with a reason, not merely fail.

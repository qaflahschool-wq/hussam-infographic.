# HUSSAM AI API — isolated hardening workspace

This directory is the GitHub source workspace for the Cloudflare Worker. It was copied from the verified deployed Worker backup before any changes.

## Safety boundary
- This branch is `work/hussam-ai-api-hardening`.
- No Cloudflare production settings, secrets, databases, or deployments have been changed.
- CI applies `migrations/0001_initial.sql` only to a local D1 emulator. A read-only inspection of the production D1 schema found the expected seven application tables and six indexes; no remote migration was run during this work.
- Do not merge or deploy this branch until the acceptance tests pass and the owner explicitly approves production changes.

## Current baseline
- `src/index.js`: new versioned API Worker with D1-backed authentication, sessions, trial enforcement, subscription redemption, and Gemini analysis.
- `src/security.js`: security primitives shared by the Worker.
- `migrations/0001_initial.sql`: proposed D1 schema for sessions, trials, activation codes, subscriptions, login throttling, and minimal usage telemetry.
- `scripts/build.mjs`: creates a local packaging copy of the root `index.html` and runtime config for build verification.
- The current Worker serves its synchronized embedded `index.html` at `/` and generates `/config.js` directly from Worker environment variables; it does not currently use an `ASSETS` binding.
- `public/`: generated during `npm run build`; not maintained by hand.
- `../AUDIT_REPORT_HUSSAM_AI_API.md`: audit findings and remediation plan.

## Authentication and entitlement target

The browser must not be trusted to decide whether a visitor is VIP, how many trials remain, or whether an administrator is authenticated. The server will become authoritative.

Proposed model:
1. A guest session is issued by the Worker only after server-side Turnstile verification and rate controls.
2. The Worker returns a short-lived opaque session token. Only its SHA-256 hash is stored in D1.
3. An administrator signs in through a server endpoint. Passwords are stored as salted PBKDF2 hashes, never as plaintext or reversible values.
4. Guest trial counts, subscriptions, activation codes, and session revocation are stored and enforced in D1.
5. Activation codes are random, one-time values; only their hashes are stored. The current browser-generated code algorithm is not carried forward as an authority.
6. Analysis requests require a valid session and a server-side entitlement check. Usage reservations must be concurrency-safe.
7. Logs contain request IDs, status, duration, and provider/model metadata only—never images, raw lesson text, session tokens, or API keys.

## Implemented API contract
- `POST /v1/auth/guest`: verify Turnstile and create guest session/device record.
- `POST /v1/auth/admin/login`: validate administrator credentials and create admin session.
- `POST /v1/auth/logout`: revoke current session.
- `GET /v1/auth/session`: return server-calculated role, trial allowance, and subscription state.
- `POST /v1/subscriptions/redeem`: redeem a one-time activation code.
- `POST /v1/admin/activation-codes`: create an activation code; admin session required.
- `POST /v1/analyze`: authenticated lesson analysis; server enforces trial/paid entitlements.

## Runtime configuration
- D1 binding: `DB` points to the existing production D1 database in the production environment.
- Secrets already present by name in Cloudflare: `GEMINI_API_KEY`, `TURNSTILE_SECRET_KEY`, `ADMIN_BOOTSTRAP_TOKEN`, and `DEVICE_ID_PEPPER`. Secret values were not read or changed.
- Non-secret variables are declared in `wrangler.toml`: `ENVIRONMENT`, `DEV_AUTH_BYPASS`, `GEMINI_MODEL`, `ALLOWED_ORIGINS`, `HUSSAM_API_BASE_URL`, and `HUSSAM_TURNSTILE_SITE_KEY`.
- The public Turnstile site key and API base URL are emitted by the Worker at `/config.js`; the private Turnstile secret remains server-only.
- Production must use `ENVIRONMENT=production` and `DEV_AUTH_BYPASS=false`. The only bypass condition is explicit local development mode.
- The current same-origin deployment uses an empty `HUSSAM_API_BASE_URL`, so browser API requests go to the Worker serving the app.
- External vision fallback remains disabled unless the owner explicitly approves the provider and data-sharing disclosure.

The live Cloudflare plain-text variable values were not readable in the settings response. The candidate values above are from the isolated branch's Wrangler configuration; deploying them has not been approved or performed.

## Read-only production configuration check (2026-11-19)
- The live Worker has the expected `DB` binding to `hussam-infographic-prod`.
- The secret binding names `GEMINI_API_KEY`, `TURNSTILE_SECRET_KEY`, `DEVICE_ID_PEPPER`, and `ADMIN_BOOTSTRAP_TOKEN` are present. Secret values were not read.
- The production D1 aggregate check returned zero active administrators, devices, active subscriptions, unused activation codes, and redeemed activation codes. No row-level data was read. First-admin bootstrap and any legacy VIP migration therefore remain launch prerequisites.
- The live Worker settings response did not expose plain-text variable values. The isolated Wrangler candidate declares production mode, bypass disabled, the Worker origin allow-list, Gemini model, and public frontend runtime config.
- `compatibility_date` in this branch matches the current Worker setting (`2026-11-16`).

## D1 migration
Do not apply `migrations/0001_initial.sql` to production blindly: the currently inspected production database already contains the expected tables and indexes. Check its migration history and take a backup before any remote migration. Before applying it to a new database:
- confirm the actual frontend origin;
- confirm the administrator account and recovery process;
- confirm the subscription duration and existing VIP migration policy;
- confirm trial policy and whether trials are per browser/device/account;
- back up any existing database before migrations.

The schema deliberately does not import or trust existing browser localStorage entitlements. Existing users should receive a controlled migration/renewal path rather than silently trusting client-side state.

## Implementation order
1. Extract and format the existing Worker without changing behavior.
2. Add route, CORS, request-size, image, timeout, and provider-retry hardening.
3. Add D1-backed auth/session/entitlement handlers.
4. Update the frontend to use server-issued sessions and server entitlement state.
5. Add tests for authentication, entitlement concurrency, invalid payloads, provider failures, and output schema.
6. Review the diff and test report before any production change.

## Hardening implementation update (2026-11-19)
The isolated hardening branch now includes:
- Image magic-byte checks for JPEG, PNG, and WebP, including MIME/signature agreement.
- PBKDF2 iteration and salt-size bounds, plus strict session identity validation.
- Whitelisted and bounded Gemini output normalization.
- Atomic first-admin bootstrap and activation-code/subscription redemption.
- Request-ID-bound guest trial reservations with idempotent refunds.
- Atomic administrator login throttling with cleanup of stale attempt records.
- CORS preflight support for the bootstrap header and explicit malformed UTF-8/content-type handling.

CI has passed on the isolated branch, including Node syntax checks, build, 23 unit/contract tests, local D1 migration, and local Worker integration smoke tests. The CI migration targets only Wrangler's local D1 emulator.

**Production remains unchanged.** The branch is a review candidate; no remote D1 migration, secret update, Cloudflare setting change, merge, or production deployment has been performed.


## Launch baseline and final integration checks
- The owner confirmed there are currently no subscribers. No VIP migration is required for the initial launch if this remains true at the release checkpoint.
- The production D1 aggregate check returned zero active admins, devices, active subscriptions, unused activation codes, and redeemed activation codes. No row-level data was read.
- The Worker serves its embedded frontend snapshot. A contract test verifies byte-for-byte equality with root `index.html` and the runtime `/config.js` injection.
- `/config.js` now reads the public API base URL and Turnstile site key from Worker runtime variables. The production same-origin API base is empty by design.
- The Gemini API key remains a Worker secret; browser analysis requests use a server-issued bearer session.
- CI passed 23 tests on commit `1cd52e0b965635f47163757708474007bc7a8939`, along with syntax checks, build, local D1 migration, local Worker integration smoke tests, and deployable ZIP packaging. Run: https://github.com/qaflahschool-wq/hussam-infographic./actions/runs/44533184030.
- No real-browser end-to-end test, live Gemini call, live Turnstile challenge, load test, or penetration test was run. Those remain post-deployment acceptance checks.

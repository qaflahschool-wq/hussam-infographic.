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
- `scripts/build.mjs`: packages the root `index.html` and runtime configuration into static assets served by the same Worker.
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

## Required runtime configuration (not configured yet)
- D1 binding: `DB`
- Secret: `GEMINI_API_KEY` (already exists in production; do not expose or rotate without approval)
- Secret: `TURNSTILE_SECRET_KEY` (requires a configured Turnstile widget)
- Secret: `ADMIN_BOOTSTRAP_TOKEN` (one-time first-admin provisioning; rotate/revoke after setup)
- Secret: `DEVICE_ID_PEPPER` (high-entropy server-only pepper used to derive device identifiers; required in production)
- Variable: `ALLOWED_ORIGINS` (exact deployed frontend origin(s), comma-separated)
- Production must use `ENVIRONMENT=production` and `DEV_AUTH_BYPASS=false`. Turnstile bypass is permitted only when `ENVIRONMENT=development` and `DEV_AUTH_BYPASS=true`.
- Optional secret/setting: external vision fallback must remain disabled unless the owner explicitly approves the provider and data-sharing disclosure.

No values are stored in this repository. Configure secrets only after review and explicit production approval.

## Read-only production configuration check (2026-11-19)
- The live Worker has the expected `DB` binding to `hussam-infographic-prod`.
- The secret binding names `GEMINI_API_KEY`, `TURNSTILE_SECRET_KEY`, `DEVICE_ID_PEPPER`, and `ADMIN_BOOTSTRAP_TOKEN` are present. Secret values were not read.
- The current Worker settings response did not expose plain-text variable bindings. Before deploying this branch, configure `ENVIRONMENT=production`, `DEV_AUTH_BYPASS=false`, `ALLOWED_ORIGINS` with the exact app origin(s), and `GEMINI_MODEL=gemini-2.5-flash`.
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

CI has passed on the isolated branch, including Node syntax checks, build, 18 unit/contract tests, local D1 migration, and local Worker integration smoke tests. The CI migration targets only Wrangler's local D1 emulator.

**Production remains unchanged.** The branch is a review candidate; no remote D1 migration, secret update, Cloudflare setting change, merge, or production deployment has been performed.

# HUSSAM INFOGRAPHIC — local and production setup

## Local development

Requirements: Node.js 20+, npm, and Wrangler CLI.

1. Install dependencies (the project uses Node built-ins only):
   `npm install`
2. Build the frontend and runtime config:
   `npm run build`
   Optional build-time variables: `HUSSAM_TURNSTILE_SITE_KEY` and `HUSSAM_API_BASE_URL`. Leave both empty for local same-origin development.
3. Apply the schema to Wrangler's local D1 emulator (this does not create a Cloudflare database):
   `npx wrangler d1 migrations apply hussam-infographic-dev --local`
   The local emulator creates files under Wrangler's local state directory. No Cloudflare D1 resource is created.
4. Create a local-only `.dev.vars` file inside `worker/` (never commit it) containing your own development values:
   `GEMINI_API_KEY=your-development-key`
   `DEVICE_ID_PEPPER=any-long-random-local-value`
   `ADMIN_BOOTSTRAP_TOKEN=any-long-random-local-bootstrap-value`
   The development config bypasses Turnstile only for local runs. Never copy `.dev.vars` or the bypass setting into production.
5. Run tests:
   `npm test`
6. Start the Worker (serves the app at http://localhost:8787):
   `npx wrangler dev`

## Production resources prepared

The following resources have already been created in the connected Cloudflare account:

- Worker target: `hussam-ai-api` (the existing Worker; its old code has not been replaced yet).
- Production D1: `hussam-infographic-prod`
- D1 UUID: `e4a4107a-afa5-4176-9084-7522eb17ef2d`
- Initial schema: applied and verified (admins, devices, sessions, activation_codes, subscriptions, usage_events, auth_attempts, and indexes).
- Turnstile widget: `HUSSAM INFOGRAPHIC Production`
- Turnstile hostname: `hussam-ai-api.alshakliamohammed04.workers.dev`
- Turnstile site key (public): `0x4AAAAAAGGB8qiUN5rEEU35`

The application HTML is bundled into `src/index.js`; the Worker serves `/` and `/config.js` from the same origin. The current GitHub Actions workflow validates the Worker, builds the frontend, runs unit tests, applies migrations to a local D1 emulator, executes local integration tests, and packages the project.

## Remaining production activation

**The production Worker has not been replaced or deployed yet.** The current Worker still runs its previous code. Before deployment, add these secret bindings to the existing `hussam-ai-api` Worker using Cloudflare Dashboard → Workers & Pages → `hussam-ai-api` → Settings → Variables and Secrets → Add → Secret:

- `TURNSTILE_SECRET_KEY`: copy the secret key from the Turnstile widget above.
- `DEVICE_ID_PEPPER`: a cryptographically random value of at least 32 bytes.
- `ADMIN_BOOTSTRAP_TOKEN`: a separate cryptographically random one-time token of at least 32 bytes.

The existing `GEMINI_API_KEY` secret is already present on this Worker and must be preserved. Do not put secret values in GitHub or in source code.

After adding the three secrets, verify that all four secret names are listed (values must remain hidden). Then the Worker can be deployed with the production D1 binding and same-origin app. On first opening the app, use the owner panel's “إعداد حساب المالك لأول مرة” section to create the owner account with the bootstrap token, a valid email, and a strong password of at least 12 characters. The bootstrap endpoint works only before the first administrator exists.

For the final release, verify health, Turnstile guest authentication, admin bootstrap/login, trial enforcement, code redemption, and one real Gemini analysis. Do not expose the bootstrap token in screenshots or public messages.

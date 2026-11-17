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
4. Set local secrets:
   `npx wrangler secret put GEMINI_API_KEY`
   `npx wrangler secret put DEVICE_ID_PEPPER`
   For local-only use, a Turnstile bypass is enabled in the development vars. Never deploy those vars to production.
6. Run tests:
   `npm test`
7. Start the Worker:
   `npx wrangler dev`

## Production checklist (do not run until explicitly approved)

1. Create a dedicated production D1 database in the correct Cloudflare account.
2. Replace the production D1 placeholder ID in wrangler.toml.
3. Set exact frontend origin in `ALLOWED_ORIGINS`.
4. Configure secrets:
   - `GEMINI_API_KEY`
   - `DEVICE_ID_PEPPER` (long random secret)
   - `TURNSTILE_SECRET_KEY`
   - `ADMIN_BOOTSTRAP_TOKEN` (long random one-time token)
5. Configure Turnstile for the final Worker hostname. Build with `HUSSAM_TURNSTILE_SITE_KEY=<public-site-key>` so the public key is written to `public/config.js`.
6. Set `DEV_AUTH_BYPASS=false` and `ENVIRONMENT=production`.
7. Apply migrations to production D1 only after database backup and explicit approval.
8. Provision the first administrator using `POST /v1/auth/admin/bootstrap` with header `X-Admin-Bootstrap`. Do not put bootstrap token or password in source control.
9. Run `npm run build` and deploy the Worker; it serves both the static frontend and API from the same origin.
10. Verify health, guest auth, admin login, trial enforcement, code redemption, and Gemini analysis.

The Worker intentionally fails closed when D1, allowed origins, required secrets, or Turnstile are not configured. No production database or secret was created by this repository change.

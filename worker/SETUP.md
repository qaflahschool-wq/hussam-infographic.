# HUSSAM INFOGRAPHIC — local and production setup

## Local development

Requirements: Node.js 20+, npm, and Wrangler CLI.

1. Install dependencies (the project currently uses Node built-ins only):
   `npm install`
2. Create local D1 storage:
   `npx wrangler d1 create hussam-infographic-dev`
3. If Wrangler returns a database UUID, replace the local `database_id` in `wrangler.toml` with that UUID.
4. Apply schema locally:
   `npx wrangler d1 migrations apply hussam-infographic-dev --local`
5. Set local secrets:
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
5. Configure Turnstile and set the public site key in the frontend configuration.
6. Set `DEV_AUTH_BYPASS=false` and `ENVIRONMENT=production`.
7. Apply migrations to production D1 only after database backup and explicit approval.
8. Provision the first administrator using `POST /v1/auth/admin/bootstrap` with header `X-Admin-Bootstrap`. Do not put bootstrap token or password in source control.
9. Deploy Worker and then deploy the frontend configured to use its exact origin.
10. Verify health, guest auth, admin login, trial enforcement, code redemption, and Gemini analysis.

The Worker intentionally fails closed when D1, allowed origins, required secrets, or Turnstile are not configured. No production database or secret was created by this repository change.

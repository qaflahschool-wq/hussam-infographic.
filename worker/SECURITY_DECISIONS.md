# HUSSAM INFOGRAPHIC — security decisions and release gates

This document records the security decisions for the isolated Worker hardening candidate. It does not authorize production deployment.

## 1. Production resources verified
- Existing Worker: `hussam-ai-api`.
- Production D1: `hussam-infographic-prod`, ID `e4a4107a-afa5-4176-9084-7522eb17ef2d`.
- Worker D1 binding `DB` points to that database.
- The production database has the expected seven application tables and six indexes. Inspection was read-only; no rows were modified and no remote migration was run.
- Secret binding names `GEMINI_API_KEY`, `TURNSTILE_SECRET_KEY`, `DEVICE_ID_PEPPER`, and `ADMIN_BOOTSTRAP_TOKEN` are present. Secret values were not read.
- The Cloudflare settings response did not expose the Worker plain-text variables. Before release, explicitly verify `ENVIRONMENT=production`, `DEV_AUTH_BYPASS=false`, `GEMINI_MODEL=gemini-2.5-flash`, and the exact `ALLOWED_ORIGINS` value.

## 2. Administrator account
- The candidate uses server-side admin authentication, PBKDF2 password hashes, hashed opaque session tokens, and a one-time bootstrap secret.
- Never place the administrator password or bootstrap token in GitHub, source code, screenshots, or ordinary chat.
- Create the first administrator only after reviewing the release candidate and confirming the bootstrap secret is set.

## 3. Free trial policy
- The candidate enforces two free analyses per installation identity using D1, Turnstile, cooldown controls, and request-specific reservations.
- This is not equivalent to verified one-person/one-trial enforcement. Without a verified account or phone identity, a visitor may attempt to create another installation identity.

## 4. Existing VIP subscriptions and codes
- The owner confirmed on 2026-11-19 that there are currently no subscribers.
- Therefore, no VIP subscriber or legacy-code migration is required for the initial launch, provided this remains true at the release checkpoint.
- Browser localStorage is not accepted as proof of payment by the new API. New subscriptions must be created through the server-side administrator flow after the first owner account is bootstrapped.
- If any paid subscriber or previously sold code appears before launch, pause release and reconcile it manually before proceeding; never import unverified browser state as proof of payment.

## 5. Turnstile and origins
- Guest-session creation requires server-side Turnstile verification outside explicit local development.
- The public site key is included in the frontend; the private Turnstile secret remains a Cloudflare secret.
- Confirm that the Turnstile hostname and `ALLOWED_ORIGINS` match the actual published application origin(s). The same-origin Worker-hosted app is currently configured as the candidate deployment path.

## 6. External AI processing
- Gemini is the configured provider. Uploaded images and text submitted for analysis are sent to Gemini by the Worker.
- Keep the provider disclosure clear to users. Do not enable another external provider without owner approval and a disclosure of data sharing.

## 7. Release gate
The hardening candidate is on `work/hussam-ai-api-hardening` and reviewed through draft PR #1. CI has passed syntax checks, build, unit/contract tests, local D1 migration, and local integration smoke tests. This does not prove live production behavior.

Before deployment:
1. Review and approve the full PR diff.
2. Verify the production plain-text Worker variables and exact application origin.
3. Decide the legacy VIP/subscriber migration approach.
4. Take and verify a production D1 backup.
5. Confirm all production secret binding names without exposing values.
6. Run the final production deployment only after explicit owner approval, then verify health, Turnstile guest login, admin bootstrap/login, trials, activation redemption, and Gemini analysis.

No production deployment, remote D1 migration, secret mutation, Worker setting change, or merge to `main` has been performed as part of this candidate work.

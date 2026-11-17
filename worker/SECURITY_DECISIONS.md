# Security decisions required before production rollout

This document records decisions that must be resolved before the Worker and frontend can be safely connected to D1. It is not permission to change production resources.

## 1. Database
- No D1 database or D1 binding was visible in the connected Cloudflare account during the read-only audit.
- Recommended direction: create one dedicated D1 database for HUSSAM INFOGRAPHIC only after reviewing the migration and receiving explicit approval.
- Do not reuse a database from another product without confirming ownership, schema, backup, and environment separation.

## 2. Administrator account
- Existing admin checks are embedded in browser JavaScript and cannot be treated as secure.
- A new administrator password must be provisioned through a one-time server-side bootstrap flow.
- Never paste the administrator password or bootstrap token into GitHub or ordinary chat.
- The first admin must be provisioned only after D1 and the bootstrap secret are configured.

## 3. Free trial policy
Current UI shows two free attempts and stores the count in localStorage. This is not enforceable.
Proposed default: two server-counted guest attempts per registered installation, plus Turnstile and request-rate controls.
Important limitation: without verified user identity, a visitor can still attempt to create a new installation identity. If strict one-person/one-trial enforcement is required, the app needs account or phone verification.

## 4. Existing VIP subscriptions and codes
- The current VIP check and code signature are computed in the browser, and a static master code is accepted there.
- The old scheme cannot be made trustworthy by simply copying its data into D1.
- Existing VIP users need a controlled migration path. Options: manually import a verified subscriber list, or issue replacement codes after confirming payments.
- Do not silently revoke legitimate paid access. Also do not trust browser localStorage as proof of payment.

## 5. Turnstile
- Guest-session creation should require server-verified Turnstile.
- This requires a public site key in the frontend and a private secret in Cloudflare.
- The widget's hostname restrictions must match the actual published frontend origin.
- Turnstile reduces automated abuse; it does not prove a visitor is a paying subscriber.

## 6. External AI fallback
- Recommended default: disabled.
- Re-enable only after the owner approves the provider and the app clearly discloses that uploaded images may be sent to that provider.

## 7. Frontend origin and deployment
- The Worker currently has a custom workers.dev URL.
- The repository contains a single root `index.html`; no deployment workflow or custom frontend domain was found in the repository.
- Before CORS is locked down, confirm the exact browser origin used by the deployed site. Do not guess it from the repository name.

## Release gate
No D1 creation, secret creation/rotation, Worker setting change, production deployment, or merge to `main` is allowed until:
1. The owner approves the database creation and final schema.
2. The owner confirms how to handle existing VIP users.
3. The actual frontend origin is verified.
4. Test results and the full code diff are reviewed.
5. The owner explicitly approves the production change.

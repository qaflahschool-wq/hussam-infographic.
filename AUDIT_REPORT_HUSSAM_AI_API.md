# HUSSAM AI API — Security and Reliability Audit
Date: 2026-11-18
Scope: Cloudflare Worker `hussam-ai-api` and its GitHub Pages client.
Mode: Read-only audit plus isolated GitHub backup/report branches. No production changes.

## Backup and source baseline
- Default branch: `main`
- Baseline commit: `e08e507020e33c9ea93c1879c451b70183464871`
- Frontend file: `index.html`, blob SHA `067798f944431183549405bc144d78526ece1ea7`
- Backup branch: `backup/pre-audit-2026-11-18`
- Worker backup: `cloudflare-backup/hussam-ai-api.worker.js`
- Worker backup source length: 448,516 characters
- Backup branch preserves the same `index.html` blob as main.
- Cloudflare deployment history identifies the Worker deployments as `quick_editor`; no GitHub-driven Worker deployment was established.
- The inspected repository default branch contains only `index.html`; no Worker source, Wrangler config, automated tests, or deployment workflow was found at repository root.

## Implementation follow-up — 2026-11-19
The findings below describe the previously deployed Worker baseline. A replacement/hardening implementation has since been prepared in the isolated branch `work/hussam-ai-api-hardening`; the original production findings remain operationally open until that candidate is reviewed and explicitly deployed.

- The owner confirmed the existing production D1 database `hussam-infographic-prod`, ID `e4a4107a-afa5-4176-9084-7522eb17ef2d`, and the Worker binding `DB`. This supersedes the earlier observation that the connected account view did not expose a D1 database/binding.
- A read-only Cloudflare API inspection confirmed the production D1 contains the seven expected application tables and all six indexes defined by `worker/migrations/0001_initial.sql`. No table rows or secret values were queried. No remote migration or write operation was performed.
- A pre-fix branch snapshot was created at `backup/pre-fixes-2026-11-19`.
- The candidate Worker source now includes server-side sessions/entitlements, image signature validation, bounded password parameters, atomic bootstrap and activation redemption, request-specific trial refunds, atomic login throttling, bounded AI output normalization, and stricter CORS/input handling.
- GitHub Actions passed: syntax checks, build, 18 tests, local D1 migration, and local Worker integration tests for concurrent bootstrap, concurrent login throttling, guest trial refund, activation-code redemption, and CORS. The run is [44529039738](https://github.com/qaflahschool-wq/hussam-infographic./actions/runs/44529039738).
- A draft review PR is open: [PR #1](https://github.com/qaflahschool-wq/hussam-infographic./pull/1).

No production secrets, Cloudflare settings, remote D1 data/schema, Worker deployment, or default-branch code have been changed. The D1 migration used by CI runs against the local Wrangler emulator only.

## Findings

### P0 — API has no server-side caller authentication
The Worker POST handler accepts a request and proceeds to Gemini without validating a session, signed token, user identity, or authorization claim. The frontend sends `deviceId`, but the Worker does not read or validate it. CORS is not authentication.
Impact: the public Worker endpoint can be called independently of the UI, bypassing client-side usage controls and consuming the configured Gemini quota.

### P0 — Subscription and trial controls are client-side only
The frontend stores trial count and VIP expiry in `localStorage`. The VIP signature algorithm and its secret material are shipped in `index.html`; a static master activation code is also accepted in the client-side activation path. The admin login checks fixed hashes in frontend JavaScript.
Impact: these mechanisms do not provide trustworthy entitlement or admin authorization. They can be inspected or bypassed by a user controlling their browser. The Worker currently does not enforce subscription state.
Recommendation: move entitlement issuance and verification to a trusted server-side design. Do not migrate the existing client-side scheme as-is.

### P1 — CORS fallback is permissive
When the Origin is not on the allow-list, `getCorsHeaders` returns `Access-Control-Allow-Origin: *`. This makes the allow-list ineffective as a browser-origin restriction. CORS remains a browser policy, not an authorization boundary.
Recommendation: return an explicit denial/no permissive CORS header for disallowed origins, handle preflight consistently, and rely on server-side authentication independently.

### P1 — Unbounded request body and weak image validation
The Worker reads the complete request body with `request.text()` before applying field truncation. It limits the image count to five but does not enforce a total request-size ceiling, per-image byte ceiling, strict MIME allow-list, or robust base64 validation before building provider payloads.
Impact: excess memory/CPU use and unnecessary provider requests are possible.
Recommendation: enforce Content-Length where present and a streaming/body-size cap; validate schema, image MIME, encoded length, and image count before provider calls.

### P1 — External vision fallback can receive uploaded images
The Worker sends images to Pollinations when no parseable Gemini result is produced. The condition is broader than a confirmed temporary 503: it can also run after other unsuccessful or malformed Gemini outcomes.
Impact: user-uploaded educational images may be sent to a second provider without a clearly enforced consent/configuration boundary.
Recommendation: disable by default until the data-sharing policy is approved; if retained, gate it explicitly, restrict triggering to approved failure classes, and disclose the provider.

### P1 — Upstream retry policy is too broad and insufficiently bounded
The retry list includes 400 and 404 as well as transient statuses. The visible loop does not implement Retry-After handling or exponential backoff, and provider fetches do not show an AbortController timeout.
Impact: avoidable provider calls, slow requests, and confusing fallback behavior.
Recommendation: classify permanent vs transient failures, cap attempts and total wall-clock time, honor Retry-After, and use bounded backoff.

### P2 — Internal diagnostics are returned to the browser
Error responses include upstream status, a provider error excerpt, and the attempted model/status list; the catch response includes an exception message.
Impact: unnecessary internal implementation detail is exposed to callers.
Recommendation: return stable public error codes and correlation IDs; keep sanitized diagnostics server-side.

### P2 — API key is placed in Gemini URL query string
The Gemini key is appended as `?key=` to the outbound request URL.
Recommendation: use Google's supported authentication header if supported by the selected API endpoint, and ensure URLs/query strings are redacted from observability.

### P2 — Worker route and health behavior are not separated
GET returns service metadata on every path, and POST processing is not restricted to a specific API route. The `workerContextActive: Boolean(ctx || true)` field is always true.
Recommendation: define explicit `/health` and `/v1/analyze` routes and remove misleading status fields.

### P2 — Observability configuration needs privacy review
Worker observability is enabled with 100% head sampling; logs persist and invocation logs are enabled; query-string redaction is disabled; traces are disabled.
Recommendation: enable query-string redaction, review which fields are logged, and choose sampling based on operational needs. Do not log request bodies, images, secrets, or personal data.

### P2 — GitHub is not yet the complete source of truth
The inspected GitHub default branch contains the client `index.html`, but no Worker source or Wrangler/deployment configuration. Cloudflare shows quick-editor deployments.
Impact: frontend and backend can drift, and backend changes are not reproducibly built/deployed from GitHub.
Recommendation: maintain Worker source in GitHub, add Wrangler configuration with non-secret bindings only, and add CI checks. Keep production deployment manual/approval-gated.

## Proposed remediation sequence

1. **Architecture and entitlement decision:** identify the authoritative user/subscription store and desired login/activation flow. The currently connected Cloudflare account did not show a D1 database or a D1 binding on this Worker; do not create a database until the existing system of record is identified.
2. **API boundary:** introduce explicit routes, server-side authentication/authorization, server-enforced entitlement and trial policy, and abuse/rate controls.
3. **Input safety:** strict schema, body/image size limits, MIME/base64 validation, and bounded parsing.
4. **Provider reliability:** Gemini model allow-list, status classification, bounded retries/timeouts, and opt-in external fallback.
5. **Output and error contracts:** schema validation, stable public errors, correlation IDs, and private sanitized diagnostics.
6. **Frontend alignment:** send the server-issued token, remove client-side secrets/master activation paths as the authority, and preserve existing UI behavior.
7. **Reproducible source:** place Worker source and Wrangler config in GitHub; CI checks only until explicit production approval.
8. **Acceptance tests:** unauthorized request rejected; valid session succeeds; trial/paid entitlements enforced server-side; disallowed Origin receives no permissive CORS; oversized/malformed payload rejected; unsupported MIME rejected; provider timeout/retry bounded; external fallback disabled unless approved; valid lesson JSON returned; no secrets/provider internals exposed.

## Test status and change boundary
- Static source/config review: completed.
- GitHub backup verification: completed.
- Runtime/API integration tests: not run.
- Browser end-to-end tests: not run.
- Load/security penetration tests: not run.
- Cloudflare settings changed: no.
- Production Worker code changed: no.
- Production deployment performed: no.

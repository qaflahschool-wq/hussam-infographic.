const base = "http://127.0.0.1:8787";
const bootstrapToken = "ci-bootstrap-token-which-is-long-enough-2026";
const password = "Local-Only-Admin-Passphrase-2026";

async function call(path, { method = "GET", body, token, headers = {}, expected } = {}) {
  const h = { ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  if (token) h.Authorization = "Bearer " + token;
  const res = await fetch(base + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (expected !== undefined && res.status !== expected) {
    throw new Error(path + " expected HTTP " + expected + " but received " + res.status + ": " + JSON.stringify(data));
  }
  return { status: res.status, data };
}

const health = await call("/health", { expected: 200 });
if (health.data?.status !== "ok") throw new Error("Worker health check failed");

const home = await fetch(base + "/");
const html = await home.text();
if (!home.ok || !html.includes("Hussam Infographic")) throw new Error("Static frontend was not served by Worker");

const guest = await call("/v1/auth/guest", {
  method: "POST",
  body: { deviceId: "HSM-12345678901234567890123456789012", turnstileToken: "" },
  expected: 200
});
const guestToken = guest.data?.token;
if (!guestToken) throw new Error("Guest session token missing");

const guestSession = await call("/v1/auth/session", { token: guestToken, expected: 200 });
if (guestSession.data?.entitlement?.role !== "guest") throw new Error("Guest entitlement missing");

await call("/v1/auth/admin/bootstrap", {
  method: "POST",
  headers: { "X-Admin-Bootstrap": bootstrapToken },
  body: { username: "owner@example.test", password },
  expected: 201
});

const admin = await call("/v1/auth/admin/login", {
  method: "POST",
  body: { username: "owner@example.test", password },
  expected: 200
});
const adminToken = admin.data?.token;
if (!adminToken) throw new Error("Admin session token missing");

const generated = await call("/v1/admin/activation-codes", {
  method: "POST",
  token: adminToken,
  body: { durationDays: 90 },
  expected: 201
});
if (!generated.data?.code?.startsWith("HUSSAM-")) throw new Error("Activation code was not generated");

await call("/v1/subscriptions/redeem", {
  method: "POST",
  token: guestToken,
  body: { code: generated.data.code },
  expected: 200
});
const upgraded = await call("/v1/auth/session", { token: guestToken, expected: 200 });
if (upgraded.data?.entitlement?.isVip !== true) throw new Error("Subscription was not reflected in server entitlement");

await call("/v1/analyze", {
  method: "POST",
  token: guestToken,
  body: { grade: "7", subject: "English", hintTitle: "Test lesson", rawText: "This is a local integration test." },
  expected: 503
}).then(({ data }) => {
  if (data?.error !== "PROVIDER_NOT_CONFIGURED") throw new Error("Expected safe missing-provider response");
});

const denied = await call("/v1/auth/guest", {
  method: "POST",
  headers: { Origin: "https://not-allowed.example" },
  body: { deviceId: "HSM-12345678901234567890123456789099", turnstileToken: "" },
  expected: 403
});
if (denied.data?.error !== "ORIGIN_NOT_ALLOWED") throw new Error("Disallowed origin was not rejected");

console.log("Local integration smoke test passed: assets, guest auth, admin bootstrap/login, one-time subscription, entitlement, provider-safe error, CORS.");

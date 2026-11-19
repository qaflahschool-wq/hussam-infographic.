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
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(12000)
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

await call("/v1/analyze", {
  method: "POST",
  token: guestToken,
  body: { grade: "7", subject: "English", hintTitle: "Trial refund test", rawText: "The provider is intentionally not configured in CI." },
  expected: 503
}).then(({ data }) => {
  if (data?.error !== "PROVIDER_NOT_CONFIGURED") throw new Error("Expected safe missing-provider response for free trial");
});
const afterRefund = await call("/v1/auth/session", { token: guestToken, expected: 200 });
if (afterRefund.data?.entitlement?.trialUsed !== 0) {
  throw new Error("Failed provider request did not refund its exact guest trial reservation");
}

const bootstrapAttempts = await Promise.all([
  call("/v1/auth/admin/bootstrap", {
    method: "POST",
    headers: { "X-Admin-Bootstrap": bootstrapToken },
    body: { username: "owner@example.test", password },
    expected: undefined
  }),
  call("/v1/auth/admin/bootstrap", {
    method: "POST",
    headers: { "X-Admin-Bootstrap": bootstrapToken },
    body: { username: "second-owner@example.test", password },
    expected: undefined
  })
]);
const createdAdmin = bootstrapAttempts.find((item) => item.status === 201);
const rejectedBootstrap = bootstrapAttempts.find((item) => item.status === 409);
if (!createdAdmin || !rejectedBootstrap) {
  throw new Error("Concurrent bootstrap did not create exactly one administrator");
}
const adminUsername = createdAdmin.data?.created ? (
  bootstrapAttempts[0].status === 201 ? "owner@example.test" : "second-owner@example.test"
) : "";

const admin = await call("/v1/auth/admin/login", {
  method: "POST",
  body: { username: adminUsername, password },
  expected: 200
});
const adminToken = admin.data?.token;
if (!adminToken) throw new Error("Admin session token missing");

const throttledAttempts = await Promise.all(Array.from({ length: 10 }, () =>
  call("/v1/auth/admin/login", {
    method: "POST",
    body: { username: "missing-user@example.test", password: "Wrong-Password-For-Rate-Limit-Test" }
  })
));
const unauthorizedCount = throttledAttempts.filter((item) => item.status === 401).length;
const limitedCount = throttledAttempts.filter((item) => item.status === 429).length;
if (unauthorizedCount !== 8 || limitedCount !== 2) {
  throw new Error("Concurrent login throttling was not atomic: expected 8 unauthorized and 2 rate-limited attempts");
}

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


const denied = await call("/v1/auth/guest", {
  method: "POST",
  headers: { Origin: "https://not-allowed.example" },
  body: { deviceId: "HSM-12345678901234567890123456789099", turnstileToken: "" },
  expected: 403
});
if (denied.data?.error !== "ORIGIN_NOT_ALLOWED") throw new Error("Disallowed origin was not rejected");

console.log("Local integration smoke test passed: assets, guest auth, admin bootstrap/login, one-time subscription, entitlement, provider-safe error, CORS.");

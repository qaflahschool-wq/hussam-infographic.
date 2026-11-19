import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const rootHtml = await readFile(new URL("../../index.html", import.meta.url), "utf8");
const workerSource = await readFile(new URL("../src/index.js", import.meta.url), "utf8");

test("Worker embedded frontend is byte-for-byte synchronized with the repository frontend", () => {
  const match = workerSource.match(/const APP_HTML_BASE64 = "([^"]+)";/);
  assert.ok(match, "Worker HTML payload is present");
  assert.equal(Buffer.from(match[1], "base64").toString("utf8"), rootHtml);
});

test("Worker injects runtime configuration before frontend scripts execute", () => {
  assert.match(workerSource, /function getAppConfigJs\(env\)/);
  assert.match(workerSource, /apiBaseUrl: typeof env\.HUSSAM_API_BASE_URL/);
  assert.match(workerSource, /turnstileSiteKey: typeof env\.HUSSAM_TURNSTILE_SITE_KEY/);
  assert.match(workerSource, /path === "\/config\.js"/);
  assert.match(workerSource, /getAppHtml\(env\)/);
  assert.match(workerSource, /html\.replace\("\<\/head\>"/);
});

test("Frontend delegates authentication, entitlements, analysis and subscriptions to the Worker API", () => {
  for (const route of [
    "/v1/auth/guest",
    "/v1/auth/session",
    "/v1/auth/admin/bootstrap",
    "/v1/auth/admin/login",
    "/v1/analyze",
    "/v1/subscriptions/redeem",
    "/v1/admin/activation-codes"
  ]) {
    assert.ok(rootHtml.includes(route), `Missing frontend API route: ${route}`);
  }
  assert.match(rootHtml, /function isVipActive\(\)\s*\{\s*return Boolean\(serverEntitlement && serverEntitlement\.isVip === true\)/);
  assert.match(rootHtml, /function getUsedTrials\(\)\s*\{\s*return serverEntitlement \? Number\(serverEntitlement\.trialUsed \|\| 0\) : 0/);
  assert.match(rootHtml, /function getActiveGeminiKey\(\)\s*\{[\s\S]{0,180}return DEFAULT_BACKEND_PROXY_URL/);
  assert.doesNotMatch(rootHtml, /generativelanguage\.googleapis\.com/);
});

test("Frontend does not treat legacy browser subscription keys as VIP authority", () => {
  assert.doesNotMatch(rootHtml, /localStorage\.(?:getItem|setItem)\(['"](?:hussam_info_vip_sub|hussam_info_sub)/);
  assert.match(rootHtml, /Browser storage is only a session cache/);
});

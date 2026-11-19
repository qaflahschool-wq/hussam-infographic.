import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const frontend = readFileSync(resolve(here, "../../index.html"), "utf8");
const worker = readFileSync(resolve(here, "../src/index.js"), "utf8");

test("all inline frontend scripts parse as JavaScript", () => {
  const scripts = [...frontend.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((value) => value.trim().length > 0);
  assert.ok(scripts.length > 0, "expected at least one inline script");
  scripts.forEach((source, index) => {
    try {
      new Script(source, { filename: `index-inline-${index}.js` });
    } catch (error) {
      throw new Error(`inline script ${index} failed: ${error.stack || error.message}; details=${JSON.stringify(Object.getOwnPropertyNames(error).reduce((o,k)=>(o[k]=error[k],o),{}))}`);
    }
  });
});

test("Worker exposes only versioned auth, subscription and analysis endpoints", () => {
  for (const route of [
    "/v1/auth/guest",
    "/v1/auth/admin/bootstrap",
    "/v1/auth/admin/login",
    "/v1/auth/session",
    "/v1/auth/logout",
    "/v1/subscriptions/redeem",
    "/v1/admin/activation-codes",
    "/v1/analyze"
  ]) assert.ok(worker.includes(route), `missing route ${route}`);
});

test("Worker fails closed for missing auth and disallowed origins", () => {
  assert.ok(worker.includes('safeError("ORIGIN_NOT_ALLOWED", 403, id)'));
  assert.ok(worker.includes('safeError("UNAUTHORIZED", 401, id)'));
  assert.ok(!worker.includes('Access-Control-Allow-Origin"] = "*'));
});

test("frontend no longer contains the previous browser-side VIP master code or admin hashes", () => {
  assert.ok(!frontend.includes("VIP-365-HUSSAM"));
  assert.ok(!frontend.includes("12904a5a"));
  assert.ok(!frontend.includes("a86e095a"));
});

test("frontend sends analysis requests through bearer-authenticated API", () => {
  assert.ok(frontend.includes("'/v1/analyze'"));
  assert.ok(frontend.includes("'Authorization': 'Bearer ' + token"));
  assert.ok(frontend.includes("applyServerEntitlement(parsed.entitlement)"));
});


test("embedded Worker frontend stays byte-for-byte aligned with the root index", () => {
  const match = worker.match(/const APP_HTML_BASE64 = "([A-Za-z0-9+/=]+)";/);
  assert.ok(match, "expected the Worker to contain its frontend snapshot");
  const embeddedFrontend = Buffer.from(match[1], "base64").toString("utf8");
  assert.equal(embeddedFrontend, frontend, "rebuild the embedded frontend after changing index.html");
  assert.ok(worker.includes('html.replace("</head>", \'  <script src="/config.js"></script>\''),
    "the Worker must inject runtime configuration before frontend scripts execute");
  assert.ok(worker.includes('window.HUSSAM_CONFIG = Object.freeze({apiBaseUrl:"",turnstileSiteKey:"0x4AAAAAAGGB8qiUN5rEEU35"})'),
    "the public Turnstile site key and same-origin API configuration must be present");
});

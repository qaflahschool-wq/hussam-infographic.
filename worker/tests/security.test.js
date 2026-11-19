import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAllowedOrigins,
  buildCorsHeaders,
  readJsonLimited,
  validateImageDataUrl,
  createOpaqueToken,
  sha256Hex,
  constantTimeEqual,
  hashPassword,
  verifyPassword,
  releaseGuestTrial,
  getBearerToken
} from "../src/security.js";

test("CORS allows only an exact configured origin", () => {
  const allowed = parseAllowedOrigins("https://example.test, https://app.example.test");
  const accepted = buildCorsHeaders("https://example.test", allowed);
  const rejected = buildCorsHeaders("https://attacker.test", allowed);
  assert.equal(accepted.allowed, true);
  assert.equal(accepted.headers.get("Access-Control-Allow-Origin"), "https://example.test");
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.headers.get("Access-Control-Allow-Origin"), null);
});
test("CORS permits the admin bootstrap header during preflight", () => {
  const result = buildCorsHeaders("https://example.test", parseAllowedOrigins("https://example.test"));
  assert.ok(result.headers.get("Access-Control-Allow-Headers").includes("X-Admin-Bootstrap"));
});

test("CORS does not create wildcard access for an absent Origin", () => {
  const result = buildCorsHeaders("", parseAllowedOrigins("https://example.test"));
  assert.equal(result.allowed, false);
  assert.equal(result.headers.get("Access-Control-Allow-Origin"), null);
});

test("readJsonLimited parses a JSON object", async () => {
  const request = new Request("https://worker.test/v1/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grade: "7", subject: "English" })
  });
  assert.deepEqual(await readJsonLimited(request, 1024), { grade: "7", subject: "English" });
});

test("readJsonLimited rejects a declared oversized body", async () => {
  const request = new Request("https://worker.test/v1/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": "2048" },
    body: "{}"
  });
  await assert.rejects(() => readJsonLimited(request, 100), { code: "REQUEST_TOO_LARGE" });
});

test("readJsonLimited maps malformed UTF-8 to INVALID_JSON", async () => {
  const request = new Request("https://worker.test/v1/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: new Uint8Array([0xff, 0xfe])
  });
  await assert.rejects(() => readJsonLimited(request, 100), { code: "INVALID_JSON" });
});

test("image validator checks real file signatures and MIME agreement", () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0y8AAAAASUVORK5CYII=";
  const valid = validateImageDataUrl(png, 1024);
  assert.equal(valid.mimeType, "image/png");
  assert.ok(valid.byteLength > 8);
  assert.equal(validateImageDataUrl("data:image/jpeg;base64,aGVsbG8=", 100), null);
  assert.equal(validateImageDataUrl("data:image/jpeg;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0y8AAAAASUVORK5CYII=", 1024), null);
  assert.equal(validateImageDataUrl("data:image/svg+xml;base64,PHN2Zz4=", 100), null);
  assert.equal(validateImageDataUrl("data:image/png;base64,not base64", 100), null);
  assert.equal(validateImageDataUrl(png, 2), null);
});

test("opaque tokens are random URL-safe values", () => {
  const first = createOpaqueToken();
  const second = createOpaqueToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});

test("SHA-256 hashes are fixed-length hex and constant comparison works", async () => {
  const digest = await sha256Hex("test");
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(constantTimeEqual("same", "same"), true);
  assert.equal(constantTimeEqual("same", "different"), false);
});

test("passwords use salted PBKDF2 and verify without storing plaintext", async () => {
  const stored = await hashPassword("StrongPassphrase-2026");
  assert.ok(stored.salt);
  assert.ok(stored.hash);
  assert.notEqual(stored.hash, "StrongPassphrase-2026");
  assert.equal(await verifyPassword("StrongPassphrase-2026", stored.salt, stored.hash, stored.iterations), true);
  assert.equal(await verifyPassword("wrong-passphrase", stored.salt, stored.hash, stored.iterations), false);
});

test("password hashing rejects unsafe PBKDF2 parameters and invalid salt sizes", async () => {
  await assert.rejects(() => hashPassword("StrongPassphrase-2026", undefined, 99999), /INVALID_PASSWORD_ITERATIONS/);
  await assert.rejects(() => hashPassword("StrongPassphrase-2026", undefined, 600001), /INVALID_PASSWORD_ITERATIONS/);
  await assert.rejects(() => hashPassword("StrongPassphrase-2026", btoa("short")), /INVALID_PASSWORD_SALT/);
});

test("bearer token parser accepts only the documented format", () => {
  const token = "A".repeat(43);
  const request = new Request("https://worker.test", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(getBearerToken(request), token);
  const bad = new Request("https://worker.test", { headers: { Authorization: "Basic abc" } });
  assert.equal(getBearerToken(bad), null);
});

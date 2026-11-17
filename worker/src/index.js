import {
  parseAllowedOrigins,
  buildCorsHeaders,
  jsonResponse,
  readJsonLimited,
  validateImageDataUrl,
  createOpaqueToken,
  sha256Hex,
  constantTimeEqual,
  hashPassword,
  verifyPassword,
  findActiveSession,
  createSession,
  reserveGuestTrial,
  releaseGuestTrial,
  getBearerToken
} from "./security.js";

const MAX_BODY_BYTES = 14 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 5;
const MAX_TRIALS = 2;
const GUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ADMIN_TTL_MS = 8 * 60 * 60 * 1000;
const MODEL_ALLOWLIST = new Set(["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"]);

function requestId() {
  return crypto.randomUUID();
}

function safeError(code, status, id) {
  return { error: code, requestId: id };
}

function response(payload, status, cors, id) {
  const headers = new Headers(cors.headers);
  headers.set("X-Request-ID", id);
  return jsonResponse(payload, status, headers);
}

function originAllowed(request, allowed) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  return allowed.has(origin);
}

async function parseBody(request, limit = MAX_BODY_BYTES) {
  const contentType = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    const e = new Error("UNSUPPORTED_CONTENT_TYPE");
    e.code = "UNSUPPORTED_CONTENT_TYPE";
    throw e;
  }
  return readJsonLimited(request, limit);
}

function validateDeviceId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,100}$/.test(value);
}

async function verifyTurnstile(token, request, env) {
  if (env.DEV_AUTH_BYPASS === "true" && env.ENVIRONMENT !== "production") return true;
  if (!env.TURNSTILE_SECRET_KEY || typeof token !== "string" || token.length < 10) return false;
  const form = new URLSearchParams();
  form.set("secret", env.TURNSTILE_SECRET_KEY);
  form.set("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.set("remoteip", ip);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const result = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
      signal: controller.signal
    });
    if (!result.ok) return false;
    const data = await result.json();
    return data.success === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function getOrCreateDevice(db, clientDeviceId, env) {
  if (!validateDeviceId(clientDeviceId)) return null;
  const pepper = env.DEVICE_ID_PEPPER || (env.DEV_AUTH_BYPASS === "true" ? "local-development-only" : "");
  if (!pepper) throw new Error("DEVICE_ID_PEPPER_NOT_CONFIGURED");
  const deviceKeyHash = await sha256Hex(pepper + ":" + clientDeviceId);
  const now = Date.now();
  await db.prepare(
    "INSERT OR IGNORE INTO devices (id, device_key_hash, trial_used, is_blocked, created_at, last_seen_at) VALUES (?, ?, 0, 0, ?, ?)"
  ).bind(crypto.randomUUID(), deviceKeyHash, now, now).run();
  const device = await db.prepare(
    "SELECT id, trial_used, is_blocked FROM devices WHERE device_key_hash = ? LIMIT 1"
  ).bind(deviceKeyHash).first();
  if (device) {
    await db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(now, device.id).run();
  }
  return device;
}

async function countRecentFailures(db, identityHash) {
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM auth_attempts WHERE identity_hash = ? AND succeeded = 0 AND created_at > ?"
  ).bind(identityHash, Date.now() - 15 * 60 * 1000).first();
  return Number(row?.n || 0);
}

async function recordAuthAttempt(db, identityHash, success) {
  await db.prepare(
    "INSERT INTO auth_attempts (id, identity_hash, succeeded, created_at) VALUES (?, ?, ?, ?)"
  ).bind(crypto.randomUUID(), identityHash, success ? 1 : 0, Date.now()).run();
}

async function getEntitlement(db, session) {
  if (session.session_type === "admin") {
    return { role: "admin", isVip: true, trialUsed: 0, trialLimit: MAX_TRIALS, remainingTrials: MAX_TRIALS, expiresAt: null };
  }
  const now = Date.now();
  const device = await db.prepare(
    "SELECT id, trial_used, is_blocked FROM devices WHERE id = ? LIMIT 1"
  ).bind(session.device_id).first();
  if (!device || device.is_blocked) return null;
  const sub = await db.prepare(
    "SELECT expires_at FROM subscriptions WHERE device_id = ? AND status = 'active' AND expires_at > ? ORDER BY expires_at DESC LIMIT 1"
  ).bind(device.id, now).first();
  const expiresAt = sub ? Number(sub.expires_at) : null;
  const trialUsed = Number(device.trial_used || 0);
  return {
    role: "guest",
    isVip: Boolean(sub),
    trialUsed,
    trialLimit: MAX_TRIALS,
    remainingTrials: sub ? MAX_TRIALS : Math.max(0, MAX_TRIALS - trialUsed),
    expiresAt
  };
}

async function requireSession(request, env) {
  const token = getBearerToken(request);
  if (!token) return null;
  return findActiveSession(env.DB, token);
}

function validateAnalysisInput(body) {
  const grade = String(body.grade || "").trim().slice(0, 80);
  const subject = String(body.subject || "").trim().slice(0, 120);
  const hintTitle = String(body.hintTitle || "").trim().slice(0, 300);
  const rawText = String(body.rawText || "").trim();
  const images = Array.isArray(body.images) ? body.images : (body.image ? [body.image] : []);
  if (rawText.length > 60000) return { error: "TEXT_TOO_LARGE" };
  if (images.length > MAX_IMAGES) return { error: "TOO_MANY_IMAGES" };
  if (!rawText && !hintTitle && images.length === 0) return { error: "EMPTY_INPUT" };
  let totalImageBytes = 0;
  const normalizedImages = [];
  for (const image of images) {
    const parsed = validateImageDataUrl(image, MAX_IMAGE_BYTES);
    if (!parsed) return { error: "INVALID_IMAGE" };
    totalImageBytes += parsed.byteLength;
    if (totalImageBytes > 10 * 1024 * 1024) return { error: "IMAGES_TOO_LARGE" };
    normalizedImages.push(parsed);
  }
  return { grade, subject, hintTitle, rawText, images: normalizedImages };
}

function buildLessonPrompt(input) {
  return [
    "أنت خبير مناهج تعليمية يمنية في منصة «حسام إنفوجرافيك».",
    "الصف الدراسي: " + input.grade + " | المادة: " + input.subject,
    input.hintTitle ? "تلميح عنوان الدرس: " + input.hintTitle : "",
    input.rawText ? "نص أولي مستخرج: " + input.rawText : "",
    "تعليمات صارمة:",
    "1. لا تخترع أي معلومة غير موجودة في الصورة أو النص المرفق.",
    "2. ضع أي كلمة أو معادلة غير واضحة في مصفوفة uncertainParts.",
    "3. أرجع كائن JSON صالح فقط (Object) يحتوي على المفاتيح التالية:",
    '{"subject":"...","grade":"...","title":"...","desc":"...","rawExtractedText":"...","uncertainParts":[],"subheadings":[],"mainIdeas":[],"definitions":[{"term":"...","def":"..."}],"lawsAndEquations":[{"law":"...","eq":"..."}],"examples":[{"title":"...","solution":"..."}],"questionsAndActivities":[],"tablesAndComparisons":[{"item":"...","col1":"...","col2":"..."}],"objectives":[{"en":"...","ar":"..."}],"infographic":[{"step":"1","en":"...","ar":"..."}],"vocab":[{"word":"...","pos":"...","ar":"...","ex":"..."}],"walkthrough":[{"en":"...","ar":"...","note":"..."}],"grammar":[{"rule":"...","formula":"...","example":"..."}],"flashcards":[{"q":"...","a":"..."}],"quiz":[{"q":"...","options":["1","2","3","4"],"correct":0}]}',
    "لا تكتب أي شرح قبل أو بعد كائن JSON."
  ].filter(Boolean).join("\n");
}

function parseModelJson(value) {
  const cleaned = String(value || "").replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed[0] || null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {}
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(cleaned.slice(first, last + 1).replace(/,\s*([}\]])/g, "$1"));
  } catch {
    return null;
  }
}

async function callGemini(input, env) {
  if (!env.GEMINI_API_KEY) throw new Error("PROVIDER_NOT_CONFIGURED");
  const model = MODEL_ALLOWLIST.has(env.GEMINI_MODEL) ? env.GEMINI_MODEL : "gemini-2.5-flash";
  const parts = [{ text: buildLessonPrompt(input) }];
  for (const image of input.images) {
    parts.push({ inline_data: { mime_type: image.mimeType, data: image.base64Data } });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 85000);
  try {
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const upstream = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: { temperature: 0.15, maxOutputTokens: 8192, responseMimeType: "application/json" }
          }),
          signal: controller.signal
        }
      );
      lastStatus = upstream.status;
      if (upstream.ok) {
        const data = await upstream.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n") || "";
        const parsed = parseModelJson(text);
        if (!parsed || !parsed.title) throw new Error("INVALID_AI_OUTPUT");
        parsed.grade = parsed.grade || input.grade;
        parsed.subject = parsed.subject || input.subject;
        return { lesson: parsed, model };
      }
      if (![429, 500, 502, 503, 504].includes(upstream.status) || attempt === 2) {
        throw new Error("UPSTREAM_" + upstream.status);
      }
      const retryAfter = Number(upstream.headers.get("Retry-After") || 0);
      const waitMs = Math.min(retryAfter > 0 ? retryAfter * 1000 : 700 * (attempt + 1), 2500);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    throw new Error("UPSTREAM_" + lastStatus);
  } finally {
    clearTimeout(timer);
  }
}

async function handleGuestAuth(request, env, id) {
  const body = await parseBody(request, 16 * 1024);
  if (!await verifyTurnstile(body.turnstileToken, request, env)) return { payload: safeError("CHALLENGE_FAILED", 403, id), status: 403 };
  const device = await getOrCreateDevice(env.DB, body.deviceId, env);
  if (!device || device.is_blocked) return { payload: safeError("DEVICE_NOT_ALLOWED", 403, id), status: 403 };
  const session = await createSession(env.DB, {
    sessionType: "guest",
    deviceId: device.id,
    ttlMs: GUEST_TTL_MS
  });
  const entitlement = await getEntitlement(env.DB, { session_type: "guest", device_id: device.id });
  return { payload: { token: session.token, expiresAt: session.expiresAt, entitlement }, status: 200 };
}

async function handleAdminBootstrap(request, env, id) {
  const body = await parseBody(request, 16 * 1024);
  const bootstrap = request.headers.get("X-Admin-Bootstrap") || "";
  if (!env.ADMIN_BOOTSTRAP_TOKEN || bootstrap.length < 20 || !constantTimeEqual(bootstrap, env.ADMIN_BOOTSTRAP_TOKEN)) {
    return { payload: safeError("BOOTSTRAP_NOT_AUTHORIZED", 403, id), status: 403 };
  }
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM admins").first();
  if (Number(count?.n || 0) > 0) return { payload: safeError("BOOTSTRAP_ALREADY_USED", 409, id), status: 409 };
  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username) || password.length < 12 || password.length > 256) {
    return { payload: safeError("INVALID_ADMIN_CREDENTIALS", 400, id), status: 400 };
  }
  const hashed = await hashPassword(password);
  const adminId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO admins (id, username, password_salt, password_hash, password_iterations, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)"
  ).bind(adminId, username, hashed.salt, hashed.hash, hashed.iterations, now, now).run();
  return { payload: { created: true }, status: 201 };
}

async function handleAdminLogin(request, env, id) {
  const body = await parseBody(request, 16 * 1024);
  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const identityHash = await sha256Hex(ip + ":" + username);
  const failures = await countRecentFailures(env.DB, identityHash);
  if (failures >= 8) return { payload: safeError("LOGIN_RATE_LIMITED", 429, id), status: 429 };
  const admin = await env.DB.prepare("SELECT * FROM admins WHERE username = ? AND is_active = 1 LIMIT 1").bind(username).first();
  const valid = Boolean(admin && await verifyPassword(password, admin.password_salt, admin.password_hash, admin.password_iterations));
  if (!valid) {
    await recordAuthAttempt(env.DB, identityHash, false);
    return { payload: safeError("INVALID_CREDENTIALS", 401, id), status: 401 };
  }
  await recordAuthAttempt(env.DB, identityHash, true);
  const session = await createSession(env.DB, { sessionType: "admin", adminId: admin.id, ttlMs: ADMIN_TTL_MS });
  await env.DB.prepare("UPDATE admins SET last_login_at = ?, updated_at = ? WHERE id = ?").bind(Date.now(), Date.now(), admin.id).run();
  return { payload: { token: session.token, expiresAt: session.expiresAt, username: admin.username }, status: 200 };
}

async function handleCreateActivationCode(request, env, session, id) {
  if (session.session_type !== "admin") return { payload: safeError("ADMIN_REQUIRED", 403, id), status: 403 };
  const body = await parseBody(request, 8 * 1024);
  const days = Number(body.durationDays);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return { payload: safeError("INVALID_DURATION", 400, id), status: 400 };
  const code = "HUSSAM-" + createOpaqueToken(18).toUpperCase();
  const codeHash = await sha256Hex(code);
  await env.DB.prepare(
    "INSERT INTO activation_codes (id, code_hash, duration_days, status, created_by_admin_id, created_at) VALUES (?, ?, ?, 'active', ?, ?)"
  ).bind(crypto.randomUUID(), codeHash, days, session.admin_id, Date.now()).run();
  return { payload: { code, durationDays: days }, status: 201 };
}

async function handleRedeemCode(request, env, session, id) {
  if (session.session_type !== "guest") return { payload: safeError("GUEST_SESSION_REQUIRED", 403, id), status: 403 };
  const body = await parseBody(request, 8 * 1024);
  const code = String(body.code || "").trim().toUpperCase();
  if (!/^HUSSAM-[A-Z0-9_-]{20,80}$/.test(code)) return { payload: safeError("INVALID_CODE", 400, id), status: 400 };
  const codeHash = await sha256Hex(code);
  const now = Date.now();
  const result = await env.DB.prepare(
    "UPDATE activation_codes SET status = 'redeemed', redeemed_by_device_id = ?, redeemed_at = ? WHERE code_hash = ? AND status = 'active' RETURNING id, duration_days"
  ).bind(session.device_id, now, codeHash).first();
  if (!result) return { payload: safeError("CODE_INVALID_OR_USED", 400, id), status: 400 };
  const current = await env.DB.prepare(
    "SELECT MAX(expires_at) AS current_expiry FROM subscriptions WHERE device_id = ? AND status = 'active' AND expires_at > ?"
  ).bind(session.device_id, now).first();
  const startsAt = Math.max(now, Number(current?.current_expiry || now));
  const expiresAt = startsAt + Number(result.duration_days) * 24 * 60 * 60 * 1000;
  try {
    await env.DB.prepare(
      "INSERT INTO subscriptions (id, device_id, activation_code_id, starts_at, expires_at, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)"
    ).bind(crypto.randomUUID(), session.device_id, result.id, startsAt, expiresAt, now).run();
  } catch {
    await env.DB.prepare("UPDATE activation_codes SET status = 'active', redeemed_by_device_id = NULL, redeemed_at = NULL WHERE id = ? AND status = 'redeemed'").bind(result.id).run();
    throw new Error("REDEMPTION_FAILED");
  }
  return { payload: { activated: true, expiresAt, durationDays: result.duration_days }, status: 200 };
}

async function handleAnalyze(request, env, session, id) {
  const body = await parseBody(request);
  const input = validateAnalysisInput(body);
  if (input.error) return { payload: safeError(input.error, 400, id), status: 400 };
  if (session.session_type === "guest") {
    const entitlement = await getEntitlement(env.DB, session);
    if (!entitlement) return { payload: safeError("DEVICE_NOT_ALLOWED", 403, id), status: 403 };
    const now = Date.now();
    const cooldown = await env.DB.prepare(
      "UPDATE devices SET last_analysis_at = ? WHERE id = ? AND (last_analysis_at IS NULL OR last_analysis_at <= ?) RETURNING id"
    ).bind(now, session.device_id, now - 4000).first();
    if (!cooldown) return { payload: safeError("RATE_LIMITED", 429, id), status: 429 };
    if (!entitlement.isVip) {
      const reservation = await reserveGuestTrial(env.DB, session.device_id, MAX_TRIALS, now);
      if (!reservation.allowed) return { payload: { ...safeError("TRIAL_LIMIT_REACHED", 402, id), entitlement }, status: 402 };
    }
  }
  const startedAt = Date.now();
  const usageId = crypto.randomUUID();
  try {
    const result = await callGemini(input, env);
    await env.DB.prepare(
      "INSERT INTO usage_events (id, session_id, device_id, request_id, outcome, provider, model, duration_ms, created_at, completed_at) VALUES (?, ?, ?, ?, 'succeeded', 'gemini', ?, ?, ?, ?)"
    ).bind(usageId, session.id, session.device_id, id, result.model, Date.now() - startedAt, startedAt, Date.now()).run();
    const entitlement = session.session_type === "guest" ? await getEntitlement(env.DB, session) : { role: "admin", isVip: true };
    return { payload: { ...result.lesson, entitlement, requestId: id }, status: 200 };
  } catch (error) {
    if (session.session_type === "guest") {
      const current = await getEntitlement(env.DB, session);
      if (current && !current.isVip) await releaseGuestTrial(env.DB, session.device_id);
    }
    await env.DB.prepare(
      "INSERT INTO usage_events (id, session_id, device_id, request_id, outcome, provider, model, duration_ms, created_at, completed_at) VALUES (?, ?, ?, ?, 'failed', 'gemini', NULL, ?, ?, ?)"
    ).bind(usageId, session.id, session.device_id, id, Date.now() - startedAt, startedAt, Date.now()).run().catch(() => {});
    const code = error?.message === "PROVIDER_NOT_CONFIGURED" ? "PROVIDER_NOT_CONFIGURED" :
      error?.message === "INVALID_AI_OUTPUT" ? "INVALID_AI_OUTPUT" :
      String(error?.message || "").startsWith("UPSTREAM_") ? "AI_PROVIDER_ERROR" :
      error?.name === "AbortError" ? "AI_TIMEOUT" : "AI_ANALYSIS_FAILED";
    return { payload: safeError(code, code === "PROVIDER_NOT_CONFIGURED" ? 503 : 502, id), status: code === "PROVIDER_NOT_CONFIGURED" ? 503 : 502 };
  }
}

export default {
  async fetch(request, env, ctx) {
    const id = requestId();
    const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    const cors = buildCorsHeaders(request.headers.get("Origin"), allowed);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (!originAllowed(request, allowed)) return response(safeError("ORIGIN_NOT_ALLOWED", 403, id), 403, cors, id);
    if (request.method === "OPTIONS") {
      if (!request.headers.get("Origin") || !allowed.has(request.headers.get("Origin"))) {
        return response(safeError("ORIGIN_NOT_ALLOWED", 403, id), 403, cors, id);
      }
      return new Response(null, { status: 204, headers: cors.headers });
    }
    if (request.method === "GET" && path === "/health") {
      return response({ service: "HUSSAM AI API", status: "ok", version: "2.0.0" }, 200, cors, id);
    }
    if (request.method === "GET" && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    if (!env.DB) return response(safeError("DATABASE_NOT_CONFIGURED", 503, id), 503, cors, id);
    try {
      if (request.method === "POST" && path === "/v1/auth/guest") {
        const result = await handleGuestAuth(request, env, id);
        return response(result.payload, result.status, cors, id);
      }
      if (request.method === "POST" && path === "/v1/auth/admin/bootstrap") {
        const result = await handleAdminBootstrap(request, env, id);
        return response(result.payload, result.status, cors, id);
      }
      if (request.method === "POST" && path === "/v1/auth/admin/login") {
        const result = await handleAdminLogin(request, env, id);
        return response(result.payload, result.status, cors, id);
      }
      const session = await requireSession(request, env);
      if (!session) return response(safeError("UNAUTHORIZED", 401, id), 401, cors, id);
      if (request.method === "GET" && path === "/v1/auth/session") {
        const entitlement = await getEntitlement(env.DB, session);
        if (!entitlement) return response(safeError("SESSION_REVOKED", 401, id), 401, cors, id);
        return response({ username: session.admin_username || null, entitlement }, 200, cors, id);
      }
      if (request.method === "POST" && path === "/v1/auth/logout") {
        const token = getBearerToken(request);
        await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
          .bind(Date.now(), await sha256Hex(token)).run();
        return response({ loggedOut: true }, 200, cors, id);
      }
      if (request.method === "POST" && path === "/v1/subscriptions/redeem") {
        const result = await handleRedeemCode(request, env, session, id);
        return response(result.payload, result.status, cors, id);
      }
      if (request.method === "POST" && path === "/v1/admin/activation-codes") {
        const result = await handleCreateActivationCode(request, env, session, id);
        return response(result.payload, result.status, cors, id);
      }
      if (request.method === "POST" && path === "/v1/analyze") {
        const result = await handleAnalyze(request, env, session, id);
        return response(result.payload, result.status, cors, id);
      }
      return response(safeError("NOT_FOUND", 404, id), 404, cors, id);
    } catch (error) {
      const code = error?.code === "REQUEST_TOO_LARGE" ? "REQUEST_TOO_LARGE" :
        error?.code === "INVALID_JSON" ? "INVALID_JSON" :
        error?.code === "UNSUPPORTED_CONTENT_TYPE" ? "UNSUPPORTED_CONTENT_TYPE" :
        "INTERNAL_ERROR";
      const status = code === "REQUEST_TOO_LARGE" ? 413 : code === "INVALID_JSON" ? 400 : code === "UNSUPPORTED_CONTENT_TYPE" ? 415 : 500;
      return response(safeError(code, status, id), status, cors, id);
    }
  }
};

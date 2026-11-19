/**
 * Security primitives for HUSSAM AI API.
 * Isolated implementation module; production Worker entrypoint is not wired to it yet.
 */

const encoder = new TextEncoder();

export function parseAllowedOrigins(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

export function buildCorsHeaders(origin, allowedOrigins) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, X-Admin-Bootstrap",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store"
  });
  const cleanOrigin = String(origin || "").trim();
  const allowed = cleanOrigin !== "" && allowedOrigins.has(cleanOrigin);
  if (allowed) {
    headers.set("Access-Control-Allow-Origin", cleanOrigin);
  }
  return { headers, allowed };
}

export function jsonResponse(payload, status = 200, headers = new Headers()) {
  const outputHeaders = new Headers(headers);
  outputHeaders.set("Content-Type", "application/json; charset=utf-8");
  outputHeaders.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(payload), { status, headers: outputHeaders });
}

export async function readJsonLimited(request, maxBytes) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > maxBytes) {
    const error = new Error("REQUEST_TOO_LARGE");
    error.code = "REQUEST_TOO_LARGE";
    throw error;
  }
  if (!request.body) {
    return {};
  }
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Request body limit exceeded");
        const error = new Error("REQUEST_TOO_LARGE");
        error.code = "REQUEST_TOO_LARGE";
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const error = new Error("INVALID_JSON");
    error.code = "INVALID_JSON";
    throw error;
  }
  try {
    const value = JSON.parse(text || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("INVALID_JSON_OBJECT");
    }
    return value;
  } catch {
    const error = new Error("INVALID_JSON");
    error.code = "INVALID_JSON";
    throw error;
  }
}

export function validateImageDataUrl(value, maxBytes) {
  if (typeof value !== "string" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) return null;
  const match = /^data:(image\\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) return null;
  let binary;
  try {
    binary = atob(match[2]);
  } catch {
    return null;
  }
  if (binary.length === 0 || binary.length > maxBytes) return null;
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const mime = match[1];
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const isWebp = bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if ((mime === "image/jpeg" && !isJpeg) ||
      (mime === "image/png" && !isPng) ||
      (mime === "image/webp" && !isWebp)) return null;
  return { mimeType: mime, base64Data: match[2], byteLength: binary.length };
}

export function createOpaqueToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    diff |= (a[i] || 0) ^ (b[i] || 0);
  }
  return diff === 0;
}

export async function hashPassword(password, saltBase64, iterations = 310000) {
  if (typeof password !== "string" || password.length < 12 || password.length > 256) {
    throw new Error("PASSWORD_POLICY");
  }
  if (!Number.isSafeInteger(iterations) || iterations < 100000 || iterations > 600000) {
    throw new Error("INVALID_PASSWORD_ITERATIONS");
  }
  let salt;
  try {
    salt = saltBase64
      ? Uint8Array.from(atob(saltBase64), (char) => char.charCodeAt(0))
      : crypto.getRandomValues(new Uint8Array(16));
  } catch {
    throw new Error("INVALID_PASSWORD_SALT");
  }
  if (salt.length < 16 || salt.length > 64) throw new Error("INVALID_PASSWORD_SALT");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256
  );
  const hash = btoa(String.fromCharCode(...new Uint8Array(bits)));
  return {
    salt: btoa(String.fromCharCode(...salt)),
    hash,
    iterations
  };
}

export async function verifyPassword(password, salt, expectedHash, iterations = 310000) {
  try {
    const result = await hashPassword(password, salt, iterations);
    return constantTimeEqual(result.hash, expectedHash);
  } catch {
    return false;
  }
}

export async function findActiveSession(db, bearerToken, now = Date.now()) {
  if (!db || !bearerToken || typeof bearerToken !== "string" || bearerToken.length > 256) {
    return null;
  }
  const tokenHash = await sha256Hex(bearerToken);
  return db.prepare(
    `SELECT s.id, s.session_type, s.admin_id, s.device_id, s.expires_at,
            a.username AS admin_username
       FROM sessions s
       LEFT JOIN admins a ON a.id = s.admin_id
      WHERE s.token_hash = ?
        AND s.revoked_at IS NULL
        AND s.expires_at > ?
        AND (s.session_type != 'admin' OR a.is_active = 1)
      LIMIT 1`
  ).bind(tokenHash, now).first();
}

export async function createSession(db, { sessionType, adminId = null, deviceId = null, ttlMs }) {
  const validIdentity = sessionType === "guest"
    ? Boolean(deviceId) && adminId === null
    : sessionType === "admin" && Boolean(adminId) && deviceId === null;
  if (!db || !validIdentity || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 ||
      !Number.isSafeInteger(Date.now() + ttlMs)) {
    throw new Error("INVALID_SESSION_ARGUMENTS");
  }
  const token = createOpaqueToken(32);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO sessions
      (id, token_hash, session_type, admin_id, device_id, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, tokenHash, sessionType, adminId, deviceId, now, now + ttlMs, now).run();
  return { token, sessionId: id, expiresAt: now + ttlMs };
}

export async function reserveGuestTrial(db, deviceId, maxTrials = 2, now = Date.now()) {
  if (!db || typeof deviceId !== "string" || !deviceId ||
      !Number.isSafeInteger(maxTrials) || maxTrials < 1 || !Number.isSafeInteger(now)) {
    throw new Error("INVALID_TRIAL_RESERVATION");
  }
  const result = await db.prepare(
    `UPDATE devices
        SET trial_used = trial_used + 1, last_seen_at = ?
      WHERE id = ?
        AND is_blocked = 0
        AND trial_used < ?
        AND NOT EXISTS (
          SELECT 1 FROM subscriptions
           WHERE subscriptions.device_id = devices.id
             AND subscriptions.status = 'active'
             AND subscriptions.expires_at > ?
        )
      RETURNING trial_used`
  ).bind(now, deviceId, maxTrials, now).first();
  return result ? { allowed: true, trialUsed: result.trial_used } : { allowed: false };
}

export async function releaseGuestTrial(db, deviceId, reservationId) {
  if (!db || typeof deviceId !== "string" || !deviceId ||
      typeof reservationId !== "string" || !reservationId) return false;
  const results = await db.batch([
    db.prepare(
      `UPDATE devices
          SET trial_used = trial_used - 1
        WHERE id = ? AND trial_used > 0
          AND EXISTS (
            SELECT 1 FROM usage_events
             WHERE id = ? AND device_id = ? AND outcome = 'reserved'
          )`
    ).bind(deviceId, reservationId, deviceId),
    db.prepare(
      "UPDATE usage_events SET outcome = 'released', completed_at = ? WHERE id = ? AND device_id = ? AND outcome = 'reserved'"
    ).bind(Date.now(), reservationId, deviceId)
  ]);
  return Number(results?.[0]?.meta?.changes || 0) === 1;
}

export function getBearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header);
  return match ? match[1] : null;
}

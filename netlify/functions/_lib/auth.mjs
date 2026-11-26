import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

const USERS_STORE = "librismeta-users";
const LIBRARY_STORE = "librismeta-library";
const SYSTEM_STORE = "librismeta-system";
const TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30 días

let cachedSecret = null;

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export function normalizeUsername(raw) {
  return String(raw || "").trim().toLowerCase();
}

export function validateCredentials(username, password) {
  const cleanUser = String(username || "").trim();
  const norm = normalizeUsername(cleanUser);
  if (!/^[a-z0-9_.-]{3,32}$/.test(norm)) {
    return { ok: false, error: "El usuario debe tener entre 3 y 32 caracteres (letras, números, ., _ o -)." };
  }
  if (typeof password !== "string" || password.length < 6 || password.length > 128) {
    return { ok: false, error: "La contraseña debe tener entre 6 y 128 caracteres." };
  }
  return { ok: true, norm, displayUsername: cleanUser };
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHashHex) {
  if (!salt || !expectedHashHex) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHashHex, "hex");
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export async function getAuthSecret() {
  if (process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 16) {
    return process.env.AUTH_SECRET;
  }
  if (cachedSecret) return cachedSecret;

  const sysStore = getStore(SYSTEM_STORE);
  const existing = await sysStore.get("jwt-secret", { type: "json" });
  if (existing && existing.secret) {
    cachedSecret = existing.secret;
    return cachedSecret;
  }

  const generated = crypto.randomBytes(32).toString("hex");
  await sysStore.setJSON("jwt-secret", { secret: generated, createdAt: Date.now() });
  const finalObj = await sysStore.get("jwt-secret", { type: "json" });
  cachedSecret = (finalObj && finalObj.secret) || generated;
  return cachedSecret;
}

function b64urlEncode(bufOrStr) {
  return Buffer.from(bufOrStr).toString("base64url");
}

function b64urlDecode(str) {
  return Buffer.from(str, "base64url").toString("utf8");
}

export async function signToken(username) {
  const secret = await getAuthSecret();
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64urlEncode(JSON.stringify({ sub: username, iat: now, exp: now + TOKEN_TTL_SEC }));
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export async function verifyTokenFromRequest(req) {
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!m) return null;
  const parts = m[1].split(".");
  if (parts.length !== 3) return null;

  const [header, payload, sig] = parts;
  const secret = await getAuthSecret();
  const expectedSig = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  const actualSig = Buffer.from(sig, "base64url");
  if (actualSig.length !== expectedSig.length || !crypto.timingSafeEqual(actualSig, expectedSig)) {
    return null;
  }

  try {
    const parsed = JSON.parse(b64urlDecode(payload));
    const now = Math.floor(Date.now() / 1000);
    if (!parsed.sub || !parsed.exp || parsed.exp < now) return null;
    return parsed.sub;
  } catch (_) {
    return null;
  }
}

export function getUsersStore() {
  return getStore(USERS_STORE);
}

export function getLibraryStore() {
  return getStore(LIBRARY_STORE);
}

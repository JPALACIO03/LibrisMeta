import {
  jsonResponse,
  normalizeUsername,
  verifyPassword,
  signToken,
  getUsersStore
} from "./_lib/auth.mjs";

export default async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Método no permitido." }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch (_) {
    return jsonResponse({ ok: false, error: "Cuerpo JSON inválido." }, 400);
  }

  const norm = normalizeUsername(body.username);
  const password = String(body.password || "");
  if (!norm || !password) {
    return jsonResponse({ ok: false, error: "Ingresa usuario y contraseña." }, 400);
  }

  const usersStore = getUsersStore();
  const userRecord = await usersStore.get(`user_${norm}`, { type: "json" });
  if (!userRecord || !verifyPassword(password, userRecord.salt, userRecord.passwordHash)) {
    return jsonResponse({ ok: false, error: "Usuario o contraseña incorrectos." }, 401);
  }

  const token = await signToken(norm);
  return jsonResponse({
    ok: true,
    token,
    username: userRecord.displayUsername || norm
  });
};

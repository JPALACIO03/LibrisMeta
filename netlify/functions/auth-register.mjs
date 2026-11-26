import {
  jsonResponse,
  validateCredentials,
  hashPassword,
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

  const check = validateCredentials(body.username, body.password);
  if (!check.ok) {
    return jsonResponse({ ok: false, error: check.error }, 400);
  }

  const usersStore = getUsersStore();
  const userKey = `user_${check.norm}`;
  const existing = await usersStore.get(userKey, { type: "json" });
  if (existing) {
    return jsonResponse({ ok: false, error: "Ese nombre de usuario ya existe." }, 409);
  }

  const { salt, hash } = hashPassword(body.password);
  const userRecord = {
    username: check.norm,
    displayUsername: check.displayUsername,
    salt,
    passwordHash: hash,
    createdAt: Date.now()
  };

  await usersStore.setJSON(userKey, userRecord);

  const token = await signToken(check.norm);
  return jsonResponse(
    {
      ok: true,
      token,
      username: check.displayUsername
    },
    201
  );
};

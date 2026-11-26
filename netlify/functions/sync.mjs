import {
  jsonResponse,
  verifyTokenFromRequest,
  getLibraryStore
} from "./_lib/auth.mjs";

function normText(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function mergeLibraryPayloads(existing, incoming) {
  const base = existing && typeof existing === "object" ? existing : {};
  const next = incoming && typeof incoming === "object" ? incoming : {};

  // 1. Combinar bajas explícitas (conservar últimos 60 días)
  const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const deletedMap = new Map();
  for (const item of [...(base.deletedIds || []), ...(next.deletedIds || [])]) {
    if (!item || !item.id) continue;
    const at = Number(item.deletedAt) || 0;
    if (at < cutoff) continue;
    const prev = deletedMap.get(item.id) || 0;
    if (at > prev) deletedMap.set(item.id, at);
  }

  // 2. Combinar libros conservando la versión más reciente de cada libro
  const booksById = new Map();
  const allBooks = [...(base.books || []), ...(next.books || [])];

  for (const b of allBooks) {
    if (!b || !b.id) continue;
    const delAt = deletedMap.get(b.id) || 0;
    const updAt = Number(b.updatedAt) || 0;
    if (delAt && delAt >= updAt) continue;

    let match = booksById.get(b.id);
    if (!match && b.asin) {
      for (const cand of booksById.values()) {
        if (cand.asin && cand.asin.toUpperCase() === b.asin.toUpperCase()) {
          match = cand;
          break;
        }
      }
    }
    if (!match && b.title) {
      const nt = normText(b.title);
      const na = normText(b.author);
      for (const cand of booksById.values()) {
        if (normText(cand.title) === nt && (!na || !cand.author || normText(cand.author) === na)) {
          match = cand;
          break;
        }
      }
    }

    if (!match) {
      booksById.set(b.id, { ...b, updatedAt: updAt });
    } else {
      const matchUpd = Number(match.updatedAt) || 0;
      const newer = updAt >= matchUpd ? b : match;
      const older = updAt >= matchUpd ? match : b;
      const merged = {
        ...older,
        ...newer,
        coverDataUrl: newer.coverDataUrl || older.coverDataUrl || "",
        description: newer.description || older.description || "",
        subjects: (newer.subjects && newer.subjects.length) ? newer.subjects : (older.subjects || []),
        totalMinutes: Math.max(Number(older.totalMinutes) || 0, Number(newer.totalMinutes) || 0),
        totalSessions: Math.max(Number(older.totalSessions) || 0, Number(newer.totalSessions) || 0),
        pageTurns: Math.max(Number(older.pageTurns) || 0, Number(newer.pageTurns) || 0),
        updatedAt: Math.max(updAt, matchUpd)
      };
      booksById.set(match.id, merged);
    }
  }

  const activeBookIds = new Set(booksById.keys());

  // 3. Combinar subrayados/citas deduplicados
  const hlMap = new Map();
  for (const h of [...(base.highlights || []), ...(next.highlights || [])]) {
    if (!h || !h.id) continue;
    if (h.bookId && deletedMap.has(h.bookId) && !activeBookIds.has(h.bookId)) continue;
    const key = `${normText(h.title)}|${h.location || ""}|${normText((h.text || "").slice(0, 48))}`;
    if (!hlMap.has(key)) hlMap.set(key, h);
  }

  // 4. Combinar sesiones de lectura deduplicadas
  const sessMap = new Map();
  for (const s of [...(base.sessions || []), ...(next.sessions || [])]) {
    if (!s) continue;
    const key = `${s.asin || ""}|${s.dateDay || ""}|${s.durationMs || 0}|${s.pageTurns || 0}`;
    if (!sessMap.has(key)) sessMap.set(key, s);
  }

  const deletedIds = Array.from(deletedMap.entries()).map(([id, deletedAt]) => ({ id, deletedAt }));

  return {
    books: Array.from(booksById.values()),
    highlights: Array.from(hlMap.values()),
    sessions: Array.from(sessMap.values()),
    deletedIds,
    updatedAt: Date.now()
  };
}

export default async (req) => {
  const username = await verifyTokenFromRequest(req);
  if (!username) {
    return jsonResponse({ ok: false, error: "Sesión no válida o expirada." }, 401);
  }

  const libStore = getLibraryStore();
  const libKey = `lib_${username}`;

  if (req.method === "GET") {
    const data = await libStore.get(libKey, { type: "json" });
    return jsonResponse({
      ok: true,
      data: data || { books: [], highlights: [], sessions: [], deletedIds: [], updatedAt: 0 }
    });
  }

  if (req.method === "POST") {
    let incoming;
    try {
      incoming = await req.json();
    } catch (_) {
      return jsonResponse({ ok: false, error: "Cuerpo JSON inválido." }, 400);
    }

    const existing = await libStore.get(libKey, { type: "json" });
    const merged = mergeLibraryPayloads(existing, incoming);
    await libStore.setJSON(libKey, merged);

    return jsonResponse({
      ok: true,
      data: merged
    });
  }

  return jsonResponse({ ok: false, error: "Método no permitido." }, 405);
};

/* Módulo de estadísticas y biblioteca local compatible con el ecosistema nativo de Kindle (sin jailbreak):
   1. Carpeta USB "documents/" del Kindle (libros, carpetas .sdr y My Clippings.txt)
   2. Paquete oficial de Amazon "Solicitar mis datos" (ZIP, CSV ReadingSession / DocumentMetadata, JSON)
   3. Registro manual y seguimiento de lecturas con exportación/importación JSON */

(function (global) {
  "use strict";

  const SPANISH_MONTHS = {
    enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
    julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11
  };

  const ENGLISH_MONTHS = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
  };

  const MONTH_LABELS_ES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

  const statsState = {
    books: [],       // { id, title, author, asin, format, status, progress, startDate, endDate, rating, notes, totalMinutes, totalSessions, pageTurns, lastOpened, hasSdr, source, updatedAt }
    highlights: [],  // { id, bookId, title, author, type, location, page, dateIso, text }
    sessions: [],    // { id, asin, title, dateDay, durationMs, pageTurns, device }
    deletedIds: []   // { id, deletedAt }
  };

  let activeFilter = "all";
  let searchQuery = "";
  let libFilter = "all";
  let libSearchQuery = "";
  let onToast = function () {};
  const expandedStatsBooks = new Set();

  function normalizeText(str) {
    return String(str || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function makeBookKey(title, author, asin) {
    const cleanAsin = String(asin || "").trim().toUpperCase();
    if (/^[A-Z0-9]{10}$/.test(cleanAsin)) return `asin:${cleanAsin}`;
    const t = normalizeText(title);
    const a = normalizeText(author);
    return `ta:${t}::${a}`;
  }

  function findMatchingBook(title, author, asin) {
    const cleanAsin = String(asin || "").trim().toUpperCase();
    if (cleanAsin) {
      const byAsin = statsState.books.find((b) => b.asin && b.asin.toUpperCase() === cleanAsin);
      if (byAsin) return byAsin;
    }
    const nt = normalizeText(title);
    const na = normalizeText(author);
    if (!nt) return null;
    return statsState.books.find((b) => {
      const bt = normalizeText(b.title);
      if (bt !== nt) return false;
      if (!na || !b.author) return true;
      return normalizeText(b.author) === na;
    }) || null;
  }

  async function makeCoverThumbnailDataUrl(coverObj) {
    if (!coverObj || !coverObj.bytes || !coverObj.bytes.length) return "";
    const mime = coverObj.mimeType || "image/jpeg";
    const rawDataUrl = `data:${mime};base64,${BookUtils.uint8ToBase64(coverObj.bytes)}`;
    // Si ya es liviana (<= 45 KB), usarla directo sin recomprimir
    if (coverObj.bytes.length <= 45 * 1024) return rawDataUrl;

    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = rawDataUrl;
      });
      const maxW = 140;
      const maxH = 210;
      const scale = Math.min(1, maxW / (img.naturalWidth || maxW), maxH / (img.naturalHeight || maxH));
      const w = Math.max(1, Math.round((img.naturalWidth || maxW) * scale));
      const h = Math.max(1, Math.round((img.naturalHeight || maxH) * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return rawDataUrl;
      ctx.drawImage(img, 0, 0, w, h);
      return canvas.toDataURL("image/jpeg", 0.78);
    } catch (_) {
      return coverObj.bytes.length <= 180 * 1024 ? rawDataUrl : "";
    }
  }

  function upsertBook(entry) {
    const existing = findMatchingBook(entry.title, entry.author, entry.asin);
    if (existing) {
      if (entry.title && (!existing.title || existing.title === existing.asin)) existing.title = entry.title;
      if (entry.author && !existing.author) existing.author = entry.author;
      if (entry.asin && !existing.asin) existing.asin = entry.asin.toUpperCase();
      if (entry.format && !existing.format) existing.format = entry.format;
      if (entry.publisher && !existing.publisher) existing.publisher = entry.publisher;
      if (entry.language && !existing.language) existing.language = entry.language;
      if (entry.series && !existing.series) existing.series = entry.series;
      if (entry.seriesIndex && !existing.seriesIndex) existing.seriesIndex = entry.seriesIndex;
      if (entry.date && !existing.date) existing.date = entry.date;
      if (entry.description && (!existing.description || entry.forceUpdateMeta)) existing.description = entry.description;
      if (Array.isArray(entry.subjects) && entry.subjects.length && (!existing.subjects || !existing.subjects.length || entry.forceUpdateMeta)) {
        existing.subjects = [...entry.subjects];
      }
      if (entry.coverDataUrl && (!existing.coverDataUrl || entry.forceUpdateMeta)) existing.coverDataUrl = entry.coverDataUrl;
      if (entry.forceUpdateMeta) {
        if (entry.title) existing.title = entry.title;
        if (entry.author !== undefined) existing.author = entry.author;
        if (entry.publisher !== undefined) existing.publisher = entry.publisher;
        if (entry.language !== undefined) existing.language = entry.language;
        if (entry.series !== undefined) existing.series = entry.series;
        if (entry.seriesIndex !== undefined) existing.seriesIndex = entry.seriesIndex;
      }
      if (entry.hasSdr) existing.hasSdr = true;
      if (entry.lastOpened && (!existing.lastOpened || entry.lastOpened > existing.lastOpened)) {
        existing.lastOpened = entry.lastOpened;
      }
      if (entry.totalMinutes) existing.totalMinutes = Math.max(existing.totalMinutes || 0, entry.totalMinutes);
      if (entry.totalSessions) existing.totalSessions = Math.max(existing.totalSessions || 0, entry.totalSessions);
      if (entry.pageTurns) existing.pageTurns = Math.max(existing.pageTurns || 0, entry.pageTurns);
      if (entry.status && existing.status === "unread") existing.status = entry.status;
      if (entry.source && !existing.source.includes(entry.source)) {
        existing.source = existing.source ? `${existing.source}, ${entry.source}` : entry.source;
      }
      existing.updatedAt = Date.now();
      return existing;
    }

    const book = {
      id: `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: String(entry.title || "Sin título").trim(),
      author: String(entry.author || "").trim(),
      asin: String(entry.asin || "").trim().toUpperCase(),
      format: String(entry.format || "").toUpperCase(),
      publisher: String(entry.publisher || "").trim(),
      language: String(entry.language || "").trim(),
      series: String(entry.series || "").trim(),
      seriesIndex: String(entry.seriesIndex || "").trim(),
      date: String(entry.date || "").trim(),
      description: String(entry.description || "").trim(),
      subjects: Array.isArray(entry.subjects) ? [...entry.subjects] : [],
      coverDataUrl: entry.coverDataUrl || "",
      status: entry.status || "unread", // unread | reading | finished
      progress: Number.isFinite(entry.progress) ? entry.progress : 0,
      startDate: entry.startDate || "",
      endDate: entry.endDate || "",
      rating: Number.isFinite(entry.rating) ? entry.rating : 0,
      notes: entry.notes || "",
      totalMinutes: entry.totalMinutes || 0,
      totalSessions: entry.totalSessions || 0,
      pageTurns: entry.pageTurns || 0,
      lastOpened: entry.lastOpened || "",
      hasSdr: Boolean(entry.hasSdr),
      source: entry.source || "Manual",
      updatedAt: Date.now()
    };
    statsState.books.push(book);
    return book;
  }

  // --- Parseador de My Clippings.txt (Español e Inglés) ---
  function parseClippingDate(metaLine) {
    const clean = String(metaLine || "").trim();
    // Español: "Añadido el martes, 14 de mayo de 2024 21:34:12"
    const esMatch = /(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i.exec(clean);
    if (esMatch) {
      const m = SPANISH_MONTHS[esMatch[2].toLowerCase()];
      if (m !== undefined) {
        const d = new Date(Date.UTC(Number(esMatch[3]), m, Number(esMatch[1])));
        return BookUtils.formatDateYMD(d);
      }
    }
    // Inglés: "Added on Tuesday, May 14, 2024 9:34:12 PM"
    const enMatch = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(clean);
    if (enMatch) {
      const m = ENGLISH_MONTHS[enMatch[1].toLowerCase()];
      if (m !== undefined) {
        const d = new Date(Date.UTC(Number(enMatch[3]), m, Number(enMatch[2])));
        return BookUtils.formatDateYMD(d);
      }
    }
    // ISO fallback
    const iso = /(\d{4}-\d{2}-\d{2})/.exec(clean);
    return iso ? iso[1] : "";
  }

  function parseTitleAuthorLine(headerLine) {
    let line = String(headerLine || "").replace(/^\uFEFF/, "").trim();
    // Formato habitual Kindle: "Título del libro (Apellido, Nombre)" o "Título (Nombre Apellido)"
    let author = "";
    let title = line;
    const lastOpen = line.lastIndexOf("(");
    if (lastOpen > 0 && line.endsWith(")")) {
      const inside = line.slice(lastOpen + 1, -1).trim();
      if (inside && inside.length < 100) {
        author = inside;
        title = line.slice(0, lastOpen).trim();
      }
    }
    return { title, author };
  }

  function parseMyClippings(text) {
    const rawBlocks = String(text || "").split("==========");
    const addedHighlights = [];
    const existingKeys = new Set(
      statsState.highlights.map((h) => `${normalizeText(h.title)}|${h.location}|${normalizeText(h.text.slice(0, 48))}`)
    );

    for (const block of rawBlocks) {
      const lines = block.replace(/\r/g, "").split("\n").map((l) => l.trimEnd());
      while (lines.length && !lines[0].trim()) lines.shift();
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      if (lines.length < 2) continue;

      const { title, author } = parseTitleAuthorLine(lines[0]);
      if (!title) continue;

      const metaLine = lines[1] || "";
      const bodyLines = lines.slice(2).filter((l, idx) => idx > 0 || l.trim() !== "");
      const quoteText = bodyLines.join("\n").trim();

      let type = "highlight";
      if (/nota|note/i.test(metaLine)) type = "note";
      else if (/marcador|bookmark/i.test(metaLine)) type = "bookmark";

      const locMatch = /(?:posici[oó]n|location)\s+([0-9-]+)/i.exec(metaLine);
      const pageMatch = /(?:p[aá]gina|page)\s+([0-9-]+)/i.exec(metaLine);
      const location = locMatch ? locMatch[1] : "";
      const page = pageMatch ? pageMatch[1] : "";
      const dateIso = parseClippingDate(metaLine);

      const book = upsertBook({
        title,
        author,
        status: "reading",
        lastOpened: dateIso,
        source: "My Clippings"
      });

      if (type === "bookmark" && !quoteText) continue;

      const dedupKey = `${normalizeText(title)}|${location}|${normalizeText(quoteText.slice(0, 48))}`;
      if (existingKeys.has(dedupKey)) continue;
      existingKeys.add(dedupKey);

      const h = {
        id: `h_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        bookId: book.id,
        title: book.title,
        author: book.author,
        type,
        location,
        page,
        dateIso,
        text: quoteText
      };
      statsState.highlights.push(h);
      addedHighlights.push(h);
    }

    return addedHighlights.length;
  }

  // --- Parseador CSV RFC-4180 para export oficial de Amazon ---
  function parseCsv(text) {
    const clean = String(text || "").replace(/^\uFEFF/, "");
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      if (inQuotes) {
        if (ch === '"') {
          if (clean[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && clean[i + 1] === "\n") i++;
        row.push(field);
        if (row.some((cell) => cell !== "")) rows.push(row);
        row = [];
        field = "";
      } else {
        field += ch;
      }
    }
    if (field !== "" || row.length > 0) {
      row.push(field);
      if (row.some((cell) => cell !== "")) rows.push(row);
    }
    if (rows.length < 2) return [];
    const headers = rows[0].map((h) => h.trim());
    return rows.slice(1).map((r) => {
      const obj = {};
      headers.forEach((h, idx) => {
        obj[h] = (r[idx] || "").trim();
      });
      return obj;
    });
  }

  function pickCol(row, candidates) {
    const keys = Object.keys(row);
    for (const c of candidates) {
      const found = keys.find((k) => k.toLowerCase() === c.toLowerCase());
      if (found && row[found] !== "") return row[found];
    }
    return "";
  }

  function parseTimestampToDay(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) return BookUtils.formatDateYMD(d);
    const m = /(\d{4}-\d{2}-\d{2})/.exec(ts);
    return m ? m[1] : "";
  }

  function computeDurationMs(row) {
    const durStr = pickCol(row, ["total_reading_millis", "duration_ms", "duration", "Duration", "ReadingDurationMs"]);
    if (durStr) {
      const num = Number(durStr);
      if (Number.isFinite(num) && num > 0) {
        // Si el valor parece estar en segundos (menor a 86400 y columna se llama duration sin ms)
        return num < 10000 && !/ms|millis/i.test(Object.keys(row).join(",")) ? num * 1000 : num;
      }
    }
    const startStr = pickCol(row, ["start_timestamp", "StartTime", "SessionStart", "start_time"]);
    const endStr = pickCol(row, ["end_timestamp", "EndTime", "SessionEnd", "end_time"]);
    if (startStr && endStr) {
      const s = new Date(startStr).getTime();
      const e = new Date(endStr).getTime();
      if (Number.isFinite(s) && Number.isFinite(e) && e > s && (e - s) < 12 * 3600 * 1000) {
        return e - s;
      }
    }
    return 0;
  }

  function ingestAmazonCsv(filename, text) {
    const rows = parseCsv(text);
    if (!rows.length) return { sessions: 0, metadata: 0 };

    const sampleKeys = Object.keys(rows[0]).map((k) => k.toLowerCase());
    const looksLikeSession =
      /readingsession/i.test(filename) ||
      sampleKeys.some((k) => k.includes("start_timestamp") || k.includes("starttime") || k.includes("sessionstart") || k.includes("pageturns") || k.includes("reading_millis"));

    const looksLikeMetadata =
      /documentmetadata|bookinfo|ownedcontent|catalog|product/i.test(filename) ||
      sampleKeys.some((k) => k.includes("title") || k.includes("book_title") || k.includes("author"));

    let sessionCount = 0;
    let metaCount = 0;

    if (looksLikeMetadata) {
      for (const r of rows) {
        const asin = pickCol(r, ["ASIN", "asin", "Asin", "product_id"]);
        const title = pickCol(r, ["Title", "title", "book_title", "Product Name", "DocumentTitle"]);
        const author = pickCol(r, ["Author", "author", "Authors", "authors", "Creator"]);
        if (!title && !asin) continue;
        upsertBook({
          title: title || asin,
          author,
          asin,
          source: "Amazon CSV"
        });
        metaCount++;
      }
    }

    if (looksLikeSession) {
      const existingSess = new Set(statsState.sessions.map((s) => `${s.asin}|${s.dateDay}|${s.durationMs}|${s.pageTurns}`));
      const aggByAsin = new Map();

      for (const r of rows) {
        const asin = pickCol(r, ["ASIN", "asin", "Asin", "content_id"]);
        const title = pickCol(r, ["Title", "title", "book_title"]);
        const startStr = pickCol(r, ["start_timestamp", "StartTime", "SessionStart", "start_time", "date"]);
        const dateDay = parseTimestampToDay(startStr);
        const durationMs = computeDurationMs(r);
        const pageTurns = Number(pickCol(r, ["page_turns", "PageTurns", "total_page_turns", "pages_read"])) || 0;
        const device = pickCol(r, ["DeviceSerialNumber", "device_serial", "device_family", "device"]);

        if (!asin && !title) continue;
        const key = asin ? asin.toUpperCase() : normalizeText(title);
        if (!aggByAsin.has(key)) {
          aggByAsin.set(key, { asin, title, totalMs: 0, sessions: 0, pageTurns: 0, lastDay: "" });
        }
        const agg = aggByAsin.get(key);
        agg.totalMs += durationMs;
        agg.sessions += 1;
        agg.pageTurns += pageTurns;
        if (dateDay && (!agg.lastDay || dateDay > agg.lastDay)) agg.lastDay = dateDay;

        if (dateDay) {
          const sKey = `${asin}|${dateDay}|${durationMs}|${pageTurns}`;
          if (!existingSess.has(sKey)) {
            existingSess.add(sKey);
            statsState.sessions.push({
              id: `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              asin: asin.toUpperCase(),
              title,
              dateDay,
              durationMs,
              pageTurns,
              device
            });
            sessionCount++;
          }
        }
      }

      for (const agg of aggByAsin.values()) {
        const book = upsertBook({
          title: agg.title || agg.asin,
          asin: agg.asin,
          totalMinutes: Math.round(agg.totalMs / 60000),
          totalSessions: agg.sessions,
          pageTurns: agg.pageTurns,
          lastOpened: agg.lastDay,
          status: agg.sessions > 0 ? "reading" : "unread",
          source: "Amazon ReadingSession"
        });
        book.totalMinutes = Math.max(book.totalMinutes || 0, Math.round(agg.totalMs / 60000));
        book.totalSessions = Math.max(book.totalSessions || 0, agg.sessions);
        book.pageTurns = Math.max(book.pageTurns || 0, agg.pageTurns);
      }
    }

    return { sessions: sessionCount, metadata: metaCount };
  }

  function ingestAmazonJson(filename, text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return { items: 0 };
    }
    let count = 0;
    const arr = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : (Array.isArray(data.books) ? data.books : []));
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const asin = item.asin || item.ASIN || "";
      const title = item.title || item.bookTitle || "";
      const author = item.author || item.authors || "";
      if (title || asin) {
        const finished = Boolean(item.isFinished || item.finished || item.percentRead === 100);
        upsertBook({
          title: title || asin,
          author: Array.isArray(author) ? author.join("; ") : author,
          asin,
          status: finished ? "finished" : "reading",
          progress: Number.isFinite(item.percentRead) ? item.percentRead : (finished ? 100 : 0),
          source: "Amazon JSON"
        });
        count++;
      }
    }
    return { items: count };
  }

  // --- Escaneo de carpeta USB del Kindle ("documents/") ---
  async function importKindleFolder(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    let clippingsCount = 0;
    let booksCount = 0;
    let sdrCount = 0;

    // 1. Indexar carpetas .sdr (por nombre base) para detectar libros abiertos y última fecha de lectura
    const sdrByBase = new Map();
    for (const f of files) {
      const rel = (f.webkitRelativePath || f.name).replace(/\\/g, "/");
      const sdrMatch = /(?:^|\/)([^/]+)\.sdr\//i.exec(rel);
      if (sdrMatch) {
        const base = sdrMatch[1].toLowerCase();
        const modDate = f.lastModified ? BookUtils.formatDateYMD(new Date(f.lastModified)) : "";
        const prev = sdrByBase.get(base) || { count: 0, lastDate: "" };
        prev.count += 1;
        if (modDate && (!prev.lastDate || modDate > prev.lastDate)) prev.lastDate = modDate;
        sdrByBase.set(base, prev);
      }
    }

    // 2. Procesar My Clippings.txt y libros compatibles
    const supportedExts = { azw3: "mobi", mobi: "mobi", azw: "mobi", prc: "mobi", epub: "epub", pdf: "pdf", fb2: "fb2" };

    for (const f of files) {
      const nameLower = f.name.toLowerCase();
      if (nameLower === "my clippings.txt") {
        const txt = await f.text();
        clippingsCount += parseMyClippings(txt);
        continue;
      }

      const ext = BookUtils.getExtension(f.name);
      const handlerKey = supportedExts[ext];
      if (!handlerKey || !global.BookHandlers || !global.BookHandlers[handlerKey]) continue;

      try {
        // Evitar leer archivos gigantes de > 80 MB de golpe en un escaneo masivo
        if (f.size > 80 * 1024 * 1024) continue;
        const bytes = new Uint8Array(await f.arrayBuffer());
        const parsed = await global.BookHandlers[handlerKey].parse(bytes, f.name);
        const m = parsed.metadata;

        const baseName = BookUtils.stripExtension(f.name).toLowerCase();
        const sdrInfo = sdrByBase.get(baseName);
        if (sdrInfo) sdrCount++;
        const coverDataUrl = await makeCoverThumbnailDataUrl(parsed.cover);

        upsertBook({
          title: m.title || BookUtils.stripExtension(f.name),
          author: m.author,
          asin: m.asin || (/^B0[A-Z0-9]{8}$/i.test(m.identifier) ? m.identifier : ""),
          format: ext.toUpperCase(),
          publisher: m.publisher,
          language: m.language,
          series: m.series,
          seriesIndex: m.seriesIndex,
          date: m.date,
          description: m.description,
          subjects: m.subjects,
          coverDataUrl,
          hasSdr: Boolean(sdrInfo),
          lastOpened: sdrInfo ? sdrInfo.lastDate : "",
          status: sdrInfo ? "reading" : "unread",
          source: "Kindle USB"
        });
        booksCount++;
      } catch (_) {
        // Si un archivo tiene DRM o formato dañado, registrarlo por nombre sin abortar el resto
        const baseName = BookUtils.stripExtension(f.name);
        const sdrInfo = sdrByBase.get(baseName.toLowerCase());
        upsertBook({
          title: baseName,
          format: ext.toUpperCase(),
          hasSdr: Boolean(sdrInfo),
          lastOpened: sdrInfo ? sdrInfo.lastDate : "",
          status: sdrInfo ? "reading" : "unread",
          source: "Kindle USB"
        });
        booksCount++;
      }
    }

    await persistStats();
    renderStatsView();
    onToast(
      `Importación Kindle completada: ${booksCount} libros, ${sdrCount} con carpeta .sdr y ${clippingsCount} subrayados/notas nuevos.`,
      "success"
    );
  }

  async function importOfficialOrTextFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    let totalClippings = 0;
    let totalSessions = 0;
    let totalMeta = 0;

    for (const f of files) {
      const lower = f.name.toLowerCase();
      if (lower.endsWith(".txt")) {
        totalClippings += parseMyClippings(await f.text());
      } else if (lower.endsWith(".csv")) {
        const res = ingestAmazonCsv(f.name, await f.text());
        totalSessions += res.sessions;
        totalMeta += res.metadata;
      } else if (lower.endsWith(".json")) {
        const txt = await f.text();
        try {
          const parsed = JSON.parse(txt);
          if (parsed && Array.isArray(parsed.books) && Array.isArray(parsed.highlights)) {
            mergeBackupJson(parsed);
            totalMeta += parsed.books.length;
          } else {
            const res = ingestAmazonJson(f.name, txt);
            totalMeta += res.items;
          }
        } catch (_) {}
      } else if (lower.endsWith(".zip") && global.JSZip) {
        const zip = await JSZip.loadAsync(await f.arrayBuffer());
        // Primero metadatos, luego sesiones (para mapear títulos a ASINs)
        const entries = Object.keys(zip.files).filter((k) => !zip.files[k].dir);
        const csvMetaFirst = entries.sort((a, b) => {
          const aIsMeta = /metadata|bookinfo|owned/i.test(a) ? 0 : 1;
          const bIsMeta = /metadata|bookinfo|owned/i.test(b) ? 0 : 1;
          return aIsMeta - bIsMeta;
        });
        for (const path of csvMetaFirst) {
          const pLow = path.toLowerCase();
          if (pLow.endsWith(".csv")) {
            const res = ingestAmazonCsv(path, await zip.file(path).async("string"));
            totalSessions += res.sessions;
            totalMeta += res.metadata;
          } else if (pLow.endsWith(".json")) {
            const res = ingestAmazonJson(path, await zip.file(path).async("string"));
            totalMeta += res.items;
          } else if (pLow.endsWith("my clippings.txt")) {
            totalClippings += parseMyClippings(await zip.file(path).async("string"));
          }
        }
      }
    }

    await persistStats();
    renderStatsView();
    onToast(
      `Datos importados: ${totalMeta} registros de libros, ${totalSessions} sesiones de lectura y ${totalClippings} subrayados.`,
      "success"
    );
  }

  function mergeBackupJson(backup) {
    for (const b of backup.books || []) {
      const merged = upsertBook(b);
      if (b.status) merged.status = b.status;
      if (Number.isFinite(b.progress)) merged.progress = b.progress;
      if (b.startDate) merged.startDate = b.startDate;
      if (b.endDate) merged.endDate = b.endDate;
      if (b.rating) merged.rating = b.rating;
      if (b.notes) merged.notes = b.notes;
    }
    const existingH = new Set(statsState.highlights.map((h) => h.id));
    for (const h of backup.highlights || []) {
      if (!existingH.has(h.id)) statsState.highlights.push(h);
    }
    const existingS = new Set(statsState.sessions.map((s) => s.id));
    for (const s of backup.sessions || []) {
      if (!existingS.has(s.id)) statsState.sessions.push(s);
    }
  }

  // --- Cálculo de estadísticas reales ---
  function computeStreaks() {
    const activeDays = new Set();
    for (const s of statsState.sessions) {
      if (s.dateDay) activeDays.add(s.dateDay);
    }
    for (const h of statsState.highlights) {
      if (h.dateIso) activeDays.add(h.dateIso);
    }
    if (activeDays.size === 0) return { current: 0, best: 0, totalDays: 0 };

    const sorted = Array.from(activeDays).sort();
    let best = 1;
    let run = 1;
    for (let i = 1; i < sorted.length; i++) {
      const prev = new Date(sorted[i - 1] + "T00:00:00Z").getTime();
      const curr = new Date(sorted[i] + "T00:00:00Z").getTime();
      if (Math.round((curr - prev) / 86400000) === 1) {
        run++;
        if (run > best) best = run;
      } else {
        run = 1;
      }
    }

    // Racha actual considerando hoy o ayer
    const today = BookUtils.formatDateYMD(new Date());
    const yesterday = BookUtils.formatDateYMD(new Date(Date.now() - 86400000));
    let current = 0;
    const lastDay = sorted[sorted.length - 1];
    if (lastDay === today || lastDay === yesterday) {
      current = 1;
      for (let i = sorted.length - 1; i > 0; i--) {
        const prev = new Date(sorted[i - 1] + "T00:00:00Z").getTime();
        const curr = new Date(sorted[i] + "T00:00:00Z").getTime();
        if (Math.round((curr - prev) / 86400000) === 1) current++;
        else break;
      }
    }

    return { current, best, totalDays: activeDays.size };
  }

  function computeMonthlyActivity() {
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      months.push({
        key,
        label: `${MONTH_LABELS_ES[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(-2)}`,
        minutes: 0,
        highlights: 0,
        finished: 0
      });
    }
    const map = new Map(months.map((m) => [m.key, m]));

    for (const s of statsState.sessions) {
      if (!s.dateDay) continue;
      const m = map.get(s.dateDay.slice(0, 7));
      if (m) m.minutes += Math.round((s.durationMs || 0) / 60000);
    }
    for (const h of statsState.highlights) {
      if (!h.dateIso) continue;
      const m = map.get(h.dateIso.slice(0, 7));
      if (m) m.highlights += 1;
    }
    for (const b of statsState.books) {
      if (b.status === "finished" && b.endDate) {
        const m = map.get(b.endDate.slice(0, 7));
        if (m) m.finished += 1;
      }
    }
    return months;
  }

  function getHighlightsForBook(book) {
    const nt = normalizeText(book.title);
    return statsState.highlights.filter(
      (h) => h.bookId === book.id || (nt && normalizeText(h.title) === nt)
    );
  }

  function formatMinutesHuman(totalMin) {
    if (!totalMin || totalMin <= 0) return "0 min";
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h} h ${m} min` : `${m} min`;
  }

  async function saveLocalOnly() {
    if (global.BookStorage && global.BookStorage.saveStats) {
      await global.BookStorage.saveStats({
        books: statsState.books,
        highlights: statsState.highlights,
        sessions: statsState.sessions,
        deletedIds: statsState.deletedIds,
        updatedAt: Date.now()
      });
    }
  }

  async function persistStats() {
    await saveLocalOnly();
    if (global.BookSync && global.BookSync.schedulePush) {
      global.BookSync.schedulePush();
    }
  }

  function getExportPayload() {
    return {
      books: statsState.books,
      highlights: statsState.highlights,
      sessions: statsState.sessions,
      deletedIds: statsState.deletedIds,
      updatedAt: Date.now()
    };
  }

  async function applyMergedData(data) {
    if (!data || typeof data !== "object") return;
    statsState.books = Array.isArray(data.books) ? data.books : [];
    statsState.highlights = Array.isArray(data.highlights) ? data.highlights : [];
    statsState.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    statsState.deletedIds = Array.isArray(data.deletedIds) ? data.deletedIds : [];
    await saveLocalOnly();
    renderStatsView();
    renderLibraryView();
  }

  // --- Renderizado de la interfaz de Estadísticas ---
  function renderStatsView() {
    const root = document.getElementById("statsSection");
    if (!root) return;

    const totalBooks = statsState.books.length;
    const finishedBooks = statsState.books.filter((b) => b.status === "finished").length;
    const readingBooks = statsState.books.filter((b) => b.status === "reading").length;
    const totalHighlights = statsState.highlights.length;
    const totalMinutes = statsState.books.reduce((acc, b) => acc + (b.totalMinutes || 0), 0);
    const streaks = computeStreaks();
    const monthly = computeMonthlyActivity();

    document.getElementById("kpiTotalBooks").textContent = String(totalBooks);
    document.getElementById("kpiFinishedBooks").textContent = String(finishedBooks);
    document.getElementById("kpiReadingBooks").textContent = `${readingBooks} en curso`;
    document.getElementById("kpiTotalTime").textContent = totalMinutes > 0 ? formatMinutesHuman(totalMinutes) : `${totalHighlights} citas`;
    document.getElementById("kpiTimeSub").textContent = totalMinutes > 0 ? `${totalHighlights} subrayados/notas` : "Importa ReadingSession para horas";
    document.getElementById("kpiStreak").textContent = `${streaks.best} días`;
    document.getElementById("kpiStreakSub").textContent = `Actual: ${streaks.current} d · Activos: ${streaks.totalDays} d`;

    // Gráfica mensual (minutos si existen sesiones, si no citas/terminados)
    const useMinutes = monthly.some((m) => m.minutes > 0);
    const chartValues = monthly.map((m) => (useMinutes ? m.minutes : (m.highlights + m.finished * 5)));
    const maxVal = Math.max(1, ...chartValues);
    const chartTitleEl = document.getElementById("monthlyChartSubtitle");
    chartTitleEl.textContent = useMinutes
      ? "Minutos leídos por mes (desde sesiones de Amazon)"
      : "Actividad mensual (subrayados en My Clippings y libros terminados)";

    const chartEl = document.getElementById("monthlyChart");
    chartEl.innerHTML = "";
    monthly.forEach((m, idx) => {
      const val = chartValues[idx];
      const pct = Math.round((val / maxVal) * 100);
      const col = document.createElement("div");
      col.className = "chart-col";
      const valLabel = useMinutes ? `${m.minutes}m` : `${m.highlights}c`;
      col.innerHTML = `
        <div class="chart-bar-wrap" title="${m.label}: ${m.minutes} min · ${m.highlights} citas · ${m.finished} terminados">
          <div class="chart-bar" style="height: ${Math.max(val > 0 ? 8 : 2, pct)}%"></div>
        </div>
        <span class="chart-val">${val > 0 ? valLabel : "0"}</span>
        <span class="chart-lbl">${m.label}</span>
      `;
      chartEl.appendChild(col);
    });

    // Top autores
    const authorMap = new Map();
    for (const b of statsState.books) {
      const auth = b.author || "Autor desconocido";
      if (!authorMap.has(auth)) authorMap.set(auth, { name: auth, books: 0, finished: 0, highlights: 0 });
      const entry = authorMap.get(auth);
      entry.books += 1;
      if (b.status === "finished") entry.finished += 1;
      entry.highlights += getHighlightsForBook(b).length;
    }
    const topAuthors = Array.from(authorMap.values())
      .sort((a, b) => (b.finished - a.finished) || (b.books - a.books) || (b.highlights - a.highlights))
      .slice(0, 6);

    const topAuthorsEl = document.getElementById("topAuthorsList");
    topAuthorsEl.innerHTML = "";
    if (!topAuthors.length) {
      topAuthorsEl.innerHTML = `<p class="muted-empty">Aún no hay libros registrados. Importa tu carpeta del Kindle, el export de Amazon o añade un libro manualmente.</p>`;
    } else {
      for (const a of topAuthors) {
        const li = document.createElement("div");
        li.className = "author-stat-row";
        li.innerHTML = `
          <span class="author-stat-name">${BookUtils.escapeXml(a.name)}</span>
          <span class="author-stat-meta">${a.books} ${a.books === 1 ? "libro" : "libros"} · ${a.finished} leídos · ${a.highlights} citas</span>
        `;
        topAuthorsEl.appendChild(li);
      }
    }

    // Lista filtrada de libros
    const q = normalizeText(searchQuery);
    const filtered = statsState.books.filter((b) => {
      if (activeFilter === "finished" && b.status !== "finished") return false;
      if (activeFilter === "reading" && b.status !== "reading") return false;
      if (activeFilter === "unread" && b.status !== "unread") return false;
      if (activeFilter === "highlights" && getHighlightsForBook(b).length === 0) return false;
      if (q) {
        const hay = `${normalizeText(b.title)} ${normalizeText(b.author)} ${normalizeText(b.asin)}`;
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const listEl = document.getElementById("statsBooksList");
    const countEl = document.getElementById("statsListCount");
    countEl.textContent = `${filtered.length} de ${totalBooks}`;
    listEl.innerHTML = "";

    if (!filtered.length) {
      listEl.innerHTML = `<div class="empty-library-box">No hay libros que coincidan con este filtro.</div>`;
      return;
    }

    for (const book of filtered) {
      const hlList = getHighlightsForBook(book);
      const pct = book.status === "finished"
        ? 100
        : Math.max(0, Math.min(100, Number(book.progress) || 0));
      const stMeta = getStatusMeta(book.status);
      const isExpanded = expandedStatsBooks.has(book.id);

      const card = document.createElement("article");
      card.className = isExpanded ? "library-book-card is-controls-open" : "library-book-card";

      const metaBadges = [];
      if (book.format) metaBadges.push(`<span class="mini-pill">${BookUtils.escapeXml(book.format)}</span>`);
      if (book.hasSdr) metaBadges.push(`<span class="mini-pill pill-sdr">Abierto en Kindle (.sdr)</span>`);
      if (book.totalMinutes > 0) metaBadges.push(`<span class="mini-pill pill-time">${formatMinutesHuman(book.totalMinutes)}</span>`);
      if (hlList.length > 0) metaBadges.push(`<span class="mini-pill pill-hl">${hlList.length} ${hlList.length === 1 ? "cita" : "citas"}</span>`);
      if (book.lastOpened) metaBadges.push(`<span class="mini-muted">Última act.: ${BookUtils.escapeXml(book.lastOpened)}</span>`);

      const extraDetails = [
        book.publisher || "",
        book.language ? `Idioma: ${book.language}` : "",
        book.series ? (book.seriesIndex ? `${book.series} #${book.seriesIndex}` : book.series) : "",
        book.asin ? `ASIN ${book.asin}` : ""
      ].filter(Boolean).join(" · ");

      const coverHtml = book.coverDataUrl
        ? `<img src="${book.coverDataUrl}" alt="Portada de ${BookUtils.escapeXml(book.title)}" />`
        : `<div class="lib-cover-placeholder" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg></div>`;

      card.innerHTML = `
        <div class="lib-book-layout">
          <div class="lib-book-cover">
            ${coverHtml}
            <span class="lib-cover-progress" aria-label="Progreso de lectura">${pct}%</span>
          </div>
          <div class="lib-book-main">
            <div class="lib-book-head">
              <div>
                <h4 class="lib-book-title">${BookUtils.escapeXml(book.title)}</h4>
                <p class="lib-book-author">${BookUtils.escapeXml(book.author || "Autor desconocido")}</p>
                ${extraDetails ? `<p class="lib-book-meta-extra">${BookUtils.escapeXml(extraDetails)}</p>` : ""}
              </div>
              <div class="lib-book-badges">${metaBadges.join("")}</div>
            </div>
            <button type="button" class="lib-controls-toggle" data-act="toggleControls" aria-expanded="${isExpanded ? "true" : "false"}">
              <span class="lib-controls-toggle-label">
                <span class="lib-toggle-status ${stMeta.cls}">${stMeta.label}</span>
                <span>Estado, progreso y fechas</span>
              </span>
              <span class="lib-controls-chevron" aria-hidden="true">▾</span>
            </button>
            <div class="lib-book-controls">
              <label class="inline-ctrl">
                <span>Estado</span>
                <select data-act="status">
                  <option value="unread" ${book.status === "unread" ? "selected" : ""}>Por leer</option>
                  <option value="reading" ${book.status === "reading" ? "selected" : ""}>Leyendo</option>
                  <option value="finished" ${book.status === "finished" ? "selected" : ""}>Leído</option>
                </select>
              </label>
              <label class="inline-ctrl ctrl-progress">
                <span>Progreso %</span>
                <input type="number" min="0" max="100" value="${pct}" data-act="progress" />
              </label>
              <label class="inline-ctrl">
                <span>Inicio lectura</span>
                <input type="date" value="${book.startDate || ""}" data-act="startDate" />
              </label>
              <label class="inline-ctrl">
                <span>Término lectura</span>
                <input type="date" value="${book.endDate || ""}" data-act="endDate" />
              </label>
              <label class="inline-ctrl">
                <span>Nota ★</span>
                <select data-act="rating">
                  <option value="0" ${!book.rating ? "selected" : ""}>—</option>
                  <option value="5" ${book.rating === 5 ? "selected" : ""}>★★★★★ (5)</option>
                  <option value="4" ${book.rating === 4 ? "selected" : ""}>★★★★ (4)</option>
                  <option value="3" ${book.rating === 3 ? "selected" : ""}>★★★ (3)</option>
                  <option value="2" ${book.rating === 2 ? "selected" : ""}>★★ (2)</option>
                  <option value="1" ${book.rating === 1 ? "selected" : ""}>★ (1)</option>
                </select>
              </label>
              <div class="lib-book-actions">
                ${hlList.length ? `<button type="button" class="btn btn-secondary btn-sm" data-act="viewHl">Ver citas (${hlList.length})</button>` : ""}
                <button type="button" class="btn btn-ghost btn-sm btn-del-book" data-act="delete" title="Quitar de estadísticas">Quitar</button>
              </div>
            </div>
          </div>
        </div>
      `;

      const toggleControlsBtn = card.querySelector('[data-act="toggleControls"]');
      if (toggleControlsBtn) {
        toggleControlsBtn.addEventListener("click", () => {
          const nextOpen = !card.classList.contains("is-controls-open");
          card.classList.toggle("is-controls-open", nextOpen);
          toggleControlsBtn.setAttribute("aria-expanded", nextOpen ? "true" : "false");
          if (nextOpen) expandedStatsBooks.add(book.id);
          else expandedStatsBooks.delete(book.id);
        });
      }

      // Enlazar cambios inline
      card.querySelector('[data-act="status"]').addEventListener("change", async (e) => {
        book.status = e.target.value;
        const today = BookUtils.formatDateYMD(new Date());
        if (book.status === "reading" && !book.startDate) {
          book.startDate = today;
        } else if (book.status === "finished") {
          book.progress = 100;
          if (!book.startDate) book.startDate = today;
          if (!book.endDate) book.endDate = today;
        } else if (book.status === "unread") {
          book.progress = 0;
        }
        book.updatedAt = Date.now();
        await persistStats();
        renderStatsView();
        renderLibraryView();
      });

      card.querySelector('[data-act="progress"]').addEventListener("change", async (e) => {
        const val = Math.max(0, Math.min(100, Number(e.target.value) || 0));
        book.progress = val;
        const today = BookUtils.formatDateYMD(new Date());
        if (val === 100) {
          book.status = "finished";
          if (!book.startDate) book.startDate = today;
          if (!book.endDate) book.endDate = today;
        } else if (val > 0 && book.status === "unread") {
          book.status = "reading";
          if (!book.startDate) book.startDate = today;
        }
        book.updatedAt = Date.now();
        await persistStats();
        renderStatsView();
        renderLibraryView();
      });

      card.querySelector('[data-act="startDate"]').addEventListener("change", async (e) => {
        book.startDate = e.target.value;
        if (book.startDate && book.status === "unread") {
          book.status = "reading";
        }
        book.updatedAt = Date.now();
        await persistStats();
        renderStatsView();
        renderLibraryView();
      });

      card.querySelector('[data-act="endDate"]').addEventListener("change", async (e) => {
        book.endDate = e.target.value;
        if (book.endDate && book.status !== "finished") {
          book.status = "finished";
          book.progress = 100;
          if (!book.startDate) book.startDate = book.endDate;
        }
        book.updatedAt = Date.now();
        await persistStats();
        renderStatsView();
        renderLibraryView();
      });

      card.querySelector('[data-act="rating"]').addEventListener("change", async (e) => {
        book.rating = Number(e.target.value) || 0;
        book.updatedAt = Date.now();
        await persistStats();
        renderStatsView();
        renderLibraryView();
      });

      const viewHlBtn = card.querySelector('[data-act="viewHl"]');
      if (viewHlBtn) {
        viewHlBtn.addEventListener("click", () => openHighlightsModal(book, hlList));
      }

      card.querySelector('[data-act="delete"]').addEventListener("click", async () => {
        statsState.books = statsState.books.filter((x) => x.id !== book.id);
        statsState.highlights = statsState.highlights.filter((h) => h.bookId !== book.id);
        statsState.deletedIds.push({ id: book.id, deletedAt: Date.now() });
        await persistStats();
        renderStatsView();
        renderLibraryView();
      });

      listEl.appendChild(card);
    }
  }

  function openHighlightsModal(book, hlList) {
    const modal = document.getElementById("highlightsModal");
    const titleEl = document.getElementById("hlModalTitle");
    const bodyEl = document.getElementById("hlModalBody");
    const exportBtn = document.getElementById("hlExportBtn");

    titleEl.textContent = `${book.title} (${hlList.length} ${hlList.length === 1 ? "cita" : "citas"})`;
    bodyEl.innerHTML = "";

    for (const h of hlList) {
      const item = document.createElement("div");
      item.className = "hl-item";
      const metaParts = [
        h.type === "note" ? "Nota" : "Subrayado",
        h.page ? `Pág. ${h.page}` : "",
        h.location ? `Pos. ${h.location}` : "",
        h.dateIso || ""
      ].filter(Boolean);
      item.innerHTML = `
        <div class="hl-meta">${BookUtils.escapeXml(metaParts.join(" · "))}</div>
        <blockquote class="hl-quote">${BookUtils.escapeXml(h.text)}</blockquote>
      `;
      bodyEl.appendChild(item);
    }

    exportBtn.onclick = () => {
      const mdLines = [`# ${book.title}`, book.author ? `*${book.author}*` : "", ""];
      for (const h of hlList) {
        const meta = [h.page ? `Pág. ${h.page}` : "", h.location ? `Pos. ${h.location}` : "", h.dateIso].filter(Boolean).join(" · ");
        mdLines.push(`> ${h.text.replace(/\n/g, "\n> ")}`);
        if (meta) mdLines.push(`— *${meta}*`);
        mdLines.push("");
      }
      const bytes = BookUtils.encodeUtf8(mdLines.join("\n"));
      const fname = `${BookUtils.sanitizeFilename(book.title)} - Citas.md`;
      BookUtils.triggerDownload(bytes, fname, "text/markdown;charset=utf-8");
    };

    modal.classList.remove("hidden");
  }

  async function importBookFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const extMap = {
      epub: "epub", pdf: "pdf", mobi: "mobi", azw: "mobi",
      azw3: "mobi", prc: "mobi", fb2: "fb2", "fb2.zip": "fb2", cbz: "cbz"
    };

    let added = 0;
    for (const file of files) {
      const ext = BookUtils.getExtension(file.name);
      const handlerKey = extMap[ext];
      if (!handlerKey || !global.BookHandlers || !global.BookHandlers[handlerKey]) continue;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const parsed = await global.BookHandlers[handlerKey].parse(bytes, file.name);
        const m = parsed.metadata;
        const coverDataUrl = await makeCoverThumbnailDataUrl(parsed.cover);
        upsertBook({
          title: m.title || BookUtils.stripExtension(file.name),
          author: m.author,
          asin: m.asin || (/^B0[A-Z0-9]{8}$/i.test(m.identifier) ? m.identifier : ""),
          format: ext.toUpperCase(),
          publisher: m.publisher,
          language: m.language,
          series: m.series,
          seriesIndex: m.seriesIndex,
          date: m.date,
          description: m.description,
          subjects: m.subjects,
          coverDataUrl,
          startDate: BookUtils.formatDateYMD(new Date()),
          status: "reading",
          source: "Archivo local"
        });
        added++;
      } catch (err) {
        console.warn("No se pudo leer el archivo para estadísticas:", file.name, err);
      }
    }

    if (added > 0) {
      renderStatsView();
      renderLibraryView();
      await persistStats();
      onToast(
        added === 1
          ? "Libro añadido automáticamente con sus metadatos y portada."
          : `${added} libros añadidos automáticamente con sus metadatos.`,
        "success"
      );
    } else {
      onToast("No se encontró ningún formato de libro compatible (EPUB, PDF, MOBI, AZW3, FB2, CBZ).", "error");
    }
  }

  async function addBookFromEditor(metadata, ext, coverObj, options) {
    const silent = options && options.silent;
    const coverDataUrl = await makeCoverThumbnailDataUrl(coverObj);
    upsertBook({
      title: metadata.title || "Sin título",
      author: metadata.author,
      asin: metadata.asin || (/^B0[A-Z0-9]{8}$/i.test(metadata.identifier) ? metadata.identifier : ""),
      format: ext ? ext.toUpperCase() : "",
      publisher: metadata.publisher,
      language: metadata.language,
      series: metadata.series,
      seriesIndex: metadata.seriesIndex,
      date: metadata.date,
      description: metadata.description,
      subjects: metadata.subjects,
      coverDataUrl,
      forceUpdateMeta: true,
      source: "Editor LibrisMeta"
    });
    renderStatsView();
    renderLibraryView();
    await persistStats();
    if (!silent) {
      onToast("Libro añadido a tu Biblioteca y Estadísticas.", "success");
    }
  }

  function getStatusMeta(status) {
    if (status === "finished") return { label: "Leído", cls: "status-pill-finished" };
    if (status === "reading") return { label: "Leyendo", cls: "status-pill-reading" };
    return { label: "Por leer", cls: "status-pill-unread" };
  }

  function renderLibraryView() {
    const gridEl = document.getElementById("libraryGrid");
    const badgeEl = document.getElementById("libTotalBadge");
    if (!gridEl || !badgeEl) return;

    const q = normalizeText(libSearchQuery);
    const filtered = statsState.books.filter((b) => {
      if (libFilter !== "all" && b.status !== libFilter) return false;
      if (q) {
        const hay = `${normalizeText(b.title)} ${normalizeText(b.author)} ${normalizeText((b.subjects || []).join(" "))} ${normalizeText(b.series)}`;
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    badgeEl.textContent = `${filtered.length} ${filtered.length === 1 ? "libro" : "libros"}`;
    gridEl.innerHTML = "";

    if (!filtered.length) {
      gridEl.innerHTML = `
        <div class="card empty-shelf-card">
          <p>${statsState.books.length ? "No hay libros que coincidan con tu búsqueda." : "Tu biblioteca aún está vacía. Añade un libro desde «+ Añadir libro» o desde el Editor."}</p>
        </div>
      `;
      return;
    }

    for (const book of filtered) {
      const st = getStatusMeta(book.status);
      const card = document.createElement("button");
      card.type = "button";
      card.className = "shelf-card";
      card.setAttribute("aria-label", `Ver detalles de ${book.title}`);

      const coverHtml = book.coverDataUrl
        ? `<img src="${book.coverDataUrl}" alt="Portada de ${BookUtils.escapeXml(book.title)}" loading="lazy" />`
        : `<div class="shelf-cover-fallback">
             <span class="shelf-fallback-title">${BookUtils.escapeXml(book.title)}</span>
             <span class="shelf-fallback-author">${BookUtils.escapeXml(book.author || "")}</span>
           </div>`;

      const progBar = book.status === "reading" && book.progress > 0
        ? `<div class="shelf-progress-track"><div class="shelf-progress-fill" style="width:${Math.min(100, book.progress)}%"></div></div>`
        : "";

      card.innerHTML = `
        <div class="shelf-cover-wrap">
          ${coverHtml}
          <span class="shelf-status-pill ${st.cls}">${st.label}</span>
          ${progBar}
        </div>
        <div class="shelf-info">
          <div class="shelf-title">${BookUtils.escapeXml(book.title)}</div>
          <div class="shelf-author">${BookUtils.escapeXml(book.author || "Autor desconocido")}</div>
        </div>
      `;

      card.addEventListener("click", () => openBookDetailModal(book));
      gridEl.appendChild(card);
    }
  }

  function openBookDetailModal(book) {
    const modal = document.getElementById("bookDetailModal");
    const titleEl = document.getElementById("bdModalTitle");
    const bodyEl = document.getElementById("bdModalBody");
    if (!modal || !bodyEl) return;

    const st = getStatusMeta(book.status);
    const hlList = getHighlightsForBook(book);
    titleEl.textContent = book.title;

    const coverHtml = book.coverDataUrl
      ? `<img src="${book.coverDataUrl}" alt="Portada de ${BookUtils.escapeXml(book.title)}" />`
      : `<div class="bd-cover-placeholder"><span>Sin portada</span></div>`;

    const metaItems = [
      book.format ? `<span><strong>Formato:</strong> ${BookUtils.escapeXml(book.format)}</span>` : "",
      book.publisher ? `<span><strong>Editorial:</strong> ${BookUtils.escapeXml(book.publisher)}</span>` : "",
      book.language ? `<span><strong>Idioma:</strong> ${BookUtils.escapeXml(book.language)}</span>` : "",
      book.series ? `<span><strong>Serie:</strong> ${BookUtils.escapeXml(book.seriesIndex ? `${book.series} #${book.seriesIndex}` : book.series)}</span>` : "",
      book.date ? `<span><strong>Publicación:</strong> ${BookUtils.escapeXml(book.date)}</span>` : "",
      book.asin ? `<span><strong>ASIN/ID:</strong> ${BookUtils.escapeXml(book.asin)}</span>` : "",
      book.startDate ? `<span><strong>Inicio:</strong> ${BookUtils.escapeXml(book.startDate)}</span>` : "",
      book.endDate ? `<span><strong>Término:</strong> ${BookUtils.escapeXml(book.endDate)}</span>` : "",
      book.totalMinutes > 0 ? `<span><strong>Tiempo leído:</strong> ${formatMinutesHuman(book.totalMinutes)}</span>` : "",
      book.rating > 0 ? `<span><strong>Nota:</strong> ${"★".repeat(book.rating)}</span>` : ""
    ].filter(Boolean);

    const tagsHtml = (book.subjects || []).length
      ? `<div class="bd-tags">${book.subjects.map((t) => `<span class="mini-pill">${BookUtils.escapeXml(t)}</span>`).join("")}</div>`
      : "";

    const descText = String(book.description || "").trim();

    bodyEl.innerHTML = `
      <div class="bd-layout">
        <div class="bd-cover-col">
          <div class="bd-cover-frame">${coverHtml}</div>
          <label class="inline-ctrl bd-status-ctrl">
            <span>Estado de lectura</span>
            <select id="bdStatusSelect">
              <option value="unread" ${book.status === "unread" ? "selected" : ""}>Por leer</option>
              <option value="reading" ${book.status === "reading" ? "selected" : ""}>Leyendo</option>
              <option value="finished" ${book.status === "finished" ? "selected" : ""}>Leído</option>
            </select>
          </label>
          ${hlList.length ? `<button id="bdViewHlBtn" type="button" class="btn btn-secondary btn-sm btn-block">Ver citas (${hlList.length})</button>` : ""}
        </div>
        <div class="bd-info-col">
          <div class="bd-header-row">
            <div>
              <h4 class="bd-title">${BookUtils.escapeXml(book.title)}</h4>
              <p class="bd-author">${BookUtils.escapeXml(book.author || "Autor desconocido")}</p>
            </div>
            <span class="shelf-status-pill bd-pill-static ${st.cls}">${st.label}</span>
          </div>
          ${metaItems.length ? `<div class="bd-meta-grid">${metaItems.join("")}</div>` : ""}
          ${tagsHtml}
          <div class="bd-desc-box">
            <h5>Descripción / Sinopsis</h5>
            <p class="bd-desc-text ${descText ? "" : "bd-desc-empty"}">${descText ? BookUtils.escapeXml(descText) : "Este libro no tiene descripción registrada en sus metadatos."}</p>
          </div>
        </div>
      </div>
    `;

    const stSelect = document.getElementById("bdStatusSelect");
    stSelect.addEventListener("change", async () => {
      book.status = stSelect.value;
      const today = BookUtils.formatDateYMD(new Date());
      if (book.status === "reading" && !book.startDate) book.startDate = today;
      if (book.status === "finished") {
        book.progress = 100;
        if (!book.startDate) book.startDate = today;
        if (!book.endDate) book.endDate = today;
      } else if (book.status === "unread") {
        book.progress = 0;
      }
      book.updatedAt = Date.now();
      renderLibraryView();
      renderStatsView();
      await persistStats();
      openBookDetailModal(book);
    });

    const hlBtn = document.getElementById("bdViewHlBtn");
    if (hlBtn) {
      hlBtn.addEventListener("click", () => {
        modal.classList.add("hidden");
        openHighlightsModal(book, hlList);
      });
    }

    modal.classList.remove("hidden");
  }

  async function init(toastFn) {
    if (typeof toastFn === "function") onToast = toastFn;

    // Eventos UI de Estadísticas (enlazar inmediatamente antes de lecturas asíncronas)
    const folderBtn = document.getElementById("importKindleFolderBtn");
    const folderInput = document.getElementById("kindleFolderInput");
    const regionSelect = document.getElementById("amazonRegionSelect");
    const amazonReqLink = document.getElementById("openAmazonRequestLink");
    const filesBtn = document.getElementById("importAmazonFilesBtn");
    const filesInput = document.getElementById("amazonFilesInput");

    if (regionSelect && amazonReqLink) {
      const updateAmazonUrl = () => {
        const domain = regionSelect.value || "amazon.com.mx";
        amazonReqLink.href = `https://www.${domain}/hz/privacy-central/data-requests/preview.html`;
        try { localStorage.setItem("LibrisMeta_amazonRegion", domain); } catch (_) {}
      };
      try {
        const savedDomain = localStorage.getItem("LibrisMeta_amazonRegion");
        if (savedDomain) regionSelect.value = savedDomain;
      } catch (_) {}
      updateAmazonUrl();
      regionSelect.addEventListener("change", updateAmazonUrl);
    }
    const addBookFileBtn = document.getElementById("addBookFileBtn");
    const bookFileInput = document.getElementById("statsBookFileInput");
    const addManualBtn = document.getElementById("addManualBookBtn");
    const manualForm = document.getElementById("manualBookForm");
    const cancelManualBtn = document.getElementById("cancelManualBookBtn");
    const exportJsonBtn = document.getElementById("exportStatsJsonBtn");
    const clearStatsBtn = document.getElementById("clearStatsBtn");
    const searchInput = document.getElementById("statsSearchInput");
    const hlCloseBtn = document.getElementById("hlCloseBtn");
    const hlModal = document.getElementById("highlightsModal");

    if (addBookFileBtn && bookFileInput) {
      addBookFileBtn.addEventListener("click", () => bookFileInput.click());
      bookFileInput.addEventListener("change", () => {
        if (bookFileInput.files && bookFileInput.files.length) {
          importBookFiles(bookFileInput.files);
          bookFileInput.value = "";
        }
      });
    }

    if (folderBtn && folderInput) {
      folderBtn.addEventListener("click", () => folderInput.click());
      folderInput.addEventListener("change", () => {
        if (folderInput.files && folderInput.files.length) {
          importKindleFolder(folderInput.files);
          folderInput.value = "";
        }
      });
    }

    if (filesBtn && filesInput) {
      filesBtn.addEventListener("click", () => filesInput.click());
      filesInput.addEventListener("change", () => {
        if (filesInput.files && filesInput.files.length) {
          importOfficialOrTextFiles(filesInput.files);
          filesInput.value = "";
        }
      });
    }

    if (addManualBtn && manualForm) {
      addManualBtn.addEventListener("click", () => {
        manualForm.classList.toggle("hidden");
      });
    }
    if (cancelManualBtn && manualForm) {
      cancelManualBtn.addEventListener("click", () => {
        manualForm.classList.add("hidden");
      });
    }

    if (manualForm) {
      manualForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const title = document.getElementById("manualTitle").value.trim();
        if (!title) return;
        const author = document.getElementById("manualAuthor").value.trim();
        const status = document.getElementById("manualStatus").value;
        const asin = document.getElementById("manualAsin").value.trim();
        upsertBook({
          title,
          author,
          asin,
          status,
          progress: status === "finished" ? 100 : (status === "reading" ? 25 : 0),
          endDate: status === "finished" ? BookUtils.formatDateYMD(new Date()) : "",
          source: "Manual"
        });
        manualForm.reset();
        manualForm.classList.add("hidden");
        await persistStats();
        renderStatsView();
        onToast("Libro registrado en tus lecturas.", "success");
      });
    }

    for (const pill of Array.from(document.querySelectorAll(".filter-chip"))) {
      pill.addEventListener("click", () => {
        for (const p of document.querySelectorAll(".filter-chip")) p.classList.remove("active");
        pill.classList.add("active");
        activeFilter = pill.dataset.filter || "all";
        renderStatsView();
      });
    }

    if (searchInput) {
      searchInput.addEventListener("input", () => {
        searchQuery = searchInput.value;
        renderStatsView();
      });
    }

    if (exportJsonBtn) {
      exportJsonBtn.addEventListener("click", () => {
        const payload = JSON.stringify({
          exportedAt: new Date().toISOString(),
          books: statsState.books,
          highlights: statsState.highlights,
          sessions: statsState.sessions
        }, null, 2);
        BookUtils.triggerDownload(
          BookUtils.encodeUtf8(payload),
          `LibrisMeta-Estadisticas-${BookUtils.formatDateYMD(new Date())}.json`,
          "application/json"
        );
        onToast("Respaldo JSON descargado.", "success");
      });
    }

    if (clearStatsBtn) {
      clearStatsBtn.addEventListener("click", async () => {
        const now = Date.now();
        for (const b of statsState.books) {
          statsState.deletedIds.push({ id: b.id, deletedAt: now });
        }
        statsState.books = [];
        statsState.highlights = [];
        statsState.sessions = [];
        if (global.BookStorage && global.BookStorage.clearStats) {
          await global.BookStorage.clearStats();
        }
        renderStatsView();
        renderLibraryView();
        onToast("Se limpiaron los datos locales.");
      });
    }

    if (hlCloseBtn && hlModal) {
      hlCloseBtn.addEventListener("click", () => hlModal.classList.add("hidden"));
    }
    if (hlModal) {
      hlModal.addEventListener("click", (e) => {
        if (e.target === hlModal) hlModal.classList.add("hidden");
      });
    }

    // Eventos de la vista Biblioteca y Modal de detalles
    const libSearchInput = document.getElementById("libSearchInput");
    const libAddBookBtn = document.getElementById("libAddBookBtn");
    const bdModal = document.getElementById("bookDetailModal");
    const bdCloseBtn = document.getElementById("bdCloseBtn");

    if (libSearchInput) {
      libSearchInput.addEventListener("input", () => {
        libSearchQuery = libSearchInput.value;
        renderLibraryView();
      });
    }
    for (const pill of Array.from(document.querySelectorAll(".lib-filter-chip"))) {
      pill.addEventListener("click", () => {
        for (const p of document.querySelectorAll(".lib-filter-chip")) p.classList.remove("active");
        pill.classList.add("active");
        libFilter = pill.dataset.filter || "all";
        renderLibraryView();
      });
    }
    if (libAddBookBtn && bookFileInput) {
      libAddBookBtn.addEventListener("click", () => bookFileInput.click());
    }
    if (bdCloseBtn && bdModal) {
      bdCloseBtn.addEventListener("click", () => bdModal.classList.add("hidden"));
      bdModal.addEventListener("click", (e) => {
        if (e.target === bdModal) bdModal.classList.add("hidden");
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (bdModal && !bdModal.classList.contains("hidden")) bdModal.classList.add("hidden");
        if (hlModal && !hlModal.classList.contains("hidden")) hlModal.classList.add("hidden");
      }
    });

    // Pintar de inmediato desde localStorage si existe, y luego reconciliar con IndexedDB
    try {
      const rawLs = localStorage.getItem("LibrisMeta_stats_v1");
      if (rawLs) {
        const lsData = JSON.parse(rawLs);
        if (lsData) {
          statsState.books = Array.isArray(lsData.books) ? lsData.books : [];
          statsState.highlights = Array.isArray(lsData.highlights) ? lsData.highlights : [];
          statsState.sessions = Array.isArray(lsData.sessions) ? lsData.sessions : [];
          statsState.deletedIds = Array.isArray(lsData.deletedIds) ? lsData.deletedIds : [];
          renderStatsView();
          renderLibraryView();
        }
      }
    } catch (_) {}

    // Restaurar estadísticas guardadas desde IndexedDB (puede contener mayor volumen)
    if (global.BookStorage && global.BookStorage.loadStats) {
      const saved = await global.BookStorage.loadStats();
      if (saved && Array.isArray(saved.books) && saved.books.length >= statsState.books.length) {
        statsState.books = saved.books;
        statsState.highlights = Array.isArray(saved.highlights) ? saved.highlights : [];
        statsState.sessions = Array.isArray(saved.sessions) ? saved.sessions : [];
        statsState.deletedIds = Array.isArray(saved.deletedIds) ? saved.deletedIds : [];
      }
    }

    renderStatsView();
    renderLibraryView();
  }

  global.BookStats = {
    init,
    addBookFromEditor,
    importBookFiles,
    importKindleFolder,
    importOfficialOrTextFiles,
    parseMyClippings,
    parseCsv,
    renderStatsView,
    renderLibraryView,
    getExportPayload,
    applyMergedData,
    getState: () => statsState
  };
})(window);

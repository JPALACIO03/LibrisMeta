/* Controlador binario para formatos PalmDB / MOBI / AZW / AZW3 / PRC */

(function (global) {
  "use strict";

  const EXTH_TAGS = {
    100: "author",
    101: "publisher",
    103: "description",
    104: "isbn",
    105: "subject",
    106: "date",
    109: "rights",
    503: "updatedTitle",
    524: "language"
  };

  const EXTH_LABELS = {
    108: "EXTH:108 (Colaborador)",
    112: "EXTH:112 (Fuente)",
    118: "EXTH:118 (Precio/Moneda)"
  };

  // Tags gestionados por los campos principales del formulario
  const MANAGED_EXTH_TYPES = new Set([100, 101, 103, 104, 105, 106, 109, 113, 501, 503, 504, 524]);

  // Tags de texto que pueden mostrarse/editarse en Metadatos Avanzados
  const EDITABLE_TEXT_EXTH_TYPES = new Set([108, 112, 118]);

  function u16(buf, off) {
    return (buf[off] << 8) | buf[off + 1];
  }

  function u32(buf, off) {
    return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
  }

  function writeU32(buf, off, val) {
    buf[off] = (val >>> 24) & 0xFF;
    buf[off + 1] = (val >>> 16) & 0xFF;
    buf[off + 2] = (val >>> 8) & 0xFF;
    buf[off + 3] = val & 0xFF;
  }

  function asciiAt(buf, off, len) {
    let s = "";
    for (let i = 0; i < len && off + i < buf.length; i++) {
      s += String.fromCharCode(buf[off + i]);
    }
    return s;
  }

  function parsePalmDb(bytes) {
    if (bytes.length < 78) {
      throw new Error("Archivo MOBI/AZW3 demasiado corto o dañado.");
    }
    const numRecords = u16(bytes, 76);
    const listEnd = 78 + numRecords * 8;
    if (numRecords === 0 || listEnd > bytes.length) {
      throw new Error("Tabla de registros PalmDB inválida.");
    }

    const headerMeta = bytes.slice(0, 78);
    const recordMeta = [];
    for (let i = 0; i < numRecords; i++) {
      const base = 78 + i * 8;
      recordMeta.push({
        offset: u32(bytes, base),
        attrAndUid: bytes.slice(base + 4, base + 8)
      });
    }

    const gap = bytes.slice(listEnd, Math.min(bytes.length, recordMeta[0].offset));
    const records = [];
    for (let i = 0; i < numRecords; i++) {
      const start = recordMeta[i].offset;
      const end = i + 1 < numRecords ? recordMeta[i + 1].offset : bytes.length;
      if (start > bytes.length || end < start) {
        throw new Error(`Registro PalmDB #${i} con desplazamientos inválidos.`);
      }
      records.push(bytes.slice(start, end));
    }

    // Nombre PalmDB en bytes 0..31 (null-terminated)
    let nameEnd = 0;
    while (nameEnd < 32 && bytes[nameEnd] !== 0) nameEnd++;
    const dbName = BookUtils.decodeUtf8(bytes.slice(0, nameEnd)).trim();

    return {
      dbType: asciiAt(bytes, 60, 4),
      dbCreator: asciiAt(bytes, 64, 4),
      dbName,
      headerMeta,
      recordMeta,
      gap,
      records
    };
  }

  function parseMobiRecord(rec) {
    if (rec.length < 32 || asciiAt(rec, 16, 4) !== "MOBI") {
      return null;
    }
    const mobiHeaderLen = u32(rec, 20);
    const mobiType = u32(rec, 24);
    const textEncoding = u32(rec, 28) === 1252 ? 1252 : 65001;
    const mobiVersion = rec.length >= 40 ? u32(rec, 36) : 0;
    const fullNameOffset = rec.length >= 92 ? u32(rec, 84) : 0;
    const fullNameLength = rec.length >= 92 ? u32(rec, 88) : 0;
    const firstImageIndex = rec.length >= 112 ? u32(rec, 108) : 0xFFFFFFFF;
    const hasExthFlag = mobiHeaderLen >= 116 && rec.length >= 132 ? (u32(rec, 128) & 0x40) !== 0 : false;

    let fullName = "";
    if (fullNameOffset > 0 && fullNameLength > 0 && fullNameOffset + fullNameLength <= rec.length) {
      fullName = BookUtils.decodeWithEncoding(
        rec.slice(fullNameOffset, fullNameOffset + fullNameLength),
        textEncoding
      );
    }

    const exthStart = 16 + mobiHeaderLen;
    const exthRecords = [];
    let hasExth = false;

    if (hasExthFlag && exthStart + 12 <= rec.length && asciiAt(rec, exthStart, 4) === "EXTH") {
      hasExth = true;
      const count = u32(rec, exthStart + 8);
      let pos = exthStart + 12;
      for (let i = 0; i < count && pos + 8 <= rec.length; i++) {
        const type = u32(rec, pos);
        const len = u32(rec, pos + 4);
        if (len < 8 || pos + len > rec.length) break;
        exthRecords.push({
          type,
          data: rec.slice(pos + 8, pos + len)
        });
        pos += len;
      }
    }

    return {
      mobiHeaderLen,
      mobiType,
      mobiVersion,
      textEncoding,
      fullNameOffset,
      fullNameLength,
      fullName,
      firstImageIndex,
      hasExth,
      exthStart,
      exthRecords
    };
  }

  function rebuildMobiRecord(origRec, metadata, encodingOverride) {
    const parsed = parseMobiRecord(origRec);
    if (!parsed) return origRec;

    const enc = encodingOverride || parsed.textEncoding;
    const exthStart = parsed.exthStart;

    if (parsed.mobiHeaderLen < 116 || exthStart > origRec.length) {
      // Header MOBI muy antiguo sin soporte EXTH completo
      return origRec;
    }

    const prefix = origRec.slice(0, exthStart);

    // Conservar registros EXTH estructurales / no gestionados
    const keptExth = parsed.exthRecords.filter((r) => {
      if (MANAGED_EXTH_TYPES.has(r.type)) return false;
      if (EDITABLE_TEXT_EXTH_TYPES.has(r.type)) return false;
      return true;
    });

    // Colocar los metadatos principales (Título 503 y Autor 100) al inicio del bloque EXTH
    const newExth = [];
    const pushTextTag = (type, str) => {
      const trimmed = String(str || "").trim();
      if (!trimmed) return;
      newExth.push({ type, data: BookUtils.encodeWithEncoding(trimmed, enc) });
    };

    pushTextTag(503, metadata.title);
    for (const auth of BookUtils.splitAuthors(metadata.author)) {
      pushTextTag(100, auth);
    }
    pushTextTag(101, metadata.publisher);
    pushTextTag(103, metadata.description);
    pushTextTag(104, metadata.identifier);
    for (const subj of metadata.subjects || []) {
      pushTextTag(105, subj);
    }
    pushTextTag(106, metadata.date);
    pushTextTag(109, metadata.rights);
    pushTextTag(524, metadata.language);

    const asinVal = String(metadata.asin || "").trim();
    if (asinVal) {
      pushTextTag(113, asinVal);
      pushTextTag(504, asinVal);
    }

    const cdeVal = String(metadata.cdeType || "").trim().toUpperCase();
    if (cdeVal === "EBOK" || cdeVal === "PDOC") {
      pushTextTag(501, cdeVal);
    } else {
      // Si el usuario eligió "Conservar original", preservar el 501 que tuviera el archivo
      const orig501 = parsed.exthRecords.find((r) => r.type === 501);
      if (orig501) newExth.push(orig501);
    }

    // Campos avanzados (EXTH:nnn)
    for (const cf of metadata.customFields || []) {
      const m = /^EXTH:(\d+)/i.exec(String(cf.key || "").trim());
      if (m) {
        const tagNum = Number(m[1]);
        if (Number.isInteger(tagNum) && tagNum > 0 && !MANAGED_EXTH_TYPES.has(tagNum)) {
          pushTextTag(tagNum, cf.value);
        }
      }
    }

    for (const r of keptExth) {
      newExth.push(r);
    }

    // Construir bloque EXTH
    let exthBodyLen = 12;
    for (const r of newExth) exthBodyLen += 8 + r.data.length;
    const exthPad = (4 - (exthBodyLen % 4)) % 4;
    const exthBuf = new Uint8Array(exthBodyLen + exthPad);
    exthBuf[0] = 0x45; // E
    exthBuf[1] = 0x58; // X
    exthBuf[2] = 0x54; // T
    exthBuf[3] = 0x48; // H
    writeU32(exthBuf, 4, exthBodyLen);
    writeU32(exthBuf, 8, newExth.length);

    let cursor = 12;
    for (const r of newExth) {
      writeU32(exthBuf, cursor, r.type);
      writeU32(exthBuf, cursor + 4, 8 + r.data.length);
      exthBuf.set(r.data, cursor + 8);
      cursor += 8 + r.data.length;
    }

    // Full Name después de EXTH (mínimo 2 bytes nulos y alineado a 4 bytes)
    const fullNameBytes = BookUtils.encodeWithEncoding(metadata.title || parsed.fullName || "", enc);
    const fullNameOffset = exthStart + exthBuf.length;
    const paddedFullNameTotal = Math.ceil((fullNameBytes.length + 2) / 4) * 4;
    const fullNamePad = paddedFullNameTotal - fullNameBytes.length;

    // Preservar cualquier dato extra después del antiguo fullName (si existiera)
    let trailing = new Uint8Array(0);
    if (parsed.fullNameOffset > 0) {
      const oldEnd = parsed.fullNameOffset + parsed.fullNameLength;
      const oldAlignedEnd = oldEnd + ((4 - (parsed.fullNameLength % 4)) % 4);
      if (oldAlignedEnd < origRec.length) {
        const rest = origRec.slice(oldAlignedEnd);
        const hasNonZero = rest.some((b) => b !== 0);
        if (hasNonZero) trailing = rest;
      }
    }

    const out = new Uint8Array(prefix.length + exthBuf.length + fullNameBytes.length + fullNamePad + trailing.length);
    out.set(prefix, 0);
    out.set(exthBuf, prefix.length);
    out.set(fullNameBytes, fullNameOffset);
    if (trailing.length) {
      out.set(trailing, fullNameOffset + fullNameBytes.length + fullNamePad);
    }

    // Actualizar punteros en cabecera MOBI
    writeU32(out, 84, fullNameOffset);
    writeU32(out, 88, fullNameBytes.length);
    const oldFlags = u32(out, 128);
    writeU32(out, 128, oldFlags | 0x40);

    return out;
  }

  async function parse(uint8Array) {
    const pdb = parsePalmDb(uint8Array);
    if (pdb.dbType !== "BOOK" && pdb.dbType !== "TEXt") {
      throw new Error(`El archivo no parece ser un libro PalmDB/MOBI válido (tipo: ${pdb.dbType}).`);
    }

    const rec0 = parseMobiRecord(pdb.records[0]);
    if (!rec0) {
      throw new Error("No se encontró una cabecera MOBI/AZW3 válida en el registro 0.");
    }

    const enc = rec0.textEncoding;
    const authors = [];
    const subjects = [];
    let title = "";
    let publisher = "";
    let description = "";
    let identifier = "";
    let date = "";
    let rights = "";
    let language = "";
    let asin = "";
    let cdeType = "";
    let coverOffset = null;
    let kf8BoundaryIdx = null;
    const customFields = [];

    for (const r of rec0.exthRecords) {
      if (r.type === 121 && r.data.length >= 4) {
        kf8BoundaryIdx = u32(r.data, 0);
        continue;
      }
      if (r.type === 201 && r.data.length >= 4) {
        coverOffset = u32(r.data, 0);
        continue;
      }

      const textVal = BookUtils.decodeWithEncoding(r.data, enc).replace(/\0+$/, "").trim();
      switch (r.type) {
        case 503:
          if (textVal) title = textVal;
          break;
        case 100:
          if (textVal) authors.push(textVal);
          break;
        case 101:
          if (!publisher) publisher = textVal;
          break;
        case 103:
          if (!description) description = textVal;
          break;
        case 104:
          if (!identifier) identifier = textVal;
          break;
        case 105:
          if (textVal) subjects.push(textVal);
          break;
        case 106:
          if (!date) date = textVal;
          break;
        case 109:
          if (!rights) rights = textVal;
          break;
        case 113:
        case 504:
          if (!asin && textVal) asin = textVal;
          break;
        case 501:
          if (textVal === "EBOK" || textVal === "PDOC") cdeType = textVal;
          break;
        case 524:
          if (!language) language = textVal;
          break;
        default:
          if (EDITABLE_TEXT_EXTH_TYPES.has(r.type) && textVal) {
            customFields.push({
              key: EXTH_LABELS[r.type] || `EXTH:${r.type}`,
              value: textVal
            });
          }
          break;
      }
    }

    if (!title) {
      title = rec0.fullName || pdb.dbName || "";
    }

    // Extraer portada si existe
    let cover = null;
    if (coverOffset !== null && rec0.firstImageIndex < pdb.records.length) {
      const imgRecIdx = rec0.firstImageIndex + coverOffset;
      if (imgRecIdx >= 0 && imgRecIdx < pdb.records.length) {
        const imgBytes = pdb.records[imgRecIdx];
        if (imgBytes && imgBytes.length > 16) {
          const mimeType = BookUtils.detectImageMime(imgBytes, "cover.jpg");
          cover = { bytes: imgBytes, mimeType };
        }
      }
    }

    // Detectar si es combo MOBI + KF8
    let kf8HeaderIdx = null;
    if (
      kf8BoundaryIdx !== null &&
      kf8BoundaryIdx + 1 < pdb.records.length &&
      asciiAt(pdb.records[kf8BoundaryIdx], 0, 8) === "BOUNDARY"
    ) {
      if (parseMobiRecord(pdb.records[kf8BoundaryIdx + 1])) {
        kf8HeaderIdx = kf8BoundaryIdx + 1;
      }
    }

    const isKf8 = rec0.mobiVersion >= 8 || kf8HeaderIdx !== null;
    const formatSub = kf8HeaderIdx !== null
      ? "MOBI + KF8 (combo)"
      : (rec0.mobiVersion >= 8 ? "AZW3 / KF8" : `MOBI v${rec0.mobiVersion || 6}`);

    return {
      metadata: {
        title,
        author: BookUtils.joinAuthors(authors),
        authorSort: "",
        language,
        publisher,
        date,
        identifier,
        rights,
        series: "",
        seriesIndex: "",
        subjects,
        description,
        creatorTool: "",
        producer: "",
        asin,
        cdeType,
        customFields
      },
      cover,
      details: `${formatSub} · ${enc === 1252 ? "CP1252" : "UTF-8"}`,
      internalState: {
        sourceBytes: uint8Array,
        kf8HeaderIdx,
        textEncoding: enc,
        isKf8
      }
    };
  }

  async function save(internalState, metadata) {
    const pdb = parsePalmDb(internalState.sourceBytes);

    // 1. Reconstruir registro 0
    pdb.records[0] = rebuildMobiRecord(pdb.records[0], metadata, internalState.textEncoding);

    // 2. Si es combo MOBI+KF8, reconstruir también la cabecera KF8
    if (internalState.kf8HeaderIdx !== null && internalState.kf8HeaderIdx < pdb.records.length) {
      const kf8Rec = pdb.records[internalState.kf8HeaderIdx];
      const kf8Parsed = parseMobiRecord(kf8Rec);
      if (kf8Parsed) {
        pdb.records[internalState.kf8HeaderIdx] = rebuildMobiRecord(
          kf8Rec,
          metadata,
          kf8Parsed.textEncoding
        );
      }
    }

    // 3. Actualizar nombre PalmDB (bytes 0..31) sin cortar caracteres UTF-8 multibyte
    const headerMeta = new Uint8Array(pdb.headerMeta);
    headerMeta.fill(0, 0, 32);
    const titleBytes = BookUtils.encodeWithEncoding(metadata.title || pdb.dbName || "Libro", internalState.textEncoding);
    let maxLen = Math.min(31, titleBytes.length);
    if (internalState.textEncoding !== 1252) {
      while (maxLen > 0 && (titleBytes[maxLen] & 0xC0) === 0x80) {
        maxLen--;
      }
    }
    headerMeta.set(titleBytes.subarray(0, maxLen), 0);

    // 4. Recalcular desplazamientos y ensamblar archivo PalmDB completo
    const listBytes = new Uint8Array(pdb.records.length * 8);
    let currentOffset = headerMeta.length + listBytes.length + pdb.gap.length;

    for (let i = 0; i < pdb.records.length; i++) {
      writeU32(listBytes, i * 8, currentOffset);
      listBytes.set(pdb.recordMeta[i].attrAndUid, i * 8 + 4);
      currentOffset += pdb.records[i].length;
    }

    const out = new Uint8Array(currentOffset);
    let pos = 0;
    out.set(headerMeta, pos); pos += headerMeta.length;
    out.set(listBytes, pos); pos += listBytes.length;
    out.set(pdb.gap, pos); pos += pdb.gap.length;

    for (const rec of pdb.records) {
      out.set(rec, pos);
      pos += rec.length;
    }

    return { bytes: out, mimeType: "application/x-mobipocket-ebook" };
  }

  global.BookHandlers = global.BookHandlers || {};
  global.BookHandlers.mobi = {
    formatLabel: "MOBI / AZW3",
    badgeClass: "fmt-mobi",
    supportsCoverEdit: false,
    kindleTip:
      "<strong>Kindle por cable USB:</strong> Con <code>EXTH 100</code> (Autor), <code>EXTH 503</code> (Título), un <strong>ASIN</strong> de Amazon y tipo <strong>EBOK</strong>, tu Kindle muestra el autor tanto en la biblioteca como en la pantalla final «Antes de irte». <em>Nota: Send to Kindle en la nube ya no procesa MOBI y convierte todo a PDOC sin ASIN.</em>",
    parse,
    save
  };
})(window);

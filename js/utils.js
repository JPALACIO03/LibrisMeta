/* Utilidades compartidas para lectura/escritura binaria, XML, texto y descarga local */

(function (global) {
  "use strict";

  const textEncoder = new TextEncoder();
  const textDecoderUtf8 = new TextDecoder("utf-8", { fatal: false });

  // Tabla parcial de caracteres Windows-1252 (0x80 - 0x9F) para codificación fiel en MOBI CP1252
  const CP1252_EXTRA = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
    0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
    0x017E: 0x9E, 0x0178: 0x9F
  };

  function encodeUtf8(str) {
    return textEncoder.encode(str || "");
  }

  function decodeUtf8(bytes) {
    return textDecoderUtf8.decode(bytes);
  }

  function decodeCp1252(bytes) {
    try {
      return new TextDecoder("windows-1252", { fatal: false }).decode(bytes);
    } catch (_) {
      let out = "";
      for (let i = 0; i < bytes.length; i++) {
        out += String.fromCharCode(bytes[i]);
      }
      return out;
    }
  }

  function encodeCp1252(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code <= 0xFF && (code < 0x80 || code >= 0xA0)) {
        out.push(code);
      } else if (CP1252_EXTRA[code] !== undefined) {
        out.push(CP1252_EXTRA[code]);
      } else {
        out.push(0x3F);
      }
    }
    return new Uint8Array(out);
  }

  function decodeWithEncoding(bytes, encodingCode) {
    if (encodingCode === 1252) {
      return decodeCp1252(bytes);
    }
    return decodeUtf8(bytes);
  }

  function encodeWithEncoding(str, encodingCode) {
    if (encodingCode === 1252) {
      return encodeCp1252(str || "");
    }
    return encodeUtf8(str || "");
  }

  function escapeXml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const val = bytes / Math.pow(1024, i);
    return `${val.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
  }

  function sanitizeFilename(name) {
    return String(name || "libro")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180) || "libro";
  }

  function getExtension(filename) {
    const lower = String(filename || "").toLowerCase();
    if (lower.endsWith(".fb2.zip")) return "fb2.zip";
    const idx = lower.lastIndexOf(".");
    return idx >= 0 ? lower.slice(idx + 1) : "";
  }

  function stripExtension(filename) {
    const lower = String(filename || "").toLowerCase();
    if (lower.endsWith(".fb2.zip")) return filename.slice(0, -8);
    const idx = filename.lastIndexOf(".");
    return idx > 0 ? filename.slice(0, idx) : filename;
  }

  function splitAuthors(str) {
    if (!str || !String(str).trim()) return [];
    return String(str)
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function joinAuthors(arr) {
    if (!Array.isArray(arr)) return String(arr || "");
    return arr.map((s) => String(s || "").trim()).filter(Boolean).join("; ");
  }

  function uint8ToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToUint8(b64) {
    const clean = String(b64 || "").replace(/\s+/g, "");
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function detectImageMime(bytes, fallbackName) {
    if (bytes && bytes.length >= 4) {
      if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return "image/png";
      if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
      if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
      ) {
        return "image/webp";
      }
    }
    const lower = String(fallbackName || "").toLowerCase();
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".gif")) return "image/gif";
    return "image/jpeg";
  }

  function mimeToExt(mime) {
    switch (mime) {
      case "image/png": return "png";
      case "image/webp": return "webp";
      case "image/gif": return "gif";
      default: return "jpg";
    }
  }

  function triggerDownload(bytes, filename, mimeType) {
    const blob = new Blob([bytes], { type: mimeType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function parseFlexibleDate(str) {
    const s = String(str || "").trim();
    if (!s) return null;
    const yearOnly = /^(\d{4})$/.exec(s);
    if (yearOnly) return new Date(Date.UTC(Number(yearOnly[1]), 0, 1));
    const ym = /^(\d{4})-(\d{1,2})$/.exec(s);
    if (ym) return new Date(Date.UTC(Number(ym[1]), Number(ym[2]) - 1, 1));
    const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (ymd) return new Date(Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])));
    const parsed = new Date(s);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function formatDateYMD(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  global.BookUtils = {
    encodeUtf8,
    decodeUtf8,
    decodeCp1252,
    encodeCp1252,
    decodeWithEncoding,
    encodeWithEncoding,
    escapeXml,
    formatBytes,
    sanitizeFilename,
    getExtension,
    stripExtension,
    splitAuthors,
    joinAuthors,
    uint8ToBase64,
    base64ToUint8,
    detectImageMime,
    mimeToExt,
    triggerDownload,
    parseFlexibleDate,
    formatDateYMD
  };
})(window);

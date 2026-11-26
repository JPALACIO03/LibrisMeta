/* Persistencia local híbrida (IndexedDB + respaldo en localStorage)
   Conserva tanto el libro en edición como la biblioteca y estadísticas de lectura */

(function (global) {
  "use strict";

  const DB_NAME = "LibrisMetaDB";
  const DB_VERSION = 2;
  const SESSION_STORE = "session";
  const STATS_STORE = "stats";
  const SESSION_KEY = "activeBook";
  const STATS_KEY = "readingStats";

  const LS_META_KEY = "LibrisMeta_draft_v1";
  const LS_BYTES_KEY = "LibrisMeta_bytes_v1";
  const LS_STATS_KEY = "LibrisMeta_stats_v1";
  const MAX_LS_BINARY_BYTES = 2.8 * 1024 * 1024;

  function openDbWithTimeout(timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) {
        reject(new Error("IndexedDB no disponible"));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("Tiempo de espera agotado para IndexedDB"));
        }
      }, timeoutMs || 700);

      try {
        const req = global.indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(SESSION_STORE)) {
            db.createObjectStore(SESSION_STORE);
          }
          if (!db.objectStoreNames.contains(STATS_STORE)) {
            db.createObjectStore(STATS_STORE);
          }
        };
        req.onsuccess = () => {
          if (settled) {
            try { req.result.close(); } catch (_) {}
            return;
          }
          settled = true;
          clearTimeout(timer);
          const db = req.result;
          db.onversionchange = () => {
            try { db.close(); } catch (_) {}
          };
          resolve(db);
        };
        req.onerror = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(req.error || new Error("Error de IndexedDB"));
        };
        req.onblocked = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error("IndexedDB bloqueado"));
        };
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      }
    });
  }

  function saveToLocalStorage(data) {
    try {
      const metaPayload = {
        originalFilename: data.originalFilename,
        originalExt: data.originalExt,
        outputFilename: data.outputFilename,
        customFilenameEdited: Boolean(data.customFilenameEdited),
        editedMeta: data.editedMeta,
        savedAt: data.savedAt,
        newCover: data.newCover && data.newCover.bytes && data.newCover.bytes.length <= 512 * 1024
          ? {
              mimeType: data.newCover.mimeType,
              b64: BookUtils.uint8ToBase64(data.newCover.bytes)
            }
          : null
      };
      global.localStorage.setItem(LS_META_KEY, JSON.stringify(metaPayload));

      if (data.originalBytes && data.originalBytes.length <= MAX_LS_BINARY_BYTES) {
        global.localStorage.setItem(LS_BYTES_KEY, BookUtils.uint8ToBase64(data.originalBytes));
        return "full";
      } else {
        global.localStorage.removeItem(LS_BYTES_KEY);
        return "meta-only";
      }
    } catch (_) {
      try {
        global.localStorage.removeItem(LS_BYTES_KEY);
        const minimalPayload = {
          originalFilename: data.originalFilename,
          originalExt: data.originalExt,
          outputFilename: data.outputFilename,
          customFilenameEdited: Boolean(data.customFilenameEdited),
          editedMeta: data.editedMeta,
          savedAt: data.savedAt,
          newCover: null
        };
        global.localStorage.setItem(LS_META_KEY, JSON.stringify(minimalPayload));
        return "meta-only";
      } catch (_) {
        return "none";
      }
    }
  }

  function loadFromLocalStorage() {
    try {
      const rawMeta = global.localStorage.getItem(LS_META_KEY);
      if (!rawMeta) return null;
      const parsed = JSON.parse(rawMeta);
      const rawBytes = global.localStorage.getItem(LS_BYTES_KEY);
      const originalBytes = rawBytes ? BookUtils.base64ToUint8(rawBytes) : null;
      const newCover = parsed.newCover && parsed.newCover.b64
        ? {
            mimeType: parsed.newCover.mimeType,
            bytes: BookUtils.base64ToUint8(parsed.newCover.b64)
          }
        : null;

      return {
        originalFilename: parsed.originalFilename,
        originalExt: parsed.originalExt,
        outputFilename: parsed.outputFilename,
        customFilenameEdited: Boolean(parsed.customFilenameEdited),
        editedMeta: parsed.editedMeta,
        savedAt: parsed.savedAt,
        newCover,
        originalBytes
      };
    } catch (_) {
      return null;
    }
  }

  function clearLocalStorage() {
    try {
      global.localStorage.removeItem(LS_META_KEY);
      global.localStorage.removeItem(LS_BYTES_KEY);
    } catch (_) {}
  }

  async function idbPut(storeName, key, value) {
    const db = await openDbWithTimeout(700);
    return new Promise((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => {
        if (!done) { done = true; try { db.close(); } catch (_) {} resolve(false); }
      }, 900);
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => { if (!done) { done = true; clearTimeout(t); db.close(); resolve(true); } };
      tx.onerror = () => { if (!done) { done = true; clearTimeout(t); db.close(); reject(tx.error); } };
      tx.onabort = () => { if (!done) { done = true; clearTimeout(t); db.close(); reject(tx.error || new Error("Aborted")); } };
    });
  }

  async function idbGet(storeName, key) {
    const db = await openDbWithTimeout(700);
    return new Promise((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => {
        if (!done) { done = true; try { db.close(); } catch (_) {} resolve(null); }
      }, 900);
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => { if (!done) { done = true; clearTimeout(t); db.close(); resolve(req.result || null); } };
      req.onerror = () => { if (!done) { done = true; clearTimeout(t); db.close(); reject(req.error); } };
      tx.onabort = () => { if (!done) { done = true; clearTimeout(t); db.close(); reject(tx.error || new Error("Aborted")); } };
    });
  }

  async function idbDelete(storeName, key) {
    const db = await openDbWithTimeout(700);
    return new Promise((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => {
        if (!done) { done = true; try { db.close(); } catch (_) {} resolve(true); }
      }, 900);
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => { if (!done) { done = true; clearTimeout(t); db.close(); resolve(true); } };
      tx.onerror = () => { if (!done) { done = true; clearTimeout(t); db.close(); reject(tx.error); } };
      tx.onabort = () => { if (!done) { done = true; clearTimeout(t); db.close(); reject(tx.error || new Error("Aborted")); } };
    });
  }

  async function saveSession(data) {
    const lsMode = saveToLocalStorage(data);
    try {
      await idbPut(SESSION_STORE, SESSION_KEY, data);
      return "full";
    } catch (_) {
      return lsMode;
    }
  }

  async function loadSession() {
    try {
      const idbData = await idbGet(SESSION_STORE, SESSION_KEY);
      if (idbData) return idbData;
    } catch (_) {}
    return loadFromLocalStorage();
  }

  async function clearSession() {
    clearLocalStorage();
    try { await idbDelete(SESSION_STORE, SESSION_KEY); } catch (_) {}
    return true;
  }

  async function saveStats(statsData) {
    try {
      global.localStorage.setItem(LS_STATS_KEY, JSON.stringify(statsData));
    } catch (_) {}
    try {
      await idbPut(STATS_STORE, STATS_KEY, statsData);
      return true;
    } catch (_) {
      return Boolean(global.localStorage.getItem(LS_STATS_KEY));
    }
  }

  async function loadStats() {
    try {
      const idbData = await idbGet(STATS_STORE, STATS_KEY);
      if (idbData) return idbData;
    } catch (_) {}
    try {
      const raw = global.localStorage.getItem(LS_STATS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  async function clearStats() {
    try { global.localStorage.removeItem(LS_STATS_KEY); } catch (_) {}
    try { await idbDelete(STATS_STORE, STATS_KEY); } catch (_) {}
    return true;
  }

  global.BookStorage = {
    saveSession,
    loadSession,
    clearSession,
    saveStats,
    loadStats,
    clearStats
  };
})(window);

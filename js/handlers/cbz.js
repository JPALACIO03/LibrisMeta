/* Controlador de lectura y escritura de metadatos para CBZ (ComicInfo.xml) */

(function (global) {
  "use strict";

  const MANAGED_CBZ_KEYS = new Set([
    "Title", "Series", "Number", "Writer", "Publisher",
    "Year", "Month", "Day", "Summary", "Genre", "LanguageISO", "Tags"
  ]);

  function findComicInfoEntry(zip) {
    for (const key of Object.keys(zip.files)) {
      if (!zip.files[key].dir && key.toLowerCase().endsWith("comicinfo.xml")) {
        return zip.files[key];
      }
    }
    return null;
  }

  function findFirstImageEntry(zip) {
    const imgs = Object.keys(zip.files)
      .filter((k) => !zip.files[k].dir && /\.(jpe?g|png|webp|gif)$/i.test(k))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    return imgs.length ? zip.files[imgs[0]] : null;
  }

  async function parse(uint8Array) {
    const zip = await JSZip.loadAsync(uint8Array);
    const infoEntry = findComicInfoEntry(zip);

    let title = "";
    let author = "";
    let publisher = "";
    let language = "";
    let date = "";
    let series = "";
    let seriesIndex = "";
    let description = "";
    let subjects = [];
    const customFields = [];
    let xmlText = "";

    if (infoEntry) {
      xmlText = await infoEntry.async("string");
      const doc = new DOMParser().parseFromString(xmlText, "application/xml");
      if (!doc.querySelector("parsererror")) {
        const root = doc.documentElement;
        const getVal = (tag) => {
          const el = Array.from(root.children).find((c) => c.localName === tag);
          return el ? el.textContent.trim() : "";
        };

        title = getVal("Title");
        author = getVal("Writer");
        publisher = getVal("Publisher");
        language = getVal("LanguageISO");
        series = getVal("Series");
        seriesIndex = getVal("Number");
        description = getVal("Summary");

        const y = getVal("Year");
        const m = getVal("Month");
        const d = getVal("Day");
        if (y) {
          date = y + (m ? `-${m.padStart(2, "0")}` + (d ? `-${d.padStart(2, "0")}` : "") : "");
        }

        const genres = getVal("Genre");
        const tags = getVal("Tags");
        const combined = [genres, tags].filter(Boolean).join(",");
        subjects = combined.split(/[,;]/).map((s) => s.trim()).filter(Boolean);

        for (const child of Array.from(root.children)) {
          if (!MANAGED_CBZ_KEYS.has(child.localName)) {
            const val = child.textContent.trim();
            if (val) customFields.push({ key: child.localName, value: val });
          }
        }
      }
    }

    let cover = null;
    const firstImg = findFirstImageEntry(zip);
    if (firstImg) {
      const bytes = await firstImg.async("uint8array");
      cover = { bytes, mimeType: BookUtils.detectImageMime(bytes, firstImg.name) };
    }

    return {
      metadata: {
        title,
        author,
        authorSort: "",
        language,
        publisher,
        date,
        identifier: "",
        rights: "",
        series,
        seriesIndex,
        subjects,
        description,
        creatorTool: "",
        producer: "",
        customFields
      },
      cover,
      details: infoEntry ? "CBZ + ComicInfo.xml" : "CBZ (creará ComicInfo.xml)",
      internalState: {
        zip,
        infoPath: infoEntry ? infoEntry.name : "ComicInfo.xml"
      }
    };
  }

  async function save(internalState, metadata) {
    const e = BookUtils.escapeXml;
    const lines = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    ];

    const addTag = (name, val) => {
      const v = String(val || "").trim();
      if (v) lines.push(`  <${name}>${e(v)}</${name}>`);
    };

    addTag("Title", metadata.title);
    addTag("Series", metadata.series);
    addTag("Number", metadata.seriesIndex);
    addTag("Writer", metadata.author);
    addTag("Publisher", metadata.publisher);
    addTag("LanguageISO", metadata.language);
    addTag("Summary", metadata.description);

    const tags = (metadata.subjects || []).map((s) => String(s || "").trim()).filter(Boolean);
    if (tags.length) {
      addTag("Genre", tags.join(", "));
    }

    const dateMatch = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/.exec(String(metadata.date || "").trim());
    if (dateMatch) {
      addTag("Year", dateMatch[1]);
      if (dateMatch[2]) addTag("Month", String(Number(dateMatch[2])));
      if (dateMatch[3]) addTag("Day", String(Number(dateMatch[3])));
    }

    for (const cf of metadata.customFields || []) {
      const k = String(cf.key || "").trim().replace(/[^a-zA-Z0-9_-]/g, "");
      const v = String(cf.value || "").trim();
      if (k && v && !MANAGED_CBZ_KEYS.has(k)) {
        lines.push(`  <${k}>${e(v)}</${k}>`);
      }
    }

    lines.push("</ComicInfo>");
    const xmlOut = lines.join("\n");

    const outZip = new JSZip();
    for (const [path, entry] of Object.entries(internalState.zip.files)) {
      if (entry.dir) continue;
      if (path === internalState.infoPath) continue;
      const isMedia = /\.(jpe?g|png|gif|webp)$/i.test(path);
      outZip.file(path, await entry.async("uint8array"), { compression: isMedia ? "STORE" : "DEFLATE" });
    }
    outZip.file(internalState.infoPath, xmlOut, { compression: "DEFLATE" });

    const bytes = await outZip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    return { bytes, mimeType: "application/vnd.comicbook+zip" };
  }

  global.BookHandlers = global.BookHandlers || {};
  global.BookHandlers.cbz = {
    formatLabel: "CBZ",
    badgeClass: "fmt-cbz",
    supportsCoverEdit: false,
    kindleTip:
      "<strong>Nota CBZ:</strong> Los metadatos se guardan en <code>ComicInfo.xml</code> dentro del archivo CBZ (compatible con Calibre, Kavita, Komga y lectores de cómics).",
    parse,
    save
  };
})(window);

/* Controlador de lectura y escritura de metadatos para FictionBook 2 (.fb2 y .fb2.zip) */

(function (global) {
  "use strict";

  const FB2_NS = "http://www.gribuser.ru/xml/fictionbook/2.0";
  const XLINK_NS = "http://www.w3.org/1999/xlink";

  function decodeXmlBytes(bytes) {
    const head = BookUtils.decodeCp1252(bytes.slice(0, Math.min(256, bytes.length)));
    const m = /encoding=["']([^"']+)["']/i.exec(head);
    const enc = m ? m[1].trim() : "utf-8";
    try {
      return new TextDecoder(enc, { fatal: false }).decode(bytes);
    } catch (_) {
      return BookUtils.decodeUtf8(bytes);
    }
  }

  function childByLocal(parent, name) {
    if (!parent) return null;
    return Array.from(parent.children).find((el) => el.localName === name) || null;
  }

  function childrenByLocal(parent, name) {
    if (!parent) return [];
    return Array.from(parent.children).filter((el) => el.localName === name);
  }

  function getOrCreateChild(doc, parent, name) {
    let el = childByLocal(parent, name);
    if (!el) {
      const ns = parent.namespaceURI || doc.documentElement.namespaceURI || FB2_NS;
      el = ns ? doc.createElementNS(ns, name) : doc.createElement(name);
      parent.appendChild(el);
    }
    return el;
  }

  function formatAuthorElement(authorEl) {
    const parts = [
      childByLocal(authorEl, "first-name")?.textContent.trim(),
      childByLocal(authorEl, "middle-name")?.textContent.trim(),
      childByLocal(authorEl, "last-name")?.textContent.trim()
    ].filter(Boolean);
    if (parts.length) return parts.join(" ");
    return childByLocal(authorEl, "nickname")?.textContent.trim() || "";
  }

  function extractAnnotationText(annEl) {
    if (!annEl) return "";
    const paras = childrenByLocal(annEl, "p");
    if (paras.length) {
      return paras.map((p) => p.textContent.trim()).filter(Boolean).join("\n\n");
    }
    return annEl.textContent.trim();
  }

  async function parse(uint8Array, filename) {
    const isZip = BookUtils.getExtension(filename) === "fb2.zip" ||
      (uint8Array[0] === 0x50 && uint8Array[1] === 0x4B);

    let xmlBytes = uint8Array;
    let zip = null;
    let fb2EntryName = null;

    if (isZip) {
      zip = await JSZip.loadAsync(uint8Array);
      const entryName = Object.keys(zip.files).find(
        (k) => !zip.files[k].dir && k.toLowerCase().endsWith(".fb2")
      );
      if (!entryName) {
        throw new Error("El archivo .fb2.zip no contiene ningún archivo .fb2.");
      }
      fb2EntryName = entryName;
      xmlBytes = await zip.file(entryName).async("uint8array");
    }

    const xmlText = decodeXmlBytes(xmlBytes);
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    if (doc.querySelector("parsererror")) {
      throw new Error("El archivo FB2 contiene XML inválido.");
    }

    const root = doc.documentElement;
    const desc = childByLocal(root, "description");
    const titleInfo = childByLocal(desc, "title-info");
    const publishInfo = childByLocal(desc, "publish-info");

    const title = childByLocal(titleInfo, "book-title")?.textContent.trim() || "";
    const authors = childrenByLocal(titleInfo, "author").map(formatAuthorElement).filter(Boolean);
    const subjects = childrenByLocal(titleInfo, "genre").map((g) => g.textContent.trim()).filter(Boolean);
    const keywordsEl = childByLocal(titleInfo, "keywords");
    if (keywordsEl && keywordsEl.textContent.trim()) {
      for (const k of keywordsEl.textContent.split(",")) {
        const clean = k.trim();
        if (clean && !subjects.includes(clean)) subjects.push(clean);
      }
    }

    const language = childByLocal(titleInfo, "lang")?.textContent.trim() || "";
    const dateEl = childByLocal(titleInfo, "date");
    const date = (dateEl?.getAttribute("value") || dateEl?.textContent || "").trim();
    const description = extractAnnotationText(childByLocal(titleInfo, "annotation"));

    const seqEl = childByLocal(titleInfo, "sequence");
    const series = seqEl ? (seqEl.getAttribute("name") || "").trim() : "";
    const seriesIndex = seqEl ? (seqEl.getAttribute("number") || "").trim() : "";

    const publisher = childByLocal(publishInfo, "publisher")?.textContent.trim() || "";
    const identifier = childByLocal(publishInfo, "isbn")?.textContent.trim() || "";
    const srcLang = childByLocal(titleInfo, "src-lang")?.textContent.trim() || "";
    const pubYear = childByLocal(publishInfo, "year")?.textContent.trim() || "";
    const pubCity = childByLocal(publishInfo, "city")?.textContent.trim() || "";

    const customFields = [];
    if (srcLang) customFields.push({ key: "src-lang", value: srcLang });
    if (pubYear) customFields.push({ key: "publish-year", value: pubYear });
    if (pubCity) customFields.push({ key: "publish-city", value: pubCity });

    // Portada (<coverpage><image l:href="#..."/></coverpage> -> <binary id="...">)
    let cover = null;
    const coverpage = childByLocal(titleInfo, "coverpage");
    const coverImgEl = coverpage ? childByLocal(coverpage, "image") : null;
    let coverBinaryId = "";
    if (coverImgEl) {
      const href =
        coverImgEl.getAttributeNS(XLINK_NS, "href") ||
        coverImgEl.getAttribute("l:href") ||
        coverImgEl.getAttribute("xlink:href") ||
        "";
      coverBinaryId = href.replace(/^#/, "");
    }
    if (coverBinaryId) {
      const binEl = childrenByLocal(root, "binary").find((b) => b.getAttribute("id") === coverBinaryId);
      if (binEl) {
        try {
          const bytes = BookUtils.base64ToUint8(binEl.textContent);
          const mimeType = binEl.getAttribute("content-type") || BookUtils.detectImageMime(bytes, coverBinaryId);
          cover = { bytes, mimeType };
        } catch (_) {
          cover = null;
        }
      }
    }

    return {
      metadata: {
        title,
        author: BookUtils.joinAuthors(authors),
        authorSort: "",
        language,
        publisher,
        date,
        identifier,
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
      details: isZip ? "FB2 comprimido (.fb2.zip)" : "FB2 XML",
      internalState: {
        isZip,
        zip,
        fb2EntryName,
        xmlText,
        coverBinaryId
      }
    };
  }

  async function save(internalState, metadata, newCover) {
    const doc = new DOMParser().parseFromString(internalState.xmlText, "application/xml");
    const root = doc.documentElement;
    const ns = root.namespaceURI || FB2_NS;
    const makeEl = (name) => (ns ? doc.createElementNS(ns, name) : doc.createElement(name));

    const desc = getOrCreateChild(doc, root, "description");
    const titleInfo = getOrCreateChild(doc, desc, "title-info");

    // Título
    const titleEl = getOrCreateChild(doc, titleInfo, "book-title");
    titleEl.textContent = String(metadata.title || "").trim();

    // Autores
    for (const oldAuth of childrenByLocal(titleInfo, "author")) {
      titleInfo.removeChild(oldAuth);
    }
    for (const fullName of BookUtils.splitAuthors(metadata.author)) {
      const aEl = makeEl("author");
      const parts = fullName.trim().split(/\s+/);
      const first = parts[0] || fullName;
      const last = parts.length > 1 ? parts.slice(1).join(" ") : "";
      const fnEl = makeEl("first-name");
      fnEl.textContent = first;
      aEl.appendChild(fnEl);
      if (last) {
        const lnEl = makeEl("last-name");
        lnEl.textContent = last;
        aEl.appendChild(lnEl);
      }
      titleInfo.appendChild(aEl);
    }

    // Géneros
    for (const oldG of childrenByLocal(titleInfo, "genre")) {
      titleInfo.removeChild(oldG);
    }
    for (const tag of metadata.subjects || []) {
      const clean = String(tag || "").trim();
      if (!clean) continue;
      const gEl = makeEl("genre");
      gEl.textContent = clean;
      titleInfo.appendChild(gEl);
    }

    // Idioma
    const langEl = childByLocal(titleInfo, "lang");
    if (String(metadata.language || "").trim()) {
      const target = langEl || getOrCreateChild(doc, titleInfo, "lang");
      target.textContent = metadata.language.trim();
    } else if (langEl) {
      titleInfo.removeChild(langEl);
    }

    // Fecha
    const dateVal = String(metadata.date || "").trim();
    const dateEl = childByLocal(titleInfo, "date");
    if (dateVal) {
      const target = dateEl || getOrCreateChild(doc, titleInfo, "date");
      target.setAttribute("value", dateVal);
      target.textContent = dateVal;
    } else if (dateEl) {
      titleInfo.removeChild(dateEl);
    }

    // Sinopsis / annotation
    const descVal = String(metadata.description || "").trim();
    const annEl = childByLocal(titleInfo, "annotation");
    if (descVal) {
      const target = annEl || getOrCreateChild(doc, titleInfo, "annotation");
      while (target.firstChild) target.removeChild(target.firstChild);
      for (const para of descVal.split(/\n{2,}/)) {
        const p = makeEl("p");
        p.textContent = para.trim();
        target.appendChild(p);
      }
    } else if (annEl) {
      titleInfo.removeChild(annEl);
    }

    // Serie
    const series = String(metadata.series || "").trim();
    const seriesIndex = String(metadata.seriesIndex || "").trim();
    const seqEl = childByLocal(titleInfo, "sequence");
    if (series) {
      const target = seqEl || getOrCreateChild(doc, titleInfo, "sequence");
      target.setAttribute("name", series);
      if (seriesIndex) target.setAttribute("number", seriesIndex);
      else target.removeAttribute("number");
    } else if (seqEl) {
      titleInfo.removeChild(seqEl);
    }

    // Publish Info
    const publishInfo = getOrCreateChild(doc, desc, "publish-info");
    const pubVal = String(metadata.publisher || "").trim();
    const pubEl = childByLocal(publishInfo, "publisher");
    if (pubVal) {
      const target = pubEl || getOrCreateChild(doc, publishInfo, "publisher");
      target.textContent = pubVal;
    } else if (pubEl) {
      publishInfo.removeChild(pubEl);
    }

    const isbnVal = String(metadata.identifier || "").trim();
    const isbnEl = childByLocal(publishInfo, "isbn");
    if (isbnVal) {
      const target = isbnEl || getOrCreateChild(doc, publishInfo, "isbn");
      target.textContent = isbnVal;
    } else if (isbnEl) {
      publishInfo.removeChild(isbnEl);
    }

    // Campos personalizados
    const customMap = new Map((metadata.customFields || []).map((c) => [c.key, c.value]));
    const applyOptChild = (parent, keyName) => {
      const val = String(customMap.get(keyName) || "").trim();
      const existing = childByLocal(parent, keyName === "publish-year" ? "year" : keyName === "publish-city" ? "city" : keyName);
      if (val) {
        const el = existing || getOrCreateChild(doc, parent, keyName === "publish-year" ? "year" : keyName === "publish-city" ? "city" : keyName);
        el.textContent = val;
      } else if (existing) {
        parent.removeChild(existing);
      }
    };
    applyOptChild(titleInfo, "src-lang");
    applyOptChild(publishInfo, "publish-year");
    applyOptChild(publishInfo, "publish-city");

    // Portada nueva
    if (newCover && newCover.bytes) {
      const coverId = internalState.coverBinaryId || `cover.${BookUtils.mimeToExt(newCover.mimeType)}`;
      let coverpage = childByLocal(titleInfo, "coverpage");
      if (!coverpage) {
        coverpage = makeEl("coverpage");
        titleInfo.appendChild(coverpage);
      }
      let imgEl = childByLocal(coverpage, "image");
      if (!imgEl) {
        imgEl = makeEl("image");
        coverpage.appendChild(imgEl);
      }
      if (!root.getAttribute("xmlns:l") && !root.getAttribute("xmlns:xlink")) {
        root.setAttribute("xmlns:l", XLINK_NS);
      }
      const attrName = root.getAttribute("xmlns:xlink") ? "xlink:href" : "l:href";
      imgEl.setAttributeNS(XLINK_NS, attrName, `#${coverId}`);

      let binEl = childrenByLocal(root, "binary").find((b) => b.getAttribute("id") === coverId);
      if (!binEl) {
        binEl = makeEl("binary");
        binEl.setAttribute("id", coverId);
        root.appendChild(binEl);
      }
      binEl.setAttribute("content-type", newCover.mimeType);
      binEl.textContent = BookUtils.uint8ToBase64(newCover.bytes);
    }

    let serialized = new XMLSerializer().serializeToString(doc);
    serialized = serialized.replace(
      /^<\?xml[^>]*\?>/,
      '<?xml version="1.0" encoding="utf-8"?>'
    );
    if (!serialized.startsWith("<?xml")) {
      serialized = '<?xml version="1.0" encoding="utf-8"?>\n' + serialized;
    }

    if (internalState.isZip && internalState.zip) {
      const outZip = new JSZip();
      for (const [path, entry] of Object.entries(internalState.zip.files)) {
        if (entry.dir) continue;
        if (path === internalState.fb2EntryName) {
          outZip.file(path, serialized, { compression: "DEFLATE" });
        } else {
          outZip.file(path, await entry.async("uint8array"), { compression: "DEFLATE" });
        }
      }
      const zipBytes = await outZip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
      return { bytes: zipBytes, mimeType: "application/zip" };
    }

    return { bytes: BookUtils.encodeUtf8(serialized), mimeType: "application/x-fictionbook+xml" };
  }

  global.BookHandlers = global.BookHandlers || {};
  global.BookHandlers.fb2 = {
    formatLabel: "FB2",
    badgeClass: "fmt-fb2",
    supportsCoverEdit: true,
    kindleTip:
      "<strong>Nota FB2:</strong> Los metadatos y la portada se guardan en formato XML estándar FictionBook 2.0 (en UTF-8). Puedes abrirlo en lectores FB2 o convertirlo a EPUB para Kindle.",
    parse,
    save
  };
})(window);

/* Controlador de lectura y escritura de metadatos para libros EPUB (2.0 y 3.x) */

(function (global) {
  "use strict";

  const DC_NS = "http://purl.org/dc/elements/1.1/";
  const OPF_NS = "http://www.idpf.org/2007/opf";
  const CONTAINER_NS = "urn:oasis:names:tc:opendocument:xmlns:container";

  const MANAGED_DC = new Set([
    "title", "creator", "language", "publisher", "date",
    "identifier", "rights", "subject", "description"
  ]);

  function resolvePath(baseDir, href) {
    const cleanHref = decodeURIComponent(String(href || "").split("#")[0]);
    const combined = baseDir ? `${baseDir}/${cleanHref}` : cleanHref;
    const parts = combined.split("/");
    const stack = [];
    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === "..") stack.pop();
      else stack.push(part);
    }
    return stack.join("/");
  }

  function encodeHref(relPath) {
    return relPath.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  }

  function getDir(filePath) {
    const idx = filePath.lastIndexOf("/");
    return idx >= 0 ? filePath.slice(0, idx) : "";
  }

  function getDcElements(metadataEl, localName) {
    const byNs = Array.from(metadataEl.getElementsByTagNameNS(DC_NS, localName));
    if (byNs.length > 0) return byNs;
    const fallback = [];
    for (const child of Array.from(metadataEl.children)) {
      if (
        child.localName === localName ||
        child.tagName.toLowerCase() === `dc:${localName}`
      ) {
        fallback.push(child);
      }
    }
    return fallback;
  }

  function getAttrNSOrPrefix(el, ns, prefix, local) {
    return (
      el.getAttributeNS(ns, local) ||
      el.getAttribute(`${prefix}:${local}`) ||
      el.getAttribute(local) ||
      ""
    );
  }

  function parseXmlStrict(xmlText, label) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "application/xml");
    const err = doc.querySelector("parsererror");
    if (err) {
      throw new Error(`XML inválido en ${label}: ${err.textContent.slice(0, 160)}`);
    }
    return doc;
  }

  function findZipEntryCaseInsensitive(zip, targetPath) {
    if (zip.file(targetPath)) return zip.file(targetPath);
    const lower = targetPath.toLowerCase();
    for (const key of Object.keys(zip.files)) {
      if (!zip.files[key].dir && key.toLowerCase() === lower) {
        return zip.files[key];
      }
    }
    return null;
  }

  async function locateOpf(zip) {
    const containerEntry = findZipEntryCaseInsensitive(zip, "META-INF/container.xml");
    if (containerEntry) {
      const xml = await containerEntry.async("string");
      const doc = parseXmlStrict(xml, "META-INF/container.xml");
      const rootfiles = doc.getElementsByTagNameNS(CONTAINER_NS, "rootfile");
      const rf = rootfiles[0] || doc.getElementsByTagName("rootfile")[0];
      if (rf) {
        const fullPath = rf.getAttribute("full-path");
        if (fullPath && findZipEntryCaseInsensitive(zip, fullPath)) {
          return findZipEntryCaseInsensitive(zip, fullPath).name;
        }
      }
    }
    // Respaldo: buscar cualquier .opf
    for (const key of Object.keys(zip.files)) {
      if (!zip.files[key].dir && key.toLowerCase().endsWith(".opf")) {
        return key;
      }
    }
    throw new Error("No se encontró el archivo OPF dentro del EPUB.");
  }

  function findCoverItem(metadataEl, manifestEl) {
    if (!manifestEl) return null;
    const items = Array.from(manifestEl.children).filter((el) => el.localName === "item");

    // 1. EPUB 3: properties="cover-image"
    for (const item of items) {
      const props = (item.getAttribute("properties") || "").split(/\s+/);
      if (props.includes("cover-image")) return item;
    }

    // 2. EPUB 2: <meta name="cover" content="id" />
    const metas = Array.from(metadataEl.children).filter((el) => el.localName === "meta");
    for (const meta of metas) {
      if ((meta.getAttribute("name") || "").toLowerCase() === "cover") {
        const coverId = meta.getAttribute("content");
        if (coverId) {
          const matched = items.find((it) => it.getAttribute("id") === coverId);
          if (matched) return matched;
        }
      }
    }

    // 3. Heurística por id/href de imagen
    for (const item of items) {
      const mt = item.getAttribute("media-type") || "";
      const id = (item.getAttribute("id") || "").toLowerCase();
      if (mt.startsWith("image/") && (id === "cover" || id === "cover-image")) {
        return item;
      }
    }
    return null;
  }

  function collectRefinesMap(metadataEl) {
    const map = new Map();
    for (const el of Array.from(metadataEl.children)) {
      if (el.localName !== "meta") continue;
      const refines = el.getAttribute("refines");
      const prop = el.getAttribute("property");
      if (refines && prop) {
        const id = refines.replace(/^#/, "");
        if (!map.has(id)) map.set(id, []);
        map.get(id).push({ el, property: prop, text: (el.textContent || "").trim() });
      }
    }
    return map;
  }

  async function parse(uint8Array) {
    const zip = await JSZip.loadAsync(uint8Array);
    const opfPath = await locateOpf(zip);
    const opfDir = getDir(opfPath);
    const opfXml = await zip.file(opfPath).async("string");
    const opfDoc = parseXmlStrict(opfXml, opfPath);

    const pkgEl = opfDoc.documentElement;
    const version = pkgEl.getAttribute("version") || "2.0";
    const metadataEl =
      Array.from(pkgEl.children).find((el) => el.localName === "metadata") ||
      opfDoc.getElementsByTagNameNS(OPF_NS, "metadata")[0] ||
      opfDoc.getElementsByTagName("metadata")[0];
    if (!metadataEl) {
      throw new Error("El archivo OPF no contiene una sección <metadata>.");
    }

    const manifestEl = Array.from(pkgEl.children).find((el) => el.localName === "manifest");
    const refinesMap = collectRefinesMap(metadataEl);

    // Título
    const titleEls = getDcElements(metadataEl, "title");
    const title = titleEls[0] ? titleEls[0].textContent.trim() : "";

    // Autores y file-as
    const creatorEls = getDcElements(metadataEl, "creator");
    const authors = [];
    let authorSort = "";
    for (const cEl of creatorEls) {
      const roleAttr = getAttrNSOrPrefix(cEl, OPF_NS, "opf", "role");
      const cid = cEl.getAttribute("id");
      const refs = cid ? (refinesMap.get(cid) || []) : [];
      const roleRef = refs.find((r) => r.property === "role");
      const role = (roleAttr || (roleRef && roleRef.text) || "aut").toLowerCase();

      if (role === "aut" || !role) {
        const name = cEl.textContent.trim();
        if (name) authors.push(name);
        if (!authorSort) {
          const faAttr = getAttrNSOrPrefix(cEl, OPF_NS, "opf", "file-as");
          const faRef = refs.find((r) => r.property === "file-as");
          authorSort = (faAttr || (faRef && faRef.text) || "").trim();
        }
      }
    }
    // Si todos los creators tenían otro rol, tomarlos igual para no perder info
    if (authors.length === 0 && creatorEls.length > 0) {
      for (const cEl of creatorEls) {
        const name = cEl.textContent.trim();
        if (name) authors.push(name);
      }
    }

    // Campos DC simples
    const getFirstDc = (name) => {
      const els = getDcElements(metadataEl, name);
      return els[0] ? els[0].textContent.trim() : "";
    };

    const language = getFirstDc("language");
    const publisher = getFirstDc("publisher");
    const date = getFirstDc("date");
    const rights = getFirstDc("rights");
    const description = getFirstDc("description");

    // Identificador: preferir ISBN o el unique-identifier del package
    const uniqueIdAttr = pkgEl.getAttribute("unique-identifier");
    const idEls = getDcElements(metadataEl, "identifier");
    let identifier = "";
    const isbnEl = idEls.find((el) => {
      const scheme = getAttrNSOrPrefix(el, OPF_NS, "opf", "scheme").toUpperCase();
      return scheme === "ISBN" || el.textContent.trim().toUpperCase().startsWith("URN:ISBN:");
    });
    if (isbnEl) {
      identifier = isbnEl.textContent.trim();
    } else if (uniqueIdAttr) {
      const uidEl = idEls.find((el) => el.getAttribute("id") === uniqueIdAttr);
      identifier = uidEl ? uidEl.textContent.trim() : (idEls[0] ? idEls[0].textContent.trim() : "");
    } else if (idEls[0]) {
      identifier = idEls[0].textContent.trim();
    }

    // Subjects (etiquetas)
    const subjects = getDcElements(metadataEl, "subject")
      .map((el) => el.textContent.trim())
      .filter(Boolean);

    // Serie y número (Calibre meta o EPUB 3 belongs-to-collection)
    let series = "";
    let seriesIndex = "";
    const metas = Array.from(metadataEl.children).filter((el) => el.localName === "meta");
    for (const m of metas) {
      const name = m.getAttribute("name");
      if (name === "calibre:series") series = (m.getAttribute("content") || "").trim();
      if (name === "calibre:series_index") seriesIndex = (m.getAttribute("content") || "").trim();
    }
    if (!series) {
      const colMeta = metas.find((m) => m.getAttribute("property") === "belongs-to-collection");
      if (colMeta) {
        series = colMeta.textContent.trim();
        const colId = colMeta.getAttribute("id");
        if (colId && refinesMap.has(colId)) {
          const pos = refinesMap.get(colId).find((r) => r.property === "group-position");
          if (pos) seriesIndex = pos.text;
        }
      }
    }

    // Campos personalizados / avanzados
    const customFields = [];
    for (const child of Array.from(metadataEl.children)) {
      if (child.namespaceURI === DC_NS || child.tagName.toLowerCase().startsWith("dc:")) {
        const local = child.localName;
        if (!MANAGED_DC.has(local)) {
          customFields.push({ key: `dc:${local}`, value: child.textContent.trim() });
        }
      } else if (child.localName === "meta") {
        const mName = child.getAttribute("name");
        const mProp = child.getAttribute("property");
        const refines = child.getAttribute("refines");
        if (mName) {
          if (
            mName !== "cover" &&
            mName !== "calibre:series" &&
            mName !== "calibre:series_index"
          ) {
            customFields.push({ key: mName, value: child.getAttribute("content") || "" });
          }
        } else if (mProp && !refines) {
          if (mProp !== "dcterms:modified" && mProp !== "belongs-to-collection") {
            customFields.push({ key: `property:${mProp}`, value: child.textContent.trim() });
          }
        }
      }
    }

    // Portada
    let cover = null;
    const coverItem = findCoverItem(metadataEl, manifestEl);
    if (coverItem) {
      const href = coverItem.getAttribute("href");
      if (href) {
        const fullCoverPath = resolvePath(opfDir, href);
        const entry = findZipEntryCaseInsensitive(zip, fullCoverPath);
        if (entry) {
          const bytes = await entry.async("uint8array");
          const mimeType = coverItem.getAttribute("media-type") || BookUtils.detectImageMime(bytes, fullCoverPath);
          cover = { bytes, mimeType, zipPath: entry.name };
        }
      }
    }

    return {
      metadata: {
        title,
        author: BookUtils.joinAuthors(authors),
        authorSort,
        language,
        publisher,
        date,
        identifier,
        rights,
        series,
        seriesIndex,
        subjects,
        description,
        creatorTool: "",
        producer: "",
        customFields
      },
      cover,
      details: `EPUB ${version}`,
      internalState: {
        zip,
        opfPath,
        opfDir,
        version
      }
    };
  }

  const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

  function ensureDcNamespace(opfDoc, metadataEl) {
    const pkgEl = opfDoc.documentElement;
    if (!pkgEl.getAttribute("xmlns:dc")) {
      pkgEl.setAttributeNS(XMLNS_NS, "xmlns:dc", DC_NS);
    }
    if (!pkgEl.getAttribute("xmlns:opf")) {
      pkgEl.setAttributeNS(XMLNS_NS, "xmlns:opf", OPF_NS);
    }
    if (metadataEl.getAttribute("xmlns:opf")) {
      metadataEl.removeAttribute("xmlns:opf");
    }
  }

  function setOrRemoveSingleDc(opfDoc, metadataEl, localName, value) {
    const existing = getDcElements(metadataEl, localName);
    const trimmed = String(value || "").trim();
    if (!trimmed) {
      for (const el of existing) el.parentNode.removeChild(el);
      return;
    }
    if (existing.length > 0) {
      existing[0].textContent = trimmed;
      for (let i = 1; i < existing.length; i++) {
        existing[i].parentNode.removeChild(existing[i]);
      }
    } else {
      const el = opfDoc.createElementNS(DC_NS, `dc:${localName}`);
      el.textContent = trimmed;
      metadataEl.appendChild(el);
    }
  }

  function removeMetaRefinesForIds(metadataEl, ids) {
    if (!ids.length) return;
    const set = new Set(ids.map((id) => `#${id}`));
    for (const child of Array.from(metadataEl.children)) {
      if (child.localName === "meta" && set.has(child.getAttribute("refines"))) {
        metadataEl.removeChild(child);
      }
    }
  }

  async function save(internalState, metadata, newCover) {
    const { zip: origZip, opfPath, opfDir, version } = internalState;
    const isEpub3 = parseFloat(version) >= 3;

    const opfXml = await origZip.file(opfPath).async("string");
    const opfDoc = parseXmlStrict(opfXml, opfPath);
    const pkgEl = opfDoc.documentElement;
    const pkgNs = pkgEl.namespaceURI || OPF_NS;
    const metadataEl =
      Array.from(pkgEl.children).find((el) => el.localName === "metadata") ||
      opfDoc.getElementsByTagNameNS(OPF_NS, "metadata")[0] ||
      opfDoc.getElementsByTagName("metadata")[0];
    const manifestEl = Array.from(pkgEl.children).find((el) => el.localName === "manifest");

    ensureDcNamespace(opfDoc, metadataEl);

    // Limpiar creadores antiguos y sus refines antes de reconstruir la cabecera de metadatos
    const oldCreators = getDcElements(metadataEl, "creator");
    const oldCreatorIds = oldCreators.map((el) => el.getAttribute("id")).filter(Boolean);
    for (const el of oldCreators) el.parentNode.removeChild(el);
    removeMetaRefinesForIds(metadataEl, oldCreatorIds);

    // 1. Campos DC principales
    setOrRemoveSingleDc(opfDoc, metadataEl, "title", metadata.title);
    setOrRemoveSingleDc(opfDoc, metadataEl, "language", metadata.language);
    setOrRemoveSingleDc(opfDoc, metadataEl, "publisher", metadata.publisher);
    setOrRemoveSingleDc(opfDoc, metadataEl, "date", metadata.date);
    setOrRemoveSingleDc(opfDoc, metadataEl, "rights", metadata.rights);
    setOrRemoveSingleDc(opfDoc, metadataEl, "description", metadata.description);

    // 2. Autores (<dc:creator>) con opf:role="aut" (requerido por Send to Kindle) y refines en EPUB 3
    const authors = BookUtils.splitAuthors(metadata.author);
    const authorSort = String(metadata.authorSort || "").trim();
    const creatorNodes = [];

    authors.forEach((authorName, idx) => {
      const cEl = opfDoc.createElementNS(DC_NS, "dc:creator");
      cEl.textContent = authorName;
      const effectiveSort = idx === 0 ? (authorSort || authorName) : "";

      // Atributos opf:role y opf:file-as siempre presentes: Kindle/Send-to-Kindle los exige incluso en EPUB 3
      cEl.setAttributeNS(OPF_NS, "opf:role", "aut");
      if (effectiveSort) {
        cEl.setAttributeNS(OPF_NS, "opf:file-as", effectiveSort);
      }

      if (isEpub3) {
        const cid = `creator-${idx + 1}`;
        cEl.setAttribute("id", cid);
        creatorNodes.push(cEl);

        const roleMeta = opfDoc.createElementNS(pkgNs, "meta");
        roleMeta.setAttribute("refines", `#${cid}`);
        roleMeta.setAttribute("property", "role");
        roleMeta.setAttribute("scheme", "marc:relators");
        roleMeta.textContent = "aut";
        creatorNodes.push(roleMeta);

        if (effectiveSort) {
          const faMeta = opfDoc.createElementNS(pkgNs, "meta");
          faMeta.setAttribute("refines", `#${cid}`);
          faMeta.setAttribute("property", "file-as");
          faMeta.textContent = effectiveSort;
          creatorNodes.push(faMeta);
        }
      } else {
        creatorNodes.push(cEl);
      }
    });

    // Insertar en orden canónico al principio de <metadata>: title -> creator(s) -> language
    const titleEl = getDcElements(metadataEl, "title")[0] || null;
    const langEl = getDcElements(metadataEl, "language")[0] || null;
    if (titleEl && titleEl !== metadataEl.firstElementChild) {
      metadataEl.insertBefore(titleEl, metadataEl.firstChild);
    }
    const anchorAfterTitle = titleEl ? titleEl.nextSibling : metadataEl.firstChild;
    for (const node of creatorNodes) {
      metadataEl.insertBefore(node, anchorAfterTitle);
    }
    if (langEl) {
      metadataEl.insertBefore(langEl, anchorAfterTitle);
    }

    // 3. Identificador (mantener id único del package válido)
    const uniqueIdAttr = pkgEl.getAttribute("unique-identifier");
    const idEls = getDcElements(metadataEl, "identifier");
    const newIdentifier = String(metadata.identifier || "").trim();
    if (newIdentifier) {
      const targetIdEl =
        idEls.find((el) => {
          const scheme = getAttrNSOrPrefix(el, OPF_NS, "opf", "scheme").toUpperCase();
          return scheme === "ISBN" || el.textContent.trim().toUpperCase().startsWith("URN:ISBN:");
        }) ||
        (uniqueIdAttr ? idEls.find((el) => el.getAttribute("id") === uniqueIdAttr) : null) ||
        idEls[0];

      if (targetIdEl) {
        targetIdEl.textContent = newIdentifier;
        const cleanDigits = newIdentifier.replace(/[-\s]/g, "").replace(/^urn:isbn:/i, "");
        if (/^(97[89])?\d{9}[\dXx]$/.test(cleanDigits)) {
          targetIdEl.setAttributeNS(OPF_NS, "opf:scheme", "ISBN");
        } else if (/^B0[A-Z0-9]{8}$/i.test(cleanDigits)) {
          targetIdEl.setAttributeNS(OPF_NS, "opf:scheme", "ASIN");
        }
      } else {
        const newIdEl = opfDoc.createElementNS(DC_NS, "dc:identifier");
        if (uniqueIdAttr) newIdEl.setAttribute("id", uniqueIdAttr);
        const cleanDigits = newIdentifier.replace(/[-\s]/g, "").replace(/^urn:isbn:/i, "");
        if (/^(97[89])?\d{9}[\dXx]$/.test(cleanDigits)) {
          newIdEl.setAttributeNS(OPF_NS, "opf:scheme", "ISBN");
        }
        newIdEl.textContent = newIdentifier;
        metadataEl.appendChild(newIdEl);
      }
    }

    // 4. Subjects (etiquetas)
    for (const el of getDcElements(metadataEl, "subject")) {
      el.parentNode.removeChild(el);
    }
    for (const tag of metadata.subjects || []) {
      const clean = String(tag || "").trim();
      if (!clean) continue;
      const sEl = opfDoc.createElementNS(DC_NS, "dc:subject");
      sEl.textContent = clean;
      metadataEl.appendChild(sEl);
    }

    // 5. Series (Calibre + EPUB 3 collection)
    const colIdsToClean = [];
    for (const child of Array.from(metadataEl.children)) {
      if (child.localName !== "meta") continue;
      const mName = child.getAttribute("name");
      const mProp = child.getAttribute("property");
      if (mName === "calibre:series" || mName === "calibre:series_index") {
        metadataEl.removeChild(child);
      } else if (mProp === "belongs-to-collection") {
        if (child.getAttribute("id")) colIdsToClean.push(child.getAttribute("id"));
        metadataEl.removeChild(child);
      }
    }
    removeMetaRefinesForIds(metadataEl, colIdsToClean);

    const series = String(metadata.series || "").trim();
    const seriesIndex = String(metadata.seriesIndex || "").trim();
    if (series) {
      const mSeries = opfDoc.createElementNS(pkgNs, "meta");
      mSeries.setAttribute("name", "calibre:series");
      mSeries.setAttribute("content", series);
      metadataEl.appendChild(mSeries);

      if (seriesIndex) {
        const mIdx = opfDoc.createElementNS(pkgNs, "meta");
        mIdx.setAttribute("name", "calibre:series_index");
        mIdx.setAttribute("content", seriesIndex);
        metadataEl.appendChild(mIdx);
      }

      if (isEpub3) {
        const colId = "collection-series";
        const colMeta = opfDoc.createElementNS(pkgNs, "meta");
        colMeta.setAttribute("property", "belongs-to-collection");
        colMeta.setAttribute("id", colId);
        colMeta.textContent = series;
        metadataEl.appendChild(colMeta);

        const typeMeta = opfDoc.createElementNS(pkgNs, "meta");
        typeMeta.setAttribute("refines", `#${colId}`);
        typeMeta.setAttribute("property", "collection-type");
        typeMeta.textContent = "series";
        metadataEl.appendChild(typeMeta);

        if (seriesIndex) {
          const posMeta = opfDoc.createElementNS(pkgNs, "meta");
          posMeta.setAttribute("refines", `#${colId}`);
          posMeta.setAttribute("property", "group-position");
          posMeta.textContent = seriesIndex;
          metadataEl.appendChild(posMeta);
        }
      }
    }

    // 6. Campos personalizados / avanzados
    for (const child of Array.from(metadataEl.children)) {
      if (child.namespaceURI === DC_NS || child.tagName.toLowerCase().startsWith("dc:")) {
        if (!MANAGED_DC.has(child.localName)) {
          metadataEl.removeChild(child);
        }
      } else if (child.localName === "meta") {
        const mName = child.getAttribute("name");
        const mProp = child.getAttribute("property");
        const refines = child.getAttribute("refines");
        if (
          mName &&
          mName !== "cover" &&
          mName !== "calibre:series" &&
          mName !== "calibre:series_index"
        ) {
          metadataEl.removeChild(child);
        } else if (mProp && !refines && mProp !== "dcterms:modified" && mProp !== "belongs-to-collection") {
          metadataEl.removeChild(child);
        }
      }
    }

    for (const cf of metadata.customFields || []) {
      const key = String(cf.key || "").trim();
      const val = String(cf.value || "").trim();
      if (!key) continue;
      if (key.startsWith("dc:")) {
        const local = key.slice(3).replace(/[^a-zA-Z0-9_-]/g, "");
        if (!local) continue;
        const el = opfDoc.createElementNS(DC_NS, `dc:${local}`);
        el.textContent = val;
        metadataEl.appendChild(el);
      } else if (key.startsWith("property:")) {
        const prop = key.slice(9).trim();
        if (!prop) continue;
        const el = opfDoc.createElementNS(pkgNs, "meta");
        el.setAttribute("property", prop);
        el.textContent = val;
        metadataEl.appendChild(el);
      } else {
        const el = opfDoc.createElementNS(pkgNs, "meta");
        el.setAttribute("name", key);
        el.setAttribute("content", val);
        metadataEl.appendChild(el);
      }
    }

    // 7. dcterms:modified para EPUB 3
    if (isEpub3) {
      const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      const modMeta = Array.from(metadataEl.children).find(
        (el) => el.localName === "meta" && el.getAttribute("property") === "dcterms:modified"
      );
      if (modMeta) {
        modMeta.textContent = nowIso;
      } else {
        const m = opfDoc.createElementNS(pkgNs, "meta");
        m.setAttribute("property", "dcterms:modified");
        m.textContent = nowIso;
        metadataEl.appendChild(m);
      }
    }

    // 8. Portada nueva (si el usuario la reemplazó)
    const replacedFiles = new Map();

    if (newCover && newCover.bytes) {
      const ext = BookUtils.mimeToExt(newCover.mimeType);
      const existingItem = findCoverItem(metadataEl, manifestEl);
      if (existingItem && manifestEl) {
        // Mantener la misma ruta para no romper referencias <img src="..."> en cover.xhtml
        const oldHref = existingItem.getAttribute("href");
        const oldZipPath = resolvePath(opfDir, oldHref);
        const existingEntry = findZipEntryCaseInsensitive(origZip, oldZipPath);
        const targetZipPath = existingEntry ? existingEntry.name : oldZipPath;
        existingItem.setAttribute("media-type", newCover.mimeType);
        replacedFiles.set(targetZipPath, newCover.bytes);
      } else if (manifestEl) {
        const newRelHref = `cover.${ext}`;
        const newZipPath = resolvePath(opfDir, newRelHref);
        const item = opfDoc.createElementNS(pkgNs, "item");
        item.setAttribute("id", "cover-image");
        item.setAttribute("href", newRelHref);
        item.setAttribute("media-type", newCover.mimeType);
        if (isEpub3) item.setAttribute("properties", "cover-image");
        manifestEl.appendChild(item);

        const coverMeta = opfDoc.createElementNS(pkgNs, "meta");
        coverMeta.setAttribute("name", "cover");
        coverMeta.setAttribute("content", "cover-image");
        metadataEl.appendChild(coverMeta);

        replacedFiles.set(newZipPath, newCover.bytes);
      }
    }

    // Serializar OPF
    let serializedOpf = new XMLSerializer().serializeToString(opfDoc);
    if (!serializedOpf.startsWith("<?xml")) {
      serializedOpf = '<?xml version="1.0" encoding="UTF-8"?>\n' + serializedOpf;
    }

    // Reempacar ZIP respetando la especificación EPUB: mimetype primero y sin compresión (STORE)
    const outZip = new JSZip();
    outZip.file("mimetype", "application/epub+zip", { compression: "STORE" });

    for (const [path, entry] of Object.entries(origZip.files)) {
      if (entry.dir) continue;
      if (path === "mimetype") continue;

      if (path === opfPath) {
        outZip.file(path, serializedOpf, { compression: "DEFLATE" });
      } else if (replacedFiles.has(path)) {
        outZip.file(path, replacedFiles.get(path), { compression: "STORE" });
        replacedFiles.delete(path);
      } else {
        const data = await entry.async("uint8array");
        const isMedia = /\.(jpe?g|png|gif|webp|mp3|mp4|woff2?)$/i.test(path);
        outZip.file(path, data, { compression: isMedia ? "STORE" : "DEFLATE" });
      }
    }

    // Agregar archivos nuevos (ej. portada nueva que no existía antes)
    for (const [path, bytes] of replacedFiles.entries()) {
      outZip.file(path, bytes, { compression: "STORE" });
    }

    const bytes = await outZip.generateAsync({
      type: "uint8array",
      mimeType: "application/epub+zip",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    });

    return { bytes, mimeType: "application/epub+zip" };
  }

  global.BookHandlers = global.BookHandlers || {};
  global.BookHandlers.epub = {
    formatLabel: "EPUB",
    badgeClass: "fmt-epub",
    supportsCoverEdit: true,
    kindleTip:
      "<strong>Sobre Send to Kindle:</strong> Este editor escribe <code>&lt;dc:title&gt;</code>, <code>&lt;dc:creator opf:role=&quot;aut&quot;&gt;</code> y <code>mimetype</code> según el estándar EPUB. Aun así, <strong>Amazon</strong> en la nube convierte el EPUB a <em>Documento Personal (PDOC)</em> sin ASIN de tienda: al subirlo por la web/app de <em>Send to Kindle</em>, rellena también la casilla «Autor» de Amazon para tu biblioteca (la pantalla final «Antes de irte» requiere un libro <code>EBOK</code> con ASIN transferido por USB en AZW3/MOBI).",
    parse,
    save
  };
})(window);

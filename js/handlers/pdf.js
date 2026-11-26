/* Controlador de lectura y escritura de metadatos para PDF (Diccionario Info + XMP) */

(function (global) {
  "use strict";

  const STANDARD_INFO_KEYS = new Set([
    "Title", "Author", "Subject", "Keywords",
    "Creator", "Producer", "CreationDate", "ModDate"
  ]);

  function getInfoString(infoDict, key) {
    const { PDFName, PDFString, PDFHexString } = PDFLib;
    const val = infoDict.lookup(PDFName.of(key));
    if (val instanceof PDFString || val instanceof PDFHexString) {
      return val.decodeText();
    }
    return "";
  }

  function extractXmpText(pdfDoc) {
    try {
      const { PDFName, PDFRawStream, decodePDFRawStream } = PDFLib;
      const metaRef = pdfDoc.catalog.get(PDFName.of("Metadata"));
      if (!metaRef) return "";
      const metaObj = pdfDoc.context.lookup(metaRef);
      if (!metaObj) return "";
      let bytes;
      if (metaObj instanceof PDFRawStream) {
        const filter = metaObj.dict.get(PDFName.of("Filter"));
        bytes = filter ? decodePDFRawStream(metaObj).decode() : metaObj.contents;
      } else if (metaObj.contents) {
        bytes = metaObj.contents;
      }
      if (!bytes) return "";
      return BookUtils.decodeUtf8(bytes);
    } catch (_) {
      return "";
    }
  }

  function parseXmpFields(xmpXml) {
    const result = {
      title: "",
      author: "",
      description: "",
      subjects: [],
      language: "",
      publisher: "",
      identifier: "",
      rights: "",
      creatorTool: "",
      producer: ""
    };
    if (!xmpXml || !xmpXml.includes("<")) return result;
    try {
      const doc = new DOMParser().parseFromString(xmpXml, "application/xml");
      if (doc.querySelector("parsererror")) return result;

      const getFirstText = (ns, local) => {
        const els = doc.getElementsByTagNameNS(ns, local);
        if (!els.length) return "";
        const li = els[0].getElementsByTagNameNS("http://www.w3.org/1999/02/22-rdf-syntax-ns#", "li");
        if (li.length) {
          return Array.from(li).map((n) => n.textContent.trim()).filter(Boolean).join("; ");
        }
        return els[0].textContent.trim();
      };

      const getListText = (ns, local) => {
        const els = doc.getElementsByTagNameNS(ns, local);
        if (!els.length) return [];
        const li = els[0].getElementsByTagNameNS("http://www.w3.org/1999/02/22-rdf-syntax-ns#", "li");
        if (li.length) {
          return Array.from(li).map((n) => n.textContent.trim()).filter(Boolean);
        }
        const single = els[0].textContent.trim();
        return single ? [single] : [];
      };

      const DC = "http://purl.org/dc/elements/1.1/";
      const XMP = "http://ns.adobe.com/xap/1.0/";
      const PDF = "http://ns.adobe.com/pdf/1.3/";

      result.title = getFirstText(DC, "title");
      result.author = getFirstText(DC, "creator");
      result.description = getFirstText(DC, "description");
      result.subjects = getListText(DC, "subject");
      result.language = getFirstText(DC, "language");
      result.publisher = getFirstText(DC, "publisher");
      result.identifier = getFirstText(DC, "identifier");
      result.rights = getFirstText(DC, "rights");
      result.creatorTool = getFirstText(XMP, "CreatorTool");
      result.producer = getFirstText(PDF, "Producer");
    } catch (_) {
      // Ignorar errores de parseo XMP
    }
    return result;
  }

  function buildXmpPacket(metadata, creationDateIso, modDateIso) {
    const e = BookUtils.escapeXml;
    const authors = BookUtils.splitAuthors(metadata.author);
    const subjects = (metadata.subjects || []).map((s) => String(s || "").trim()).filter(Boolean);

    const creatorXml = authors.length
      ? `<dc:creator><rdf:Seq>${authors.map((a) => `<rdf:li>${e(a)}</rdf:li>`).join("")}</rdf:Seq></dc:creator>`
      : "";
    const subjectXml = subjects.length
      ? `<dc:subject><rdf:Bag>${subjects.map((s) => `<rdf:li>${e(s)}</rdf:li>`).join("")}</rdf:Bag></dc:subject>`
      : "";
    const titleXml = metadata.title
      ? `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${e(metadata.title)}</rdf:li></rdf:Alt></dc:title>`
      : "";
    const descXml = metadata.description
      ? `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${e(metadata.description)}</rdf:li></rdf:Alt></dc:description>`
      : "";
    const rightsXml = metadata.rights
      ? `<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">${e(metadata.rights)}</rdf:li></rdf:Alt></dc:rights>`
      : "";
    const langXml = metadata.language
      ? `<dc:language><rdf:Bag><rdf:li>${e(metadata.language)}</rdf:li></rdf:Bag></dc:language>`
      : "";
    const pubXml = metadata.publisher
      ? `<dc:publisher><rdf:Bag><rdf:li>${e(metadata.publisher)}</rdf:li></rdf:Bag></dc:publisher>`
      : "";
    const idXml = metadata.identifier
      ? `<dc:identifier>${e(metadata.identifier)}</dc:identifier>`
      : "";

    const keywordsJoined = subjects.join(", ");

    return (
      `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
      `<x:xmpmeta xmlns:x="adobe:ns:meta/">\n` +
      `  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n` +
      `    <rdf:Description rdf:about=""\n` +
      `      xmlns:dc="http://purl.org/dc/elements/1.1/"\n` +
      `      xmlns:pdf="http://ns.adobe.com/pdf/1.3/"\n` +
      `      xmlns:xmp="http://ns.adobe.com/xap/1.0/">\n` +
      `      ${titleXml}\n` +
      `      ${creatorXml}\n` +
      `      ${descXml}\n` +
      `      ${subjectXml}\n` +
      `      ${rightsXml}\n` +
      `      ${langXml}\n` +
      `      ${pubXml}\n` +
      `      ${idXml}\n` +
      (keywordsJoined ? `      <pdf:Keywords>${e(keywordsJoined)}</pdf:Keywords>\n` : "") +
      (metadata.producer ? `      <pdf:Producer>${e(metadata.producer)}</pdf:Producer>\n` : "") +
      (metadata.creatorTool ? `      <xmp:CreatorTool>${e(metadata.creatorTool)}</xmp:CreatorTool>\n` : "") +
      (creationDateIso ? `      <xmp:CreateDate>${e(creationDateIso)}</xmp:CreateDate>\n` : "") +
      `      <xmp:ModifyDate>${e(modDateIso)}</xmp:ModifyDate>\n` +
      `    </rdf:Description>\n` +
      `  </rdf:RDF>\n` +
      `</x:xmpmeta>\n` +
      `<?xpacket end="w"?>`
    );
  }

  async function parse(uint8Array) {
    const pdfDoc = await PDFLib.PDFDocument.load(uint8Array, {
      updateMetadata: false,
      ignoreEncryption: true
    });
    const { PDFName } = PDFLib;
    const infoDict = pdfDoc.getInfoDict();

    const xmpXml = extractXmpText(pdfDoc);
    const xmp = parseXmpFields(xmpXml);

    const title = pdfDoc.getTitle() || xmp.title || "";
    const author = pdfDoc.getAuthor() || xmp.author || "";
    const description = pdfDoc.getSubject() || xmp.description || "";
    const kwRaw = pdfDoc.getKeywords() || "";
    const kwList = kwRaw
      ? kwRaw.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
      : xmp.subjects;

    const creatorTool = pdfDoc.getCreator() || xmp.creatorTool || "";
    const producer = pdfDoc.getProducer() || xmp.producer || "";
    const creationDateObj = pdfDoc.getCreationDate();
    const date = creationDateObj ? BookUtils.formatDateYMD(creationDateObj) : "";

    let language = xmp.language;
    if (!language) {
      const langObj = pdfDoc.catalog.get(PDFName.of("Lang"));
      if (langObj && typeof langObj.decodeText === "function") {
        language = langObj.decodeText();
      }
    }

    // Claves personalizadas en Info dictionary
    const customFields = [];
    for (const keyName of infoDict.keys()) {
      const cleanKey = keyName.asString().replace(/^\//, "");
      if (!STANDARD_INFO_KEYS.has(cleanKey)) {
        const val = getInfoString(infoDict, cleanKey);
        if (val) {
          customFields.push({ key: cleanKey, value: val });
        }
      }
    }

    const pageCount = pdfDoc.getPageCount();
    const hasXmp = Boolean(xmpXml);

    return {
      metadata: {
        title,
        author,
        authorSort: "",
        language,
        publisher: xmp.publisher,
        date,
        identifier: xmp.identifier,
        rights: xmp.rights,
        series: "",
        seriesIndex: "",
        subjects: kwList,
        description,
        creatorTool,
        producer,
        customFields
      },
      cover: null,
      details: `PDF · ${pageCount} págs.${hasXmp ? " + XMP" : ""}`,
      internalState: {
        sourceBytes: uint8Array,
        originalDate: date,
        originalCreationDateObj: creationDateObj || null
      }
    };
  }

  function canEncodeLatin1(str) {
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c > 0xFF || (c >= 0x7F && c <= 0x9F)) return false;
    }
    return true;
  }

  function escapePdfLiteral(str) {
    return str
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n");
  }

  function toKindleSafePdfText(str) {
    const { PDFString, PDFHexString } = PDFLib;
    if (canEncodeLatin1(str)) {
      return PDFString.of(escapePdfLiteral(str));
    }
    return PDFHexString.fromText(str);
  }

  function setOrDeleteInfo(infoDict, key, value) {
    const { PDFName } = PDFLib;
    const trimmed = String(value || "").trim();
    if (trimmed) {
      infoDict.set(PDFName.of(key), toKindleSafePdfText(trimmed));
    } else {
      infoDict.delete(PDFName.of(key));
    }
  }

  async function save(internalState, metadata) {
    const { PDFName, PDFString } = PDFLib;
    const pdfDoc = await PDFLib.PDFDocument.load(internalState.sourceBytes, {
      updateMetadata: false,
      ignoreEncryption: true
    });
    const infoDict = pdfDoc.getInfoDict();

    setOrDeleteInfo(infoDict, "Title", metadata.title);
    setOrDeleteInfo(infoDict, "Author", metadata.author);
    setOrDeleteInfo(infoDict, "Subject", metadata.description);
    setOrDeleteInfo(infoDict, "Creator", metadata.creatorTool);
    setOrDeleteInfo(infoDict, "Producer", metadata.producer);

    const subjects = (metadata.subjects || []).map((s) => String(s || "").trim()).filter(Boolean);
    if (subjects.length > 0) {
      // Unir con coma y usar PDFString compatible con lectores Kindle
      infoDict.set(PDFName.of("Keywords"), toKindleSafePdfText(subjects.join(", ")));
    } else {
      infoDict.delete(PDFName.of("Keywords"));
    }

    // Idioma en el catálogo del PDF
    const lang = String(metadata.language || "").trim();
    if (lang) {
      pdfDoc.catalog.set(PDFName.of("Lang"), toKindleSafePdfText(lang));
    } else {
      pdfDoc.catalog.delete(PDFName.of("Lang"));
    }

    // Fechas
    let creationDateObj = internalState.originalCreationDateObj;
    const editedDateStr = String(metadata.date || "").trim();
    if (editedDateStr !== internalState.originalDate) {
      if (!editedDateStr) {
        infoDict.delete(PDFName.of("CreationDate"));
        creationDateObj = null;
      } else {
        const parsed = BookUtils.parseFlexibleDate(editedDateStr);
        if (parsed) {
          pdfDoc.setCreationDate(parsed);
          creationDateObj = parsed;
        }
      }
    }
    const now = new Date();
    pdfDoc.setModificationDate(now);

    // Claves personalizadas en Info dictionary
    for (const keyName of Array.from(infoDict.keys())) {
      const cleanKey = keyName.asString().replace(/^\//, "");
      if (!STANDARD_INFO_KEYS.has(cleanKey)) {
        infoDict.delete(keyName);
      }
    }
    for (const cf of metadata.customFields || []) {
      const k = String(cf.key || "").trim().replace(/^\//, "");
      const v = String(cf.value || "").trim();
      if (k && !STANDARD_INFO_KEYS.has(k)) {
        infoDict.set(PDFName.of(k), toKindleSafePdfText(v));
      }
    }

    // Actualizar o crear el stream XMP /Metadata para compatibilidad total (Adobe, macOS, Calibre, Kindle)
    const creationIso = creationDateObj ? creationDateObj.toISOString() : "";
    const modIso = now.toISOString();
    const xmpString = buildXmpPacket(metadata, creationIso, modIso);
    const xmpBytes = BookUtils.encodeUtf8(xmpString);
    const xmpStream = pdfDoc.context.stream(xmpBytes, {
      Type: "Metadata",
      Subtype: "XML"
    });
    const xmpRef = pdfDoc.context.register(xmpStream);
    pdfDoc.catalog.set(PDFName.of("Metadata"), xmpRef);

    const outBytes = await pdfDoc.save({ useObjectStreams: false });
    return { bytes: new Uint8Array(outBytes), mimeType: "application/pdf" };
  }

  global.BookHandlers = global.BookHandlers || {};
  global.BookHandlers.pdf = {
    formatLabel: "PDF",
    badgeClass: "fmt-pdf",
    supportsCoverEdit: false,
    kindleTip:
      "<strong>Nota PDF:</strong> Se actualizan tanto el diccionario clásico <code>/Info</code> como el paquete XML <strong>XMP</strong> (<code>/Metadata</code>) y el idioma (<code>/Lang</code>), asegurando que Kindle, Calibre y lectores muestren los nuevos metadatos.",
    parse,
    save
  };
})(window);

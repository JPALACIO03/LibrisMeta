/* Controlador principal de interfaz, persistencia local, verificación y descarga */

(function () {
  "use strict";

  const EXT_MAP = {
    epub: "epub",
    pdf: "pdf",
    mobi: "mobi",
    azw: "mobi",
    azw3: "mobi",
    prc: "mobi",
    fb2: "fb2",
    "fb2.zip": "fb2",
    cbz: "cbz"
  };

  const state = {
    handlerKey: null,
    handler: null,
    originalFilename: "",
    originalExt: "",
    originalBytes: null,
    originalResult: null,
    internalState: null,
    subjects: [],
    customFields: [],
    newCover: null,
    coverObjectUrl: null,
    customFilenameEdited: false
  };

  const els = {
    uploadSection: document.getElementById("uploadSection"),
    editorSection: document.getElementById("editorSection"),
    dropzone: document.getElementById("dropzone"),
    fileInput: document.getElementById("fileInput"),
    selectFileBtn: document.getElementById("selectFileBtn"),
    changeFileBtn: document.getElementById("changeFileBtn"),
    resetBtn: document.getElementById("resetBtn"),
    closeBookBtn: document.getElementById("closeBookBtn"),

    formatBadge: document.getElementById("formatBadge"),
    originalFileName: document.getElementById("originalFileName"),
    fileMetaInfo: document.getElementById("fileMetaInfo"),
    autosaveStatus: document.getElementById("autosaveStatus"),

    coverPreview: document.getElementById("coverPreview"),
    coverPlaceholder: document.getElementById("coverPlaceholder"),
    coverInput: document.getElementById("coverInput"),
    changeCoverBtn: document.getElementById("changeCoverBtn"),
    coverSupportNote: document.getElementById("coverSupportNote"),
    previewTitle: document.getElementById("previewTitle"),
    previewAuthor: document.getElementById("previewAuthor"),

    outputFilename: document.getElementById("outputFilename"),
    outputExt: document.getElementById("outputExt"),
    saveDownloadBtn: document.getElementById("saveDownloadBtn"),
    mobileActionBar: document.getElementById("mobileActionBar"),
    mobileSaveBtn: document.getElementById("mobileSaveBtn"),
    verifyBox: document.getElementById("verifyBox"),
    kindleTip: document.getElementById("kindleTip"),

    metaTitle: document.getElementById("metaTitle"),
    metaAuthor: document.getElementById("metaAuthor"),
    metaAuthorSort: document.getElementById("metaAuthorSort"),
    metaLanguage: document.getElementById("metaLanguage"),
    metaDate: document.getElementById("metaDate"),
    metaSeries: document.getElementById("metaSeries"),
    metaSeriesIndex: document.getElementById("metaSeriesIndex"),
    metaPublisher: document.getElementById("metaPublisher"),
    metaIdentifier: document.getElementById("metaIdentifier"),
    metaRights: document.getElementById("metaRights"),
    metaCreatorTool: document.getElementById("metaCreatorTool"),
    metaProducer: document.getElementById("metaProducer"),
    pdfExtraFields: document.getElementById("pdfExtraFields"),
    metaAsin: document.getElementById("metaAsin"),
    metaCdeType: document.getElementById("metaCdeType"),
    kindleExtraFields: document.getElementById("kindleExtraFields"),
    metaDescription: document.getElementById("metaDescription"),

    tagsContainer: document.getElementById("tagsContainer"),
    tagInput: document.getElementById("tagInput"),

    customCountBadge: document.getElementById("customCountBadge"),
    customFieldsList: document.getElementById("customFieldsList"),
    addCustomFieldBtn: document.getElementById("addCustomFieldBtn"),

    toast: document.getElementById("toast"),
    tabEditorBtn: document.getElementById("tabEditorBtn"),
    tabLibraryBtn: document.getElementById("tabLibraryBtn"),
    tabStatsBtn: document.getElementById("tabStatsBtn"),
    editorView: document.getElementById("editorView"),
    librarySection: document.getElementById("librarySection"),
    statsSection: document.getElementById("statsSection"),
    addToStatsBtn: document.getElementById("addToStatsBtn")
  };

  let toastTimer = null;
  function showToast(message, type) {
    els.toast.textContent = message;
    els.toast.className = "toast" + (type ? ` toast-${type}` : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.add("hidden");
    }, 4500);
  }

  let persistTimer = null;
  function setAutosaveIndicator(text, saving) {
    if (!els.autosaveStatus) return;
    els.autosaveStatus.textContent = text;
    els.autosaveStatus.classList.toggle("is-saving", Boolean(saving));
  }

  let pendingDraftToApply = null;

  async function persistCurrentSessionNow() {
    if (!state.originalBytes || !state.handlerKey || !globalThis.BookStorage) return;
    const mode = await window.BookStorage.saveSession({
      originalFilename: state.originalFilename,
      originalExt: state.originalExt,
      originalBytes: state.originalBytes,
      outputFilename: els.outputFilename.value,
      customFilenameEdited: state.customFilenameEdited,
      editedMeta: collectFormMetadata({ commitPendingTag: false }),
      newCover: state.newCover
        ? { bytes: state.newCover.bytes, mimeType: state.newCover.mimeType }
        : null,
      savedAt: Date.now()
    });
    if (mode === "full") {
      setAutosaveIndicator("Guardado en navegador", false);
    } else if (mode === "meta-only") {
      setAutosaveIndicator("Metadatos guardados", false);
    } else {
      setAutosaveIndicator("Sin persistencia local", false);
    }
  }

  function schedulePersist(immediate) {
    if (!state.originalBytes) return;
    setAutosaveIndicator("Guardando...", true);
    clearTimeout(persistTimer);
    if (immediate) {
      persistCurrentSessionNow();
    } else {
      persistTimer = setTimeout(() => {
        persistCurrentSessionNow();
      }, 250);
    }
  }

  function detectHandlerKey(filename, bytes) {
    const ext = BookUtils.getExtension(filename);
    if (EXT_MAP[ext]) return { handlerKey: EXT_MAP[ext], ext };

    if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
      return { handlerKey: "pdf", ext: "pdf" };
    }
    return null;
  }

  function setCoverPreview(coverObj) {
    if (state.coverObjectUrl) {
      URL.revokeObjectURL(state.coverObjectUrl);
      state.coverObjectUrl = null;
    }
    if (coverObj && coverObj.bytes) {
      const blob = new Blob([coverObj.bytes], { type: coverObj.mimeType || "image/jpeg" });
      state.coverObjectUrl = URL.createObjectURL(blob);
      els.coverPreview.src = state.coverObjectUrl;
      els.coverPreview.classList.remove("hidden");
      els.coverPlaceholder.classList.add("hidden");
    } else {
      els.coverPreview.removeAttribute("src");
      els.coverPreview.classList.add("hidden");
      els.coverPlaceholder.classList.remove("hidden");
    }
  }

  function renderTags() {
    for (const chip of Array.from(els.tagsContainer.querySelectorAll(".tag-chip"))) {
      chip.remove();
    }
    state.subjects.forEach((tag, idx) => {
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.textContent = tag;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("aria-label", `Quitar etiqueta ${tag}`);
      btn.textContent = "×";
      btn.addEventListener("click", () => {
        state.subjects.splice(idx, 1);
        renderTags();
        schedulePersist(true);
      });

      chip.appendChild(btn);
      els.tagsContainer.insertBefore(chip, els.tagInput);
    });
  }

  function addTagFromInput(raw) {
    const parts = String(raw || "").split(",").map((s) => s.trim()).filter(Boolean);
    let added = false;
    for (const p of parts) {
      if (!state.subjects.includes(p)) {
        state.subjects.push(p);
        added = true;
      }
    }
    if (added) {
      renderTags();
      schedulePersist(true);
    }
  }

  function renderCustomFields() {
    els.customFieldsList.innerHTML = "";
    els.customCountBadge.textContent = `${state.customFields.length} ${state.customFields.length === 1 ? "campo" : "campos"}`;

    state.customFields.forEach((item, idx) => {
      const row = document.createElement("div");
      row.className = "custom-row";

      const keyInput = document.createElement("input");
      keyInput.type = "text";
      keyInput.className = "custom-key";
      keyInput.placeholder = state.handlerKey === "epub" ? "Ej. dc:contributor o calibre:rating" : "Nombre del campo";
      keyInput.value = item.key || "";
      keyInput.addEventListener("input", () => {
        state.customFields[idx].key = keyInput.value;
        schedulePersist(false);
      });

      const valInput = document.createElement("input");
      valInput.type = "text";
      valInput.placeholder = "Valor";
      valInput.value = item.value || "";
      valInput.addEventListener("input", () => {
        state.customFields[idx].value = valInput.value;
        schedulePersist(false);
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn-remove-row";
      delBtn.title = "Eliminar campo";
      delBtn.textContent = "×";
      delBtn.addEventListener("click", () => {
        state.customFields.splice(idx, 1);
        renderCustomFields();
        schedulePersist(true);
      });

      row.appendChild(keyInput);
      row.appendChild(valInput);
      row.appendChild(delBtn);
      els.customFieldsList.appendChild(row);
    });
  }

  function buildTitleAuthorFilename() {
    const t = els.metaTitle.value.trim();
    const a = els.metaAuthor.value.trim();
    const combined = t && a ? `${t} - ${a}` : (t || a || BookUtils.stripExtension(state.originalFilename));
    return BookUtils.sanitizeFilename(combined);
  }

  function updateLivePreview() {
    els.previewTitle.textContent = els.metaTitle.value.trim() || "Sin título";
    els.previewAuthor.textContent = els.metaAuthor.value.trim() || "Autor desconocido";
    if (!state.customFilenameEdited) {
      els.outputFilename.value = buildTitleAuthorFilename();
    }
  }

  function populateForm(metadata, coverToDisplay) {
    els.metaTitle.value = metadata.title || "";
    els.metaAuthor.value = metadata.author || "";
    els.metaAuthorSort.value = metadata.authorSort || "";
    els.metaLanguage.value = metadata.language || "";
    els.metaDate.value = metadata.date || "";
    els.metaSeries.value = metadata.series || "";
    els.metaSeriesIndex.value = metadata.seriesIndex || "";
    els.metaPublisher.value = metadata.publisher || "";
    els.metaIdentifier.value = metadata.identifier || "";
    els.metaRights.value = metadata.rights || "";
    els.metaCreatorTool.value = metadata.creatorTool || "";
    els.metaProducer.value = metadata.producer || "";
    els.metaAsin.value = metadata.asin || "";
    els.metaCdeType.value = metadata.cdeType || "";
    els.metaDescription.value = metadata.description || "";

    state.subjects = [...(metadata.subjects || [])];
    state.customFields = (metadata.customFields || []).map((c) => ({ key: c.key, value: c.value }));

    renderTags();
    renderCustomFields();
    setCoverPreview(coverToDisplay);
    updateLivePreview();
    els.verifyBox.classList.add("hidden");
  }

  function collectFormMetadata(options) {
    const commitPendingTag = !options || options.commitPendingTag !== false;
    if (commitPendingTag && els.tagInput.value.trim()) {
      addTagFromInput(els.tagInput.value);
      els.tagInput.value = "";
    }

    return {
      title: els.metaTitle.value,
      author: els.metaAuthor.value,
      authorSort: els.metaAuthorSort.value,
      language: els.metaLanguage.value,
      date: els.metaDate.value,
      series: els.metaSeries.value,
      seriesIndex: els.metaSeriesIndex.value,
      publisher: els.metaPublisher.value,
      identifier: els.metaIdentifier.value,
      rights: els.metaRights.value,
      creatorTool: els.metaCreatorTool.value,
      producer: els.metaProducer.value,
      asin: els.metaAsin.value,
      cdeType: els.metaCdeType.value,
      subjects: [...state.subjects],
      description: els.metaDescription.value,
      customFields: state.customFields.map((c) => ({ key: c.key, value: c.value }))
    };
  }

  function activateEditorUI(handlerKey, handler, filename, ext, bytesLength, parsed) {
    els.formatBadge.textContent = handler.formatLabel;
    els.formatBadge.className = `fmt-pill ${handler.badgeClass}`;
    els.originalFileName.textContent = filename;
    els.fileMetaInfo.textContent = `${BookUtils.formatBytes(bytesLength)} · ${parsed.details}`;
    els.outputExt.textContent = `.${ext}`;
    els.kindleTip.innerHTML = handler.kindleTip;
    els.pdfExtraFields.classList.toggle("hidden", handlerKey !== "pdf");
    els.kindleExtraFields.classList.toggle("hidden", handlerKey !== "mobi");

    els.changeCoverBtn.disabled = !handler.supportsCoverEdit;
    els.coverSupportNote.textContent = handler.supportsCoverEdit
      ? "Admite JPG, PNG o WebP."
      : `La edición de portada no está disponible para ${handler.formatLabel}.`;

    els.uploadSection.classList.add("hidden");
    els.editorSection.classList.remove("hidden");
    els.mobileActionBar.classList.remove("hidden");
  }

  async function loadBookBytes(bytes, filename, restoredSession) {
    const detected = detectHandlerKey(filename, bytes);
    if (!detected || !window.BookHandlers[detected.handlerKey]) {
      showToast("Formato no compatible. Usa EPUB, PDF, MOBI, AZW3, PRC, FB2 o CBZ.", "error");
      return;
    }

    const handler = window.BookHandlers[detected.handlerKey];
    const parsed = await handler.parse(bytes, filename);

    state.handlerKey = detected.handlerKey;
    state.handler = handler;
    state.originalFilename = filename;
    state.originalExt = restoredSession ? restoredSession.originalExt : detected.ext;
    state.originalBytes = bytes;
    state.originalResult = parsed;
    state.internalState = parsed.internalState;

    activateEditorUI(detected.handlerKey, handler, filename, state.originalExt, bytes.length, parsed);

    if (restoredSession && restoredSession.editedMeta) {
      state.newCover = restoredSession.newCover || null;
      state.customFilenameEdited = Boolean(restoredSession.customFilenameEdited);
      populateForm(restoredSession.editedMeta, state.newCover || parsed.cover);
      if (state.customFilenameEdited && restoredSession.outputFilename) {
        els.outputFilename.value = restoredSession.outputFilename;
      } else {
        els.outputFilename.value = buildTitleAuthorFilename();
      }
      setAutosaveIndicator("Sesión restaurada", false);
      showToast(`Se restauró tu libro «${filename}» con tus cambios sin perder datos.`, "success");
    } else if (pendingDraftToApply && pendingDraftToApply.originalFilename === filename) {
      state.newCover = pendingDraftToApply.newCover || null;
      state.customFilenameEdited = Boolean(pendingDraftToApply.customFilenameEdited);
      populateForm(pendingDraftToApply.editedMeta, state.newCover || parsed.cover);
      if (state.customFilenameEdited && pendingDraftToApply.outputFilename) {
        els.outputFilename.value = pendingDraftToApply.outputFilename;
      } else {
        els.outputFilename.value = buildTitleAuthorFilename();
      }
      pendingDraftToApply = null;
      await persistCurrentSessionNow();
      showToast(`Se aplicó el borrador guardado sobre «${filename}».`, "success");
    } else {
      pendingDraftToApply = null;
      state.newCover = null;
      state.customFilenameEdited = false;
      populateForm(parsed.metadata, parsed.cover);
      els.outputFilename.value = buildTitleAuthorFilename();
      await persistCurrentSessionNow();
      // Registrar y sincronizar automáticamente al subir cualquier libro nuevo en el editor
      if (window.BookStats) {
        window.BookStats.addBookFromEditor(parsed.metadata, detected.ext, parsed.cover, { silent: true });
      }
      showToast(`Libro cargado (${parsed.details}). Tus cambios se guardan automáticamente.`, "success");
    }
  }

  async function loadBookFile(file) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      await loadBookBytes(bytes, file.name, null);
    } catch (err) {
      console.error(err);
      showToast(`No se pudo leer el libro: ${err.message || err}`, "error");
    }
  }

  function buildVerificationHtml(edited, verified, finalSize) {
    const vm = verified.metadata;
    const e = BookUtils.escapeXml;
    const items = [];

    const checkField = (label, expected, actual) => {
      const exp = String(expected || "").trim();
      const act = String(actual || "").trim();
      if (!exp && !act) return;
      if (exp === act || !exp) {
        items.push(`<li><strong>${e(label)}:</strong> ${e(act || "(vacío)")}</li>`);
      } else {
        items.push(`<li><strong>${e(label)}:</strong> ${e(act || "(no admitido por el formato)")}</li>`);
      }
    };

    checkField("Título", edited.title, vm.title);
    checkField("Autor", edited.author, vm.author);
    checkField("Idioma", edited.language, vm.language);
    checkField("Editorial", edited.publisher, vm.publisher);
    checkField("Fecha", edited.date, vm.date);
    checkField("ISBN/ID", edited.identifier, vm.identifier);
    if (edited.series || vm.series) {
      const serTxt = vm.series ? (vm.seriesIndex ? `${vm.series} (#${vm.seriesIndex})` : vm.series) : "(no admitido por el formato)";
      items.push(`<li><strong>Serie:</strong> ${e(serTxt)}</li>`);
    }
    if ((edited.subjects && edited.subjects.length) || (vm.subjects && vm.subjects.length)) {
      items.push(`<li><strong>Etiquetas guardadas:</strong> ${vm.subjects.length ? e(vm.subjects.join(", ")) : "0"}</li>`);
    }
    if (edited.description || vm.description) {
      items.push(`<li><strong>Sinopsis:</strong> ${vm.description ? "Guardada (" + vm.description.length + " car.)" : "Vacía"}</li>`);
    }
    if (vm.customFields && vm.customFields.length) {
      items.push(`<li><strong>Campos personalizados:</strong> ${vm.customFields.length} guardados</li>`);
    }
    if (state.handlerKey === "mobi" && (vm.asin || vm.cdeType)) {
      items.push(`<li><strong>Kindle ASIN / Tipo:</strong> ${e(vm.asin || "(sin ASIN)")} · ${e(vm.cdeType || "original")}</li>`);
    }
    if (state.newCover) {
      items.push(`<li><strong>Portada:</strong> Actualizada (${verified.cover ? "verificada" : "incrustada"})</li>`);
    }

    let kindleStatusHtml = "";
    if (!String(vm.author || "").trim()) {
      kindleStatusHtml = `<div style="margin-top:8px;color:#925b14;"><strong>Aviso Kindle:</strong> El campo <em>Autor</em> está vacío; Kindle lo mostrará como «Autor no disponible».</div>`;
    } else if (state.handlerKey === "epub") {
      kindleStatusHtml = `<div style="margin-top:8px;"><strong>Apto para Send to Kindle:</strong> <code>dc:title</code>, <code>dc:creator</code> (<code>opf:role="aut"</code>), idioma y <code>mimetype</code> verificados.</div>`;
    } else if (state.handlerKey === "pdf") {
      kindleStatusHtml = `<div style="margin-top:8px;"><strong>Apto para Kindle (PDF):</strong> <code>/Author</code> y <code>/Title</code> guardados como texto PDF compatible + XMP.</div>`;
    } else if (state.handlerKey === "mobi") {
      kindleStatusHtml = `<div style="margin-top:8px;"><strong>Apto para Kindle (USB):</strong> <code>EXTH 100</code> (Autor), <code>EXTH 503</code> (Título) y <code>FullName</code> verificados.</div>`;
    }

    return (
      `<strong>Verificado dentro del archivo descargado (${BookUtils.formatBytes(finalSize)}):</strong>` +
      `<ul class="verify-list">${items.join("")}</ul>` +
      kindleStatusHtml
    );
  }

  async function handleSaveAndDownload() {
    if (!state.handler || !state.internalState) return;
    els.saveDownloadBtn.disabled = true;
    els.mobileSaveBtn.disabled = true;
    els.verifyBox.classList.add("hidden");

    try {
      if (!state.customFilenameEdited || !els.outputFilename.value.trim()) {
        els.outputFilename.value = buildTitleAuthorFilename();
      }
      const editedMeta = collectFormMetadata({ commitPendingTag: true });
      persistCurrentSessionNow();

      const result = await state.handler.save(state.internalState, editedMeta, state.newCover);

      // Verificación real de ida y vuelta sobre los bytes exactos que se descargarán
      const verified = await state.handler.parse(result.bytes, state.originalFilename);

      const baseName = BookUtils.sanitizeFilename(els.outputFilename.value || "libro");
      const downloadName = `${baseName}.${state.originalExt}`;
      BookUtils.triggerDownload(result.bytes, downloadName, result.mimeType);

      els.verifyBox.innerHTML = buildVerificationHtml(editedMeta, verified, result.bytes.length);
      els.verifyBox.classList.remove("hidden");

      // Sincronizar automáticamente con Biblioteca y Estadísticas al guardar
      if (window.BookStats) {
        const coverObj = state.newCover || (state.originalResult && state.originalResult.cover) || null;
        window.BookStats.addBookFromEditor(editedMeta, state.originalExt, coverObj, { silent: true });
      }

      showToast(`Metadatos verificados y libro descargado: ${downloadName}`, "success");
    } catch (err) {
      console.error(err);
      showToast(`Error al guardar el libro: ${err.message || err}`, "error");
    } finally {
      els.saveDownloadBtn.disabled = false;
      els.mobileSaveBtn.disabled = false;
    }
  }

  // Eventos de subida y Drag & Drop
  els.selectFileBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    els.fileInput.click();
  });

  els.dropzone.addEventListener("click", () => els.fileInput.click());
  els.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.fileInput.click();
    }
  });

  els.changeFileBtn.addEventListener("click", () => els.fileInput.click());

  els.fileInput.addEventListener("change", () => {
    if (els.fileInput.files && els.fileInput.files[0]) {
      loadBookFile(els.fileInput.files[0]);
      els.fileInput.value = "";
    }
  });

  ["dragenter", "dragover"].forEach((evt) => {
    els.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      els.dropzone.classList.add("drag-over");
    });
  });

  ["dragleave", "drop"].forEach((evt) => {
    els.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      els.dropzone.classList.remove("drag-over");
    });
  });

  els.dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) loadBookFile(file);
  });

  // Autoguardado al editar cualquier campo del formulario o nombre de salida
  const formInputs = [
    els.metaTitle, els.metaAuthor, els.metaAuthorSort, els.metaLanguage,
    els.metaDate, els.metaSeries, els.metaSeriesIndex, els.metaPublisher,
    els.metaIdentifier, els.metaRights, els.metaCreatorTool, els.metaProducer,
    els.metaAsin, els.metaCdeType, els.metaDescription, els.outputFilename
  ];
  for (const inputEl of formInputs) {
    const evtName = inputEl.tagName === "SELECT" ? "change" : "input";
    inputEl.addEventListener(evtName, () => {
      if (inputEl === els.metaTitle || inputEl === els.metaAuthor) {
        updateLivePreview();
      } else if (inputEl === els.outputFilename) {
        const val = els.outputFilename.value.trim();
        state.customFilenameEdited = Boolean(val) && val !== buildTitleAuthorFilename();
      }
      schedulePersist(false);
    });
  }

  els.resetBtn.addEventListener("click", () => {
    if (!state.originalResult) return;
    state.newCover = null;
    state.customFilenameEdited = false;
    populateForm(state.originalResult.metadata, state.originalResult.cover);
    els.outputFilename.value = buildTitleAuthorFilename();
    schedulePersist(true);
    showToast("Se restablecieron los metadatos originales del archivo.");
  });

  els.closeBookBtn.addEventListener("click", async () => {
    clearTimeout(persistTimer);
    if (window.BookStorage) {
      await window.BookStorage.clearSession();
    }
    state.handlerKey = null;
    state.handler = null;
    state.originalBytes = null;
    state.originalResult = null;
    state.internalState = null;
    state.newCover = null;
    state.customFilenameEdited = false;
    setCoverPreview(null);
    els.editorSection.classList.add("hidden");
    els.mobileActionBar.classList.add("hidden");
    els.uploadSection.classList.remove("hidden");
    showToast("Libro cerrado y borrador local limpiado.");
  });

  // Portada
  els.changeCoverBtn.addEventListener("click", () => els.coverInput.click());
  els.coverInput.addEventListener("change", async () => {
    const imgFile = els.coverInput.files && els.coverInput.files[0];
    if (!imgFile) return;
    try {
      const bytes = new Uint8Array(await imgFile.arrayBuffer());
      const mimeType = BookUtils.detectImageMime(bytes, imgFile.name);
      state.newCover = { bytes, mimeType };
      setCoverPreview(state.newCover);
      schedulePersist(true);
      showToast("Nueva portada cargada y guardada en borrador.", "success");
    } catch (err) {
      showToast("No se pudo cargar la imagen de portada.", "error");
    } finally {
      els.coverInput.value = "";
    }
  });

  // Etiquetas (Tags)
  els.tagsContainer.addEventListener("click", () => els.tagInput.focus());
  els.tagInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (els.tagInput.value.trim()) {
        addTagFromInput(els.tagInput.value);
        els.tagInput.value = "";
      }
    } else if (e.key === "Backspace" && !els.tagInput.value && state.subjects.length > 0) {
      state.subjects.pop();
      renderTags();
      schedulePersist(true);
    }
  });
  els.tagInput.addEventListener("blur", () => {
    if (els.tagInput.value.trim()) {
      addTagFromInput(els.tagInput.value);
      els.tagInput.value = "";
    }
  });

  // Campos personalizados
  els.addCustomFieldBtn.addEventListener("click", () => {
    state.customFields.push({ key: "", value: "" });
    renderCustomFields();
    schedulePersist(true);
  });

  // Guardar y descargar (botón escritorio + barra móvil)
  els.saveDownloadBtn.addEventListener("click", handleSaveAndDownload);
  els.mobileSaveBtn.addEventListener("click", handleSaveAndDownload);

  // Asegurar guardado antes de recargar o cerrar pestaña
  window.addEventListener("pagehide", () => {
    if (state.originalBytes) {
      persistCurrentSessionNow();
    }
  });

  // Navegación entre Editor, Biblioteca y Estadísticas
  function switchTab(tabName) {
    const valid = tabName === "library" || tabName === "stats" ? tabName : "editor";
    els.tabEditorBtn.classList.toggle("active", valid === "editor");
    els.tabLibraryBtn.classList.toggle("active", valid === "library");
    els.tabStatsBtn.classList.toggle("active", valid === "stats");

    els.editorView.classList.toggle("hidden", valid !== "editor");
    els.librarySection.classList.toggle("hidden", valid !== "library");
    els.statsSection.classList.toggle("hidden", valid !== "stats");

    if (valid !== "editor") {
      els.mobileActionBar.classList.add("hidden");
      if (window.BookStats) {
        window.BookStats.renderStatsView();
        if (window.BookStats.renderLibraryView) window.BookStats.renderLibraryView();
      }
      if (window.BookSync && window.BookSync.syncIfStale) {
        window.BookSync.syncIfStale(3000);
      }
    } else if (state.originalBytes) {
      els.mobileActionBar.classList.remove("hidden");
    }
    try { localStorage.setItem("LibrisMeta_activeTab", valid); } catch (_) {}
  }

  els.tabEditorBtn.addEventListener("click", () => switchTab("editor"));
  els.tabLibraryBtn.addEventListener("click", () => switchTab("library"));
  els.tabStatsBtn.addEventListener("click", () => switchTab("stats"));

  if (els.addToStatsBtn) {
    els.addToStatsBtn.addEventListener("click", () => {
      if (!window.BookStats) return;
      const meta = collectFormMetadata({ commitPendingTag: true });
      const coverObj = state.newCover || (state.originalResult && state.originalResult.cover) || null;
      window.BookStats.addBookFromEditor(meta, state.originalExt, coverObj);
    });
  }

  // Restaurar sesión guardada al abrir o actualizar la página
  window.addEventListener("DOMContentLoaded", async () => {
    try {
      const lastTab = localStorage.getItem("LibrisMeta_activeTab");
      if (lastTab === "stats" || lastTab === "library") switchTab(lastTab);
    } catch (_) {}

    if (window.BookStats) {
      await window.BookStats.init(showToast);
    }
    if (window.BookSync) {
      window.BookSync.init(showToast);
    }

    if (!window.BookStorage) return;
    const saved = await window.BookStorage.loadSession();
    if (!saved) return;

    if (saved.originalBytes && saved.originalFilename) {
      try {
        const bytes = saved.originalBytes instanceof Uint8Array
          ? saved.originalBytes
          : new Uint8Array(saved.originalBytes);
        await loadBookBytes(bytes, saved.originalFilename, saved);
      } catch (err) {
        console.warn("No se pudo restaurar la sesión anterior:", err);
        await window.BookStorage.clearSession();
      }
    } else if (saved.editedMeta && saved.originalFilename) {
      pendingDraftToApply = saved;
      showToast(`Hay un borrador de metadatos guardado para «${saved.originalFilename}». Selecciona ese archivo para restaurarlo.`);
    }
  });
})();

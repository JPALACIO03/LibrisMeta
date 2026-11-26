/* Cliente de autenticación y sincronización en la nube (Netlify Functions + Blobs) */

(function (global) {
  "use strict";

  const AUTH_STORAGE_KEY = "LibrisMeta_auth_v1";
  let syncTimer = null;
  let syncInFlight = false;
  let notifyFn = function () {};

  function isCloudSupported() {
    return location.protocol === "http:" || location.protocol === "https:";
  }

  function getSession() {
    try {
      const raw = localStorage.getItem(AUTH_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && parsed.token ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function saveSession(session) {
    try {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
    } catch (_) {}
  }

  function clearSession() {
    try {
      localStorage.removeItem(AUTH_STORAGE_KEY);
    } catch (_) {}
  }

  function formatTimeShort(ts) {
    if (!ts) return "nunca";
    try {
      return new Date(ts).toLocaleString("es", {
        dateStyle: "short",
        timeStyle: "short"
      });
    } catch (_) {
      return new Date(ts).toISOString();
    }
  }

  function updateAccountButton(statusText, isBusy) {
    const btn = document.getElementById("accountBtn");
    const labelEl = document.getElementById("accountBtnLabel");
    const dotEl = document.getElementById("accountStatusDot");
    const syncTextEl = document.getElementById("authLastSyncText");
    if (!btn || !labelEl || !dotEl) return;

    const sess = getSession();
    if (sess) {
      labelEl.textContent = statusText || sess.username;
      dotEl.className = "acct-dot " + (isBusy ? "dot-syncing" : "dot-online");
      if (syncTextEl) {
        syncTextEl.textContent = `Última sincronización: ${formatTimeShort(sess.lastSyncAt)}`;
      }
    } else {
      labelEl.textContent = "Cuenta / Sync";
      dotEl.className = "acct-dot dot-offline";
    }
  }

  function renderAuthModalView() {
    const loggedOutView = document.getElementById("authLoggedOutView");
    const loggedInView = document.getElementById("authLoggedInView");
    const envWarning = document.getElementById("authFileProtocolNotice");
    const userDisplay = document.getElementById("authUserDisplay");
    if (!loggedOutView || !loggedInView) return;

    if (envWarning) {
      envWarning.classList.toggle("hidden", isCloudSupported());
    }

    const sess = getSession();
    if (sess) {
      loggedOutView.classList.add("hidden");
      loggedInView.classList.remove("hidden");
      if (userDisplay) userDisplay.textContent = sess.username;
      updateAccountButton();
    } else {
      loggedInView.classList.add("hidden");
      loggedOutView.classList.remove("hidden");
      updateAccountButton();
    }
  }

  async function apiJson(path, options) {
    const res = await fetch(path, options);
    let data = {};
    try {
      data = await res.json();
    } catch (_) {}
    if (!res.ok) {
      const err = new Error(data.error || `Error del servidor (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function authenticate(mode, username, password) {
    if (!isCloudSupported()) {
      throw new Error("La sincronización requiere abrir la app en Netlify o en un servidor http://localhost.");
    }
    const endpoint = mode === "register" ? "/api/auth-register" : "/api/auth-login";
    const resp = await apiJson(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });

    saveSession({
      token: resp.token,
      username: resp.username,
      lastSyncAt: 0
    });
    renderAuthModalView();
    await syncNow(true);
    return resp;
  }

  async function syncNow(showMessage) {
    const sess = getSession();
    if (!sess || !isCloudSupported() || !global.BookStats) return false;
    if (syncInFlight) return false;

    syncInFlight = true;
    updateAccountButton("Sincronizando...", true);

    try {
      const payload = global.BookStats.getExportPayload();
      const resp = await apiJson("/api/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${sess.token}`
        },
        body: JSON.stringify(payload)
      });

      if (resp && resp.data) {
        await global.BookStats.applyMergedData(resp.data);
      }

      const freshSess = getSession();
      if (freshSess) {
        freshSess.lastSyncAt = Date.now();
        saveSession(freshSess);
      }
      updateAccountButton();
      if (showMessage) {
        notifyFn("Biblioteca y estadísticas sincronizadas con la nube.", "success");
      }
      return true;
    } catch (err) {
      if (err && err.status === 401) {
        clearSession();
        renderAuthModalView();
        notifyFn("Tu sesión expiró. Inicia sesión nuevamente para sincronizar.", "error");
      } else if (showMessage) {
        notifyFn(err.message || "No se pudo sincronizar ahora.", "error");
      } else {
        console.warn("Sync en segundo plano omitida:", err.message || err);
      }
      updateAccountButton();
      return false;
    } finally {
      syncInFlight = false;
    }
  }

  function schedulePush() {
    const sess = getSession();
    if (!sess || !isCloudSupported()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncNow(false);
    }, 650);
  }

  function logout() {
    clearTimeout(syncTimer);
    clearSession();
    renderAuthModalView();
    notifyFn("Sesión cerrada. Tus datos siguen guardados en este dispositivo.");
  }

  function init(toastFn) {
    if (typeof toastFn === "function") notifyFn = toastFn;

    const accountBtn = document.getElementById("accountBtn");
    const authModal = document.getElementById("authModal");
    const authCloseBtn = document.getElementById("authCloseBtn");
    const authForm = document.getElementById("authForm");
    const authModeLogin = document.getElementById("authModeLogin");
    const authModeRegister = document.getElementById("authModeRegister");
    const authSubmitBtn = document.getElementById("authSubmitBtn");
    const authErrorBox = document.getElementById("authErrorBox");
    const syncNowBtn = document.getElementById("syncNowBtn");
    const logoutBtn = document.getElementById("logoutBtn");

    let currentMode = "login";
    const setMode = (mode) => {
      currentMode = mode;
      if (authModeLogin) authModeLogin.classList.toggle("active", mode === "login");
      if (authModeRegister) authModeRegister.classList.toggle("active", mode === "register");
      if (authSubmitBtn) {
        authSubmitBtn.textContent = mode === "register" ? "Crear cuenta y sincronizar" : "Iniciar sesión";
      }
      if (authErrorBox) authErrorBox.classList.add("hidden");
    };

    if (authModeLogin) authModeLogin.addEventListener("click", () => setMode("login"));
    if (authModeRegister) authModeRegister.addEventListener("click", () => setMode("register"));

    if (accountBtn && authModal) {
      accountBtn.addEventListener("click", () => {
        renderAuthModalView();
        authModal.classList.remove("hidden");
      });
    }
    if (authCloseBtn && authModal) {
      authCloseBtn.addEventListener("click", () => authModal.classList.add("hidden"));
      authModal.addEventListener("click", (e) => {
        if (e.target === authModal) authModal.classList.add("hidden");
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && authModal && !authModal.classList.contains("hidden")) {
        authModal.classList.add("hidden");
      }
    });

    if (authForm) {
      authForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const userInp = document.getElementById("authUsername");
        const passInp = document.getElementById("authPassword");
        if (authErrorBox) authErrorBox.classList.add("hidden");
        if (authSubmitBtn) authSubmitBtn.disabled = true;

        try {
          await authenticate(currentMode, userInp.value, passInp.value);
          authForm.reset();
          if (authModal) authModal.classList.add("hidden");
        } catch (err) {
          if (authErrorBox) {
            authErrorBox.textContent = err.message || "Error al autenticar.";
            authErrorBox.classList.remove("hidden");
          }
        } finally {
          if (authSubmitBtn) authSubmitBtn.disabled = false;
        }
      });
    }

    if (syncNowBtn) {
      syncNowBtn.addEventListener("click", () => syncNow(true));
    }
    if (logoutBtn) {
      logoutBtn.addEventListener("click", () => {
        logout();
        if (authModal) authModal.classList.add("hidden");
      });
    }

    renderAuthModalView();
    if (getSession() && isCloudSupported()) {
      // Sincronizar automáticamente en segundo plano al abrir la app
      syncNow(false);
    }
  }

  global.BookSync = {
    init,
    getSession,
    authenticate,
    syncNow,
    schedulePush,
    logout
  };
})(window);

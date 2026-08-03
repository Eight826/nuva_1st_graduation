/**
 * Post-event certificate claim: id + name only (no PIN).
 * Verifies against ambassadors_public (public read), then downloads PDF.
 */
(() => {
  const FALLBACK_CONFIG = {
    apiKey: "AIzaSyAi5mGcvdeQE05l6G3SMqjigeaPhT9NC4o",
    authDomain: "nuva-guraduation.firebaseapp.com",
    projectId: "nuva-guraduation",
    storageBucket: "nuva-guraduation.firebasestorage.app",
    messagingSenderId: "246984553531",
    appId: "1:246984553531:web:641e436d656340d46e581e",
  };

  const config = window.firebaseConfig || FALLBACK_CONFIG;
  if (!firebase.apps.length) {
    firebase.initializeApp(config);
  }
  const db = firebase.firestore();

  const BTN_LABEL = "下載電子證書";

  const els = {
    form: document.getElementById("claim-form"),
    inputId: document.getElementById("input-id"),
    inputName: document.getElementById("input-name"),
    error: document.getElementById("claim-error"),
    ok: document.getElementById("claim-ok"),
    btn: document.getElementById("btn-download"),
  };

  function normalizeId(raw) {
    const s = String(raw ?? "").trim();
    if (!s) return "";
    if (/^\d+$/.test(s)) return String(Number(s));
    return s;
  }

  function normalizeName(raw) {
    return String(raw ?? "").trim();
  }

  function setError(message) {
    if (!els.error) return;
    if (message) {
      els.error.textContent = message;
      els.error.classList.remove("hidden");
    } else {
      els.error.textContent = "";
      els.error.classList.add("hidden");
    }
  }

  function setOk(message) {
    if (!els.ok) return;
    if (message) {
      els.ok.textContent = message;
      els.ok.classList.remove("hidden");
    } else {
      els.ok.textContent = "";
      els.ok.classList.add("hidden");
    }
  }

  async function lookupAmbassador(id, name) {
    const snap = await db.collection("ambassadors_public").doc(id).get();
    if (!snap.exists) {
      throw new Error("找不到此大使編號");
    }
    const data = snap.data() || {};
    if (normalizeName(data.name) !== name) {
      throw new Error("姓名與編號不符");
    }
    return {
      id: data.id || id,
      name: normalizeName(data.name),
    };
  }

  els.form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    setError("");
    setOk("");

    const id = normalizeId(els.inputId?.value);
    const name = normalizeName(els.inputName?.value);
    if (!id || !name) {
      setError("請填寫大使編號與姓名");
      return;
    }

    if (
      !window.NuvaCertificate ||
      typeof window.NuvaCertificate.downloadCertificate !== "function"
    ) {
      setError("證書模組尚未載入，請重新整理頁面");
      return;
    }

    els.btn.disabled = true;
    els.btn.textContent = "驗證中…";
    try {
      const ambassador = await lookupAmbassador(id, name);
      els.btn.textContent = "產生證書中…";
      await window.NuvaCertificate.downloadCertificate(ambassador.name);
      setOk(`已開始下載「${ambassador.name}」的電子證書`);
    } catch (err) {
      const msg =
        (err && err.message) ||
        "無法領取證書，請確認編號與姓名後再試";
      setError(msg);
    } finally {
      els.btn.disabled = false;
      els.btn.textContent = BTN_LABEL;
    }
  });
})();

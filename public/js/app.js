(() => {
  const ROLE_TAG = {
    大力士: { bg: "#1E2A4A", fg: "#7FA8F5" },
    品味家: { bg: "#1B3B2A", fg: "#6FCB9F" },
    判斷家: { bg: "#3B2E1B", fg: "#E0B36F" },
    工作人員: { bg: "#2A2A2A", fg: "#A3A3A3" },
  };

  /** Keep in sync with `.card-3d.is-spinning` animation duration in index.html */
  const SPIN_MS = 2400;
  const FLIP_DELAY_MS = 120;

  const FALLBACK_CONFIG = {
    apiKey: "AIzaSyAi5mGcvdeQE05l6G3SMqjigeaPhT9NC4o",
    authDomain: "nuva-guraduation.firebaseapp.com",
    projectId: "nuva-guraduation",
    storageBucket: "nuva-guraduation.firebasestorage.app",
    messagingSenderId: "246984553531",
    appId: "1:246984553531:web:641e436d656340d46e581e",
    measurementId: "G-HCY9C04TZ8",
  };

  const config = window.firebaseConfig || FALLBACK_CONFIG;
  firebase.initializeApp(config);

  // Match Cloud Functions region (asia-east1)
  const functions = firebase.app().functions("asia-east1");
  const verifyCheckin = functions.httpsCallable("verifyCheckin");
  const drawRole = functions.httpsCallable("drawRole");
  const createPuzzleSession = functions.httpsCallable("createPuzzleSession");

  const PUZZLE_SESSION_KEY = "nuva_puzzle_session";

  const els = {
    stepVerify: document.getElementById("step-verify"),
    stepDraw: document.getElementById("step-draw"),
    stepResult: document.getElementById("step-result"),
    form: document.getElementById("verify-form"),
    inputId: document.getElementById("input-id"),
    inputName: document.getElementById("input-name"),
    inputPin: document.getElementById("input-pin"),
    verifyError: document.getElementById("verify-error"),
    btnVerify: document.getElementById("btn-verify"),
    drawIdentity: document.getElementById("draw-identity"),
    drawError: document.getElementById("draw-error"),
    btnDraw: document.getElementById("btn-draw"),
    resultCard: document.getElementById("result-card"),
    resultFrontLabel: document.getElementById("result-front-label"),
    resultRole: document.getElementById("result-role"),
    resultTag: document.getElementById("result-tag"),
    resultName: document.getElementById("result-name"),
    resultId: document.getElementById("result-id"),
    resultNote: document.getElementById("result-note"),
    certError: document.getElementById("cert-error"),
    btnDownloadCert: document.getElementById("btn-download-cert"),
    btnPuzzle: document.getElementById("btn-puzzle"),
    btnReset: document.getElementById("btn-reset"),
  };

  /** @type {{ id: string, name: string, pin: string } | null} */
  let session = null;
  /** @type {string} */
  let resultName = "";
  const CERT_BTN_LABEL = "下載電子證書";

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function prefersReducedMotion() {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function showStep(step) {
    els.stepVerify.classList.toggle("hidden", step !== "verify");
    els.stepDraw.classList.toggle("hidden", step !== "draw");
    els.stepResult.classList.toggle("hidden", step !== "result");
  }

  function setError(el, message) {
    if (!message) {
      el.classList.add("hidden");
      el.textContent = "";
      return;
    }
    el.textContent = message;
    el.classList.remove("hidden");
  }

  function friendlyError(err) {
    const code = (err && err.code) || "";
    const msg = (err && err.message) || "發生未知錯誤";
    // Firebase callable wraps as functions/xxx
    const clean = msg.replace(/^.*?:\s*/, "");
    if (code.includes("not-found")) return clean || "找不到資料";
    if (code.includes("permission-denied")) return clean || "驗證失敗";
    if (code.includes("failed-precondition")) return clean || "目前無法繼續";
    if (code.includes("resource-exhausted")) return clean || "名額已滿";
    if (code.includes("invalid-argument")) return clean || "請檢查輸入內容";
    return clean || msg;
  }

  function applyRoleTag(role) {
    const style = ROLE_TAG[role] || { bg: "#1E2A4A", fg: "#7FA8F5" };
    els.resultTag.textContent = role;
    els.resultTag.style.background = style.bg;
    els.resultTag.style.color = style.fg;
  }

  function resetCardMotion() {
    els.resultCard.classList.remove("is-flipped", "is-revealing", "is-spinning");
  }

  function fillResult({ id, name, role }) {
    resultName = name || "";
    els.resultRole.textContent = role || "—";
    applyRoleTag(role || "");
    els.resultName.textContent = name || "";
    els.resultId.textContent = id ? `編號 ${id}` : "";
  }

  function setCertError(message) {
    if (!els.certError) return;
    setError(els.certError, message);
  }

  function setCertButtonVisible(visible) {
    if (!els.btnDownloadCert) return;
    els.btnDownloadCert.classList.toggle("hidden", !visible);
    if (!visible) {
      els.btnDownloadCert.disabled = false;
      els.btnDownloadCert.textContent = CERT_BTN_LABEL;
    }
  }

  function retriggerRolePop() {
    els.resultRole.classList.remove("role-pop");
    els.resultTag.classList.remove("role-pop");
    void els.resultRole.offsetWidth;
    els.resultRole.classList.add("role-pop");
    els.resultTag.classList.add("role-pop");
  }

  function setResultChrome({
    frontLabel,
    note,
    resetVisible,
    puzzleVisible,
    certVisible,
  }) {
    if (els.resultFrontLabel) {
      els.resultFrontLabel.textContent = frontLabel;
    }
    els.resultNote.textContent = note || "";
    els.btnReset.classList.toggle("hidden", !resetVisible);
    if (els.btnPuzzle) {
      els.btnPuzzle.classList.toggle("hidden", !puzzleVisible);
    }
    if (typeof certVisible === "boolean") {
      setCertButtonVisible(certVisible);
    }
  }

  async function preparePuzzleSession(creds, profile) {
    if (!els.btnPuzzle) return;
    const isStaff = !!(
      profile &&
      (profile.is_staff === true ||
        profile.preview === true ||
        profile.role === "工作人員")
    );
    if (!profile || (!profile.is_drawn && !isStaff)) {
      els.btnPuzzle.classList.add("hidden");
      return;
    }

    // Show immediately — don't wait on createPuzzleSession (cold start / errors).
    els.btnPuzzle.classList.remove("hidden");
    els.btnPuzzle.textContent = isStaff ? "前往解謎預覽" : "前往組隊／解謎";

    try {
      const { data } = await createPuzzleSession(creds);
      localStorage.setItem(
        PUZZLE_SESSION_KEY,
        JSON.stringify({
          token: data.token,
          expires_at: data.expires_at,
          id: data.id || profile.id,
          name: data.name || profile.name,
          role: data.role || profile.role,
          is_staff: data.is_staff === true || isStaff,
          preview: data.preview === true || isStaff,
        })
      );
      if (data.is_staff || data.preview || isStaff) {
        els.btnPuzzle.textContent = "前往解謎預覽";
      }
    } catch (err) {
      // Link still works; join/auth gate can re-issue a session.
      console.warn("createPuzzleSession", err);
    }
  }

  function beginSpinCard({ id, name }) {
    resetCardMotion();
    // Keep the back face mysterious while the card spins past it.
    els.resultRole.textContent = "？";
    els.resultTag.textContent = "???";
    els.resultTag.style.background = "#1E2A4A";
    els.resultTag.style.color = "#7FA8F5";
    els.resultName.textContent = name || "";
    els.resultId.textContent = id ? `編號 ${id}` : "";
    setCertError("");
    setResultChrome({
      frontLabel: "抽取中…",
      note: "卡片旋轉中，正在抽取你的身分…",
      resetVisible: false,
      puzzleVisible: false,
      certVisible: false,
    });
    showStep("result");
    if (!prefersReducedMotion()) {
      void els.resultCard.offsetWidth;
      els.resultCard.classList.add("is-spinning");
    }
  }

  /** Quick flip for already-drawn lookups (no lottery spin). */
  function showResult({ id, name, role, is_staff }, note) {
    const staff = is_staff === true || role === "工作人員";
    fillResult({ id, name, role });
    resetCardMotion();
    retriggerRolePop();
    setCertError("");
    setResultChrome({
      frontLabel: "翻開中…",
      note: note || "",
      resetVisible: true,
      puzzleVisible: true,
      certVisible: true,
    });
    if (els.btnPuzzle) {
      els.btnPuzzle.textContent = staff ? "前往解謎預覽" : "前往組隊／解謎";
    }
    showStep("result");
    requestAnimationFrame(() => {
      els.resultCard.classList.add("is-revealing");
      setTimeout(() => els.resultCard.classList.add("is-flipped"), FLIP_DELAY_MS);
    });
    if (session) {
      preparePuzzleSession(session, {
        id,
        name,
        role,
        is_drawn: true,
        is_staff: staff,
      });
    }
  }

  /**
   * Wait for the spin animation (and API), then flip to reveal the role.
   * @param {{ id: string, name: string, role: string, is_staff?: boolean }} payload
   * @param {string} note
   * @param {number} startedAt
   */
  async function finishSpinReveal(payload, note, startedAt) {
    if (prefersReducedMotion()) {
      resetCardMotion();
      fillResult(payload);
      retriggerRolePop();
      setCertError("");
      setResultChrome({
        frontLabel: "翻開中…",
        note: note || "",
        resetVisible: true,
        puzzleVisible: false,
        certVisible: true,
      });
      els.resultCard.classList.add("is-flipped");
      if (session) {
        await preparePuzzleSession(session, { ...payload, is_drawn: true });
      }
      return;
    }

    const remain = Math.max(0, SPIN_MS - (Date.now() - startedAt));
    if (remain > 0) await sleep(remain);

    els.resultCard.classList.remove("is-spinning");
    fillResult(payload);
    retriggerRolePop();
    setCertError("");
    setResultChrome({
      frontLabel: "翻開中…",
      note: note || "",
      resetVisible: true,
      puzzleVisible: false,
      certVisible: true,
    });
    void els.resultCard.offsetWidth;
    els.resultCard.classList.add("is-revealing");
    await sleep(FLIP_DELAY_MS);
    els.resultCard.classList.add("is-flipped");
    if (session) {
      await preparePuzzleSession(session, { ...payload, is_drawn: true });
    }
  }

  function credentialsFromForm() {
    return {
      id: els.inputId.value.trim(),
      name: els.inputName.value.trim(),
      pin: els.inputPin.value.trim(),
    };
  }

  els.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setError(els.verifyError, "");
    const creds = credentialsFromForm();
    els.btnVerify.disabled = true;
    els.btnVerify.textContent = "驗證中…";

    try {
      const { data } = await verifyCheckin(creds);
      session = creds;

      if (data.status === "already_drawn") {
        showResult(data, "你已完成抽取，以下為先前結果");
        return;
      }

      if (data.status === "ready_to_draw") {
        els.drawIdentity.textContent = `${data.name}（編號 ${data.id}）`;
        setError(els.drawError, "");
        showStep("draw");
        return;
      }

      setError(els.verifyError, "無法辨識驗證結果，請稍後再試");
    } catch (err) {
      setError(els.verifyError, friendlyError(err));
    } finally {
      els.btnVerify.disabled = false;
      els.btnVerify.textContent = "進入驗證";
    }
  });

  els.btnDraw.addEventListener("click", async () => {
    if (!session) {
      showStep("verify");
      return;
    }
    setError(els.drawError, "");
    els.btnDraw.disabled = true;
    els.btnDraw.textContent = "抽取中…";

    const startedAt = Date.now();
    beginSpinCard(session);

    try {
      const { data } = await drawRole(session);
      const note =
        data.status === "already_drawn"
          ? "你已完成抽取，以下為先前結果"
          : "請妥善記住你的遊戲身分";
      await finishSpinReveal(data, note, startedAt);
    } catch (err) {
      resetCardMotion();
      showStep("draw");
      setError(els.drawError, friendlyError(err));
    } finally {
      els.btnDraw.disabled = false;
      els.btnDraw.textContent = "抽取我的遊戲身分";
    }
  });

  if (els.btnDownloadCert) {
    els.btnDownloadCert.addEventListener("click", async () => {
      const name = resultName || (session && session.name) || "";
      if (!name) {
        setCertError("缺少姓名，無法產生證書");
        return;
      }
      if (
        !window.NuvaCertificate ||
        typeof window.NuvaCertificate.downloadCertificate !== "function"
      ) {
        setCertError("證書模組尚未就緒，請重新整理頁面");
        return;
      }

      setCertError("");
      els.btnDownloadCert.disabled = true;
      els.btnDownloadCert.textContent = "產生中…";
      try {
        await window.NuvaCertificate.downloadCertificate(name);
      } catch (err) {
        console.warn("downloadCertificate", err);
        const msg =
          (err && err.message) || "證書產生失敗，請稍後再試";
        setCertError(msg.replace(/^.*?:\s*/, "") || msg);
      } finally {
        els.btnDownloadCert.disabled = false;
        els.btnDownloadCert.textContent = CERT_BTN_LABEL;
      }
    });
  }

  els.btnReset.addEventListener("click", () => {
    session = null;
    resultName = "";
    resetCardMotion();
    setError(els.verifyError, "");
    setError(els.drawError, "");
    setCertError("");
    setResultChrome({
      frontLabel: "翻開中…",
      note: "",
      resetVisible: true,
      puzzleVisible: false,
      certVisible: false,
    });
    showStep("verify");
  });
})();

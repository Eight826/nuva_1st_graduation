(() => {
  const ROLE_TAG = {
    大力士: { bg: "#1E2A4A", fg: "#7FA8F5" },
    品味家: { bg: "#1B3B2A", fg: "#6FCB9F" },
    判斷家: { bg: "#3B2E1B", fg: "#E0B36F" },
  };

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
    resultRole: document.getElementById("result-role"),
    resultTag: document.getElementById("result-tag"),
    resultName: document.getElementById("result-name"),
    resultId: document.getElementById("result-id"),
    resultNote: document.getElementById("result-note"),
    btnReset: document.getElementById("btn-reset"),
  };

  /** @type {{ id: string, name: string, pin: string } | null} */
  let session = null;

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

  function showResult({ id, name, role }, note) {
    els.resultRole.textContent = role || "—";
    applyRoleTag(role || "");
    els.resultName.textContent = name || "";
    els.resultId.textContent = id ? `編號 ${id}` : "";
    els.resultNote.textContent = note || "";
    els.resultCard.classList.remove("is-flipped", "is-revealing");
    // re-trigger role pop animation
    els.resultRole.classList.remove("role-pop");
    els.resultTag.classList.remove("role-pop");
    void els.resultRole.offsetWidth;
    els.resultRole.classList.add("role-pop");
    els.resultTag.classList.add("role-pop");
    showStep("result");
    requestAnimationFrame(() => {
      els.resultCard.classList.add("is-revealing");
      setTimeout(() => els.resultCard.classList.add("is-flipped"), 280);
    });
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

    try {
      const { data } = await drawRole(session);
      showResult(
        data,
        data.status === "already_drawn"
          ? "你已完成抽取，以下為先前結果"
          : "請妥善記住你的遊戲身分"
      );
    } catch (err) {
      setError(els.drawError, friendlyError(err));
    } finally {
      els.btnDraw.disabled = false;
      els.btnDraw.textContent = "抽取我的遊戲身分";
    }
  });

  els.btnReset.addEventListener("click", () => {
    session = null;
    els.resultCard.classList.remove("is-flipped");
    setError(els.verifyError, "");
    setError(els.drawError, "");
    showStep("verify");
  });
})();

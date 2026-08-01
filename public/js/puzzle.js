/**
 * Shared puzzle session + navigation helpers for join / act pages.
 */
(() => {
  const STORAGE_KEY = "nuva_puzzle_session";
  const ACT_ORDER = [
    "lobby",
    "opening",
    "act1",
    "act2",
    "act3",
    "act4",
    "waiting",
    "finale",
  ];
  const ACT_PAGE = {
    lobby: "join.html",
    opening: "opening.html",
    act1: "act1.html",
    act2: "act2.html",
    act3: "act3.html",
    act4: "act4.html",
    waiting: "waiting.html",
    finale: "finale.html",
  };
  const ACT_LABEL = {
    lobby: "組隊大廳",
    opening: "開場",
    act1: "第一幕",
    act2: "第二幕",
    act3: "第三幕",
    act4: "第四幕",
    waiting: "等待終場",
    finale: "終場",
  };

  /** Narrative progress bar steps (excludes lobby). */
  const PROGRESS_STEPS = [
    "opening",
    "act1",
    "act2",
    "act3",
    "act4",
    "waiting",
    "finale",
  ];
  const PROGRESS_SHORT = ["開", "一", "二", "三", "四", "等", "終"];

  function ensureProgressStyles() {
    if (document.getElementById("act-progress-styles")) return;
    const style = document.createElement("style");
    style.id = "act-progress-styles";
    style.textContent = `
      .act-progress {
        display: flex;
        gap: 0.35rem;
        width: 100%;
        max-width: 17rem;
        margin-left: auto;
        margin-right: auto;
      }
      .act-progress-seg {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.25rem;
        padding: 0;
        margin: 0;
        border: 0;
        background: transparent;
        appearance: none;
        -webkit-appearance: none;
        cursor: default;
        color: inherit;
        font: inherit;
      }
      .act-progress-bar {
        display: block;
        width: 100%;
        height: 5px;
        border-radius: 1px;
        background: #2a2a2a;
        transition: background 0.25s ease, box-shadow 0.25s ease, transform 0.25s ease;
      }
      .act-progress-seg.is-on .act-progress-bar {
        background: #3b6fe8;
      }
      .act-progress-label {
        font-size: 10px;
        line-height: 1;
        color: #6b6b6b;
        transition: color 0.25s ease;
      }
      .act-progress-seg.is-on .act-progress-label {
        color: #e8e8e8;
      }
      .act-progress-seg.is-current .act-progress-bar {
        background: #5b8cff;
        box-shadow:
          0 0 6px 1px rgba(59, 111, 232, 0.95),
          0 0 14px 3px rgba(59, 111, 232, 0.55),
          0 0 22px 6px rgba(59, 111, 232, 0.28);
        animation: actProgressGlow 1.8s ease-in-out infinite;
      }
      .act-progress-seg.is-current .act-progress-label {
        color: #fff;
        text-shadow: 0 0 8px rgba(59, 111, 232, 0.8);
      }
      .act-progress-seg.is-clickable {
        cursor: pointer;
      }
      .act-progress-seg.is-clickable:hover .act-progress-bar {
        filter: brightness(1.25);
        transform: scaleY(1.35);
      }
      .act-progress-seg.is-clickable:focus-visible {
        outline: 1px solid #3b6fe8;
        outline-offset: 2px;
      }
      @keyframes actProgressGlow {
        0%, 100% {
          box-shadow:
            0 0 5px 1px rgba(59, 111, 232, 0.75),
            0 0 12px 2px rgba(59, 111, 232, 0.4),
            0 0 18px 4px rgba(59, 111, 232, 0.2);
        }
        50% {
          box-shadow:
            0 0 8px 2px rgba(91, 140, 255, 1),
            0 0 18px 5px rgba(59, 111, 232, 0.65),
            0 0 28px 8px rgba(59, 111, 232, 0.35);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .act-progress-seg.is-current .act-progress-bar {
          animation: none;
        }
      }
    `;
    document.head.appendChild(style);
  }

  /** @type {((act: string) => void) | null} */
  let progressNavigateFn = null;

  function setProgressNavigate(fn) {
    progressNavigateFn = typeof fn === "function" ? fn : null;
  }

  function ensureProgressDom() {
    const root = document.getElementById("act-progress");
    if (!root) return null;
    ensureProgressStyles();
    if (root.dataset.ready === "1") return root;
    root.classList.add("act-progress");
    root.setAttribute("role", "navigation");
    root.setAttribute("aria-label", "幕進度");
    root.innerHTML = PROGRESS_SHORT.map(
      (label, i) =>
        `<button type="button" class="act-progress-seg" data-step="${i}" data-act="${PROGRESS_STEPS[i]}" disabled aria-label="${ACT_LABEL[PROGRESS_STEPS[i]] || label}">` +
        `<span class="act-progress-bar"></span>` +
        `<span class="act-progress-label">${label}</span>` +
        `</button>`
    ).join("");
    root.addEventListener("click", (e) => {
      const seg = e.target.closest(".act-progress-seg");
      if (!seg || !root.contains(seg)) return;
      if (!seg.classList.contains("is-clickable")) return;
      const act = seg.getAttribute("data-act");
      if (!act || !progressNavigateFn) return;
      progressNavigateFn(act);
    });
    root.dataset.ready = "1";
    return root;
  }

  /**
   * @param {{
   *   groupAct?: string|null,
   *   pageAct?: string|null,
   *   openingUnlocked?: boolean,
   *   preview?: boolean,
   * }} [opts]
   */
  function renderActProgress(opts) {
    // Backward compat: renderActProgress("act1")
    if (typeof opts === "string" || opts == null) {
      opts = { groupAct: opts || null, pageAct: opts || null };
    }
    const root = ensureProgressDom();
    if (!root) return;

    const preview = !!opts.preview;
    const pageAct = opts.pageAct || null;
    let groupAct = opts.groupAct || null;
    if (groupAct === "lobby") groupAct = opts.openingUnlocked ? "opening" : null;

    const progressIdx = preview
      ? PROGRESS_STEPS.indexOf(pageAct)
      : PROGRESS_STEPS.indexOf(groupAct);
    const pageIdx = PROGRESS_STEPS.indexOf(pageAct);
    const openingUnlocked = preview ? true : opts.openingUnlocked === true;
    const effectiveGroup =
      groupAct === "lobby" && openingUnlocked ? "opening" : groupAct || "lobby";

    const label =
      pageIdx >= 0
        ? `目前：${ACT_LABEL[pageAct] || pageAct}`
        : progressIdx >= 0
          ? `組進度：${ACT_LABEL[groupAct] || groupAct}`
          : "組進度：尚未開始";
    root.setAttribute("aria-label", label);

    root.querySelectorAll(".act-progress-seg").forEach((el) => {
      const step = Number(el.getAttribute("data-step"));
      const act = el.getAttribute("data-act");
      const on = progressIdx >= 0 && step <= progressIdx;
      const current = pageIdx >= 0 && step === pageIdx;
      const reachable =
        preview ||
        (openingUnlocked &&
          act &&
          canViewAct(act, effectiveGroup, openingUnlocked));
      const clickable = !!(reachable && act && act !== pageAct);

      el.classList.toggle("is-on", on || current);
      el.classList.toggle("is-current", current);
      el.classList.toggle("is-clickable", clickable);
      el.disabled = !clickable;
      el.setAttribute("aria-current", current ? "step" : "false");
    });
  }

  const FALLBACK_CONFIG = {
    apiKey: "AIzaSyAi5mGcvdeQE05l6G3SMqjigeaPhT9NC4o",
    authDomain: "nuva-guraduation.firebaseapp.com",
    projectId: "nuva-guraduation",
    storageBucket: "nuva-guraduation.firebasestorage.app",
    messagingSenderId: "246984553531",
    appId: "1:246984553531:web:641e436d656340d46e581e",
    measurementId: "G-HCY9C04TZ8",
  };

  function ensureFirebase() {
    if (!firebase.apps.length) {
      firebase.initializeApp(window.firebaseConfig || FALLBACK_CONFIG);
    }
    return {
      functions: firebase.app().functions("asia-east1"),
      db: firebase.firestore(),
    };
  }

  function loadStoredSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.token) return null;
      if (data.expires_at && Number(data.expires_at) < Date.now()) {
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  function saveSession(payload) {
    const next = {
      token: payload.token,
      expires_at: payload.expires_at || null,
      id: payload.id || "",
      name: payload.name || "",
      role: payload.role || "",
      is_staff: payload.is_staff === true || payload.preview === true,
      preview: payload.preview === true || payload.is_staff === true,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function friendlyError(err) {
    const msg = (err && err.message) || "發生未知錯誤";
    return msg.replace(/^.*?:\s*/, "");
  }

  function actIndex(act) {
    const i = ACT_ORDER.indexOf(act);
    return i < 0 ? 0 : i;
  }

  function pageForAct(act) {
    return ACT_PAGE[act] || "join.html";
  }

  /**
   * @param {string} pageAct - which act this HTML page represents (lobby for join)
   * @param {string} currentAct - group's currentAct
   * @param {boolean} openingUnlocked
   */
  function canViewAct(pageAct, currentAct, openingUnlocked) {
    if (pageAct === "lobby") return true;
    if (!openingUnlocked) return false;
    // After unlock, lobby→opening is allowed even if still "lobby"
    const effective = currentAct === "lobby" ? "opening" : currentAct;
    return actIndex(pageAct) <= actIndex(effective);
  }

  function shouldFollow(pageAct, currentAct, openingUnlocked) {
    if (!openingUnlocked) return false;
    const effective = currentAct === "lobby" ? "opening" : currentAct;
    return actIndex(effective) > actIndex(pageAct) && pageAct !== "lobby";
  }

  function ensurePreviewStyles() {
    if (document.getElementById("staff-preview-styles")) return;
    const style = document.createElement("style");
    style.id = "staff-preview-styles";
    style.textContent = `
      .staff-preview-badge {
        display: inline-block;
        margin-top: 0.35rem;
        font-size: 10px;
        letter-spacing: 0.08em;
        color: #e8c547;
      }
      .staff-preview-nav {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
        justify-content: center;
        margin-top: 1.5rem;
        padding-top: 1rem;
        border-top: 1px solid #2a2a2a;
      }
      .staff-preview-nav a {
        border: 1px solid #2a2a2a;
        background: #1f1f1f;
        color: #a3a3a3;
        font-size: 11px;
        padding: 0.35rem 0.55rem;
        text-decoration: none;
      }
      .staff-preview-nav a.is-current {
        border-color: #3b6fe8;
        color: #fff;
        background: rgba(59, 111, 232, 0.2);
      }
      .staff-preview-nav a:hover {
        border-color: #3b6fe8;
        color: #fff;
      }
    `;
    document.head.appendChild(style);
  }

  const PREVIEW_NAV = [
    { act: "lobby", href: "./join.html", label: "首頁" },
    { act: "opening", href: "./opening.html", label: "開" },
    { act: "act1", href: "./act1.html", label: "一" },
    { act: "act2", href: "./act2.html", label: "二" },
    { act: "act3", href: "./act3.html", label: "三" },
    { act: "act4", href: "./act4.html", label: "四" },
    { act: "waiting", href: "./waiting.html", label: "等" },
    { act: "finale", href: "./finale.html", label: "終" },
  ];

  function mountPreviewNav(pageAct) {
    ensurePreviewStyles();
    let nav = document.getElementById("staff-preview-nav");
    if (!nav) {
      nav = document.createElement("nav");
      nav.id = "staff-preview-nav";
      nav.className = "staff-preview-nav";
      nav.setAttribute("aria-label", "工作人員預覽導覽");
      const host =
        document.getElementById("puzzle-main") ||
        document.querySelector("main") ||
        document.body;
      host.appendChild(nav);
    }
    nav.innerHTML = PREVIEW_NAV.map((item) => {
      const current = item.act === pageAct ? " is-current" : "";
      return `<a class="${current.trim()}" href="${item.href}">${item.label}</a>`;
    }).join("");
  }

  function ensurePreviewBadge() {
    ensurePreviewStyles();
    let badge = document.getElementById("staff-preview-badge");
    if (badge) return badge;
    const progress = document.getElementById("act-progress");
    badge = document.createElement("p");
    badge.id = "staff-preview-badge";
    badge.className = "staff-preview-badge";
    badge.textContent = "預覽";
    if (progress && progress.parentNode) {
      progress.insertAdjacentElement("afterend", badge);
    } else {
      const header = document.querySelector("header");
      if (header) header.appendChild(badge);
    }
    return badge;
  }

  function syncActProgress(state, pageAct) {
    const preview = isPreviewState(state);
    if (preview) {
      ensurePreviewBadge();
    } else {
      const badge = document.getElementById("staff-preview-badge");
      if (badge) badge.remove();
    }
    const step = pageAct === "lobby" ? null : pageAct;
    renderActProgress({
      groupAct: preview ? step : state && state.group && state.group.currentAct,
      pageAct: step,
      openingUnlocked: preview ? true : !!(state && state.openingUnlocked),
      preview,
    });
  }

  /**
   * Hide write actions for staff preview (read-only).
   */
  function applyStaffPreviewChrome(pageAct) {
    mountPreviewNav(pageAct);
    const follow = document.getElementById("follow-banner");
    if (follow) follow.classList.add("hidden");

    // Never leave write controls disabled/hidden on the shared DOM after preview.
    // (join.html re-shows panels; ensure the join button itself is usable.)
    const hideIds = [
      "btn-next",
      "btn-leave",
      "btn-enter",
      "btn-accuse",
      "accuse-form",
      "join-panel",
      "group-panel",
      "panel-taste",
      "panel-judge",
      "panel-strong",
    ];
    hideIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.add("hidden");
    });
    const btnJoin = document.getElementById("btn-join");
    if (btnJoin) {
      // Hide with panel; do not leave a stray disabled state for later.
      btnJoin.classList.add("hidden");
      btnJoin.disabled = false;
      btnJoin.textContent = "加入小組";
    }

    document.querySelectorAll("[data-preview-hide]").forEach((el) => {
      el.classList.add("hidden");
    });

    let notice = document.getElementById("staff-preview-notice");
    if (!notice) {
      notice = document.createElement("p");
      notice.id = "staff-preview-notice";
      notice.className = "mt-4 text-center text-xs text-[#E8C547]";
      notice.textContent = "工作人員預覽（唯讀）— 無法入組或推進進度";
      const main = document.getElementById("puzzle-main");
      if (main) {
        const headerSibling = main.querySelector("article, .space-y-4, form, .border");
        if (headerSibling) main.insertBefore(notice, headerSibling);
        else main.prepend(notice);
      }
    }
  }

  function isPreviewState(state) {
    return !!(state && (state.preview === true || state.is_staff === true));
  }

  window.NuvaPuzzle = {
    STORAGE_KEY,
    ACT_ORDER,
    ACT_PAGE,
    ACT_LABEL,
    PROGRESS_STEPS,
    PROGRESS_SHORT,
    ensureFirebase,
    loadStoredSession,
    saveSession,
    clearSession,
    friendlyError,
    actIndex,
    pageForAct,
    canViewAct,
    shouldFollow,
    renderActProgress,
    setProgressNavigate,
    isPreviewState,
    applyStaffPreviewChrome,
    syncActProgress,
    mountPreviewNav,

    async createSessionFromCreds(creds) {
      const { functions } = ensureFirebase();
      const createPuzzleSession = functions.httpsCallable("createPuzzleSession");
      const { data } = await createPuzzleSession(creds);
      return saveSession(data);
    },

    async getState(authPayload) {
      const { functions } = ensureFirebase();
      const getPuzzleState = functions.httpsCallable("getPuzzleState");
      const { data } = await getPuzzleState(authPayload);
      if (data.token) {
        saveSession({
          token: data.token,
          expires_at: data.expires_at,
          id: data.id,
          name: data.name,
          role: data.role,
          is_staff: data.is_staff,
          preview: data.preview,
        });
      }
      return data;
    },

    authPayload() {
      const stored = loadStoredSession();
      if (stored && stored.token) return { token: stored.token };
      return null;
    },

    /**
     * Bootstrap a puzzle page: restore token or show gate form.
     * @param {{ pageAct: string, onReady: Function, gateEls?: object }} opts
     */
    async bootPage(opts) {
      const { pageAct, onReady } = opts;
      const { functions, db } = ensureFirebase();
      const callables = {
        getPuzzleState: functions.httpsCallable("getPuzzleState"),
        joinGroup: functions.httpsCallable("joinGroup"),
        leaveGroup: functions.httpsCallable("leaveGroup"),
        advanceAct: functions.httpsCallable("advanceAct"),
        submitAct2Answer: functions.httpsCallable("submitAct2Answer"),
        submitAct4Accusation: functions.httpsCallable("submitAct4Accusation"),
        createPuzzleSession: functions.httpsCallable("createPuzzleSession"),
        verifyCheckin: functions.httpsCallable("verifyCheckin"),
      };

      let state = null;
      let unsub = null;
      let followBanner = null;

      function setFollowBanner(show, targetAct) {
        if (!followBanner) {
          followBanner = document.getElementById("follow-banner");
        }
        if (!followBanner) return;
        if (!show) {
          followBanner.classList.add("hidden");
          return;
        }
        const label = ACT_LABEL[targetAct] || targetAct;
        followBanner.querySelector("[data-follow-label]").textContent =
          `組已前往${label}`;
        followBanner.dataset.target = targetAct;
        followBanner.classList.remove("hidden");
      }

      async function refresh(auth) {
        const { data } = await callables.getPuzzleState(auth);
        if (data.token) {
          saveSession({
            token: data.token,
            expires_at: data.expires_at,
            id: data.id,
            name: data.name,
            role: data.role,
            is_staff: data.is_staff,
            preview: data.preview,
          });
        }
        state = data;
        return data;
      }

      function watchGroup(groupId) {
        if (unsub) {
          unsub();
          unsub = null;
        }
        if (!groupId) return;
        unsub = db
          .collection("groups")
          .doc(groupId)
          .onSnapshot((snap) => {
            if (!snap.exists || !state) return;
            const g = snap.data() || {};
            state.group = {
              id: groupId,
              code: g.code || "",
              members: g.members || [],
              slots: g.slots || {},
              currentAct: g.currentAct || "lobby",
              act2: g.act2 || {},
              act4: g.act4 || { solved: false, rank: null },
              memberCount: (g.members || []).length,
            };
            const current = state.group.currentAct;
            const effective =
              current === "lobby" && state.openingUnlocked ? "opening" : current;
            if (shouldFollow(pageAct, current, state.openingUnlocked)) {
              setFollowBanner(true, effective);
            } else {
              setFollowBanner(false);
            }
            syncActProgress(state, pageAct);
            if (typeof opts.onGroupUpdate === "function") {
              opts.onGroupUpdate(state);
            }
          });
      }

      function navigateToAct(act) {
        const page = pageForAct(act === "lobby" ? "lobby" : act);
        window.location.href = `./${page}`;
      }
      setProgressNavigate(navigateToAct);

      async function ensureAccess() {
        let auth = window.NuvaPuzzle.authPayload();
        if (!auth) {
          return { needLogin: true };
        }
        try {
          const data = await refresh(auth);
          auth = { token: loadStoredSession().token };

          if (isPreviewState(data)) {
            return { state: data, auth, callables, navigateToAct, refresh, setFollowBanner };
          }

          if (pageAct !== "lobby" && !data.group_id) {
            window.location.replace("./join.html");
            return { redirected: true };
          }
          if (pageAct !== "lobby" && !data.openingUnlocked) {
            window.location.replace("./join.html");
            return { redirected: true };
          }
          if (
            pageAct !== "lobby" &&
            data.group &&
            !canViewAct(pageAct, data.group.currentAct, data.openingUnlocked)
          ) {
            const cur =
              data.group.currentAct === "lobby" && data.openingUnlocked
                ? "opening"
                : data.group.currentAct || "lobby";
            window.location.replace(`./${pageForAct(cur)}`);
            return { redirected: true };
          }

          watchGroup(data.group_id);
          return { state: data, auth, callables, navigateToAct, refresh, setFollowBanner };
        } catch (err) {
          clearSession();
          return { needLogin: true, error: friendlyError(err) };
        }
      }

      const access = await ensureAccess();
      if (access.redirected) return access;

      if (access.needLogin) {
        const gate = document.getElementById("auth-gate");
        const main = document.getElementById("puzzle-main");
        if (gate) gate.classList.remove("hidden");
        if (main) main.classList.add("hidden");

        const form = document.getElementById("auth-form");
        if (form) {
          form.addEventListener("submit", async (e) => {
            e.preventDefault();
            const errEl = document.getElementById("auth-error");
            const btn = document.getElementById("btn-auth");
            const creds = {
              id: document.getElementById("auth-id").value.trim(),
              name: document.getElementById("auth-name").value.trim(),
              pin: document.getElementById("auth-pin").value.trim(),
            };
            if (errEl) {
              errEl.classList.add("hidden");
              errEl.textContent = "";
            }
            if (btn) {
              btn.disabled = true;
              btn.textContent = "驗證中…";
            }
            try {
              const verify = await callables.verifyCheckin(creds);
              if (verify.data.status !== "already_drawn") {
                throw new Error("請先完成角色抽取");
              }
              const session = await callables.createPuzzleSession(creds);
              saveSession({
                ...session.data,
                id: verify.data.id,
                name: verify.data.name,
                role: verify.data.role,
                is_staff: verify.data.is_staff || session.data.is_staff,
                preview: session.data.preview || verify.data.is_staff,
              });
              window.location.reload();
            } catch (err) {
              if (errEl) {
                errEl.textContent = friendlyError(err);
                errEl.classList.remove("hidden");
              }
            } finally {
              if (btn) {
                btn.disabled = false;
                btn.textContent = "進入解謎";
              }
            }
          });
        }
        return access;
      }

      const gate = document.getElementById("auth-gate");
      const main = document.getElementById("puzzle-main");
      if (gate) gate.classList.add("hidden");
      if (main) main.classList.remove("hidden");

      const followBtn = document.querySelector("[data-follow-go]");
      if (followBtn) {
        followBtn.addEventListener("click", () => {
          const target =
            (followBanner && followBanner.dataset.target) ||
            (state && state.group && state.group.currentAct) ||
            "opening";
          navigateToAct(target === "lobby" ? "opening" : target);
        });
      }

      if (access.state) {
        syncActProgress(access.state, pageAct);
        if (isPreviewState(access.state)) {
          applyStaffPreviewChrome(pageAct);
        }
      }

      if (typeof onReady === "function") {
        await onReady({
          state: access.state,
          auth: access.auth,
          callables,
          navigateToAct,
          refresh: async () => {
            const data = await refresh(access.auth);
            access.auth = { token: loadStoredSession().token };
            if (!isPreviewState(data)) {
              watchGroup(data.group_id);
            }
            syncActProgress(data, pageAct);
            if (isPreviewState(data)) {
              applyStaffPreviewChrome(pageAct);
            }
            return data;
          },
          setFollowBanner,
          logout() {
            clearSession();
            window.location.href = "./join.html";
          },
        });
      }
      return access;
    },
  };
})();

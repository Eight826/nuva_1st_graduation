(() => {
  const ROLE_ORDER = ["大力士", "品味家", "判斷家", "工作人員"];
  const ROLE_COLORS = {
    大力士: "#7FA8F5",
    品味家: "#6FCB9F",
    判斷家: "#E0B36F",
    工作人員: "#A3A3A3",
  };

  const config = window.firebaseConfig;
  if (!config) {
    document.body.innerHTML = "<p style='color:#fff;padding:2rem'>缺少 Firebase 設定</p>";
    return;
  }

  firebase.initializeApp(config);
  const auth = firebase.auth();
  const db = firebase.firestore();
  const functions = firebase.app().functions("asia-east1");
  const ensureAdminClaim = functions.httpsCallable("ensureAdminClaim");
  const resetAmbassador = functions.httpsCallable("resetAmbassador");
  const adjustRolePool = functions.httpsCallable("adjustRolePool");
  const exportRoster = functions.httpsCallable("exportRoster");
  const exportFinalRoster = functions.httpsCallable("exportFinalRoster");
  const getKillerAssignment = functions.httpsCallable("getKillerAssignment");
  const setKiller = functions.httpsCallable("setKiller");
  const initPuzzleGroups = functions.httpsCallable("initPuzzleGroups");
  const unlockOpening = functions.httpsCallable("unlockOpening");
  const unlockFinale = functions.httpsCallable("unlockFinale");
  const listPuzzleGroups = functions.httpsCallable("listPuzzleGroups");
  const passAct2Role = functions.httpsCallable("passAct2Role");
  const designateSilencersAndUnlockAct4 = functions.httpsCallable(
    "designateSilencersAndUnlockAct4"
  );
  const adminMoveMember = functions.httpsCallable("adminMoveMember");

  const ACT_LABEL = {
    lobby: "組隊",
    opening: "開場",
    act1: "第一幕",
    act2: "第二幕",
    act3: "第三幕",
    act4: "第四幕",
    waiting: "等待終場",
    finale: "終場",
  };

  const views = {
    login: document.getElementById("view-login"),
    denied: document.getElementById("view-denied"),
    dashboard: document.getElementById("view-dashboard"),
  };

  const els = {
    loginForm: document.getElementById("login-form"),
    loginEmail: document.getElementById("login-email"),
    loginPassword: document.getElementById("login-password"),
    loginError: document.getElementById("login-error"),
    btnLogin: document.getElementById("btn-login"),
    deniedMsg: document.getElementById("denied-msg"),
    btnDeniedLogout: document.getElementById("btn-denied-logout"),
    btnLogout: document.getElementById("btn-logout"),
    adminEmail: document.getElementById("admin-email"),
    liveBadge: document.getElementById("live-badge"),
    statTotal: document.getElementById("stat-total"),
    statAttending: document.getElementById("stat-attending"),
    statAbsent: document.getElementById("stat-absent"),
    statDrawn: document.getElementById("stat-drawn"),
    statPending: document.getElementById("stat-pending"),
    statKiller: document.getElementById("stat-killer"),
    roleStats: document.getElementById("role-stats"),
    tableBody: document.getElementById("table-body"),
    tableEmpty: document.getElementById("table-empty"),
    tableFilter: document.getElementById("table-filter"),
    restoreForm: document.getElementById("restore-form"),
    restoreId: document.getElementById("restore-id"),
    restoreMsg: document.getElementById("restore-msg"),
    btnRestore: document.getElementById("btn-restore"),
    poolForm: document.getElementById("pool-form"),
    poolStrong: document.getElementById("pool-strong"),
    poolTaste: document.getElementById("pool-taste"),
    poolJudge: document.getElementById("pool-judge"),
    poolKiller: document.getElementById("pool-killer"),
    poolSyncInitial: document.getElementById("pool-sync-initial"),
    poolMsg: document.getElementById("pool-msg"),
    btnPoolSave: document.getElementById("btn-pool-save"),
    btnExportRoster: document.getElementById("btn-export-roster"),
    btnExportFinal: document.getElementById("btn-export-final"),
    exportMsg: document.getElementById("export-msg"),
    opsMsg: document.getElementById("ops-msg"),
    modalFinal: document.getElementById("modal-final"),
    btnFinalCancel: document.getElementById("btn-final-cancel"),
    btnFinalConfirm: document.getElementById("btn-final-confirm"),
    modalPin: document.getElementById("modal-pin"),
    pinModalBody: document.getElementById("pin-modal-body"),
    pinModalPin: document.getElementById("pin-modal-pin"),
    btnPinCopy: document.getElementById("btn-pin-copy"),
    btnPinClose: document.getElementById("btn-pin-close"),
    killerModeBadge: document.getElementById("killer-mode-badge"),
    killerCurrent: document.getElementById("killer-current"),
    killerForm: document.getElementById("killer-form"),
    killerSelect: document.getElementById("killer-select"),
    btnKillerSet: document.getElementById("btn-killer-set"),
    btnKillerClear: document.getElementById("btn-killer-clear"),
    killerMsg: document.getElementById("killer-msg"),
    puzzleUnlockBadge: document.getElementById("puzzle-unlock-badge"),
    puzzleAct4Badge: document.getElementById("puzzle-act4-badge"),
    puzzleFinaleBadge: document.getElementById("puzzle-finale-badge"),
    puzzleSilencers: document.getElementById("puzzle-silencers"),
    puzzleMsg: document.getElementById("puzzle-msg"),
    btnInitGroups: document.getElementById("btn-init-groups"),
    btnResetGroups: document.getElementById("btn-reset-groups"),
    btnUnlockOpening: document.getElementById("btn-unlock-opening"),
    btnLockOpening: document.getElementById("btn-lock-opening"),
    btnUnlockFinale: document.getElementById("btn-unlock-finale"),
    btnLockFinale: document.getElementById("btn-lock-finale"),
    silencerGroup: document.getElementById("silencer-group"),
    btnDesignateSilencers: document.getElementById("btn-designate-silencers"),
    btnRefreshGroups: document.getElementById("btn-refresh-groups"),
    groupsBody: document.getElementById("groups-body"),
    groupsEmpty: document.getElementById("groups-empty"),
    moveForm: document.getElementById("move-form"),
    moveId: document.getElementById("move-id"),
    moveGroup: document.getElementById("move-group"),
    btnMove: document.getElementById("btn-move"),
    btnRemoveMember: document.getElementById("btn-remove-member"),
  };

  /** @type {Array<Record<string, any>>} */
  let ambassadors = [];
  /** @type {Record<string, any> | null} */
  let systemConfig = null;
  /** @type {Array<Record<string, any>>} */
  let puzzleGroups = [];
  let openingUnlocked = false;
  let act4Unlocked = false;
  let finaleUnlocked = false;
  let silencers = [];
  let unsubPublic = null;
  let unsubConfig = null;
  let unsubGroups = null;
  let latestPin = "";
  /** @type {"all"|"drawn"|"pending"} */
  let statusFilter = "all";
  /** @type {"all"|"attending"|"absent"} */
  let attendanceFilter = "all";
  /** @type {{ id: string, name: string } | null} */
  let currentKiller = null;

  function isAttending(a) {
    return a && a.is_attending !== false;
  }

  function isStaff(a) {
    return !!(a && a.is_staff === true);
  }

  function showView(name) {
    Object.entries(views).forEach(([key, el]) => {
      el.classList.toggle("hidden", key !== name);
    });
  }

  const TAB_IDS = ["checkin", "ambassadors", "puzzle"];
  const TAB_HASH = {
    checkin: "checkin",
    ambassadors: "ambassadors",
    puzzle: "puzzle",
  };
  const HASH_TO_TAB = {
    checkin: "checkin",
    ambassadors: "ambassadors",
    puzzle: "puzzle",
  };

  /** @type {"checkin"|"ambassadors"|"puzzle"} */
  let activeTab = "checkin";

  function tabFromHash() {
    const raw = (location.hash || "").replace(/^#/, "").trim().toLowerCase();
    return HASH_TO_TAB[raw] || "checkin";
  }

  /**
   * @param {"checkin"|"ambassadors"|"puzzle"} tab
   * @param {{ syncHash?: boolean, scroll?: boolean }} [opts]
   */
  function setActiveTab(tab, opts = {}) {
    const next = TAB_IDS.includes(tab) ? tab : "checkin";
    const syncHash = opts.syncHash !== false;
    const scroll = opts.scroll !== false;
    activeTab = next;

    document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
      const on = panel.getAttribute("data-tab-panel") === next;
      panel.classList.toggle("hidden", !on);
      if (on) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
    });

    document.querySelectorAll(".admin-tab").forEach((btn) => {
      const on = btn.getAttribute("data-tab") === next;
      btn.setAttribute("aria-selected", on ? "true" : "false");
      btn.classList.toggle("border-brand", on);
      btn.classList.toggle("text-white", on);
      btn.classList.toggle("font-medium", on);
      btn.classList.toggle("border-transparent", !on);
      btn.classList.toggle("text-mute", !on);
    });

    if (syncHash) {
      const desired = `#${TAB_HASH[next]}`;
      if (location.hash !== desired) {
        history.replaceState(null, "", desired);
      }
    }

    if (scroll) {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
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

  function setMsg(el, message, ok = true) {
    if (!message) {
      el.classList.add("hidden");
      el.textContent = "";
      return;
    }
    el.textContent = message;
    el.className = `mb-2 text-sm ${ok ? "text-brand" : "text-red-400"}`;
    if (el === els.exportMsg || el === els.opsMsg) {
      el.className = `mt-3 text-sm ${ok ? "text-brand" : "text-red-400"}`;
      if (el === els.opsMsg) el.className = `mt-4 text-sm ${ok ? "text-brand" : "text-red-400"}`;
    }
    el.classList.remove("hidden");
  }

  function friendlyError(err) {
    const msg = (err && err.message) || "發生未知錯誤";
    return msg.replace(/^.*?:\s*/, "");
  }

  function formatTime(ts) {
    if (!ts) return "—";
    const date = ts.toDate ? ts.toDate() : new Date(ts);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString("zh-TW", { hour12: false });
  }

  function numericIdSort(a, b) {
    const na = Number(a.id);
    const nb = Number(b.id);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return String(a.id).localeCompare(String(b.id), "zh-Hant");
  }

  function fillPoolForm(force = false) {
    if (
      !force &&
      document.activeElement &&
      els.poolForm.contains(document.activeElement)
    ) {
      return;
    }
    const remaining =
      (systemConfig && systemConfig.role_pool && systemConfig.role_pool.remaining) || {};
    els.poolStrong.value = remaining["大力士"] ?? "";
    els.poolTaste.value = remaining["品味家"] ?? "";
    els.poolJudge.value = remaining["判斷家"] ?? "";
    els.poolKiller.value =
      systemConfig && systemConfig.killer ? systemConfig.killer.remaining ?? "" : "";
  }

  function renderStats() {
    const total = ambassadors.length;
    const attendingList = ambassadors.filter(isAttending);
    const attending = attendingList.length;
    const staffList = ambassadors.filter(isStaff);
    const drawnList = ambassadors.filter((a) => a.is_drawn && !isStaff(a));
    const drawn = drawnList.length;
    // Pending draws only count physical attendees who can still draw (non-staff).
    const pendingAttending = attendingList.filter(
      (a) => !a.is_drawn && !isStaff(a)
    ).length;
    els.statTotal.textContent = String(total);
    if (els.statAttending) els.statAttending.textContent = String(attending);
    if (els.statAbsent) els.statAbsent.textContent = String(total - attending);
    els.statDrawn.textContent = String(drawn);
    els.statPending.textContent = String(pendingAttending);

    const killerRemaining =
      systemConfig && systemConfig.killer ? systemConfig.killer.remaining : null;
    els.statKiller.textContent =
      killerRemaining === null || killerRemaining === undefined ? "—" : String(killerRemaining);

    const drawnByRole = {};
    for (const a of [...drawnList, ...staffList]) {
      const role = a.role || (isStaff(a) ? "工作人員" : "未命名");
      drawnByRole[role] = (drawnByRole[role] || 0) + 1;
    }

    const remaining =
      (systemConfig && systemConfig.role_pool && systemConfig.role_pool.remaining) || {};
    const initial =
      (systemConfig && systemConfig.role_pool && systemConfig.role_pool.initial) || {};

    const roles = Array.from(
      new Set([...ROLE_ORDER, ...Object.keys(drawnByRole), ...Object.keys(remaining)])
    );

    els.roleStats.innerHTML = roles
      .map((role) => {
        const got = drawnByRole[role] || 0;
        const left = role === "工作人員" ? 0 : Number(remaining[role] ?? 0);
        const init =
          role === "工作人員"
            ? got
            : Number(initial[role] ?? got + left);
        const pct = init > 0 ? Math.min(100, Math.round((got / init) * 100)) : 0;
        const color = ROLE_COLORS[role] || "#3B6FE8";
        return `
          <div>
            <div class="mb-1.5 flex items-center justify-between text-sm">
              <span style="color:${color}">${role}</span>
              <span class="text-xs text-mute">已分發 ${got} · 庫存 ${left} · 初始 ${init || "—"}</span>
            </div>
            <div class="stat-bar"><span style="width:${pct}%;background:${color}"></span></div>
          </div>`;
      })
      .join("");
  }

  function renderTable() {
    const q = (els.tableFilter.value || "").trim().toLowerCase();
    const rows = ambassadors
      .filter((a) => {
        if (statusFilter === "drawn" && !a.is_drawn) return false;
        if (statusFilter === "pending" && a.is_drawn) return false;
        if (attendanceFilter === "attending" && !isAttending(a)) return false;
        if (attendanceFilter === "absent" && isAttending(a)) return false;
        if (!q) return true;
        return (
          String(a.id).toLowerCase().includes(q) ||
          String(a.name || "").toLowerCase().includes(q) ||
          String(a.role || "").toLowerCase().includes(q)
        );
      })
      .slice()
      .sort(numericIdSort);

    els.tableEmpty.classList.toggle("hidden", rows.length > 0);
    els.tableBody.innerHTML = rows
      .map((a) => {
        const attending = isAttending(a);
        const staff = isStaff(a);
        const attendance = attending
          ? '<span class="text-brand">出席</span>'
          : '<span class="text-mute">未出席</span>';
        const status = staff
          ? '<span class="text-mute">工作人員</span>'
          : a.is_drawn
            ? '<span class="text-brand">已抽取</span>'
            : attending
              ? '<span class="text-mute">未抽取</span>'
              : '<span class="text-mute">不可抽籤</span>';
        const roleLabel = a.is_drawn || staff ? a.role || (staff ? "工作人員" : "—") : "—";
        const actionCell = staff
          ? '<span class="text-xs text-mute">固定身分</span>'
          : a.is_drawn
            ? `<button
                type="button"
                data-reset-id="${a.id}"
                data-reset-name="${a.name || ""}"
                class="btn-reset border border-brand/50 px-2 py-1 text-xs text-brand hover:bg-brand/10"
              >恢復未抽取</button>`
            : '<span class="text-xs text-mute">—</span>';
        return `
          <tr class="hover:bg-panel/60">
            <td class="px-4 py-3 font-mono text-xs">${a.id}</td>
            <td class="px-4 py-3">${a.name || ""}</td>
            <td class="px-4 py-3">${attendance}</td>
            <td class="px-4 py-3">${roleLabel}</td>
            <td class="px-4 py-3">${status}</td>
            <td class="px-4 py-3 text-xs text-mute">${formatTime(a.drawn_at)}</td>
            <td class="px-4 py-3">${actionCell}</td>
          </tr>`;
      })
      .join("");
  }

  async function restoreAmbassadorById(id, nameHint = "") {
    const person = ambassadors.find((a) => String(a.id) === String(id));
    const name = nameHint || (person && person.name) || id;
    if (person && isStaff(person)) {
      throw new Error("工作人員為固定身分，無法重置");
    }
    const appearsDrawn = person
      ? person.is_drawn === true || !!(person.role && String(person.role).trim())
      : true;
    if (person && !appearsDrawn) {
      throw new Error("此大使目前已是未抽取狀態");
    }
    if (
      !window.confirm(
        `確定將「${name}」（${id}）恢復為未抽取？\n只會清除職位／兇手並歸還庫存，PIN 不會更換。`
      )
    ) {
      return null;
    }

    // Force-refresh auth token so admin custom claim is present on the callable.
    const user = auth.currentUser;
    if (!user) throw new Error("尚未登入");
    await user.getIdToken(true);

    const { data } = await resetAmbassador({ id: String(id).trim() });
    if (!data || !data.ok) {
      throw new Error("重置未成功，請再試一次");
    }
    return data;
  }

  function fillKillerSelect() {
    if (!els.killerSelect) return;
    const selected = els.killerSelect.value;
    const attending = ambassadors
      .filter((a) => isAttending(a) && !isStaff(a))
      .slice()
      .sort(numericIdSort);
    const options = [
      '<option value="">請選擇…</option>',
      ...attending.map(
        (a) =>
          `<option value="${a.id}">${a.id}　${a.name || ""}${
            a.is_drawn ? `（${a.role || "已抽"}）` : "（未抽）"
          }</option>`
      ),
    ];
    els.killerSelect.innerHTML = options.join("");
    if (selected && attending.some((a) => String(a.id) === String(selected))) {
      els.killerSelect.value = selected;
    } else if (currentKiller && currentKiller.id) {
      els.killerSelect.value = String(currentKiller.id);
    }
  }

  async function refreshKillerAssignment() {
    if (!els.killerCurrent) return;
    try {
      const user = auth.currentUser;
      if (!user) return;
      await user.getIdToken(true);
      const { data } = await getKillerAssignment({});
      const modeLabel = data.mode === "manual" ? "手動指定" : "抽籤隨機";
      if (els.killerModeBadge) {
        els.killerModeBadge.textContent = `模式：${modeLabel}`;
        els.killerModeBadge.classList.toggle("text-red-300", data.mode === "manual");
      }
      if (data.killers && data.killers.length) {
        currentKiller = data.killers[0];
        els.killerCurrent.textContent = `目前犯人：${currentKiller.name}（編號 ${currentKiller.id}）`;
        els.killerCurrent.classList.remove("text-mute");
        els.killerCurrent.classList.add("text-red-300");
      } else {
        currentKiller = null;
        els.killerCurrent.textContent = "目前犯人：尚未指定";
        els.killerCurrent.classList.add("text-mute");
        els.killerCurrent.classList.remove("text-red-300");
      }
      fillKillerSelect();
    } catch (err) {
      els.killerCurrent.textContent = `目前犯人：讀取失敗（${friendlyError(err)}）`;
      els.killerCurrent.classList.add("text-mute");
    }
  }

  function refreshUi() {
    renderStats();
    renderTable();
    fillKillerSelect();
    if (systemConfig && systemConfig.puzzle) {
      openingUnlocked = systemConfig.puzzle.openingUnlocked === true;
      if (els.puzzleUnlockBadge) {
        els.puzzleUnlockBadge.textContent = openingUnlocked
          ? "開場：已解鎖"
          : "開場：未解鎖";
        els.puzzleUnlockBadge.className = openingUnlocked
          ? "text-xs text-brand"
          : "text-xs text-mute";
      }
    }
  }

  function renderGroups() {
    if (!els.groupsBody) return;
    const rows = puzzleGroups.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    els.groupsEmpty.classList.toggle("hidden", rows.length > 0);

    if (els.moveGroup) {
      const current = els.moveGroup.value;
      els.moveGroup.innerHTML =
        '<option value="">選擇 G01–G15</option>' +
        rows.map((g) => `<option value="${g.id}">${g.id}（${g.code}）</option>`).join("");
      els.moveGroup.value = current;
    }

    if (els.silencerGroup) {
      const current = els.silencerGroup.value;
      els.silencerGroup.innerHTML =
        '<option value="">選擇組別</option>' +
        rows
          .map((g) => {
            const n = (g.members || []).length;
            return `<option value="${g.id}">${g.id}（${g.code} · ${n}/4）</option>`;
          })
          .join("");
      els.silencerGroup.value = current;
    }

    els.groupsBody.innerHTML = rows
      .map((g) => {
        const act2 = g.act2 || {};
        const lights = ["品味家", "判斷家", "大力士"]
          .map((r) => {
            const ok = !!act2[r];
            return `<span class="${ok ? "text-brand" : "text-mute"}">${r.slice(0, 1)}${
              ok ? "✓" : "·"
            }</span>`;
          })
          .join(" ");
        const members = (g.members || [])
          .map((m) => `${m.name || m.id}(${m.role})`)
          .join("、") || "—";
        const rank =
          g.act4 && g.act4.rank != null ? ` · #${g.act4.rank}` : "";
        const passBtns = ["品味家", "判斷家", "大力士"]
          .map((r) => {
            const ok = !!act2[r];
            const short = r === "品味家" ? "品味" : r === "判斷家" ? "判斷" : "大力";
            return `<button
                type="button"
                data-pass-group="${g.id}"
                data-pass-role="${r}"
                class="border border-line px-2 py-1 text-xs ${
                  ok ? "text-mute" : "text-brand hover:border-brand"
                }"
                ${ok ? "disabled" : ""}
              >${ok ? `${short}已過` : `${short}通過`}</button>`;
          })
          .join("");
        return `
          <tr class="hover:bg-ink/40">
            <td class="px-3 py-2 font-mono text-xs">${g.id}</td>
            <td class="px-3 py-2 font-mono tracking-widest text-brand">${g.code || ""}</td>
            <td class="px-3 py-2">${(g.members || []).length}/4</td>
            <td class="px-3 py-2 text-xs text-mute max-w-[220px]">${members}</td>
            <td class="px-3 py-2">${ACT_LABEL[g.currentAct] || g.currentAct || "—"}${rank}</td>
            <td class="px-3 py-2 text-xs">${lights}</td>
            <td class="px-3 py-2">
              <div class="flex flex-wrap gap-1">${passBtns}</div>
            </td>
          </tr>`;
      })
      .join("");
  }

  async function refreshPuzzleGroups() {
    if (!els.groupsBody) return;
    try {
      const { data } = await listPuzzleGroups({});
      puzzleGroups = data.groups || [];
      openingUnlocked = !!data.openingUnlocked;
      act4Unlocked = !!data.act4Unlocked;
      finaleUnlocked = !!data.finaleUnlocked;
      silencers = Array.isArray(data.silencers) ? data.silencers : [];
      if (els.puzzleUnlockBadge) {
        els.puzzleUnlockBadge.textContent = openingUnlocked
          ? "開場：已解鎖"
          : "開場：未解鎖";
      }
      if (els.puzzleAct4Badge) {
        els.puzzleAct4Badge.textContent = act4Unlocked
          ? "第四幕：已解鎖"
          : "第四幕：未解鎖";
      }
      if (els.puzzleFinaleBadge) {
        els.puzzleFinaleBadge.textContent = finaleUnlocked
          ? "終場：已解鎖"
          : "終場：未解鎖";
      }
      if (els.puzzleSilencers) {
        els.puzzleSilencers.textContent = silencers.length
          ? `封口者：${silencers.join("、")}`
          : "封口者：尚未指定";
      }
      renderGroups();
    } catch (err) {
      setMsg(els.puzzleMsg, friendlyError(err), false);
    }
  }

  function stopListeners() {
    if (unsubPublic) {
      unsubPublic();
      unsubPublic = null;
    }
    if (unsubConfig) {
      unsubConfig();
      unsubConfig = null;
    }
    if (unsubGroups) {
      unsubGroups();
      unsubGroups = null;
    }
  }

  function startListeners() {
    stopListeners();
    els.liveBadge.textContent = "即時更新中";
    els.liveBadge.classList.add("text-brand");

    unsubPublic = db.collection("ambassadors_public").onSnapshot(
      (snap) => {
        // Prefer document id over any field named `id` inside the payload.
        ambassadors = snap.docs.map((doc) => ({ ...doc.data(), id: doc.id }));
        refreshUi();
      },
      (err) => {
        console.error(err);
        els.liveBadge.textContent = "大使資料連線失敗";
        els.liveBadge.classList.remove("text-brand");
      }
    );

    unsubConfig = db
      .collection("system_config")
      .doc("main")
      .onSnapshot(
        (doc) => {
          systemConfig = doc.exists ? doc.data() : null;
          fillPoolForm();
          refreshUi();
        },
        (err) => {
          console.error(err);
          els.liveBadge.textContent = "系統設定讀取失敗（需 admin claim）";
          els.liveBadge.classList.remove("text-brand");
        }
      );

    unsubGroups = db.collection("groups").onSnapshot(
      (snap) => {
        puzzleGroups = snap.docs.map((doc) => {
          const d = doc.data() || {};
          return {
            id: doc.id,
            code: d.code || "",
            members: d.members || [],
            slots: d.slots || {},
            currentAct: d.currentAct || "lobby",
            act2: d.act2 || {},
            memberCount: (d.members || []).length,
          };
        });
        renderGroups();
      },
      (err) => {
        console.error(err);
        setMsg(els.puzzleMsg, "小組即時更新失敗：" + friendlyError(err), false);
      }
    );
  }

  async function promoteIfAllowed(user) {
    const token = await user.getIdTokenResult();
    if (token.claims.admin === true) return true;

    try {
      await ensureAdminClaim({});
      await user.getIdToken(true);
      const refreshed = await user.getIdTokenResult();
      return refreshed.claims.admin === true;
    } catch (err) {
      const msg = (err && err.message) || "無法取得管理員權限";
      els.deniedMsg.textContent = msg.replace(/^.*?:\s*/, "");
      return false;
    }
  }

  async function enterAdmin(user) {
    const ok = await promoteIfAllowed(user);
    if (!ok) {
      stopListeners();
      showView("denied");
      return;
    }
    els.adminEmail.textContent = user.email || "";
    els.adminEmail.classList.remove("hidden");
    showView("dashboard");
    setActiveTab(tabFromHash(), { syncHash: true, scroll: false });
    startListeners();
    refreshKillerAssignment();
    refreshPuzzleGroups();
  }

  function downloadCsv(filename, csv) {
    const blob = new Blob(["\uFEFF" + csv + "\n"], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function openModal(el) {
    el.classList.remove("hidden");
    el.classList.add("flex");
  }

  function closeModal(el) {
    el.classList.add("hidden");
    el.classList.remove("flex");
  }

  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      stopListeners();
      showView("login");
      return;
    }
    await enterAdmin(user);
  });

  els.loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    setError(els.loginError, "");
    els.btnLogin.disabled = true;
    els.btnLogin.textContent = "登入中…";
    try {
      await auth.signInWithEmailAndPassword(
        els.loginEmail.value.trim(),
        els.loginPassword.value
      );
    } catch (err) {
      const code = err && err.code;
      let msg = "登入失敗";
      if (code === "auth/invalid-credential" || code === "auth/wrong-password") {
        msg = "Email 或密碼錯誤";
      } else if (code === "auth/user-not-found") {
        msg = "找不到此帳號";
      } else if (code === "auth/too-many-requests") {
        msg = "嘗試次數過多，請稍後再試";
      } else if (err && err.message) {
        msg = err.message;
      }
      setError(els.loginError, msg);
    } finally {
      els.btnLogin.disabled = false;
      els.btnLogin.textContent = "登入";
    }
  });

  function logout() {
    stopListeners();
    auth.signOut();
  }

  els.btnLogout.addEventListener("click", logout);
  els.btnDeniedLogout.addEventListener("click", logout);
  els.tableFilter.addEventListener("input", renderTable);

  document.querySelectorAll(".admin-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab") || "checkin";
      setActiveTab(tab, { syncHash: true, scroll: true });
    });
  });

  window.addEventListener("hashchange", () => {
    if (views.dashboard.classList.contains("hidden")) return;
    setActiveTab(tabFromHash(), { syncHash: false, scroll: true });
  });

  els.tableBody.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-reset-id]");
    if (!btn) return;
    const id = btn.getAttribute("data-reset-id");
    const name = btn.getAttribute("data-reset-name") || "";
    btn.disabled = true;
    try {
      const data = await restoreAmbassadorById(id, name);
      if (data) {
        const roleNote = data.restored_role
          ? `（已歸還 ${data.restored_role}${data.restored_killer ? "／兇手名額" : ""}）`
          : "";
        setMsg(els.opsMsg, `已將 ${data.name} 恢復為未抽取${roleNote}`, true);
      }
    } catch (err) {
      setMsg(els.opsMsg, friendlyError(err), false);
    } finally {
      btn.disabled = false;
    }
  });

  els.restoreForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = els.restoreId.value.trim();
    if (!id) return;
    els.btnRestore.disabled = true;
    try {
      const data = await restoreAmbassadorById(id);
      if (data) {
        const roleNote = data.restored_role
          ? `（已歸還 ${data.restored_role}${data.restored_killer ? "／兇手名額" : ""}）`
          : "";
        setMsg(els.restoreMsg, `已將 ${data.name}（${data.id}）恢復為未抽取${roleNote}`, true);
        els.restoreId.value = "";
      }
    } catch (err) {
      setMsg(els.restoreMsg, friendlyError(err), false);
    } finally {
      els.btnRestore.disabled = false;
    }
  });

  function styleChipGroup(selector, activeEl) {
    document.querySelectorAll(selector).forEach((c) => {
      const active = c === activeEl;
      c.classList.toggle("border-brand", active);
      c.classList.toggle("bg-brand/20", active);
      c.classList.toggle("text-white", active);
      c.classList.toggle("border-line", !active);
      c.classList.toggle("text-mute", !active);
    });
  }

  document.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      statusFilter = chip.getAttribute("data-filter") || "all";
      styleChipGroup(".filter-chip", chip);
      renderTable();
    });
  });

  document.querySelectorAll(".attendance-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      attendanceFilter = chip.getAttribute("data-attendance") || "all";
      styleChipGroup(".attendance-chip", chip);
      renderTable();
    });
  });

  if (els.killerForm) {
    els.killerForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = (els.killerSelect.value || "").trim();
      if (!id) return;
      const person = ambassadors.find((a) => String(a.id) === String(id));
      const name = (person && person.name) || id;
      if (
        !window.confirm(
          `確定將「${name}」（${id}）指定為犯人（兇手）？\n此資訊高度機密，請勿在遊戲進行中外流。`
        )
      ) {
        return;
      }
      els.btnKillerSet.disabled = true;
      try {
        const user = auth.currentUser;
        if (!user) throw new Error("尚未登入");
        await user.getIdToken(true);
        const { data } = await setKiller({ id, is_killer: true });
        setMsg(
          els.killerMsg,
          `已指定 ${data.name}（${data.id}）為犯人；抽籤改為手動模式`,
          true
        );
        await refreshKillerAssignment();
      } catch (err) {
        setMsg(els.killerMsg, friendlyError(err), false);
      } finally {
        els.btnKillerSet.disabled = false;
      }
    });
  }

  if (els.btnKillerClear) {
    els.btnKillerClear.addEventListener("click", async () => {
      const id = (els.killerSelect.value || (currentKiller && currentKiller.id) || "").trim();
      if (!id) {
        setMsg(els.killerMsg, "請先選擇要清除的大使，或先指定一位犯人", false);
        return;
      }
      const person = ambassadors.find((a) => String(a.id) === String(id));
      const name = (person && person.name) || (currentKiller && currentKiller.name) || id;
      if (!window.confirm(`確定清除「${name}」（${id}）的犯人指定？`)) return;
      els.btnKillerClear.disabled = true;
      try {
        const user = auth.currentUser;
        if (!user) throw new Error("尚未登入");
        await user.getIdToken(true);
        const { data } = await setKiller({ id, is_killer: false });
        setMsg(els.killerMsg, `已清除 ${data.name}（${data.id}）的犯人指定`, true);
        await refreshKillerAssignment();
      } catch (err) {
        setMsg(els.killerMsg, friendlyError(err), false);
      } finally {
        els.btnKillerClear.disabled = false;
      }
    });
  }

  els.poolForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    els.btnPoolSave.disabled = true;
    try {
      const { data } = await adjustRolePool({
        remaining: {
          大力士: Number(els.poolStrong.value),
          品味家: Number(els.poolTaste.value),
          判斷家: Number(els.poolJudge.value),
        },
        killer_remaining: Number(els.poolKiller.value),
        sync_initial: !!els.poolSyncInitial.checked,
      });
      setMsg(els.poolMsg, `角色池已更新（合計 ${Object.values(data.remaining).reduce((a, b) => a + b, 0)}）`, true);
    } catch (err) {
      setMsg(els.poolMsg, friendlyError(err), false);
    } finally {
      els.btnPoolSave.disabled = false;
    }
  });

  els.btnExportRoster.addEventListener("click", async () => {
    els.btnExportRoster.disabled = true;
    try {
      const { data } = await exportRoster({});
      downloadCsv(data.filename, data.csv);
      setMsg(els.exportMsg, `已匯出一般名單（${data.count} 筆，不含兇手）`, true);
    } catch (err) {
      setMsg(els.exportMsg, friendlyError(err), false);
    } finally {
      els.btnExportRoster.disabled = false;
    }
  });

  els.btnExportFinal.addEventListener("click", () => openModal(els.modalFinal));
  els.btnFinalCancel.addEventListener("click", () => closeModal(els.modalFinal));
  els.btnFinalConfirm.addEventListener("click", async () => {
    els.btnFinalConfirm.disabled = true;
    try {
      const { data } = await exportFinalRoster({ confirm: true });
      downloadCsv(data.filename, data.csv);
      closeModal(els.modalFinal);
      setMsg(els.exportMsg, `已匯出完整結局名單（${data.count} 筆，含兇手）`, true);
    } catch (err) {
      setMsg(els.exportMsg, friendlyError(err), false);
    } finally {
      els.btnFinalConfirm.disabled = false;
    }
  });

  els.btnPinClose.addEventListener("click", () => closeModal(els.modalPin));
  els.btnPinCopy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(latestPin);
      els.btnPinCopy.textContent = "已複製";
      setTimeout(() => {
        els.btnPinCopy.textContent = "複製 PIN";
      }, 1200);
    } catch (_) {
      els.btnPinCopy.textContent = "複製失敗";
    }
  });

  if (els.btnInitGroups) {
    els.btnInitGroups.addEventListener("click", async () => {
      els.btnInitGroups.disabled = true;
      try {
        const { data } = await initPuzzleGroups({ resetMembers: false });
        setMsg(els.puzzleMsg, `已確保 ${data.groups.length} 組`, true);
        await refreshPuzzleGroups();
      } catch (err) {
        setMsg(els.puzzleMsg, friendlyError(err), false);
      } finally {
        els.btnInitGroups.disabled = false;
      }
    });
  }

  if (els.btnResetGroups) {
    els.btnResetGroups.addEventListener("click", async () => {
      if (
        !window.confirm(
          "確定重置全部 15 組？將清空成員、進度與組別碼，並解除開場鎖定狀態。"
        )
      ) {
        return;
      }
      els.btnResetGroups.disabled = true;
      try {
        const { data } = await initPuzzleGroups({
          resetMembers: true,
          forceNewCodes: true,
        });
        setMsg(els.puzzleMsg, `已重置 ${data.groups.length} 組`, true);
        await refreshPuzzleGroups();
      } catch (err) {
        setMsg(els.puzzleMsg, friendlyError(err), false);
      } finally {
        els.btnResetGroups.disabled = false;
      }
    });
  }

  if (els.btnUnlockOpening) {
    els.btnUnlockOpening.addEventListener("click", async () => {
      if (!window.confirm("確定對全場解鎖開場？未滿組也可進入開場。")) return;
      try {
        await unlockOpening({ unlocked: true });
        setMsg(els.puzzleMsg, "開場已解鎖", true);
        await refreshPuzzleGroups();
      } catch (err) {
        setMsg(els.puzzleMsg, friendlyError(err), false);
      }
    });
  }

  if (els.btnLockOpening) {
    els.btnLockOpening.addEventListener("click", async () => {
      try {
        await unlockOpening({ unlocked: false });
        setMsg(els.puzzleMsg, "開場已重新鎖定", true);
        await refreshPuzzleGroups();
      } catch (err) {
        setMsg(els.puzzleMsg, friendlyError(err), false);
      }
    });
  }

  if (els.btnUnlockFinale) {
    els.btnUnlockFinale.addEventListener("click", async () => {
      if (!window.confirm("確定對全場解鎖終場？")) return;
      try {
        await unlockFinale({ unlocked: true });
        setMsg(els.puzzleMsg, "終場已解鎖", true);
        await refreshPuzzleGroups();
      } catch (err) {
        setMsg(els.puzzleMsg, friendlyError(err), false);
      }
    });
  }

  if (els.btnLockFinale) {
    els.btnLockFinale.addEventListener("click", async () => {
      try {
        await unlockFinale({ unlocked: false });
        setMsg(els.puzzleMsg, "終場已重新鎖定", true);
        await refreshPuzzleGroups();
      } catch (err) {
        setMsg(els.puzzleMsg, friendlyError(err), false);
      }
    });
  }

  if (els.btnDesignateSilencers) {
    els.btnDesignateSilencers.addEventListener("click", async () => {
      const groupId = (els.silencerGroup && els.silencerGroup.value) || "";
      if (!groupId) {
        setMsg(els.puzzleMsg, "請先選擇組別", false);
        return;
      }
      if (
        !window.confirm(
          `確定將 ${groupId} 四位成員指定為封口者，並解鎖全場第四幕？`
        )
      ) {
        return;
      }
      els.btnDesignateSilencers.disabled = true;
      try {
        const { data } = await designateSilencersAndUnlockAct4({
          group_id: groupId,
          unlock: true,
        });
        setMsg(
          els.puzzleMsg,
          `已指定封口者 ${((data && data.silencers) || []).join("、")}，第四幕已解鎖`,
          true
        );
        await refreshPuzzleGroups();
      } catch (err) {
        setMsg(els.puzzleMsg, friendlyError(err), false);
      } finally {
        els.btnDesignateSilencers.disabled = false;
      }
    });
  }

  if (els.btnRefreshGroups) {
    els.btnRefreshGroups.addEventListener("click", () => refreshPuzzleGroups());
  }

  if (els.groupsBody) {
    els.groupsBody.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-pass-group][data-pass-role]");
      if (!btn) return;
      const groupId = btn.getAttribute("data-pass-group");
      const role = btn.getAttribute("data-pass-role");
      if (!window.confirm(`確認 ${groupId}「${role}」任務通過？`)) return;
      btn.disabled = true;
      try {
        await passAct2Role({ group_id: groupId, role });
        setMsg(els.puzzleMsg, `${groupId} ${role}任務已通過`, true);
        await refreshPuzzleGroups();
      } catch (err) {
        setMsg(els.puzzleMsg, friendlyError(err), false);
        btn.disabled = false;
      }
    });
  }

  if (els.moveForm) {
    els.moveForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = (els.moveId.value || "").trim();
      const group_id = (els.moveGroup.value || "").trim();
      if (!id || !group_id) {
        setMsg(els.puzzleMsg, "請填寫大使編號與目標組別", false);
        return;
      }
      els.btnMove.disabled = true;
      try {
        await adminMoveMember({ id, group_id });
        setMsg(els.puzzleMsg, `已將 ${id} 移至 ${group_id}`, true);
        els.moveId.value = "";
      } catch (err) {
        setMsg(els.puzzleMsg, friendlyError(err), false);
      } finally {
        els.btnMove.disabled = false;
      }
    });
  }

  if (els.btnRemoveMember) {
    els.btnRemoveMember.addEventListener("click", async () => {
      const id = (els.moveId.value || "").trim();
      if (!id) {
        setMsg(els.puzzleMsg, "請填寫要移出的大使編號", false);
        return;
      }
      if (!window.confirm(`確定將 ${id} 移出目前組別？`)) return;
      try {
        await adminMoveMember({ id, remove: true });
        setMsg(els.puzzleMsg, `已將 ${id} 移出組別`, true);
      } catch (err) {
        setMsg(els.puzzleMsg, friendlyError(err), false);
      }
    });
  }
})();

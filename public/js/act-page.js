/**
 * Narrative act page controller (opening / act1 / act3 / act4 / finale).
 * Page must set: <body data-act="opening"> etc.
 */
(() => {
  const act = document.body.getAttribute("data-act");
  if (!act) return;

  NuvaPuzzle.bootPage({
    pageAct: act,
    onGroupUpdate(state) {
      updateChrome(state);
    },
    async onReady(ctx) {
      const { state, auth, callables, navigateToAct, refresh, logout } = ctx;
      window.__puzzleCtx = ctx;
      updateChrome(state);

      const btnNext = document.getElementById("btn-next");
      const btnBack = document.getElementById("btn-back");
      const errEl = document.getElementById("act-error");

      document.getElementById("btn-logout")?.addEventListener("click", logout);

      if (btnBack) {
        btnBack.addEventListener("click", () => {
          const cur = state.group?.currentAct || act;
          const idx = NuvaPuzzle.actIndex(act);
          if (idx <= 1) {
            navigateToAct("lobby");
            return;
          }
          navigateToAct(NuvaPuzzle.ACT_ORDER[idx - 1]);
        });
      }

      if (btnNext) {
        const isFinale = act === "finale";
        if (isFinale) {
          btnNext.classList.add("hidden");
        }
        btnNext.addEventListener("click", async () => {
          errEl?.classList.add("hidden");
          btnNext.disabled = true;
          try {
            const latest = await refresh();
            const current = latest.group?.currentAct || "lobby";
            // Only the member on the group's frontier advances.
            if (current === act || (current === "lobby" && act === "opening")) {
              const res = await callables.advanceAct(auth);
              const next = res.data.currentAct;
              navigateToAct(next);
            } else if (NuvaPuzzle.actIndex(current) > NuvaPuzzle.actIndex(act)) {
              navigateToAct(current === "lobby" ? "opening" : current);
            } else {
              throw new Error("組別尚未抵達此幕，請稍候");
            }
          } catch (e) {
            if (errEl) {
              errEl.textContent = NuvaPuzzle.friendlyError(e);
              errEl.classList.remove("hidden");
            }
          } finally {
            btnNext.disabled = false;
          }
        });
      }
    },
  });

  function updateChrome(state) {
    const me = document.getElementById("me-chip");
    if (me) {
      me.textContent = `${state.name} · ${state.role} · ${state.group?.id || ""}`;
    }
    NuvaPuzzle.syncActProgress(state, act);
    if (NuvaPuzzle.isPreviewState(state)) {
      NuvaPuzzle.applyStaffPreviewChrome(act);
      return;
    }
    // Hide next if viewing a past act (read-only revisit)
    const btnNext = document.getElementById("btn-next");
    if (btnNext && state.group) {
      const effective =
        state.group.currentAct === "lobby" && state.openingUnlocked
          ? "opening"
          : state.group.currentAct;
      const onFrontier = effective === act;
      btnNext.classList.toggle("hidden", !onFrontier || act === "finale");
      const note = document.getElementById("readonly-note");
      if (note) {
        note.classList.toggle("hidden", onFrontier || act === "finale");
      }
    }
  }
})();

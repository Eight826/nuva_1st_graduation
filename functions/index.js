/**
 * Phase 2 — Callable Cloud Functions for ambassador check-in & role draw.
 * All draw / killer / inventory logic runs here with Admin SDK only.
 */
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { randomInt, randomBytes } = require("crypto");

initializeApp();
setGlobalOptions({ region: "asia-east1" });

const db = getFirestore();
const CONFIG_DOC = db.collection("system_config").doc("main");
const STAFF_ROLE = "工作人員";
const GAME_ROLES = ["大力士", "品味家", "判斷家"];
const GROUP_COUNT = 15;
const GROUP_SLOT_CAPACITY = { 大力士: 2, 品味家: 1, 判斷家: 1 };
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
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Normalize numeric ids so "002" and "2" resolve to the same doc. */
function normalizeId(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (/^\d+$/.test(s)) return String(Number(s));
  return s;
}

function isStaff(ambassador) {
  return !!(ambassador && ambassador.is_staff === true);
}

function assertAttending(ambassador) {
  // Legacy docs without the field are treated as attending (backward compatible).
  if (ambassador && ambassador.is_attending === false) {
    throw new HttpsError(
      "failed-precondition",
      "此大使未登記參加實體活動，無法抽籤。如有疑問請聯絡管理員"
    );
  }
}

function assertNotStaff(ambassador, actionLabel) {
  if (isStaff(ambassador)) {
    throw new HttpsError(
      "failed-precondition",
      `工作人員為固定身分，無法${actionLabel}`
    );
  }
}

function normalizeName(raw) {
  return String(raw ?? "").trim();
}

function normalizePin(raw) {
  return String(raw ?? "").trim();
}

function assertCredentials(data) {
  const id = normalizeId(data && data.id);
  const name = normalizeName(data && data.name);
  const pin = normalizePin(data && data.pin);
  if (!id || !name || !pin) {
    throw new HttpsError("invalid-argument", "請填寫大使編號、姓名與報到 PIN");
  }
  return { id, name, pin };
}

/**
 * Weighted random pick from role_pool.remaining, e.g. { 大力士: 47, 品味家: 22 }.
 */
function pickRole(remaining) {
  const entries = Object.entries(remaining || {}).filter(([, n]) => Number(n) > 0);
  const total = entries.reduce((sum, [, n]) => sum + Number(n), 0);
  if (total <= 0) {
    throw new HttpsError("resource-exhausted", "角色池已抽完，請聯絡管理員");
  }
  let ticket = randomInt(0, total);
  for (const [role, count] of entries) {
    ticket -= Number(count);
    if (ticket < 0) return role;
  }
  return entries[entries.length - 1][0];
}

/**
 * Fair assignment of exactly killer.remaining killers across remaining seats.
 * P(is_killer) = killerRemaining / seatsRemaining.
 */
function decideKiller(killerRemaining, seatsRemaining) {
  const k = Number(killerRemaining) || 0;
  const seats = Number(seatsRemaining) || 0;
  if (k <= 0 || seats <= 0) return false;
  if (k >= seats) return true;
  return randomInt(0, seats) < k;
}

function publicPayload(ambassador, extra = {}) {
  return {
    id: ambassador.id,
    name: ambassador.name,
    role: ambassador.role || "",
    is_drawn: !!ambassador.is_drawn,
    drawn_at: ambassador.drawn_at || null,
    is_attending: ambassador.is_attending !== false,
    is_staff: isStaff(ambassador),
    ...extra,
  };
}

/**
 * verifyCheckin — validate id + name + PIN.
 * - already drawn → return role (PIN must still match, even if used)
 * - not drawn → PIN must be unused → ready_to_draw
 */
exports.verifyCheckin = onCall({ cors: true }, async (request) => {
  const { id, name, pin } = assertCredentials(request.data);

  const [publicSnap, codeSnap] = await Promise.all([
    db.collection("ambassadors_public").doc(id).get(),
    db.collection("checkin_codes").doc(id).get(),
  ]);

  if (!publicSnap.exists) {
    throw new HttpsError("not-found", "找不到此大使編號");
  }
  if (!codeSnap.exists) {
    throw new HttpsError("failed-precondition", "此大使尚未核發報到 PIN，請聯絡管理員");
  }

  const ambassador = publicSnap.data();
  const code = codeSnap.data();

  if (normalizeName(ambassador.name) !== name) {
    throw new HttpsError("permission-denied", "姓名與編號不符");
  }
  if (normalizePin(code.pin) !== pin) {
    throw new HttpsError("permission-denied", "報到 PIN 錯誤");
  }

  // Fixed staff: always show 工作人員, never enter draw flow.
  if (isStaff(ambassador)) {
    return {
      status: "already_drawn",
      ...publicPayload({
        ...ambassador,
        role: ambassador.role || STAFF_ROLE,
        is_drawn: true,
      }),
    };
  }

  if (ambassador.is_drawn) {
    return {
      status: "already_drawn",
      ...publicPayload(ambassador),
    };
  }

  assertAttending(ambassador);

  if (code.used) {
    throw new HttpsError(
      "failed-precondition",
      "此 PIN 已使用但尚未完成抽籤，請聯絡管理員重置"
    );
  }

  return {
    status: "ready_to_draw",
    ...publicPayload(ambassador),
  };
});

/**
 * drawRole — atomic draw inside a transaction.
 * Returns only public fields (never is_killer).
 */
exports.drawRole = onCall({ cors: true }, async (request) => {
  const { id, name, pin } = assertCredentials(request.data);

  const publicRef = db.collection("ambassadors_public").doc(id);
  const secretRef = db.collection("ambassadors_secret").doc(id);
  const codeRef = db.collection("checkin_codes").doc(id);

  const result = await db.runTransaction(async (tx) => {
    const [publicSnap, secretSnap, codeSnap, configSnap] = await Promise.all([
      tx.get(publicRef),
      tx.get(secretRef),
      tx.get(codeRef),
      tx.get(CONFIG_DOC),
    ]);

    if (!publicSnap.exists) {
      throw new HttpsError("not-found", "找不到此大使編號");
    }
    if (!codeSnap.exists) {
      throw new HttpsError("failed-precondition", "此大使尚未核發報到 PIN");
    }
    if (!configSnap.exists) {
      throw new HttpsError("failed-precondition", "系統設定尚未初始化");
    }

    const ambassador = publicSnap.data();
    const code = codeSnap.data();
    const config = configSnap.data();

    if (normalizeName(ambassador.name) !== name) {
      throw new HttpsError("permission-denied", "姓名與編號不符");
    }
    if (normalizePin(code.pin) !== pin) {
      throw new HttpsError("permission-denied", "報到 PIN 錯誤");
    }

    // Fixed staff never enter the game role pool.
    if (isStaff(ambassador)) {
      return publicPayload(
        {
          ...ambassador,
          role: ambassador.role || STAFF_ROLE,
          is_drawn: true,
        },
        { status: "already_drawn" }
      );
    }

    // Idempotent: already drawn → return existing role, never re-roll
    if (ambassador.is_drawn) {
      return publicPayload(ambassador, { status: "already_drawn" });
    }

    assertAttending(ambassador);

    if (code.used) {
      throw new HttpsError(
        "failed-precondition",
        "此 PIN 已使用，無法再次抽籤，請聯絡管理員"
      );
    }

    const remaining = { ...(config.role_pool && config.role_pool.remaining) };
    const seatsRemaining = Object.values(remaining).reduce(
      (sum, n) => sum + Number(n || 0),
      0
    );
    const killerRemaining = Number(
      (config.killer && config.killer.remaining) || 0
    );
    const killerMode =
      (config.killer && config.killer.mode) === "manual" ? "manual" : "random";
    const secret = secretSnap.exists ? secretSnap.data() || {} : {};

    const role = pickRole(remaining);
    remaining[role] = Number(remaining[role]) - 1;

    // Manual mode: killer is designated by admin only; never roll at draw time.
    // Also preserve a pre-assigned secret.is_killer if already set.
    let isKiller;
    let nextKillerRemaining = killerRemaining;
    if (killerMode === "manual") {
      isKiller = secret.is_killer === true;
      nextKillerRemaining = killerRemaining;
    } else if (secret.is_killer === true) {
      isKiller = true;
      nextKillerRemaining = killerRemaining;
    } else {
      isKiller = decideKiller(killerRemaining, seatsRemaining);
      nextKillerRemaining = isKiller
        ? Math.max(0, killerRemaining - 1)
        : killerRemaining;
    }

    tx.update(publicRef, {
      role,
      is_drawn: true,
      drawn_at: FieldValue.serverTimestamp(),
    });

    tx.set(
      secretRef,
      {
        id,
        role,
        is_killer: isKiller,
      },
      { merge: true }
    );

    tx.update(codeRef, { used: true });

    tx.set(
      CONFIG_DOC,
      {
        role_pool: {
          ...(config.role_pool || {}),
          remaining,
        },
        killer: {
          ...(config.killer || {}),
          remaining: nextKillerRemaining,
        },
      },
      { merge: true }
    );

    return {
      status: "drawn",
      id,
      name: ambassador.name,
      role,
      is_drawn: true,
    };
  });

  return result;
});

/**
 * ensureAdminClaim — grant { admin: true } if the signed-in email is allowlisted.
 * Client must call getIdToken(true) afterwards to refresh the JWT.
 */
const ADMIN_ALLOWLIST = new Set(
  String(process.env.ADMIN_ALLOWLIST || "nuvadmin@gmail.com")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

exports.ensureAdminClaim = onCall({ cors: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "請先登入");
  }

  const email = String(request.auth.token.email || "").toLowerCase();
  if (!email || !ADMIN_ALLOWLIST.has(email)) {
    throw new HttpsError("permission-denied", "此帳號不在管理員白名單");
  }

  if (request.auth.token.admin === true) {
    return { ok: true, already: true, email };
  }

  const { getAuth } = require("firebase-admin/auth");
  await getAuth().setCustomUserClaims(request.auth.uid, { admin: true });
  return { ok: true, already: false, email };
});

function assertAdmin(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "請先登入管理員帳號");
  }
  if (request.auth.token.admin !== true) {
    throw new HttpsError(
      "permission-denied",
      "缺少管理員權限，請重新登出再登入後重試"
    );
  }
}

function generatePin() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function formatDrawnAt(value) {
  if (!value) return "";
  if (typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  return String(value);
}

/**
 * resetAmbassador — clear role / draw state, restore inventory.
 * Keeps the same check-in PIN; only marks it unused so they can draw again.
 */
exports.resetAmbassador = onCall({ cors: true }, async (request) => {
  assertAdmin(request);
  const id = normalizeId(request.data && request.data.id);
  if (!id) {
    throw new HttpsError("invalid-argument", "請提供大使編號");
  }

  const publicRef = db.collection("ambassadors_public").doc(id);
  const secretRef = db.collection("ambassadors_secret").doc(id);
  const codeRef = db.collection("checkin_codes").doc(id);

  try {
    const result = await db.runTransaction(async (tx) => {
      // Sequential reads — safer than Promise.all inside transactions.
      const publicSnap = await tx.get(publicRef);
      const secretSnap = await tx.get(secretRef);
      const codeSnap = await tx.get(codeRef);
      const configSnap = await tx.get(CONFIG_DOC);

      if (!publicSnap.exists) {
        throw new HttpsError("not-found", "找不到此大使編號");
      }

      const ambassador = publicSnap.data() || {};
      assertNotStaff(ambassador, "重置");

      const secret = secretSnap.exists ? secretSnap.data() || {} : {};
      const config = configSnap.exists ? configSnap.data() || {} : {};
      const remaining = {
        ...((config.role_pool && config.role_pool.remaining) || {}),
      };
      let killerRemaining = Number((config.killer && config.killer.remaining) || 0);

      const previousRole = String(ambassador.role || "").trim();
      const wasDrawn = ambassador.is_drawn === true || previousRole.length > 0;
      const wasKiller = secret.is_killer === true;
      const previousGroupId = String(ambassador.group_id || "").trim();

      if (!wasDrawn) {
        throw new HttpsError("failed-precondition", "此大使目前沒有可清除的身份");
      }

      // Only restore inventory for game roles (never invent a 工作人員 pool seat).
      if (previousRole && GAME_ROLES.includes(previousRole)) {
        remaining[previousRole] = Number(remaining[previousRole] || 0) + 1;
      }
      if (wasKiller) {
        killerRemaining += 1;
      }

      if (previousGroupId) {
        const groupRef = db.collection("groups").doc(previousGroupId);
        const groupSnap = await tx.get(groupRef);
        if (groupSnap.exists) {
          const group = groupSnap.data() || {};
          const members = (group.members || []).filter(
            (m) => normalizeId(m.id) !== id
          );
          const slots = {
            ...(group.slots || emptySlots()),
          };
          if (GAME_ROLES.includes(previousRole)) {
            slots[previousRole] = Number(slots[previousRole] || 0) + 1;
          }
          tx.update(groupRef, {
            members,
            slots,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      }

      tx.set(
        publicRef,
        {
          id,
          name: ambassador.name || "",
          role: "",
          is_drawn: false,
          is_staff: false,
          group_id: FieldValue.delete(),
          drawn_at: FieldValue.delete(),
          // Preserve attendance; default true only when field was never set.
          is_attending:
            ambassador.is_attending === undefined
              ? true
              : !!ambassador.is_attending,
        },
        { merge: true }
      );

      tx.set(
        secretRef,
        {
          id,
          role: "",
          is_killer: false,
        },
        { merge: true }
      );

      if (codeSnap.exists) {
        tx.set(
          codeRef,
          {
            ambassador_id: id,
            pin: codeSnap.data().pin,
            used: false,
          },
          { merge: true }
        );
      }

      if (configSnap.exists) {
        const nextConfig = {
          role_pool: {
            initial: (config.role_pool && config.role_pool.initial) || remaining,
            remaining,
          },
          killer: {
            initial: (config.killer && config.killer.initial) || killerRemaining,
            remaining: killerRemaining,
          },
        };
        tx.set(CONFIG_DOC, nextConfig, { merge: true });
      }

      return {
        ok: true,
        id,
        name: ambassador.name || "",
        restored_role: previousRole || null,
        restored_killer: wasKiller,
      };
    });

    return result;
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error("resetAmbassador failed", id, err);
    throw new HttpsError("internal", `重置失敗：${err.message || err}`);
  }
});

/**
 * exportPinRoster — check-in PIN list for paper slips / print page (admin only).
 */
exports.exportPinRoster = onCall({ cors: true }, async (request) => {
  assertAdmin(request);

  const [publicSnap, codeSnap] = await Promise.all([
    db.collection("ambassadors_public").get(),
    db.collection("checkin_codes").get(),
  ]);

  const codes = new Map();
  codeSnap.docs.forEach((doc) => {
    codes.set(doc.id, doc.data());
  });

  const rows = publicSnap.docs
    .map((doc) => {
      const d = doc.data();
      const c = codes.get(doc.id) || {};
      return {
        id: d.id || doc.id,
        name: d.name || "",
        pin: c.pin || "",
        used: !!c.used,
        is_drawn: !!d.is_drawn,
        is_attending: d.is_attending !== false,
      };
    })
    .sort((a, b) => Number(a.id) - Number(b.id) || String(a.id).localeCompare(String(b.id)));

  return {
    ok: true,
    draw_url: "https://nuva-guraduation.web.app/",
    rows,
    count: rows.length,
  };
});

/**
 * getKillerAssignment — admin-only: who is currently designated as 兇手/犯人.
 * Not exposed on the public listener (secret collection).
 */
exports.getKillerAssignment = onCall({ cors: true }, async (request) => {
  assertAdmin(request);

  const configSnap = await CONFIG_DOC.get();
  const config = configSnap.exists ? configSnap.data() || {} : {};
  const killer = config.killer || {};
  const mode = killer.mode === "manual" ? "manual" : "random";

  const secretSnap = await db
    .collection("ambassadors_secret")
    .where("is_killer", "==", true)
    .get();

  const killers = [];
  for (const doc of secretSnap.docs) {
    const publicSnap = await db.collection("ambassadors_public").doc(doc.id).get();
    const p = publicSnap.exists ? publicSnap.data() || {} : {};
    killers.push({
      id: doc.id,
      name: p.name || "",
      is_attending: p.is_attending !== false,
      is_drawn: !!p.is_drawn,
      role: p.role || "",
    });
  }

  killers.sort(
    (a, b) => Number(a.id) - Number(b.id) || String(a.id).localeCompare(String(b.id))
  );

  return {
    ok: true,
    mode,
    remaining: Number(killer.remaining || 0),
    killers,
    assigned_id: killer.assigned_id || (killers[0] && killers[0].id) || null,
  };
});

/**
 * setKiller — admin designates (or clears) the 犯人/兇手.
 * Only physical attendees may be designated. Switches killer.mode to "manual"
 * so drawRole will not randomly assign another killer.
 */
exports.setKiller = onCall({ cors: true }, async (request) => {
  assertAdmin(request);
  const id = normalizeId(request.data && request.data.id);
  const makeKiller = !!(request.data && request.data.is_killer);
  if (!id) {
    throw new HttpsError("invalid-argument", "請提供大使編號");
  }

  const publicRef = db.collection("ambassadors_public").doc(id);
  const secretRef = db.collection("ambassadors_secret").doc(id);

  const publicSnap = await publicRef.get();
  if (!publicSnap.exists) {
    throw new HttpsError("not-found", "找不到此大使編號");
  }
  const ambassador = publicSnap.data() || {};
  if (makeKiller && ambassador.is_attending === false) {
    throw new HttpsError(
      "failed-precondition",
      "只能指定「實體出席」的大使為犯人"
    );
  }
  if (makeKiller) {
    assertNotStaff(ambassador, "指定為犯人");
  }

  const existingKillers = await db
    .collection("ambassadors_secret")
    .where("is_killer", "==", true)
    .get();

  const batch = db.batch();

  // Single-killer game: clear any previous designation first.
  for (const doc of existingKillers.docs) {
    if (doc.id === id && makeKiller) continue;
    batch.set(doc.ref, { is_killer: false }, { merge: true });
  }

  batch.set(
    secretRef,
    {
      id,
      is_killer: makeKiller,
      role: ambassador.role || "",
    },
    { merge: true }
  );

  const configSnap = await CONFIG_DOC.get();
  const config = configSnap.exists ? configSnap.data() || {} : {};
  batch.set(
    CONFIG_DOC,
    {
      killer: {
        ...(config.killer || {}),
        mode: "manual",
        remaining: makeKiller ? 0 : Number((config.killer && config.killer.remaining) || 0),
        assigned_id: makeKiller ? id : null,
        assigned_name: makeKiller ? ambassador.name || "" : null,
        updated_at: FieldValue.serverTimestamp(),
      },
    },
    { merge: true }
  );

  await batch.commit();

  return {
    ok: true,
    id,
    name: ambassador.name || "",
    is_killer: makeKiller,
    mode: "manual",
  };
});

/**
 * adjustRolePool — update role_pool.remaining and optional killer.remaining.
 */
exports.adjustRolePool = onCall({ cors: true }, async (request) => {
  assertAdmin(request);
  const data = request.data || {};
  const remainingInput = data.remaining || {};
  const roles = ["大力士", "品味家", "判斷家"];
  const remaining = {};

  for (const role of roles) {
    if (remainingInput[role] === undefined || remainingInput[role] === null) {
      throw new HttpsError("invalid-argument", `請提供角色「${role}」的剩餘名額`);
    }
    const n = Number(remainingInput[role]);
    if (!Number.isInteger(n) || n < 0) {
      throw new HttpsError("invalid-argument", `「${role}」名額必須為非負整數`);
    }
    remaining[role] = n;
  }

  let killerRemaining;
  if (data.killer_remaining !== undefined && data.killer_remaining !== null) {
    killerRemaining = Number(data.killer_remaining);
    if (!Number.isInteger(killerRemaining) || killerRemaining < 0) {
      throw new HttpsError("invalid-argument", "兇手剩餘名額必須為非負整數");
    }
  }

  const configSnap = await CONFIG_DOC.get();
  if (!configSnap.exists) {
    throw new HttpsError("failed-precondition", "系統設定尚未初始化");
  }
  const config = configSnap.data();
  const payload = {
    role_pool: {
      ...(config.role_pool || {}),
      remaining,
    },
  };
  if (data.sync_initial === true) {
    payload.role_pool.initial = { ...remaining };
  }
  if (killerRemaining !== undefined) {
    payload.killer = {
      ...(config.killer || {}),
      remaining: killerRemaining,
    };
    if (data.sync_initial === true) {
      payload.killer.initial = killerRemaining;
    }
  }

  await CONFIG_DOC.set(payload, { merge: true });
  return { ok: true, remaining, killer_remaining: killerRemaining ?? null };
});

/**
 * exportRoster — public fields only (safe during game).
 */
exports.exportRoster = onCall({ cors: true }, async (request) => {
  assertAdmin(request);
  const snap = await db.collection("ambassadors_public").get();
  const rows = snap.docs
    .map((doc) => {
      const d = doc.data();
      return {
        id: d.id || doc.id,
        name: d.name || "",
        role: d.role || "",
        is_drawn: !!d.is_drawn,
        drawn_at: formatDrawnAt(d.drawn_at),
        is_attending: d.is_attending !== false,
      };
    })
    .sort((a, b) => Number(a.id) - Number(b.id) || String(a.id).localeCompare(String(b.id)));

  const header = "編號,姓名,角色,是否已抽取,抽籤時間,實體出席";
  const csv = [
    header,
    ...rows.map(
      (r) =>
        `${r.id},${escapeCsv(r.name)},${escapeCsv(r.role)},${r.is_drawn ? "是" : "否"},${r.drawn_at},${
          r.is_attending ? "是" : "否"
        }`
    ),
  ].join("\n");

  return { ok: true, filename: "ambassadors_roster.csv", csv, count: rows.length };
});

/**
 * exportFinalRoster — includes is_killer. Requires confirm: true.
 */
exports.exportFinalRoster = onCall({ cors: true }, async (request) => {
  assertAdmin(request);
  if (!(request.data && request.data.confirm === true)) {
    throw new HttpsError(
      "failed-precondition",
      "請先確認：此檔案包含兇手身分，請勿在遊戲進行中外流"
    );
  }

  const [publicSnap, secretSnap] = await Promise.all([
    db.collection("ambassadors_public").get(),
    db.collection("ambassadors_secret").get(),
  ]);

  const secrets = new Map();
  secretSnap.docs.forEach((doc) => {
    secrets.set(doc.id, doc.data());
  });

  const rows = publicSnap.docs
    .map((doc) => {
      const d = doc.data();
      const s = secrets.get(doc.id) || {};
      return {
        id: d.id || doc.id,
        name: d.name || "",
        role: d.role || "",
        is_drawn: !!d.is_drawn,
        drawn_at: formatDrawnAt(d.drawn_at),
        is_attending: d.is_attending !== false,
        is_killer: !!s.is_killer,
      };
    })
    .sort((a, b) => Number(a.id) - Number(b.id) || String(a.id).localeCompare(String(b.id)));

  const header = "編號,姓名,角色,是否已抽取,抽籤時間,實體出席,是否兇手";
  const csv = [
    header,
    ...rows.map(
      (r) =>
        `${r.id},${escapeCsv(r.name)},${escapeCsv(r.role)},${r.is_drawn ? "是" : "否"},${r.drawn_at},${
          r.is_attending ? "是" : "否"
        },${r.is_killer ? "是" : "否"}`
    ),
  ].join("\n");

  return {
    ok: true,
    filename: "ambassadors_final_roster_WITH_KILLER.csv",
    csv,
    count: rows.length,
  };
});

function escapeCsv(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Puzzle / groups
// ---------------------------------------------------------------------------

function emptySlots() {
  return { ...GROUP_SLOT_CAPACITY };
}

function emptyAct2() {
  return { 品味家: false, 判斷家: false, 大力士: false };
}

function emptyAct4() {
  return { solved: false, rank: null };
}

function sameIdSet(a, b) {
  const na = [...new Set((a || []).map(normalizeId).filter(Boolean))].sort();
  const nb = [...new Set((b || []).map(normalizeId).filter(Boolean))].sort();
  if (na.length !== nb.length) return false;
  return na.every((v, i) => v === nb[i]);
}

function actIndex(act) {
  const i = ACT_ORDER.indexOf(act);
  return i < 0 ? 0 : i;
}

function nextAct(act) {
  const i = actIndex(act);
  if (i >= ACT_ORDER.length - 1) return null;
  return ACT_ORDER[i + 1];
}

function groupIdFromIndex(n) {
  return `G${String(n).padStart(2, "0")}`;
}

function generateGroupCode() {
  let code = "";
  for (let i = 0; i < 4; i += 1) {
    code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

function normalizeAnswer(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    )
    .toLowerCase();
}

function groupPublicView(groupId, group) {
  if (!group) return null;
  const act4 = group.act4 || emptyAct4();
  return {
    id: groupId,
    code: group.code || "",
    members: group.members || [],
    slots: group.slots || emptySlots(),
    currentAct: group.currentAct || "lobby",
    act2: group.act2 || emptyAct2(),
    act4: {
      solved: act4.solved === true,
      rank: act4.rank == null ? null : Number(act4.rank),
    },
    memberCount: (group.members || []).length,
  };
}

function puzzleConfigFrom(config) {
  const puzzle = (config && config.puzzle) || {};
  return {
    openingUnlocked: puzzle.openingUnlocked === true,
    act4Unlocked: puzzle.act4Unlocked === true,
    finaleUnlocked: puzzle.finaleUnlocked === true,
    silencers: Array.isArray(puzzle.silencers)
      ? puzzle.silencers.map(normalizeId).filter(Boolean)
      : [],
    act4ClearCount: Number(puzzle.act4ClearCount || 0),
  };
}

async function issuePuzzleSession(id, name) {
  const token = randomBytes(24).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await db.collection("puzzle_sessions").doc(token).set({
    ambassador_id: id,
    name,
    expires_at: expiresAt,
    created_at: FieldValue.serverTimestamp(),
  });
  return { token, expires_at: expiresAt };
}

/**
 * Resolve player from {token} or {id,name,pin}. Always re-checks PIN when
 * credentials are provided; token sessions expire after SESSION_TTL_MS.
 */
async function resolvePlayer(data) {
  const token = String((data && data.token) || "").trim();
  if (token) {
    const sessionRef = db.collection("puzzle_sessions").doc(token);
    const sessionSnap = await sessionRef.get();
    if (!sessionSnap.exists) {
      throw new HttpsError("unauthenticated", "登入已失效，請重新驗證");
    }
    const session = sessionSnap.data() || {};
    if (Number(session.expires_at || 0) < Date.now()) {
      await sessionRef.delete().catch(() => {});
      throw new HttpsError("unauthenticated", "登入已過期，請重新驗證");
    }
    const id = normalizeId(session.ambassador_id);
    const publicSnap = await db.collection("ambassadors_public").doc(id).get();
    if (!publicSnap.exists) {
      throw new HttpsError("not-found", "找不到此大使編號");
    }
    const ambassador = publicSnap.data() || {};
    return {
      id,
      name: ambassador.name || session.name || "",
      ambassador,
      token,
    };
  }

  const { id, name, pin } = assertCredentials(data);
  const [publicSnap, codeSnap] = await Promise.all([
    db.collection("ambassadors_public").doc(id).get(),
    db.collection("checkin_codes").doc(id).get(),
  ]);
  if (!publicSnap.exists) {
    throw new HttpsError("not-found", "找不到此大使編號");
  }
  if (!codeSnap.exists) {
    throw new HttpsError("failed-precondition", "此大使尚未核發報到 PIN");
  }
  const ambassador = publicSnap.data() || {};
  const code = codeSnap.data() || {};
  if (normalizeName(ambassador.name) !== name) {
    throw new HttpsError("permission-denied", "姓名與編號不符");
  }
  if (normalizePin(code.pin) !== pin) {
    throw new HttpsError("permission-denied", "報到 PIN 錯誤");
  }
  return { id, name, pin, ambassador };
}

function assertDrawnGamePlayer(ambassador) {
  assertNotStaff(ambassador, "參加解謎");
  if (!ambassador.is_drawn || !GAME_ROLES.includes(String(ambassador.role || ""))) {
    throw new HttpsError("failed-precondition", "請先完成角色抽取後再組隊");
  }
}

/** Staff may hold a read-only preview session; players must be drawn game roles. */
function assertPuzzleSessionAllowed(ambassador) {
  if (isStaff(ambassador)) return;
  assertDrawnGamePlayer(ambassador);
}

function missingAct2Roles(group) {
  const act2 = group.act2 || emptyAct2();
  const missing = [];
  if (!act2["品味家"]) missing.push("品味家");
  if (!act2["判斷家"]) missing.push("判斷家");
  if (!act2["大力士"]) missing.push("大力士");
  return missing;
}

/**
 * createPuzzleSession — after draw / verify, issue a localStorage-friendly token.
 * Staff get a read-only preview session (no group).
 */
exports.createPuzzleSession = onCall({ cors: true }, async (request) => {
  const { id, name, ambassador } = await resolvePlayer(request.data);
  assertPuzzleSessionAllowed(ambassador);
  const staff = isStaff(ambassador);
  const session = await issuePuzzleSession(id, name || ambassador.name);
  return {
    ok: true,
    ...session,
    id,
    name: ambassador.name,
    role: staff ? ambassador.role || STAFF_ROLE : ambassador.role,
    is_staff: staff,
    preview: staff,
  };
});

/**
 * initPuzzleGroups — admin creates/resets G01–G15 with fresh codes.
 * resetMembers=true also clears ambassadors_public.group_id for those groups.
 */
exports.initPuzzleGroups = onCall({ cors: true }, async (request) => {
  assertAdmin(request);
  const resetMembers = !!(request.data && request.data.resetMembers);
  const forceCodes = !!(request.data && request.data.forceNewCodes);

  const existing = await db.collection("groups").get();
  const existingById = new Map(existing.docs.map((d) => [d.id, d.data() || {}]));
  const usedCodes = new Set();

  if (resetMembers) {
    const publicSnap = await db.collection("ambassadors_public").get();
    let batch = db.batch();
    let n = 0;
    for (const doc of publicSnap.docs) {
      if (!(doc.data() || {}).group_id) continue;
      batch.set(doc.ref, { group_id: FieldValue.delete() }, { merge: true });
      n += 1;
      if (n >= 400) {
        await batch.commit();
        batch = db.batch();
        n = 0;
      }
    }
    if (n > 0) await batch.commit();

    // Clear old code index
    const codeSnap = await db.collection("group_codes").get();
    batch = db.batch();
    n = 0;
    for (const doc of codeSnap.docs) {
      batch.delete(doc.ref);
      n += 1;
      if (n >= 400) {
        await batch.commit();
        batch = db.batch();
        n = 0;
      }
    }
    if (n > 0) await batch.commit();
  }

  const groups = [];
  let batch = db.batch();
  let opCount = 0;
  async function flush() {
    if (opCount === 0) return;
    await batch.commit();
    batch = db.batch();
    opCount = 0;
  }

  for (let i = 1; i <= GROUP_COUNT; i += 1) {
    const groupId = groupIdFromIndex(i);
    const prev = existingById.get(groupId) || null;
    let code = prev && prev.code;
    if (!code || forceCodes || resetMembers) {
      do {
        code = generateGroupCode();
      } while (usedCodes.has(code));
    }
    usedCodes.add(code);

    let payload;
    if (resetMembers || !prev) {
      payload = {
        code,
        slots: emptySlots(),
        members: [],
        currentAct: "lobby",
        act2: emptyAct2(),
        act4: emptyAct4(),
        updatedAt: FieldValue.serverTimestamp(),
      };
    } else {
      payload = {
        code,
        slots: prev.slots || emptySlots(),
        members: prev.members || [],
        currentAct: prev.currentAct || "lobby",
        act2: prev.act2 || emptyAct2(),
        act4: prev.act4 || emptyAct4(),
        updatedAt: FieldValue.serverTimestamp(),
      };
    }

    batch.set(db.collection("groups").doc(groupId), payload, { merge: false });
    batch.set(db.collection("group_codes").doc(code), { group_id: groupId });
    opCount += 2;
    groups.push({ id: groupId, code });
    if (opCount >= 400) await flush();
  }
  await flush();

  const puzzleUpdate = {};
  if (resetMembers) {
    puzzleUpdate.openingUnlocked = false;
    puzzleUpdate.act4Unlocked = false;
    puzzleUpdate.finaleUnlocked = false;
    puzzleUpdate.silencers = [];
    puzzleUpdate.act4ClearCount = 0;
    puzzleUpdate.answers = {
      taster: "PLACEHOLDER",
      judge: "PLACEHOLDER",
    };
  }
  if (Object.keys(puzzleUpdate).length) {
    await CONFIG_DOC.set({ puzzle: puzzleUpdate }, { merge: true });
  }

  const configSnap = await CONFIG_DOC.get();
  const puzzle = (configSnap.data() && configSnap.data().puzzle) || {};
  const patch = {};
  if (puzzle.openingUnlocked === undefined) patch.openingUnlocked = false;
  if (puzzle.act4Unlocked === undefined) patch.act4Unlocked = false;
  if (puzzle.finaleUnlocked === undefined) patch.finaleUnlocked = false;
  if (!Array.isArray(puzzle.silencers)) patch.silencers = [];
  if (puzzle.act4ClearCount === undefined) patch.act4ClearCount = 0;
  if (!puzzle.answers) {
    patch.answers = { taster: "PLACEHOLDER", judge: "PLACEHOLDER" };
  }
  if (Object.keys(patch).length) {
    await CONFIG_DOC.set({ puzzle: patch }, { merge: true });
  }

  return { ok: true, groups, resetMembers };
});

/**
 * unlockOpening — admin flips global opening gate.
 */
exports.unlockOpening = onCall({ cors: true }, async (request) => {
  assertAdmin(request);
  const unlocked = request.data && request.data.unlocked === false ? false : true;
  await CONFIG_DOC.set(
    {
      puzzle: {
        openingUnlocked: unlocked,
        unlockedAt: unlocked ? FieldValue.serverTimestamp() : null,
      },
    },
    { merge: true }
  );
  return { ok: true, openingUnlocked: unlocked };
});

/**
 * unlockFinale — admin flips global finale gate.
 */
exports.unlockFinale = onCall({ cors: true }, async (request) => {
  assertAdmin(request);
  const unlocked = request.data && request.data.unlocked === false ? false : true;
  await CONFIG_DOC.set(
    {
      puzzle: {
        finaleUnlocked: unlocked,
        finaleUnlockedAt: unlocked ? FieldValue.serverTimestamp() : null,
      },
    },
    { merge: true }
  );
  return { ok: true, finaleUnlocked: unlocked };
});

/**
 * designateSilencersAndUnlockAct4 — set silencers from a group (must be 4) and unlock act4.
 */
exports.designateSilencersAndUnlockAct4 = onCall({ cors: true }, async (request) => {
  assertAdmin(request);
  const groupId = String((request.data && request.data.group_id) || "").trim();
  const alsoUnlock =
    request.data && request.data.unlock === false ? false : true;
  if (!groupId) {
    throw new HttpsError("invalid-argument", "請提供組別 ID");
  }

  const groupSnap = await db.collection("groups").doc(groupId).get();
  if (!groupSnap.exists) {
    throw new HttpsError("not-found", "找不到組別");
  }
  const group = groupSnap.data() || {};
  const members = Array.isArray(group.members) ? group.members : [];
  if (members.length !== 4) {
    throw new HttpsError(
      "failed-precondition",
      `該組目前有 ${members.length} 人，封口者必須正好 4 人`
    );
  }
  const silencers = members.map((m) => normalizeId(m.id)).filter(Boolean);
  if (silencers.length !== 4 || new Set(silencers).size !== 4) {
    throw new HttpsError("failed-precondition", "組員編號無效或不完整");
  }

  const puzzlePatch = { silencers };
  if (alsoUnlock) {
    puzzlePatch.act4Unlocked = true;
    puzzlePatch.act4UnlockedAt = FieldValue.serverTimestamp();
  }
  await CONFIG_DOC.set({ puzzle: puzzlePatch }, { merge: true });

  return {
    ok: true,
    group_id: groupId,
    silencers,
    act4Unlocked: alsoUnlock
      ? true
      : undefined,
  };
});

/**
 * listPuzzleGroups — admin snapshot of all groups + opening flag.
 */
exports.listPuzzleGroups = onCall({ cors: true }, async (request) => {
  assertAdmin(request);
  const [groupsSnap, configSnap] = await Promise.all([
    db.collection("groups").get(),
    CONFIG_DOC.get(),
  ]);
  const config = configSnap.exists ? configSnap.data() || {} : {};
  const groups = groupsSnap.docs
    .map((doc) => groupPublicView(doc.id, doc.data()))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return {
    ok: true,
    openingUnlocked: puzzleConfigFrom(config).openingUnlocked,
    act4Unlocked: puzzleConfigFrom(config).act4Unlocked,
    finaleUnlocked: puzzleConfigFrom(config).finaleUnlocked,
    silencers: puzzleConfigFrom(config).silencers,
    groups,
  };
});

/**
 * getPuzzleState — player: role, group, act progress, unlock gates.
 * Staff: preview mode (no group, free navigation on client).
 */
exports.getPuzzleState = onCall({ cors: true }, async (request) => {
  const player = await resolvePlayer(request.data);
  const { id, ambassador } = player;
  assertPuzzleSessionAllowed(ambassador);

  const staff = isStaff(ambassador);
  const configSnap = await CONFIG_DOC.get();
  const config = configSnap.exists ? configSnap.data() || {} : {};
  const puzzleCfg = puzzleConfigFrom(config);

  if (staff) {
    let session = null;
    if (!player.token && player.pin) {
      session = await issuePuzzleSession(id, ambassador.name);
    }
    return {
      ok: true,
      id,
      name: ambassador.name,
      role: ambassador.role || STAFF_ROLE,
      is_staff: true,
      preview: true,
      group_id: null,
      group: null,
      openingUnlocked: true,
      act4Unlocked: true,
      finaleUnlocked: true,
      ...(session || (player.token ? { token: player.token } : {})),
    };
  }

  const groupId = String(ambassador.group_id || "").trim();

  let group = null;
  if (groupId) {
    const groupSnap = await db.collection("groups").doc(groupId).get();
    if (groupSnap.exists) {
      group = groupPublicView(groupId, groupSnap.data());
    }
  }

  let session = null;
  if (!player.token && player.pin) {
    session = await issuePuzzleSession(id, ambassador.name);
  }

  let silencersPublic = null;
  if (puzzleCfg.finaleUnlocked && puzzleCfg.silencers.length > 0) {
    silencersPublic = [];
    for (const sid of puzzleCfg.silencers) {
      const pubSnap = await db.collection("ambassadors_public").doc(sid).get();
      const pub = pubSnap.exists ? pubSnap.data() || {} : {};
      silencersPublic.push({
        id: sid,
        name: String(pub.name || "").trim() || "（未知）",
      });
    }
  }

  return {
    ok: true,
    id,
    name: ambassador.name,
    role: ambassador.role,
    is_staff: false,
    preview: false,
    group_id: groupId || null,
    group,
    openingUnlocked: puzzleCfg.openingUnlocked,
    act4Unlocked: puzzleCfg.act4Unlocked,
    finaleUnlocked: puzzleCfg.finaleUnlocked,
    ...(silencersPublic ? { silencersPublic } : {}),
    ...(session || (player.token ? { token: player.token } : {})),
  };
});

/**
 * joinGroup — enter by code; enforce role slot capacity.
 */
exports.joinGroup = onCall({ cors: true }, async (request) => {
  const player = await resolvePlayer(request.data);
  const { id, ambassador } = player;
  assertDrawnGamePlayer(ambassador);

  const code = String((request.data && request.data.code) || "")
    .trim()
    .toUpperCase();
  if (!code) {
    throw new HttpsError("invalid-argument", "請輸入組別碼");
  }

  const result = await db.runTransaction(async (tx) => {
    const publicRef = db.collection("ambassadors_public").doc(id);
    const publicSnap = await tx.get(publicRef);
    if (!publicSnap.exists) {
      throw new HttpsError("not-found", "找不到此大使編號");
    }
    const live = publicSnap.data() || {};
    assertDrawnGamePlayer(live);
    const liveGroupId = String(live.group_id || "").trim();
    const role = String(live.role || "");

    const codeRef = db.collection("group_codes").doc(code);
    const codeSnap = await tx.get(codeRef);
    if (!codeSnap.exists) {
      throw new HttpsError("not-found", "找不到此組別碼");
    }
    const groupId = String((codeSnap.data() || {}).group_id || "").trim();
    if (!groupId) {
      throw new HttpsError("not-found", "組別碼無效");
    }
    const groupRef = db.collection("groups").doc(groupId);
    const groupSnap = await tx.get(groupRef);
    if (!groupSnap.exists) {
      throw new HttpsError("not-found", "找不到此組別");
    }
    const group = groupSnap.data() || {};

    if (liveGroupId && liveGroupId === groupId) {
      return groupPublicView(groupId, group);
    }
    if (liveGroupId && liveGroupId !== groupId) {
      throw new HttpsError(
        "failed-precondition",
        "你已在其他組別，請先退組後再加入"
      );
    }

    const members = [...(group.members || [])];
    if (members.some((m) => normalizeId(m.id) === id)) {
      return groupPublicView(groupId, group);
    }
    if (members.length >= 4) {
      throw new HttpsError("resource-exhausted", "此組人數已滿");
    }

    const slots = { ...(group.slots || emptySlots()) };
    const left = Number(slots[role] || 0);
    if (left <= 0) {
      throw new HttpsError(
        "failed-precondition",
        `此組「${role}」名額已滿，請加入其他組`
      );
    }
    slots[role] = left - 1;
    members.push({ id, name: live.name || "", role });

    tx.update(groupRef, {
      members,
      slots,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(publicRef, { group_id: groupId }, { merge: true });

    return groupPublicView(groupId, {
      ...group,
      members,
      slots,
    });
  });

  return { ok: true, group: result };
});

/**
 * leaveGroup — self-service only before opening unlock.
 */
exports.leaveGroup = onCall({ cors: true }, async (request) => {
  const player = await resolvePlayer(request.data);
  const { id, ambassador } = player;
  assertDrawnGamePlayer(ambassador);

  const configSnap = await CONFIG_DOC.get();
  const config = configSnap.exists ? configSnap.data() || {} : {};
  if (puzzleConfigFrom(config).openingUnlocked) {
    throw new HttpsError(
      "failed-precondition",
      "開場已解鎖，無法自行退組，請聯絡現場工作人員"
    );
  }

  await db.runTransaction(async (tx) => {
    const publicRef = db.collection("ambassadors_public").doc(id);
    const publicSnap = await tx.get(publicRef);
    if (!publicSnap.exists) {
      throw new HttpsError("not-found", "找不到此大使編號");
    }
    const live = publicSnap.data() || {};
    const groupId = String(live.group_id || "").trim();
    if (!groupId) {
      throw new HttpsError("failed-precondition", "你目前不在任何組別");
    }
    const groupRef = db.collection("groups").doc(groupId);
    const groupSnap = await tx.get(groupRef);
    if (groupSnap.exists) {
      const group = groupSnap.data() || {};
      const role = String(live.role || "");
      const members = (group.members || []).filter(
        (m) => normalizeId(m.id) !== id
      );
      const slots = { ...(group.slots || emptySlots()) };
      if (GAME_ROLES.includes(role)) {
        slots[role] = Number(slots[role] || 0) + 1;
      }
      tx.update(groupRef, {
        members,
        slots,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    tx.set(publicRef, { group_id: FieldValue.delete() }, { merge: true });
  });

  return { ok: true };
});

/**
 * adminMoveMember — move player between groups (or remove) after opening.
 */
exports.adminMoveMember = onCall({ cors: true }, async (request) => {
  assertAdmin(request);
  const id = normalizeId(request.data && request.data.id);
  const targetGroupId = String((request.data && request.data.group_id) || "").trim();
  const removeOnly = !!(request.data && request.data.remove);
  if (!id) {
    throw new HttpsError("invalid-argument", "請提供大使編號");
  }
  if (!removeOnly && !targetGroupId) {
    throw new HttpsError("invalid-argument", "請提供目標組別");
  }

  await db.runTransaction(async (tx) => {
    const publicRef = db.collection("ambassadors_public").doc(id);
    const publicSnap = await tx.get(publicRef);
    if (!publicSnap.exists) {
      throw new HttpsError("not-found", "找不到此大使編號");
    }
    const live = publicSnap.data() || {};
    assertDrawnGamePlayer(live);
    const role = String(live.role || "");
    const fromId = String(live.group_id || "").trim();

    if (fromId) {
      const fromRef = db.collection("groups").doc(fromId);
      const fromSnap = await tx.get(fromRef);
      if (fromSnap.exists) {
        const from = fromSnap.data() || {};
        const members = (from.members || []).filter(
          (m) => normalizeId(m.id) !== id
        );
        const slots = { ...(from.slots || emptySlots()) };
        if (GAME_ROLES.includes(role)) {
          slots[role] = Number(slots[role] || 0) + 1;
        }
        // If removing mid-act2 progress for that role's personal flag — keep
        // group act2 flags (大力士 is group-level; 品味家/判斷家 may need reset).
        const act2 = { ...(from.act2 || emptyAct2()) };
        if (role === "品味家" || role === "判斷家") {
          act2[role] = false;
        }
        tx.update(fromRef, {
          members,
          slots,
          act2,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }

    if (removeOnly) {
      tx.set(publicRef, { group_id: FieldValue.delete() }, { merge: true });
      return;
    }

    if (fromId === targetGroupId) return;

    const toRef = db.collection("groups").doc(targetGroupId);
    const toSnap = await tx.get(toRef);
    if (!toSnap.exists) {
      throw new HttpsError("not-found", "找不到目標組別");
    }
    const to = toSnap.data() || {};
    const members = [...(to.members || [])];
    if (members.length >= 4) {
      throw new HttpsError("resource-exhausted", "目標組人數已滿");
    }
    if (members.some((m) => normalizeId(m.id) === id)) {
      tx.set(publicRef, { group_id: targetGroupId }, { merge: true });
      return;
    }
    const slots = { ...(to.slots || emptySlots()) };
    if (Number(slots[role] || 0) <= 0) {
      throw new HttpsError(
        "failed-precondition",
        `目標組「${role}」名額已滿`
      );
    }
    slots[role] = Number(slots[role]) - 1;
    members.push({ id, name: live.name || "", role });
    tx.update(toRef, {
      members,
      slots,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(publicRef, { group_id: targetGroupId }, { merge: true });
  });

  return { ok: true };
});

/**
 * advanceAct — any member advances narrative acts; act2 requires all tasks done.
 */
exports.advanceAct = onCall({ cors: true }, async (request) => {
  const player = await resolvePlayer(request.data);
  const { id, ambassador } = player;
  assertDrawnGamePlayer(ambassador);

  const configSnap = await CONFIG_DOC.get();
  const config = configSnap.exists ? configSnap.data() || {} : {};
  if (!puzzleConfigFrom(config).openingUnlocked) {
    throw new HttpsError("failed-precondition", "開場尚未解鎖，請稍候主辦宣布");
  }

  const groupId = String(ambassador.group_id || "").trim();
  if (!groupId) {
    throw new HttpsError("failed-precondition", "請先加入小組");
  }

  const result = await db.runTransaction(async (tx) => {
    const publicRef = db.collection("ambassadors_public").doc(id);
    const publicSnap = await tx.get(publicRef);
    const live = publicSnap.exists ? publicSnap.data() || {} : {};
    if (String(live.group_id || "") !== groupId) {
      throw new HttpsError("failed-precondition", "組別狀態已變更，請重新整理");
    }

    const groupRef = db.collection("groups").doc(groupId);
    const groupSnap = await tx.get(groupRef);
    if (!groupSnap.exists) {
      throw new HttpsError("not-found", "找不到組別");
    }
    const group = groupSnap.data() || {};
    const current = group.currentAct || "lobby";

    if (current === "lobby") {
      // First advance after unlock: enter opening.
      tx.update(groupRef, {
        currentAct: "opening",
        updatedAt: FieldValue.serverTimestamp(),
      });
      return {
        ok: true,
        previousAct: "lobby",
        currentAct: "opening",
        group: groupPublicView(groupId, { ...group, currentAct: "opening" }),
      };
    }

    if (current === "finale") {
      return {
        ok: true,
        previousAct: "finale",
        currentAct: "finale",
        done: true,
        group: groupPublicView(groupId, group),
      };
    }

    if (current === "act2") {
      const missing = missingAct2Roles(group);
      if (missing.length > 0) {
        throw new HttpsError(
          "failed-precondition",
          `尚有身分未完成：${missing.join("、")}，請等待隊友完成後再前進`
        );
      }
    }

    if (current === "act3") {
      if (!puzzleConfigFrom(config).act4Unlocked) {
        throw new HttpsError(
          "failed-precondition",
          "第四幕尚未開放，請等待主辦宣布"
        );
      }
    }

    if (current === "act4") {
      throw new HttpsError(
        "failed-precondition",
        "請先完成正式指認後再前進"
      );
    }

    if (current === "waiting") {
      if (!puzzleConfigFrom(config).finaleUnlocked) {
        throw new HttpsError(
          "failed-precondition",
          "終場尚未開放，請稍候主辦宣布"
        );
      }
    }

    const nxt = nextAct(current);
    if (!nxt) {
      throw new HttpsError("failed-precondition", "已無下一幕");
    }

    tx.update(groupRef, {
      currentAct: nxt,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return {
      ok: true,
      previousAct: current,
      currentAct: nxt,
      group: groupPublicView(groupId, { ...group, currentAct: nxt }),
    };
  });

  return result;
});

/**
 * submitAct4Accusation — verify killer + silencers; on success move to waiting with rank.
 */
exports.submitAct4Accusation = onCall({ cors: true }, async (request) => {
  const player = await resolvePlayer(request.data);
  const { id, ambassador } = player;
  assertDrawnGamePlayer(ambassador);

  const groupId = String(ambassador.group_id || "").trim();
  if (!groupId) {
    throw new HttpsError("failed-precondition", "請先加入小組");
  }

  const killerIdGuess = normalizeId(request.data && request.data.killer_id);
  const killerNameGuess = normalizeAnswer(request.data && request.data.killer_name);
  let silencerGuess = request.data && request.data.silencers;
  if (typeof silencerGuess === "string") {
    silencerGuess = silencerGuess.split(/[,，\s]+/);
  }
  if (!Array.isArray(silencerGuess)) silencerGuess = [];
  silencerGuess = silencerGuess.map(normalizeId).filter(Boolean);

  if (!killerIdGuess || !killerNameGuess) {
    throw new HttpsError("invalid-argument", "請填寫犯人編號與姓名");
  }
  if (silencerGuess.length !== 4 || new Set(silencerGuess).size !== 4) {
    throw new HttpsError("invalid-argument", "請填寫正好 4 位不重複的封口者編號");
  }

  const configSnap = await CONFIG_DOC.get();
  const config = configSnap.exists ? configSnap.data() || {} : {};
  const puzzleCfg = puzzleConfigFrom(config);
  if (!puzzleCfg.openingUnlocked) {
    throw new HttpsError("failed-precondition", "開場尚未解鎖");
  }
  if (!puzzleCfg.act4Unlocked) {
    throw new HttpsError("failed-precondition", "第四幕尚未開放");
  }
  if (puzzleCfg.silencers.length !== 4) {
    throw new HttpsError("failed-precondition", "封口者尚未設定，請聯絡主辦");
  }

  const killerSnap = await db
    .collection("ambassadors_secret")
    .where("is_killer", "==", true)
    .limit(2)
    .get();
  if (killerSnap.empty) {
    throw new HttpsError("failed-precondition", "犯人尚未指定，請聯絡主辦");
  }
  if (killerSnap.size > 1) {
    throw new HttpsError("failed-precondition", "犯人設定異常，請聯絡主辦");
  }
  const killerId = normalizeId(killerSnap.docs[0].id);
  const killerPublic = await db.collection("ambassadors_public").doc(killerId).get();
  if (!killerPublic.exists) {
    throw new HttpsError("failed-precondition", "犯人資料異常，請聯絡主辦");
  }
  const killerName = normalizeAnswer(killerPublic.data().name);

  const killerOk =
    killerIdGuess === killerId && killerNameGuess === killerName;
  const silencersOk = sameIdSet(silencerGuess, puzzleCfg.silencers);
  if (!killerOk || !silencersOk) {
    throw new HttpsError("permission-denied", "指認不正確");
  }

  const result = await db.runTransaction(async (tx) => {
    const publicSnap = await tx.get(db.collection("ambassadors_public").doc(id));
    const live = publicSnap.exists ? publicSnap.data() || {} : {};
    if (String(live.group_id || "") !== groupId) {
      throw new HttpsError("failed-precondition", "組別狀態已變更");
    }

    const groupRef = db.collection("groups").doc(groupId);
    const groupSnap = await tx.get(groupRef);
    if (!groupSnap.exists) {
      throw new HttpsError("not-found", "找不到組別");
    }
    const group = groupSnap.data() || {};
    if ((group.currentAct || "lobby") !== "act4") {
      throw new HttpsError("failed-precondition", "目前不在第四幕");
    }

    const prevAct4 = group.act4 || emptyAct4();
    if (prevAct4.solved === true) {
      return {
        ok: true,
        already: true,
        rank: prevAct4.rank,
        currentAct: "waiting",
        group: groupPublicView(groupId, {
          ...group,
          currentAct: "waiting",
          act4: prevAct4,
        }),
      };
    }

    const configRef = CONFIG_DOC;
    const freshConfigSnap = await tx.get(configRef);
    const freshConfig = freshConfigSnap.exists ? freshConfigSnap.data() || {} : {};
    const freshPuzzle = freshConfig.puzzle || {};
    const nextCount = Number(freshPuzzle.act4ClearCount || 0) + 1;
    const act4 = {
      solved: true,
      rank: nextCount,
      clearedAt: FieldValue.serverTimestamp(),
    };

    tx.set(
      configRef,
      { puzzle: { act4ClearCount: nextCount } },
      { merge: true }
    );
    tx.update(groupRef, {
      currentAct: "waiting",
      act4,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      ok: true,
      rank: nextCount,
      currentAct: "waiting",
      group: groupPublicView(groupId, {
        ...group,
        currentAct: "waiting",
        act4: { solved: true, rank: nextCount },
      }),
    };
  });

  return result;
});

/**
 * submitAct2Answer — 品味家 / 判斷家 answer check (placeholder answers OK).
 */
exports.submitAct2Answer = onCall({ cors: true }, async (request) => {
  const player = await resolvePlayer(request.data);
  const { id, ambassador } = player;
  assertDrawnGamePlayer(ambassador);

  const role = String(ambassador.role || "");
  if (role !== "品味家" && role !== "判斷家") {
    throw new HttpsError(
      "failed-precondition",
      "此身分請依畫面指示完成任務（大力士由主領確認）"
    );
  }

  const answer = normalizeAnswer(request.data && request.data.answer);
  if (!answer) {
    throw new HttpsError("invalid-argument", "請輸入答案");
  }

  const groupId = String(ambassador.group_id || "").trim();
  if (!groupId) {
    throw new HttpsError("failed-precondition", "請先加入小組");
  }

  const configSnap = await CONFIG_DOC.get();
  const config = configSnap.exists ? configSnap.data() || {} : {};
  if (!puzzleConfigFrom(config).openingUnlocked) {
    throw new HttpsError("failed-precondition", "開場尚未解鎖");
  }
  const answers = (config.puzzle && config.puzzle.answers) || {};
  const expectedRaw =
    role === "品味家" ? answers.taster : answers.judge;
  const expected = normalizeAnswer(expectedRaw);
  if (!expected || expected === "placeholder") {
    throw new HttpsError(
      "failed-precondition",
      "答案尚未設定，請聯絡主辦後再試"
    );
  }
  if (answer !== expected) {
    throw new HttpsError("permission-denied", "答案不正確，請再想想");
  }

  const result = await db.runTransaction(async (tx) => {
    const publicSnap = await tx.get(db.collection("ambassadors_public").doc(id));
    const live = publicSnap.exists ? publicSnap.data() || {} : {};
    if (String(live.group_id || "") !== groupId) {
      throw new HttpsError("failed-precondition", "組別狀態已變更");
    }
    const groupRef = db.collection("groups").doc(groupId);
    const groupSnap = await tx.get(groupRef);
    if (!groupSnap.exists) {
      throw new HttpsError("not-found", "找不到組別");
    }
    const group = groupSnap.data() || {};
    if ((group.currentAct || "lobby") !== "act2") {
      throw new HttpsError("failed-precondition", "目前不在第二幕");
    }
    const act2 = { ...(group.act2 || emptyAct2()), [role]: true };
    tx.update(groupRef, {
      act2,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return groupPublicView(groupId, { ...group, act2 });
  });

  return { ok: true, correct: true, group: result };
});

/**
 * passAct2Role — admin one-tap pass for a group's act2 role task.
 */
exports.passAct2Role = onCall({ cors: true }, async (request) => {
  assertAdmin(request);
  const groupId = String((request.data && request.data.group_id) || "").trim();
  const role = String((request.data && request.data.role) || "").trim();
  if (!groupId) {
    throw new HttpsError("invalid-argument", "請提供組別 ID");
  }
  if (!GAME_ROLES.includes(role)) {
    throw new HttpsError(
      "invalid-argument",
      "role 須為 品味家、判斷家 或 大力士"
    );
  }

  const groupRef = db.collection("groups").doc(groupId);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(groupRef);
    if (!snap.exists) {
      throw new HttpsError("not-found", "找不到組別");
    }
    const group = snap.data() || {};
    const act2 = { ...(group.act2 || emptyAct2()), [role]: true };
    tx.update(groupRef, {
      act2,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return groupPublicView(groupId, { ...group, act2 });
  });

  return { ok: true, role, group: result };
});

/**
 * setPuzzleAnswers — admin updates act2 placeholder answers later.
 */
exports.setPuzzleAnswers = onCall({ cors: true }, async (request) => {
  assertAdmin(request);
  const data = request.data || {};
  const payload = {};
  if (data.taster !== undefined) payload.taster = String(data.taster ?? "");
  if (data.judge !== undefined) payload.judge = String(data.judge ?? "");
  if (!Object.keys(payload).length) {
    throw new HttpsError("invalid-argument", "請提供 taster 或 judge 答案");
  }
  await CONFIG_DOC.set({ puzzle: { answers: payload } }, { merge: true });
  return { ok: true };
});

exports.health = require("firebase-functions").https.onRequest((_req, res) => {
  res.status(200).json({
    ok: true,
    phase: 6,
    message:
      "draw + puzzle groups + multi-act progress ready",
  });
});

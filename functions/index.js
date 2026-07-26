/**
 * Phase 2 — Callable Cloud Functions for ambassador check-in & role draw.
 * All draw / killer / inventory logic runs here with Admin SDK only.
 */
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { randomInt } = require("crypto");

initializeApp();
setGlobalOptions({ region: "asia-east1" });

const db = getFirestore();
const CONFIG_DOC = db.collection("system_config").doc("main");

function normalizeId(raw) {
  return String(raw ?? "").trim();
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

  if (ambassador.is_drawn) {
    return {
      status: "already_drawn",
      ...publicPayload(ambassador),
    };
  }

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

    // Idempotent: already drawn → return existing role, never re-roll
    if (ambassador.is_drawn) {
      return publicPayload(ambassador, { status: "already_drawn" });
    }

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

    const role = pickRole(remaining);
    remaining[role] = Number(remaining[role]) - 1;

    const isKiller = decideKiller(killerRemaining, seatsRemaining);

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
          remaining: isKiller ? Math.max(0, killerRemaining - 1) : killerRemaining,
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
      const secret = secretSnap.exists ? secretSnap.data() || {} : {};
      const config = configSnap.exists ? configSnap.data() || {} : {};
      const remaining = {
        ...((config.role_pool && config.role_pool.remaining) || {}),
      };
      let killerRemaining = Number((config.killer && config.killer.remaining) || 0);

      const previousRole = String(ambassador.role || "").trim();
      const wasDrawn = ambassador.is_drawn === true || previousRole.length > 0;
      const wasKiller = secret.is_killer === true;

      if (!wasDrawn) {
        throw new HttpsError("failed-precondition", "此大使目前沒有可清除的身份");
      }

      if (previousRole) {
        remaining[previousRole] = Number(remaining[previousRole] || 0) + 1;
      }
      if (wasKiller) {
        killerRemaining += 1;
      }

      tx.set(
        publicRef,
        {
          id,
          name: ambassador.name || "",
          role: "",
          is_drawn: false,
          drawn_at: FieldValue.delete(),
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
      };
    })
    .sort((a, b) => Number(a.id) - Number(b.id) || String(a.id).localeCompare(String(b.id)));

  const header = "編號,姓名,角色,是否已抽取,抽籤時間";
  const csv = [
    header,
    ...rows.map(
      (r) =>
        `${r.id},${escapeCsv(r.name)},${escapeCsv(r.role)},${r.is_drawn ? "是" : "否"},${r.drawn_at}`
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
        is_killer: !!s.is_killer,
      };
    })
    .sort((a, b) => Number(a.id) - Number(b.id) || String(a.id).localeCompare(String(b.id)));

  const header = "編號,姓名,角色,是否已抽取,抽籤時間,是否兇手";
  const csv = [
    header,
    ...rows.map(
      (r) =>
        `${r.id},${escapeCsv(r.name)},${escapeCsv(r.role)},${r.is_drawn ? "是" : "否"},${r.drawn_at},${
          r.is_killer ? "是" : "否"
        }`
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

exports.health = require("firebase-functions").https.onRequest((_req, res) => {
  res.status(200).json({
    ok: true,
    phase: 5,
    message:
      "draw + admin ops + pin roster + restore-to-undrawn ready",
  });
});

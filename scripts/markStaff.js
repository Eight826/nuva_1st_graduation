/**
 * Mark fixed staff from scripts/data/staff.csv.
 *
 * - Sets is_staff: true, role: "工作人員", is_drawn: true
 * - Keeps is_attending as-is (default true)
 * - Recalculates role_pool for attending non-staff draw seats
 *
 * Usage:
 *   cd scripts && npm run mark-staff
 */
const fs = require("fs");
const { FieldValue } = require("@google-cloud/firestore");
const {
  PROJECT_ID,
  createDb,
  normalizeAmbassadorId,
  loadStaffRows,
  STAFF_ROLE,
  GAME_ROLES,
  allocateRolePool,
  isStaffRecord,
} = require("./lib/common");

async function main() {
  const staffRows = loadStaffRows();
  if (staffRows.length === 0) {
    throw new Error("scripts/data/staff.csv is missing or empty");
  }

  console.log(`Project: ${PROJECT_ID}`);
  console.log(`Staff to mark: ${staffRows.length}`);

  const db = createDb();
  const staffIds = new Set(staffRows.map((r) => r.id));
  const staffNameById = new Map(staffRows.map((r) => [r.id, r.name]));

  const publicSnap = await db.collection("ambassadors_public").get();
  const existing = new Map();
  publicSnap.docs.forEach((doc) => {
    const id = normalizeAmbassadorId(doc.id);
    existing.set(id, { ref: doc.ref, id, data: doc.data() || {} });
  });

  const missing = staffRows.filter((r) => !existing.has(r.id));
  if (missing.length) {
    console.log("\nMissing from Firestore:");
    for (const m of missing) console.log(`  ${m.id}\t${m.name}`);
    throw new Error(
      `${missing.length} staff id(s) not found in ambassadors_public — seed or create them first`
    );
  }

  let batch = db.batch();
  let ops = 0;

  async function flush(force = false) {
    if (ops === 0) return;
    if (!force && ops < 400) return;
    await batch.commit();
    batch = db.batch();
    ops = 0;
  }

  for (const { id, name } of staffRows) {
    const row = existing.get(id);
    const displayName = name || row.data.name || "";
    batch.set(
      row.ref,
      {
        id,
        name: displayName,
        role: STAFF_ROLE,
        is_drawn: true,
        is_staff: true,
        is_attending:
          row.data.is_attending === undefined ? true : !!row.data.is_attending,
        drawn_at: row.data.drawn_at || FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    batch.set(
      db.collection("ambassadors_secret").doc(id),
      {
        id,
        role: STAFF_ROLE,
        is_killer: false,
      },
      { merge: true }
    );
    ops += 2;
    row.data = {
      ...row.data,
      name: displayName,
      role: STAFF_ROLE,
      is_drawn: true,
      is_staff: true,
    };
    await flush(false);
  }

  // Role pool = attending ambassadors who are not staff (draw seats).
  const attendingRows = [...existing.values()].filter((r) => {
    const attending =
      r.data.is_attending === undefined ? true : !!r.data.is_attending;
    return attending;
  });
  const drawRows = attendingRows.filter(
    (r) => !isStaffRecord({ ...r.data, id: r.id }, staffIds)
  );
  const undrawnDraw = drawRows.filter(
    (r) => !(r.data.is_drawn === true || String(r.data.role || "").trim())
  ).length;
  const drawnByRole = {};
  for (const role of GAME_ROLES) drawnByRole[role] = 0;
  for (const r of drawRows) {
    const role = String(r.data.role || "").trim();
    if (r.data.is_drawn && GAME_ROLES.includes(role)) {
      drawnByRole[role] += 1;
    }
  }
  const remaining = allocateRolePool(undrawnDraw);
  const initial = {
    大力士: drawnByRole["大力士"] + remaining["大力士"],
    品味家: drawnByRole["品味家"] + remaining["品味家"],
    判斷家: drawnByRole["判斷家"] + remaining["判斷家"],
  };

  batch.set(
    db.collection("system_config").doc("main"),
    {
      role_pool: { remaining, initial },
      attending_count: attendingRows.length,
      draw_seat_count: drawRows.length,
      staff_count: staffIds.size,
      staff_marked_at: FieldValue.serverTimestamp(),
      ambassador_count: existing.size,
    },
    { merge: true }
  );
  ops += 1;
  await flush(true);

  console.log("\n=== Staff mark complete ===");
  for (const id of [...staffIds].sort((a, b) => Number(a) - Number(b))) {
    console.log(`  ${id}\t${staffNameById.get(id)}\t${STAFF_ROLE}`);
  }
  console.log(
    `\nDraw seats=${drawRows.length}, undrawn=${undrawnDraw}, staff=${staffIds.size}`
  );
  console.log(`role_pool.remaining=`, remaining);
  console.log(`role_pool.initial=`, initial);
}

main().catch((err) => {
  console.error("markStaff failed:", err.message || err);
  process.exit(1);
});

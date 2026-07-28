/**
 * Seed Firestore for Phase 1 foundation.
 *
 * Usage:
 *   1. Prefer: place serviceAccountKey.json at repo root
 *      OR: be logged in via `npx firebase-tools@latest login` (uses IAM Owner token)
 *   2. cd scripts && npm install
 *   3. npm run seed
 *
 * Inputs (scripts/data/):
 *   - ambassadors.csv (id,name) — preferred
 *   - falls back to 大使名單-工作表1.csv (編號,姓名)
 *   - optional attendees.csv — marks is_attending (實體出席)
 *   - optional staff.csv — fixed 工作人員 (is_staff, no game draw seats)
 *
 * Writes:
 *   - ambassadors_public / ambassadors_secret / checkin_codes / system_config
 *   - scripts/output/pin-roster.csv + pin-roster.txt (gitignored) for paper check-in
 *
 * ⚠ Full re-seed overwrites docs and regenerates PINs. Prefer
 *   `npm run mark-attendance` to update attendance on a live roster.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { FieldValue } = require("@google-cloud/firestore");
const {
  PROJECT_ID,
  createDb,
  parseNameIdCsv,
  allocateRolePool,
  loadStaffIds,
  STAFF_ROLE,
} = require("./lib/common");

const PIN_LENGTH = 6;

function resolveCsvPath() {
  const dataDir = path.join(__dirname, "data");
  const preferred = path.join(dataDir, "ambassadors.csv");
  const fallback = path.join(dataDir, "大使名單-工作表1.csv");
  if (fs.existsSync(preferred)) return preferred;
  if (fs.existsSync(fallback)) return fallback;
  throw new Error(
    "No ambassador CSV found. Place scripts/data/ambassadors.csv (id,name) or scripts/data/大使名單-工作表1.csv"
  );
}

function loadAttendingIds() {
  const attendeesPath = path.join(__dirname, "data", "attendees.csv");
  if (!fs.existsSync(attendeesPath)) return null;
  const rows = parseNameIdCsv(fs.readFileSync(attendeesPath, "utf8"));
  return new Set(rows.map((r) => r.id));
}

function generatePin(used) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const max = 10 ** PIN_LENGTH;
    const n = crypto.randomInt(0, max);
    const pin = String(n).padStart(PIN_LENGTH, "0");
    if (!used.has(pin)) {
      used.add(pin);
      return pin;
    }
  }
  throw new Error("Failed to generate unique PIN");
}

async function main() {
  console.log(`Project: ${PROJECT_ID}`);
  const db = createDb();

  const csvPath = resolveCsvPath();
  const ambassadors = parseNameIdCsv(fs.readFileSync(csvPath, "utf8"));
  if (ambassadors.length === 0) {
    throw new Error("No ambassadors parsed from CSV");
  }

  const attendingIds = loadAttendingIds();
  const staffIds = loadStaffIds();
  const attendingCount = attendingIds
    ? ambassadors.filter((a) => attendingIds.has(a.id)).length
    : ambassadors.length;
  const drawSeatCount = ambassadors.filter((a) => {
    const attending = attendingIds ? attendingIds.has(a.id) : true;
    return attending && !staffIds.has(a.id);
  }).length;

  // Pool seats follow who will actually draw (attending non-staff).
  const rolePool = allocateRolePool(drawSeatCount);
  const poolSum = rolePool.大力士 + rolePool.品味家 + rolePool.判斷家;
  console.log(`Ambassadors: ${ambassadors.length} (from ${path.basename(csvPath)})`);
  if (attendingIds) {
    console.log(`Attending (attendees.csv match): ${attendingCount}`);
  } else {
    console.log("No attendees.csv — treating all ambassadors as attending");
  }
  if (staffIds.size) {
    console.log(`Staff (staff.csv): ${staffIds.size} → draw seats: ${drawSeatCount}`);
  }
  console.log(`Role pool (2:1:1):`, rolePool, `sum=${poolSum}`);
  if (poolSum !== drawSeatCount) {
    console.warn(
      `Warning: role pool sum (${poolSum}) != draw seat count (${drawSeatCount})`
    );
  }

  const pinUsed = new Set();
  const roster = [];
  const batchSize = 400;
  let batch = db.batch();
  let ops = 0;

  async function commitIfNeeded(force = false) {
    if (ops === 0) return;
    if (!force && ops < batchSize) return;
    await batch.commit();
    batch = db.batch();
    ops = 0;
  }

  for (const { id, name } of ambassadors) {
    const pin = generatePin(pinUsed);
    const isAttending = attendingIds ? attendingIds.has(id) : true;
    const isStaff = staffIds.has(id);
    const publicRef = db.collection("ambassadors_public").doc(id);
    const secretRef = db.collection("ambassadors_secret").doc(id);
    const codeRef = db.collection("checkin_codes").doc(id);

    batch.set(publicRef, {
      id,
      name,
      role: isStaff ? STAFF_ROLE : "",
      is_drawn: isStaff,
      drawn_at: isStaff ? FieldValue.serverTimestamp() : null,
      is_attending: isAttending,
      is_staff: isStaff,
    });
    batch.set(secretRef, {
      id,
      is_killer: false,
      role: isStaff ? STAFF_ROLE : "",
    });
    batch.set(codeRef, {
      ambassador_id: id,
      pin,
      used: false,
    });
    ops += 3;
    roster.push({
      id,
      name,
      pin,
      is_attending: isAttending,
      is_staff: isStaff,
    });
    await commitIfNeeded(false);
  }

  const configRef = db.collection("system_config").doc("main");
  batch.set(configRef, {
    role_pool: {
      remaining: rolePool,
      initial: rolePool,
    },
    killer: {
      remaining: 1,
      initial: 1,
    },
    seeded_at: FieldValue.serverTimestamp(),
    ambassador_count: ambassadors.length,
    attending_count: attendingCount,
    draw_seat_count: drawSeatCount,
    staff_count: staffIds.size,
  });
  ops += 1;
  await commitIfNeeded(true);

  const rosterCsv = [
    "編號,姓名,PIN,實體出席,工作人員",
    ...roster.map(
      (r) =>
        `${r.id},${r.name},${r.pin},${r.is_attending ? "是" : "否"},${
          r.is_staff ? "是" : "否"
        }`
    ),
  ].join("\n");
  const rosterTxt = [
    "報到 PIN 對照表（請勿外流）",
    `專案: ${PROJECT_ID}`,
    `人數: ${roster.length}`,
    `實體出席: ${attendingCount}`,
    `工作人員: ${staffIds.size}`,
    `可抽籤名額: ${drawSeatCount}`,
    "",
    ...roster.map(
      (r) =>
        `${r.id}\t${r.name}\tPIN=${r.pin}\t出席=${r.is_attending ? "是" : "否"}\t工作人員=${
          r.is_staff ? "是" : "否"
        }`
    ),
  ].join("\n");

  const outDir = path.join(__dirname, "output");
  fs.mkdirSync(outDir, { recursive: true });
  const csvOut = path.join(outDir, "pin-roster.csv");
  const txtOut = path.join(outDir, "pin-roster.txt");
  fs.writeFileSync(csvOut, rosterCsv + "\n", "utf8");
  fs.writeFileSync(txtOut, rosterTxt + "\n", "utf8");

  console.log("\n=== Seed complete ===");
  console.log(`Wrote ${roster.length} ambassadors to Firestore`);
  console.log(`system_config/main → killer.remaining=1, role_pool=`, rolePool);
  console.log(`PIN roster: ${csvOut}`);
  console.log(`PIN roster: ${txtOut}`);
  console.log("\nSample (first 5):");
  for (const r of roster.slice(0, 5)) {
    console.log(
      `  ${r.id}  ${r.name}  PIN=${r.pin}  出席=${r.is_attending ? "是" : "否"}`
    );
  }
}

main().catch((err) => {
  console.error("Seed failed:", err.message || err);
  if (String(err.message || err).includes("Could not load the default credentials")) {
    console.error(
      "\nDownload a service account key:\n" +
        "  Firebase Console → Project settings → Service accounts → Generate new private key\n" +
        "  Save as ./serviceAccountKey.json (gitignored), then re-run npm run seed"
    );
  }
  process.exit(1);
});

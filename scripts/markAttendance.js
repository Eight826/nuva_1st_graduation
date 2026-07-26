/**
 * Mark physical-event attendance from scripts/data/attendees.csv.
 *
 * - Ambassadors listed in attendees.csv → is_attending: true
 * - Everyone else in ambassadors_public → is_attending: false
 * - Missing attendees can be created with a new PIN (--create-missing)
 * - Optionally resize role_pool to match attending seats (--sync-pool)
 *
 * Usage:
 *   cd scripts && npm run mark-attendance
 *   cd scripts && npm run mark-attendance -- --create-missing --sync-pool
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { FieldValue } = require("@google-cloud/firestore");
const {
  PROJECT_ID,
  createDb,
  normalizeAmbassadorId,
  parseNameIdCsv,
  allocateRolePool,
} = require("./lib/common");

const PIN_LENGTH = 6;
const ATTENDEES_PATH = path.join(__dirname, "data", "attendees.csv");

function hasFlag(name) {
  return process.argv.includes(name);
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
  const createMissing = hasFlag("--create-missing");
  const syncPool = hasFlag("--sync-pool");

  if (!fs.existsSync(ATTENDEES_PATH)) {
    throw new Error(`Missing ${ATTENDEES_PATH}`);
  }

  console.log(`Project: ${PROJECT_ID}`);
  console.log(`Attendees file: ${ATTENDEES_PATH}`);
  console.log(`Flags: create-missing=${createMissing}, sync-pool=${syncPool}`);

  const db = createDb();
  const attendees = parseNameIdCsv(fs.readFileSync(ATTENDEES_PATH, "utf8"));
  if (attendees.length === 0) {
    throw new Error("No attendees parsed from CSV");
  }

  const attendingIds = new Set(attendees.map((a) => a.id));
  const attendeeById = new Map(attendees.map((a) => [a.id, a.name]));

  const [publicSnap, codeSnap] = await Promise.all([
    db.collection("ambassadors_public").get(),
    db.collection("checkin_codes").get(),
  ]);

  const existing = new Map();
  publicSnap.docs.forEach((doc) => {
    existing.set(normalizeAmbassadorId(doc.id), {
      ref: doc.ref,
      id: normalizeAmbassadorId(doc.id),
      data: doc.data() || {},
    });
  });

  const usedPins = new Set();
  codeSnap.docs.forEach((doc) => {
    const pin = String((doc.data() || {}).pin || "");
    if (pin) usedPins.add(pin);
  });

  const missing = attendees.filter((a) => !existing.has(a.id));
  if (missing.length) {
    console.log(`\nMissing from Firestore (${missing.length}):`);
    for (const m of missing) console.log(`  ${m.id}\t${m.name}`);
    if (!createMissing) {
      console.log("  → re-run with --create-missing to create them (new PIN)");
    }
  }

  const createdPins = [];
  let batch = db.batch();
  let ops = 0;
  let created = 0;

  async function flush(force = false) {
    if (ops === 0) return;
    if (!force && ops < 400) return;
    await batch.commit();
    batch = db.batch();
    ops = 0;
  }

  // Create missing attendees first (optional).
  if (createMissing) {
    for (const { id, name } of missing) {
      const pin = generatePin(usedPins);
      batch.set(db.collection("ambassadors_public").doc(id), {
        id,
        name,
        role: "",
        is_drawn: false,
        drawn_at: null,
        is_attending: true,
      });
      batch.set(db.collection("ambassadors_secret").doc(id), {
        id,
        is_killer: false,
        role: "",
      });
      batch.set(db.collection("checkin_codes").doc(id), {
        ambassador_id: id,
        pin,
        used: false,
      });
      ops += 3;
      created += 1;
      createdPins.push({ id, name, pin });
      existing.set(id, {
        ref: db.collection("ambassadors_public").doc(id),
        id,
        data: { name, is_attending: true, is_drawn: false },
      });
      await flush(false);
    }
  }

  // Update attendance flags for everyone currently in the map.
  // Always write so legacy docs without the field get a concrete boolean.
  let markedTrue = 0;
  let markedFalse = 0;
  for (const [id, row] of existing.entries()) {
    const shouldAttend = attendingIds.has(id);
    batch.set(
      row.ref,
      {
        id,
        name: shouldAttend
          ? attendeeById.get(id) || row.data.name || ""
          : row.data.name || "",
        is_attending: shouldAttend,
      },
      { merge: true }
    );
    ops += 1;
    if (shouldAttend) markedTrue += 1;
    else markedFalse += 1;
    // Keep in-memory snapshot accurate for --sync-pool.
    row.data.is_attending = shouldAttend;
    await flush(false);
  }

  if (syncPool) {
    // Role pool seats = attending ambassadors who still need a role,
    // plus keep already-drawn attending roles accounted in initial.
    const attendingRows = [...existing.values()].filter((r) =>
      attendingIds.has(r.id)
    );
    const undrawnAttending = attendingRows.filter(
      (r) => !(r.data.is_drawn === true || String(r.data.role || "").trim())
    ).length;
    const drawnByRole = {};
    for (const r of attendingRows) {
      if (r.data.is_drawn && r.data.role) {
        const role = String(r.data.role);
        drawnByRole[role] = (drawnByRole[role] || 0) + 1;
      }
    }
    const remaining = allocateRolePool(undrawnAttending);
    const initial = {
      大力士: (drawnByRole["大力士"] || 0) + remaining["大力士"],
      品味家: (drawnByRole["品味家"] || 0) + remaining["品味家"],
      判斷家: (drawnByRole["判斷家"] || 0) + remaining["判斷家"],
    };
    batch.set(
      db.collection("system_config").doc("main"),
      {
        role_pool: { remaining, initial },
        attending_count: attendingIds.size,
        ambassador_count: existing.size,
        attendance_marked_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    ops += 1;
    console.log("\nSynced role pool to attending seats:");
    console.log(`  attending=${attendingIds.size}, undrawn=${undrawnAttending}`);
    console.log(`  remaining=`, remaining);
    console.log(`  initial=`, initial);
  } else {
    batch.set(
      db.collection("system_config").doc("main"),
      {
        attending_count: attendingIds.size,
        ambassador_count: existing.size,
        attendance_marked_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    ops += 1;
  }

  await flush(true);

  if (createdPins.length) {
    const outDir = path.join(__dirname, "output");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "new-attendee-pins.csv");
    const csv = [
      "編號,姓名,PIN",
      ...createdPins.map((r) => `${r.id},${r.name},${r.pin}`),
    ].join("\n");
    fs.writeFileSync(outPath, csv + "\n", "utf8");
    console.log(`\nNew PIN file: ${outPath}`);
    for (const r of createdPins) {
      console.log(`  ${r.id}  ${r.name}  PIN=${r.pin}`);
    }
  }

  const unresolved = createMissing
    ? []
    : missing.map((m) => `${m.id}:${m.name}`);

  console.log("\n=== Attendance mark complete ===");
  console.log(`Attending (CSV): ${attendingIds.size}`);
  console.log(`Marked attending writes: ${markedTrue}`);
  console.log(`Marked not-attending writes: ${markedFalse}`);
  console.log(`Created missing: ${created}`);
  if (unresolved.length) {
    console.log(`Unresolved (not in Firestore): ${unresolved.join(", ")}`);
  }
}

main().catch((err) => {
  console.error("markAttendance failed:", err.message || err);
  process.exit(1);
});

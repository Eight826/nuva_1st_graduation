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
 *
 * Writes:
 *   - ambassadors_public / ambassadors_secret / checkin_codes / system_config
 *   - scripts/output/pin-roster.csv + pin-roster.txt (gitignored) for paper check-in
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Firestore, FieldValue } = require("@google-cloud/firestore");
const { OAuth2Client, GoogleAuth } = require("google-auth-library");

const ROOT = path.resolve(__dirname, "..");
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "nuva-guraduation";
const PIN_LENGTH = 6;

function createDb() {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const keyCandidates = [
    envPath ? path.resolve(envPath) : null,
    path.join(ROOT, "serviceAccountKey.json"),
    path.join(__dirname, "serviceAccountKey.json"),
  ].filter(Boolean);

  for (const file of keyCandidates) {
    if (fs.existsSync(file)) {
      console.log(`Credential: ${file}`);
      return new Firestore({ projectId: PROJECT_ID, keyFilename: file });
    }
  }

  const configPath = path.join(
    os.homedir(),
    ".config",
    "configstore",
    "firebase-tools.json"
  );
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const tokens = config.tokens || {};
    if (tokens.access_token) {
      const expiresAt = Number(tokens.expires_at) || 0;
      if (expiresAt && expiresAt <= Date.now() + 60_000) {
        throw new Error(
          "Firebase CLI access token expired. Run: npx firebase-tools@latest login --reauth"
        );
      }
      console.log("Credential: firebase-tools access_token (IAM)");
      const authClient = new OAuth2Client();
      authClient.setCredentials({
        access_token: tokens.access_token,
        token_type: tokens.token_type || "Bearer",
      });
      // Prevent accidental refresh with firebase-tools client (often invalid_client).
      authClient.refreshAccessToken = async () => {
        throw new Error(
          "Access token expired during seed. Re-run: npx firebase-tools@latest login --reauth"
        );
      };
      return new Firestore({ projectId: PROJECT_ID, authClient });
    }
  }

  console.log("Credential: applicationDefault()");
  return new Firestore({
    projectId: PROJECT_ID,
    auth: new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    }),
  });
}

function parseCsv(text) {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error("CSV is empty or missing header");
  }

  const header = lines[0].split(",").map((h) => h.trim());
  const idIdx = header.findIndex((h) =>
    ["id", "編號", "ambassador_id"].includes(h.toLowerCase())
  );
  const nameIdx = header.findIndex((h) =>
    ["name", "姓名"].includes(h.toLowerCase())
  );

  if (idIdx < 0 || nameIdx < 0) {
    throw new Error(`CSV header must include id/編號 and name/姓名. Got: ${header.join(",")}`);
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const id = String(cols[idIdx] || "").trim();
    const name = String(cols[nameIdx] || "").trim();
    if (!id || !name) continue;
    rows.push({ id, name });
  }
  return rows;
}

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

/** Allocate remaining seats in 2:1:1 (大力士 : 品味家 : 判斷家). */
function allocateRolePool(total) {
  const overrideStrong = process.env.ROLE_POOL_大力士;
  const overrideTaste = process.env.ROLE_POOL_品味家;
  const overrideJudge = process.env.ROLE_POOL_判斷家;

  if (overrideStrong && overrideTaste && overrideJudge) {
    return {
      大力士: Number(overrideStrong),
      品味家: Number(overrideTaste),
      判斷家: Number(overrideJudge),
    };
  }

  const unit = Math.floor(total / 4);
  const 品味家 = unit;
  const 判斷家 = unit;
  const 大力士 = total - 品味家 - 判斷家;
  return { 大力士, 品味家, 判斷家 };
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
  const ambassadors = parseCsv(fs.readFileSync(csvPath, "utf8"));
  if (ambassadors.length === 0) {
    throw new Error("No ambassadors parsed from CSV");
  }

  const rolePool = allocateRolePool(ambassadors.length);
  const poolSum = rolePool.大力士 + rolePool.品味家 + rolePool.判斷家;
  console.log(`Ambassadors: ${ambassadors.length} (from ${path.basename(csvPath)})`);
  console.log(`Role pool (2:1:1):`, rolePool, `sum=${poolSum}`);
  if (poolSum !== ambassadors.length) {
    console.warn(`Warning: role pool sum (${poolSum}) != ambassador count (${ambassadors.length})`);
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
    const publicRef = db.collection("ambassadors_public").doc(id);
    const secretRef = db.collection("ambassadors_secret").doc(id);
    const codeRef = db.collection("checkin_codes").doc(id);

    batch.set(publicRef, {
      id,
      name,
      role: "",
      is_drawn: false,
      drawn_at: null,
    });
    batch.set(secretRef, {
      id,
      is_killer: false,
      role: "",
    });
    batch.set(codeRef, {
      ambassador_id: id,
      pin,
      used: false,
    });
    ops += 3;
    roster.push({ id, name, pin });
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
  });
  ops += 1;
  await commitIfNeeded(true);

  const rosterCsv = ["編號,姓名,PIN", ...roster.map((r) => `${r.id},${r.name},${r.pin}`)].join("\n");
  const rosterTxt = [
    "報到 PIN 對照表（請勿外流）",
    `專案: ${PROJECT_ID}`,
    `人數: ${roster.length}`,
    "",
    ...roster.map((r) => `${r.id}\t${r.name}\tPIN=${r.pin}`),
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
    console.log(`  ${r.id}  ${r.name}  PIN=${r.pin}`);
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

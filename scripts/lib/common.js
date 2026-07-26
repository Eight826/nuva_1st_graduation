/**
 * Shared helpers for Admin SDK maintenance scripts.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Firestore } = require("@google-cloud/firestore");
const { OAuth2Client, GoogleAuth } = require("google-auth-library");

const ROOT = path.resolve(__dirname, "..", "..");
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "nuva-guraduation";

function createDb() {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const keyCandidates = [
    envPath ? path.resolve(envPath) : null,
    path.join(ROOT, "serviceAccountKey.json"),
    path.join(__dirname, "..", "serviceAccountKey.json"),
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
      authClient.refreshAccessToken = async () => {
        throw new Error(
          "Access token expired during script. Re-run: npx firebase-tools@latest login --reauth"
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

/** Normalize numeric ambassador ids ("002" → "2", "000" → "0"). */
function normalizeAmbassadorId(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (/^\d+$/.test(s)) return String(Number(s));
  return s;
}

function parseNameIdCsv(text) {
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
    ["id", "編號", "大使編號", "ambassador_id"].includes(h.toLowerCase())
  );
  const nameIdx = header.findIndex((h) =>
    ["name", "姓名", "大使姓名"].includes(h.toLowerCase())
  );

  if (idIdx < 0 || nameIdx < 0) {
    throw new Error(
      `CSV header must include id/編號/大使編號 and name/姓名/大使姓名. Got: ${header.join(",")}`
    );
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const id = normalizeAmbassadorId(cols[idIdx]);
    const name = String(cols[nameIdx] || "").trim();
    if (!id || !name) continue;
    rows.push({ id, name });
  }
  return rows;
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

module.exports = {
  ROOT,
  PROJECT_ID,
  createDb,
  normalizeAmbassadorId,
  parseNameIdCsv,
  allocateRolePool,
};

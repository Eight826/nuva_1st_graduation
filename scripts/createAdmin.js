/**
 * Create (or verify) an Email/Password admin user via Identity Toolkit.
 *
 * Usage:
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='StrongPass!' node createAdmin.js
 *
 * If ADMIN_PASSWORD is omitted, a random password is generated and written to
 * scripts/output/admin-credentials.txt (gitignored).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyAi5mGcvdeQE05l6G3SMqjigeaPhT9NC4o";
const EMAIL = (process.env.ADMIN_EMAIL || "nuvadmin@gmail.com").trim();
const PASSWORD =
  process.env.ADMIN_PASSWORD ||
  crypto.randomBytes(9).toString("base64url") + "Aa1!";

async function signUp(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  return { status: res.status, body: await res.json() };
}

async function signIn(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  return { status: res.status, body: await res.json() };
}

async function main() {
  console.log(`Project API key present: ${!!API_KEY}`);
  console.log(`Admin email: ${EMAIL}`);

  const created = await signUp(EMAIL, PASSWORD);
  if (created.body && created.body.localId) {
    console.log("Created Email/Password user:", created.body.localId);
  } else if (
    created.body &&
    created.body.error &&
    /EMAIL_EXISTS/i.test(created.body.error.message || "")
  ) {
    console.log("User already exists — verifying password…");
    const login = await signIn(EMAIL, PASSWORD);
    if (!(login.body && login.body.localId)) {
      console.error(
        "Login failed. If the account already has a different password, set ADMIN_PASSWORD to that value or reset it in Firebase Console."
      );
      console.error(login.body && login.body.error);
      process.exit(1);
    }
    console.log("Password OK for existing user:", login.body.localId);
  } else {
    console.error("signUp failed:", created.body && created.body.error);
    process.exit(1);
  }

  const outDir = path.join(__dirname, "output");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, "admin-credentials.txt");
  const text = [
    "nuva admin credentials (do not commit / share)",
    `email=${EMAIL}`,
    `password=${PASSWORD}`,
    "login=https://nuva-guraduation.web.app/admin.html",
    "After first login, ensureAdminClaim grants { admin: true } for allowlisted emails.",
    "",
  ].join("\n");
  fs.writeFileSync(out, text, "utf8");
  console.log(`Wrote ${out}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.log("Generated password saved to scripts/output/admin-credentials.txt");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

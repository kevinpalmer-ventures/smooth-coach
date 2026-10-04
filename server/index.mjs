import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";
import jwt from "jsonwebtoken";
import mysql from "mysql2/promise";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";
const sessionCookie = "webdev_app_session";
const stateCookie = "smoothcoach_oauth_state";
const projectId = process.env.MANUS_PROJECT_ID;
const oauthPortalUrl = process.env.MANUS_OAUTH_PORTAL_URL;
const oauthApiUrl = process.env.MANUS_OAUTH_API_URL;
const jwtSecret = process.env.MANUS_JWT_SECRET;
const databaseUrl = process.env.DATABASE_URL;
const manusApiUrl = process.env.MANUS_API_URL;
const manusApiKey = process.env.MANUS_API_KEY;

if (!projectId || !oauthPortalUrl || !oauthApiUrl || !jwtSecret || !databaseUrl || !manusApiUrl || !manusApiKey) {
  throw new Error("Smooth Coach requires the managed OAuth, session, database, and storage environment variables.");
}

const pool = mysql.createPool({
  uri: databaseUrl,
  waitForConnections: true,
  connectionLimit: 6,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "50kb" }));
app.use(cookieParser());

const secureCookie = (maxAge) => ({
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
  ...(maxAge ? { maxAge } : {})
});

function publicOrigin(req) {
  const forwardedHost = req.get("x-forwarded-host");
  const host = (forwardedHost || req.get("host") || "").split(",")[0].trim();
  const forwardedProto = req.get("x-forwarded-proto");
  const protocol = (forwardedProto || "https").split(",")[0].trim();
  if (!host) throw new Error("Unable to determine the application origin.");
  return `${protocol}://${host}`;
}

function decodeState(encoded) {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return typeof parsed.nonce === "string" && typeof parsed.redirectUri === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function sessionFromRequest(req) {
  const token = req.cookies[sessionCookie];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] });
    if (typeof payload !== "object" || payload === null || payload.appId !== projectId) return null;
    const openId = payload.openId || payload.sub;
    if (typeof openId !== "string" || !openId) return null;
    return {
      openId,
      name: typeof payload.name === "string" ? payload.name : "Smooth Coach member",
      email: typeof payload.email === "string" ? payload.email : ""
    };
  } catch {
    return null;
  }
}

async function upsertUser(user) {
  await pool.execute(
    `INSERT INTO user_profiles (open_id, display_name, email)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), email = VALUES(email)`,
    [user.openId, user.name, user.email]
  );
}

function requireUser(req, res, next) {
  const user = sessionFromRequest(req);
  if (!user) return res.status(401).json({ error: "Sign in is required for this private account data." });
  req.smoothCoachUser = user;
  next();
}

async function ensureSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS user_profiles (
    open_id VARCHAR(255) PRIMARY KEY,
    display_name VARCHAR(255) NOT NULL,
    email VARCHAR(320) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_coach_state (
    open_id VARCHAR(255) PRIMARY KEY,
    state_json JSON NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_coach_state_user FOREIGN KEY (open_id) REFERENCES user_profiles(open_id) ON DELETE CASCADE
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS weight_entries (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    open_id VARCHAR(255) NOT NULL,
    weight DECIMAL(7,2) NOT NULL,
    unit ENUM('lb', 'kg') NOT NULL,
    logged_at DATE NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_weight_per_day (open_id, logged_at),
    KEY weight_entries_user_date (open_id, logged_at),
    CONSTRAINT fk_weight_user FOREIGN KEY (open_id) REFERENCES user_profiles(open_id) ON DELETE CASCADE
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS progress_photos (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    open_id VARCHAR(255) NOT NULL,
    storage_key VARCHAR(700) NOT NULL UNIQUE,
    captured_at DATE NOT NULL,
    caption VARCHAR(160) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY progress_photos_user_date (open_id, captured_at),
    CONSTRAINT fk_progress_photo_user FOREIGN KEY (open_id) REFERENCES user_profiles(open_id) ON DELETE CASCADE
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS progress_photo_uploads (
    storage_key VARCHAR(700) PRIMARY KEY,
    open_id VARCHAR(255) NOT NULL,
    content_type VARCHAR(50) NOT NULL,
    declared_size INT UNSIGNED NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY progress_photo_uploads_owner (open_id, expires_at),
    CONSTRAINT fk_progress_photo_upload_user FOREIGN KEY (open_id) REFERENCES user_profiles(open_id) ON DELETE CASCADE
  )`);
}

function validCoachState(state) {
  return state && typeof state === "object" && Number.isInteger(state.activeDay) && state.activeDay >= 1 && state.activeDay <= 10 && (state.planMode === "full" || state.planMode === "modified") && state.days && typeof state.days === "object" && typeof state.reminders === "boolean";
}

function mapWeights(rows) {
  return rows.map((row) => ({
    id: Number(row.id),
    weight: Number(row.weight),
    unit: row.unit,
    loggedAt: row.loggedAt
  }));
}

function isRealDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value);
}

const maxProgressPhotoBytes = 8 * 1024 * 1024;
const photoExtensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const photoPrefixFor = (openId) => `smooth-coach/progress-photos/${crypto.createHash("sha256").update(openId).digest("hex").slice(0, 32)}`;

async function storagePresign(action, key) {
  const endpoint = new URL(`/v1/storage/presign/${action}`, manusApiUrl);
  endpoint.searchParams.set("path", key);
  const response = await fetch(endpoint, { headers: { authorization: `Bearer ${manusApiKey}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.url !== "string") throw new Error(`Storage ${action} request failed`);
  return payload.url;
}

async function mapProgressPhotos(rows) {
  return Promise.all(rows.map(async (row) => ({
    id: Number(row.id),
    capturedAt: row.capturedAt,
    caption: row.caption,
    imageUrl: await storagePresign("get", row.storageKey)
  })));
}

async function verifyUploadedPhoto(key, expectedType, declaredSize) {
  const downloadUrl = await storagePresign("get", key);
  const response = await fetch(downloadUrl, { headers: { range: "bytes=0-31" } });
  const contentRange = response.headers.get("content-range");
  const sizeMatch = contentRange?.match(/\/(\d+)$/);
  const actualSize = Number(sizeMatch?.[1] ?? response.headers.get("content-length"));
  const actualType = response.headers.get("content-type")?.split(";", 1)[0].toLowerCase();
  await response.body?.cancel();
  if (!response.ok || actualType !== expectedType || !Number.isFinite(actualSize) || actualSize < 1 || actualSize > declaredSize || actualSize > maxProgressPhotoBytes) {
    throw new Error("Uploaded picture did not match its approved type or size.");
  }
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/auth/login", (req, res) => {
  const origin = publicOrigin(req);
  const redirectUri = `${origin}/api/auth/callback`;
  const nonce = crypto.randomBytes(24).toString("hex");
  const state = Buffer.from(JSON.stringify({ redirectUri, nonce })).toString("base64url");
  res.cookie(stateCookie, nonce, secureCookie(10 * 60 * 1000));
  const authorize = new URL("/app-auth", oauthPortalUrl);
  authorize.searchParams.set("appId", projectId);
  authorize.searchParams.set("redirectUri", redirectUri);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("responseType", "code");
  res.redirect(authorize.toString());
});

app.get("/api/auth/callback", async (req, res, next) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? decodeState(req.query.state) : null;
    const origin = publicOrigin(req);
    const expectedRedirectUri = `${origin}/api/auth/callback`;
    const cookieNonce = typeof req.cookies[stateCookie] === "string" ? req.cookies[stateCookie] : "";
    const nonceMatches = Boolean(state && cookieNonce && Buffer.byteLength(state.nonce) === Buffer.byteLength(cookieNonce) && crypto.timingSafeEqual(Buffer.from(state.nonce), Buffer.from(cookieNonce)));
    if (!code || !state || !nonceMatches || state.redirectUri !== expectedRedirectUri) {
      return res.status(400).send("The sign-in request could not be verified. Return to Smooth Coach and try again.");
    }
    res.clearCookie(stateCookie, secureCookie());
    const tokenResponse = await fetch(`${oauthApiUrl}/webdev.v1.WebDevAuthPublicService/ExchangeToken`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: projectId, grantType: "authorization_code", code, redirectUri: expectedRedirectUri })
    });
    if (!tokenResponse.ok) throw new Error("Token exchange failed");
    const token = await tokenResponse.json();
    const identityResponse = await fetch(`${oauthApiUrl}/webdev.v1.WebDevAuthPublicService/GetUserInfo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessToken: token.accessToken })
    });
    if (!identityResponse.ok) throw new Error("Identity lookup failed");
    const identity = await identityResponse.json();
    if (!identity.openId) throw new Error("Identity response did not include an account ID");
    const user = { openId: String(identity.openId), name: String(identity.name || "Smooth Coach member"), email: String(identity.email || "") };
    await upsertUser(user);
    const applicationSession = jwt.sign({ ...user, appId: projectId }, jwtSecret, { algorithm: "HS256", expiresIn: "30d" });
    res.cookie(sessionCookie, applicationSession, secureCookie(30 * 24 * 60 * 60 * 1000));
    res.redirect("/");
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie(sessionCookie, secureCookie());
  res.status(204).end();
});

app.get("/api/auth/me", async (req, res, next) => {
  try {
    const user = sessionFromRequest(req);
    if (!user) return res.status(401).json({ error: "Not signed in" });
    await upsertUser(user);
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

app.get("/api/coach-state", requireUser, async (req, res, next) => {
  try {
    await upsertUser(req.smoothCoachUser);
    const [rows] = await pool.execute("SELECT state_json AS stateJson FROM user_coach_state WHERE open_id = ?", [req.smoothCoachUser.openId]);
    const stateJson = rows[0]?.stateJson;
    const coachState = typeof stateJson === "string" ? JSON.parse(stateJson) : stateJson;
    res.json({ coachState: validCoachState(coachState) ? coachState : null });
  } catch (error) {
    next(error);
  }
});

app.put("/api/coach-state", requireUser, async (req, res, next) => {
  try {
    if (!validCoachState(req.body?.coachState)) return res.status(400).json({ error: "The coaching state was invalid." });
    await upsertUser(req.smoothCoachUser);
    await pool.execute(
      `INSERT INTO user_coach_state (open_id, state_json) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE state_json = VALUES(state_json)`,
      [req.smoothCoachUser.openId, JSON.stringify(req.body.coachState)]
    );
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/weights", requireUser, async (req, res, next) => {
  try {
    await upsertUser(req.smoothCoachUser);
    const [rows] = await pool.execute(
      "SELECT id, weight, unit, DATE_FORMAT(logged_at, '%Y-%m-%d') AS loggedAt FROM weight_entries WHERE open_id = ? ORDER BY logged_at ASC, id ASC",
      [req.smoothCoachUser.openId]
    );
    res.json({ weights: mapWeights(rows) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/weights", requireUser, async (req, res, next) => {
  try {
    const { weight, unit, loggedAt } = req.body ?? {};
    const numericWeight = Number(weight);
    const dateIsReal = isRealDate(loggedAt);
    if (!Number.isFinite(numericWeight) || numericWeight <= 0 || numericWeight > 1000 || !["lb", "kg"].includes(unit) || !dateIsReal) {
      return res.status(400).json({ error: "Enter a positive weight, a valid date, and lb or kg." });
    }
    await upsertUser(req.smoothCoachUser);
    const [existing] = await pool.execute("SELECT unit FROM weight_entries WHERE open_id = ? LIMIT 1", [req.smoothCoachUser.openId]);
    if (existing[0] && existing[0].unit !== unit) return res.status(400).json({ error: `Use ${existing[0].unit} to keep this account's timeline consistent.` });
    await pool.execute(
      `INSERT INTO weight_entries (open_id, weight, unit, logged_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE weight = VALUES(weight), unit = VALUES(unit), updated_at = CURRENT_TIMESTAMP`,
      [req.smoothCoachUser.openId, numericWeight, unit, loggedAt]
    );
    const [rows] = await pool.execute(
      "SELECT id, weight, unit, DATE_FORMAT(logged_at, '%Y-%m-%d') AS loggedAt FROM weight_entries WHERE open_id = ? ORDER BY logged_at ASC, id ASC",
      [req.smoothCoachUser.openId]
    );
    res.status(201).json({ weights: mapWeights(rows) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/progress-photos", requireUser, async (req, res, next) => {
  try {
    await upsertUser(req.smoothCoachUser);
    const [rows] = await pool.execute(
      "SELECT id, storage_key AS storageKey, DATE_FORMAT(captured_at, '%Y-%m-%d') AS capturedAt, caption FROM progress_photos WHERE open_id = ? ORDER BY captured_at ASC, id ASC",
      [req.smoothCoachUser.openId]
    );
    res.json({ photos: await mapProgressPhotos(rows) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/progress-photos/presign", requireUser, async (req, res, next) => {
  try {
    const { contentType, size, capturedAt } = req.body ?? {};
    if (typeof contentType !== "string" || !Object.hasOwn(photoExtensions, contentType) || !Number.isInteger(size) || size < 1 || size > maxProgressPhotoBytes || !isRealDate(capturedAt)) {
      return res.status(400).json({ error: "Choose a dated JPEG, PNG, or WebP image up to 8 MB." });
    }
    await upsertUser(req.smoothCoachUser);
    const prefix = photoPrefixFor(req.smoothCoachUser.openId);
    const key = `${prefix}/${capturedAt}/${crypto.randomUUID()}.${photoExtensions[contentType]}`;
    await pool.execute(
      "INSERT INTO progress_photo_uploads (storage_key, open_id, content_type, declared_size, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 15 MINUTE))",
      [key, req.smoothCoachUser.openId, contentType, size]
    );
    const uploadUrl = await storagePresign("put", key);
    res.json({ key, uploadUrl });
  } catch (error) {
    next(error);
  }
});

app.post("/api/progress-photos", requireUser, async (req, res, next) => {
  try {
    const { key, capturedAt, caption } = req.body ?? {};
    const prefix = `${photoPrefixFor(req.smoothCoachUser.openId)}/`;
    const safeCaption = typeof caption === "string" ? caption.trim() : "";
    if (typeof key !== "string" || !key.startsWith(prefix) || !isRealDate(capturedAt) || safeCaption.length > 160) {
      return res.status(400).json({ error: "That picture record was not valid." });
    }
    await upsertUser(req.smoothCoachUser);
    const [pendingUploads] = await pool.execute(
      "SELECT content_type AS contentType, declared_size AS declaredSize FROM progress_photo_uploads WHERE storage_key = ? AND open_id = ? AND expires_at > UTC_TIMESTAMP()",
      [key, req.smoothCoachUser.openId]
    );
    if (!pendingUploads[0]) return res.status(400).json({ error: "This upload was not approved or has expired. Choose the picture again." });
    await verifyUploadedPhoto(key, pendingUploads[0].contentType, Number(pendingUploads[0].declaredSize));
    await pool.execute(
      "INSERT INTO progress_photos (open_id, storage_key, captured_at, caption) VALUES (?, ?, ?, ?)",
      [req.smoothCoachUser.openId, key, capturedAt, safeCaption]
    );
    await pool.execute("DELETE FROM progress_photo_uploads WHERE storage_key = ? AND open_id = ?", [key, req.smoothCoachUser.openId]);
    const [rows] = await pool.execute(
      "SELECT id, storage_key AS storageKey, DATE_FORMAT(captured_at, '%Y-%m-%d') AS capturedAt, caption FROM progress_photos WHERE open_id = ? ORDER BY captured_at ASC, id ASC",
      [req.smoothCoachUser.openId]
    );
    res.status(201).json({ photos: await mapProgressPhotos(rows) });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error("Smooth Coach server error", error instanceof Error ? error.message : error);
  res.status(500).json({ error: "Smooth Coach could not complete that request. Please try again." });
});

await ensureSchema();

if (isProduction) {
  const dist = path.join(root, "dist");
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
}

app.listen(port, "0.0.0.0", () => console.log(`Smooth Coach is ready on port ${port}`));

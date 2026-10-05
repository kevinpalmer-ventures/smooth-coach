import crypto from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";
import multer from "multer";
import { createAuth } from "./auth.mjs";
import { ConfigError, loadConfig } from "./config.mjs";
import { createPool, describeDatabaseError, ensureSchema, retryTransient } from "./db.mjs";
import { describeError } from "./errors.mjs";
import { contentTypeForKey, createPhotoStorage, photoTypes, sniffImageType } from "./photoStorage.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function exitOnStartupFailure(component, reason) {
  console.error(`Smooth Coach could not start: ${component}: ${reason}`);
  process.exit(1);
}

let config;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

const pool = createPool(config.databaseUrl);
await retryTransient(() => ensureSchema(pool), {
  timeoutMs: config.databaseStartupTimeoutMs,
  onRetry: (error) => console.warn(`Smooth Coach is waiting for the database: ${describeDatabaseError(error, config.databaseUrl)}`)
}).catch((error) => exitOnStartupFailure("database", describeDatabaseError(error, config.databaseUrl)));
const auth = await createAuth({ config, pool }).catch((error) => exitOnStartupFailure("sign-in provider", describeError(error)));
const photoStorage = createPhotoStorage(config.s3);
await photoStorage.checkBucket().catch((error) => exitOnStartupFailure("photo storage", describeError(error)));
const { requireUser } = auth;

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "50kb" }));
app.use(cookieParser());

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

const selectWeights = `SELECT id, weight, unit, to_char(logged_at, 'YYYY-MM-DD') AS "loggedAt" FROM weight_entries WHERE open_id = $1 ORDER BY logged_at ASC, id ASC`;

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api/auth", auth.router);

app.get("/api/coach-state", requireUser, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT state_json AS "stateJson" FROM user_coach_state WHERE open_id = $1`, [req.smoothCoachUser.openId]);
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
    await pool.query(
      `INSERT INTO user_coach_state (open_id, state_json) VALUES ($1, $2::jsonb)
       ON CONFLICT (open_id) DO UPDATE SET state_json = EXCLUDED.state_json`,
      [req.smoothCoachUser.openId, JSON.stringify(req.body.coachState)]
    );
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/weights", requireUser, async (req, res, next) => {
  try {
    const { rows } = await pool.query(selectWeights, [req.smoothCoachUser.openId]);
    res.json({ weights: mapWeights(rows) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/weights", requireUser, async (req, res, next) => {
  try {
    const { weight, unit, loggedAt } = req.body ?? {};
    const numericWeight = Number(weight);
    if (!Number.isFinite(numericWeight) || numericWeight <= 0 || numericWeight > 1000 || !["lb", "kg"].includes(unit) || !isRealDate(loggedAt)) {
      return res.status(400).json({ error: "Enter a positive weight, a valid date, and lb or kg." });
    }
    const { rows: existing } = await pool.query("SELECT unit FROM weight_entries WHERE open_id = $1 LIMIT 1", [req.smoothCoachUser.openId]);
    if (existing[0] && existing[0].unit !== unit) return res.status(400).json({ error: `Use ${existing[0].unit} to keep this account's timeline consistent.` });
    await pool.query(
      `INSERT INTO weight_entries (open_id, weight, unit, logged_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (open_id, logged_at) DO UPDATE SET weight = EXCLUDED.weight, unit = EXCLUDED.unit, updated_at = CURRENT_TIMESTAMP`,
      [req.smoothCoachUser.openId, numericWeight, unit, loggedAt]
    );
    const { rows } = await pool.query(selectWeights, [req.smoothCoachUser.openId]);
    res.status(201).json({ weights: mapWeights(rows) });
  } catch (error) {
    next(error);
  }
});

const maxPhotoBytes = 8 * 1024 * 1024;
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxPhotoBytes, files: 1, fields: 2, fieldSize: 1024 } }).single("photo");
const photoKeyPrefix = (openId) => `progress-photos/${crypto.createHash("sha256").update(openId).digest("hex").slice(0, 32)}`;

function receivePhoto(req, res, next) {
  photoUpload(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Choose a dated JPEG, PNG, or WebP image up to 8 MB." });
    if (error instanceof multer.MulterError) return res.status(400).json({ error: "That picture upload was not valid." });
    next(error);
  });
}

async function listPhotos(openId) {
  const { rows } = await pool.query(
    `SELECT id, to_char(captured_at, 'YYYY-MM-DD') AS "capturedAt", caption FROM progress_photos WHERE open_id = $1 ORDER BY captured_at ASC, id ASC`,
    [openId]
  );
  return rows.map((row) => ({ id: Number(row.id), capturedAt: row.capturedAt, caption: row.caption, imageUrl: `/api/progress-photos/${row.id}/image` }));
}

app.get("/api/progress-photos", requireUser, async (req, res, next) => {
  try {
    res.json({ photos: await listPhotos(req.smoothCoachUser.openId) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/progress-photos", requireUser, receivePhoto, async (req, res, next) => {
  try {
    const { openId } = req.smoothCoachUser;
    const contentType = req.file ? sniffImageType(req.file.buffer) : null;
    if (!contentType) return res.status(400).json({ error: "Choose a JPEG, PNG, or WebP image up to 8 MB." });
    const { capturedAt, caption } = req.body ?? {};
    const safeCaption = typeof caption === "string" ? caption.trim() : "";
    if (!isRealDate(capturedAt) || safeCaption.length > 160) return res.status(400).json({ error: "That picture record was not valid." });
    const key = `${photoKeyPrefix(openId)}/${capturedAt}/${crypto.randomUUID()}.${photoTypes[contentType]}`;
    await photoStorage.putPhoto(key, req.file.buffer, contentType);
    try {
      await pool.query("INSERT INTO progress_photos (open_id, storage_key, captured_at, caption) VALUES ($1, $2, $3, $4)", [openId, key, capturedAt, safeCaption]);
    } catch (error) {
      await photoStorage.deletePhoto(key).catch((cleanupError) => console.error("Smooth Coach photo cleanup failed", cleanupError.message));
      throw error;
    }
    res.status(201).json({ photos: await listPhotos(openId) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/progress-photos/:id/image", requireUser, async (req, res, next) => {
  try {
    if (!/^[1-9]\d{0,17}$/.test(req.params.id)) return res.status(404).json({ error: "Picture not found." });
    const { rows } = await pool.query(`SELECT storage_key AS "storageKey" FROM progress_photos WHERE id = $1 AND open_id = $2`, [req.params.id, req.smoothCoachUser.openId]);
    if (!rows[0]) return res.status(404).json({ error: "Picture not found." });
    const stream = await photoStorage.getPhotoStream(rows[0].storageKey);
    if (!stream) return res.status(404).json({ error: "Picture not found." });
    res.set({ "content-type": contentTypeForKey(rows[0].storageKey), "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" });
    pipeline(stream, res, (error) => {
      if (error && error.code !== "ERR_STREAM_PREMATURE_CLOSE") console.error("Smooth Coach photo storage stream failed", error.message);
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error("Smooth Coach server error", describeError(error));
  res.status(500).json({ error: "Smooth Coach could not complete that request. Please try again." });
});

if (config.isProduction) {
  const dist = path.join(root, "dist");
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
}

app.listen(config.port, "0.0.0.0", () => console.log(`Smooth Coach is ready on port ${config.port}`));

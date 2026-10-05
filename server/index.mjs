import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";
import { createAuth } from "./auth.mjs";
import { ConfigError, loadConfig } from "./config.mjs";
import { createPool, ensureSchema } from "./db.mjs";
import { createPhotoStorage } from "./photoStorage.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function exitOnStartupFailure(component, error) {
  console.error(`Smooth Coach could not start: ${component}: ${error.message}`);
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
await ensureSchema(pool).catch((error) => exitOnStartupFailure("database", error));
const auth = await createAuth({ config, pool }).catch((error) => exitOnStartupFailure("sign-in provider", error));
const photoStorage = createPhotoStorage(config.s3);
await photoStorage.checkBucket().catch((error) => exitOnStartupFailure("photo storage", error));
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

app.use((error, _req, res, _next) => {
  console.error("Smooth Coach server error", error instanceof Error ? error.message : error);
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

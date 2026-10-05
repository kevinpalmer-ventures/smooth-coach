// PostgreSQL pool and startup schema management.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describeError } from "./errors.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaFile = path.join(root, "deploy", "postgres", "smooth-coach-schema.sql");
const schemaLockId = 7317204517;

// TLS is configured through DATABASE_URL (sslmode=verify-full, plus sslrootcert=/path/to/ca.pem
// when the provider uses its own certificate authority), so certificate validation stays on.
export function createPool(databaseUrl) {
  // The connection timeout makes a firewall that silently drops packets fail in about 10 seconds.
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 6, connectionTimeoutMillis: 10000 });
  pool.on("error", (error) => console.error("Smooth Coach database pool error", describeError(error)));
  return pool;
}

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function refusedConnection(error) {
  return error?.code === "ECONNREFUSED" || (Array.isArray(error?.errors) && error.errors.some((item) => item?.code === "ECONNREFUSED"));
}

// The startup failure reason for a database error. Never includes the URL, only its host class.
export function describeDatabaseError(error, databaseUrl) {
  let host = "";
  try {
    host = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    // An unparseable URL gets no hint; the error itself still names the failure.
  }
  const reason = describeError(error);
  if (!refusedConnection(error) || !loopbackHosts.has(host)) return reason;
  return `${reason} (DATABASE_URL points at ${host}; inside the container that is the container itself, so use host.docker.internal for a PostgreSQL server on the Docker host)`;
}

// Applies the idempotent, additive schema shared with deploy/postgres/setup-smooth-coach-postgres.sh.
// The advisory lock keeps concurrently starting containers from applying it at the same time.
export async function ensureSchema(pool) {
  const schemaSql = await readFile(schemaFile, "utf8");
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [schemaLockId]);
    await client.query(schemaSql);
    await client.query("SELECT pg_advisory_unlock($1)", [schemaLockId]);
    client.release();
  } catch (error) {
    // Discarding the connection also rolls back the open transaction and drops the advisory lock.
    client.release(true);
    throw error;
  }
}

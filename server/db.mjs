// PostgreSQL pool and startup schema management.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaFile = path.join(root, "deploy", "postgres", "smooth-coach-schema.sql");
const schemaLockId = 7317204517;

// TLS is configured through DATABASE_URL (sslmode=verify-full, plus sslrootcert=/path/to/ca.pem
// when the provider uses its own certificate authority), so certificate validation stays on.
export function createPool(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
  pool.on("error", (error) => console.error("Smooth Coach database pool error", error.message));
  return pool;
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

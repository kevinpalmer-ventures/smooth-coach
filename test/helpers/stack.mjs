// Connection details for the services in test/compose.yml, plus one fresh database per test file.
import crypto from "node:crypto";
import pg from "pg";
import { createPhotoStorage } from "../../server/photoStorage.mjs";

const postgresBase = "postgresql://postgres:smooth-coach-test@127.0.0.1:55433";

export const stack = Object.freeze({
  adminDatabaseUrl: `${postgresBase}/postgres`,
  garageAdminUrl: "http://127.0.0.1:39903",
  garageAdminToken: "smooth-coach-test-admin-token",
  s3: Object.freeze({
    endpoint: "http://127.0.0.1:39900",
    region: "garage",
    bucket: "smooth-coach-test",
    accessKeyId: "GK0123456789abcdef01234567",
    secretAccessKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    forcePathStyle: true
  })
});

// Waits until PostgreSQL accepts connections and garage-init has created the test bucket.
export async function waitForStack(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  const storage = createPhotoStorage(stack.s3);
  let lastError;
  try {
    while (Date.now() < deadline) {
      try {
        const client = new pg.Client({ connectionString: stack.adminDatabaseUrl });
        await client.connect();
        await client.end();
        await storage.checkBucket();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  } finally {
    storage.destroy();
  }
  throw new Error(`Test stack is not ready (${lastError?.message ?? "unknown error"}). Start it with: npm run test:stack:up`);
}

export async function createTestDatabase() {
  await waitForStack();
  const name = `smooth_coach_test_${crypto.randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: stack.adminDatabaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return {
    databaseUrl: `${postgresBase}/${name}?sslmode=disable`,
    async drop() {
      const client = new pg.Client({ connectionString: stack.adminDatabaseUrl });
      await client.connect();
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await client.end();
    }
  };
}

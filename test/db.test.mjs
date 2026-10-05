import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPool, ensureSchema } from "../server/db.mjs";
import { createTestDatabase } from "./helpers/stack.mjs";

describe("ensureSchema", () => {
  let database;
  before(async () => {
    database = await createTestDatabase();
  });
  after(() => database.drop());

  it("creates the four application tables and three triggers, idempotently and concurrently", async () => {
    const pools = [createPool(database.databaseUrl), createPool(database.databaseUrl)];
    try {
      await Promise.all(pools.map((pool) => ensureSchema(pool)));
      await ensureSchema(pools[0]);
      const { rows: tables } = await pools[0].query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
      assert.deepEqual(tables.map((row) => row.tablename), ["progress_photos", "user_coach_state", "user_profiles", "weight_entries"]);
      const { rows: triggers } = await pools[0].query("SELECT count(*)::int AS count FROM pg_trigger WHERE NOT tgisinternal");
      assert.equal(triggers[0].count, 3);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  });
});

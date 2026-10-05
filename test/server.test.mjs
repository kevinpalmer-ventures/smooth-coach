import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { requiredVariables } from "../server/config.mjs";
import { startFakeOidc } from "./helpers/fake-oidc.mjs";
import { baseEnv, freePort, runServerUntilExit, startServer, testSessionSecret } from "./helpers/server.mjs";
import { api, signIn } from "./helpers/session.mjs";
import { createTestDatabase } from "./helpers/stack.mjs";
import { startTcpProxy } from "./helpers/tcp-proxy.mjs";

describe("server startup", () => {
  let provider;
  let database;

  before(async () => {
    provider = await startFakeOidc();
    database = await createTestDatabase();
  });
  after(async () => {
    await provider.close();
    await database.drop();
  });

  async function expectStartupFailure(env, pattern) {
    const { code, output } = await runServerUntilExit(env);
    assert.notEqual(code, 0);
    assert.match(output, pattern);
    assert.ok(!output.includes(testSessionSecret), "output must not include secrets");
  }

  it("names every missing variable and exits", async () => {
    const { code, output } = await runServerUntilExit({});
    assert.notEqual(code, 0);
    assert.ok(output.includes(`Smooth Coach requires these environment variables: ${requiredVariables.join(", ")}`), output);
  });

  it("names the database when PostgreSQL is unreachable", async () => {
    const env = { ...baseEnv({ databaseUrl: "postgresql://postgres:nope@127.0.0.1:1/none?sslmode=disable", provider, port: await freePort() }), DATABASE_STARTUP_TIMEOUT: "1" };
    await expectStartupFailure(env, /Smooth Coach could not start: database: \S/);
  });

  it("waits for a database that becomes reachable after startup", async () => {
    const target = new URL(database.databaseUrl);
    const delayedPort = await freePort();
    const delayedUrl = database.databaseUrl.replace(`${target.hostname}:${target.port}`, `127.0.0.1:${delayedPort}`);
    const startup = startServer(baseEnv({ databaseUrl: delayedUrl, provider, port: await freePort() }));
    startup.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const proxy = await startTcpProxy(Number(target.port), target.hostname, delayedPort);
    let server;
    try {
      server = await startup;
      assert.match(server.output(), /Smooth Coach is waiting for the database: .*ECONNREFUSED/);
      assert.deepEqual((await api(server, "/api/health")).data, { ok: true });
    } finally {
      await server?.stop();
      await proxy.close();
    }
  });

  it("explains a refused localhost database connection without printing the password", async () => {
    const env = { ...baseEnv({ databaseUrl: "postgresql://postgres:hunter2-secret@localhost:1/none?sslmode=disable", provider, port: await freePort() }), DATABASE_STARTUP_TIMEOUT: "1" };
    const { code, output } = await runServerUntilExit(env);
    assert.notEqual(code, 0);
    assert.match(output, /Smooth Coach could not start: database: \S/);
    assert.match(output, /ECONNREFUSED/);
    assert.match(output, /host\.docker\.internal/);
    assert.ok(!output.includes("hunter2-secret"), "output must not include the database password");
  });

  it("names the sign-in provider when OIDC_ISSUER is unreachable", async () => {
    const env = { ...baseEnv({ databaseUrl: database.databaseUrl, provider, port: await freePort() }), OIDC_ISSUER: "http://127.0.0.1:1" };
    await expectStartupFailure(env, /Smooth Coach could not start: sign-in provider: could not load provider configuration from OIDC_ISSUER/);
  });

  it("names photo storage when the bucket is missing", async () => {
    const env = { ...baseEnv({ databaseUrl: database.databaseUrl, provider, port: await freePort() }), S3_BUCKET: "missing-bucket" };
    await expectStartupFailure(env, /Smooth Coach could not start: photo storage: bucket "missing-bucket" does not exist/);
  });
});

describe("coach state and weights API", () => {
  let provider;
  let database;
  let server;
  let alice;
  let bob;

  before(async () => {
    provider = await startFakeOidc();
    database = await createTestDatabase();
    server = await startServer(baseEnv({ databaseUrl: database.databaseUrl, provider, port: await freePort() }));
    ({ cookie: alice } = await signIn(server, provider, { sub: "alice", name: "Alice Test", email: "alice@example.test" }));
    ({ cookie: bob } = await signIn(server, provider, { sub: "bob", name: "Bob Test", email: "bob@example.test" }));
  });
  after(async () => {
    await server?.stop();
    await provider?.close();
    await database?.drop();
  });

  it("reports health and the signed-in user", async () => {
    assert.deepEqual((await api(server, "/api/health")).data, { ok: true });
    assert.equal((await api(server, "/api/auth/me", { cookie: alice })).data.user.name, "Alice Test");
  });

  it("requires a session for private data", async () => {
    assert.equal((await api(server, "/api/coach-state")).status, 401);
    assert.equal((await api(server, "/api/weights")).status, 401);
    assert.equal((await api(server, "/api/coach-state", { method: "PUT", json: { coachState: {} } })).status, 401);
    assert.equal((await api(server, "/api/weights", { method: "POST", json: { weight: 150, unit: "lb", loggedAt: "2026-09-01" } })).status, 401);
  });

  it("stores, updates, validates, and isolates coach state", async () => {
    assert.equal((await api(server, "/api/coach-state", { cookie: alice })).data.coachState, null);
    const state = { activeDay: 3, planMode: "modified", days: { 1: { tasks: ["prep", "morning"], water: 5, reflection: "Feeling good — ünïcode ✓" } }, reminders: false };
    assert.equal((await api(server, "/api/coach-state", { cookie: alice, method: "PUT", json: { coachState: state } })).status, 204);
    assert.deepEqual((await api(server, "/api/coach-state", { cookie: alice })).data.coachState, JSON.parse(JSON.stringify(state)));
    await api(server, "/api/coach-state", { cookie: alice, method: "PUT", json: { coachState: { ...state, activeDay: 4 } } });
    assert.equal((await api(server, "/api/coach-state", { cookie: alice })).data.coachState.activeDay, 4);
    assert.equal((await api(server, "/api/coach-state", { cookie: alice, method: "PUT", json: { coachState: { activeDay: 11 } } })).status, 400);
    assert.equal((await api(server, "/api/coach-state", { cookie: bob })).data.coachState, null);
  });

  it("stores, updates, validates, and isolates weights", async () => {
    const first = await api(server, "/api/weights", { cookie: alice, method: "POST", json: { weight: 154.2, unit: "lb", loggedAt: "2026-09-01" } });
    assert.equal(first.status, 201);
    assert.equal(typeof first.data.weights[0].id, "number");
    assert.deepEqual(first.data.weights.map(({ weight, unit, loggedAt }) => ({ weight, unit, loggedAt })), [{ weight: 154.2, unit: "lb", loggedAt: "2026-09-01" }]);
    await api(server, "/api/weights", { cookie: alice, method: "POST", json: { weight: 150, unit: "lb", loggedAt: "2026-08-25" } });
    const updated = await api(server, "/api/weights", { cookie: alice, method: "POST", json: { weight: 153.6, unit: "lb", loggedAt: "2026-09-01" } });
    assert.deepEqual(updated.data.weights.map((entry) => [entry.loggedAt, entry.weight]), [["2026-08-25", 150], ["2026-09-01", 153.6]]);
    const wrongUnit = await api(server, "/api/weights", { cookie: alice, method: "POST", json: { weight: 70, unit: "kg", loggedAt: "2026-09-02" } });
    assert.equal(wrongUnit.status, 400);
    assert.match(wrongUnit.data.error, /lb/);
    assert.equal((await api(server, "/api/weights", { cookie: alice, method: "POST", json: { weight: 150, unit: "lb", loggedAt: "2026-02-30" } })).status, 400);
    assert.deepEqual((await api(server, "/api/weights", { cookie: alice })).data.weights, updated.data.weights);
    assert.deepEqual((await api(server, "/api/weights", { cookie: bob })).data.weights, []);
    const bobKg = await api(server, "/api/weights", { cookie: bob, method: "POST", json: { weight: 70.5, unit: "kg", loggedAt: "2026-09-01" } });
    assert.equal(bobKg.status, 201);
    assert.equal(bobKg.data.weights.length, 1);
  });
});

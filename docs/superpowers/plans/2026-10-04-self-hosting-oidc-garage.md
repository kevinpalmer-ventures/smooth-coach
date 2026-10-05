# Smooth Coach 3.0.0 Self-Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every Manus dependency so Smooth Coach runs on the owner's Docker host with OpenID Connect sign-in and photos stored in a self-hosted Garage bucket, released as 3.0.0.

**Architecture:** The 414-line `server/index.mjs` is split into `config.mjs` (env validation), `db.mjs` (pool + schema), `auth.mjs` (OIDC via `openid-client` + session cookie), and `photoStorage.mjs` (S3 client for Garage + image sniffing); `index.mjs` keeps startup, routes, and serving. Photos travel through the app server (multipart upload, authenticated image route); Garage is only on the internal Docker network. A `docker-compose.yml` runs the app, Garage, and a one-shot `garage-init` container; PostgreSQL is the owner's existing server.

**Tech Stack:** Node 22 (ESM `.mjs`), Express 4, `pg`, `openid-client` 6, `@aws-sdk/client-s3` 3, `multer` 2, React 18 + Vite 5 (frontend), Garage v2.4.1, `node:test` + Docker Compose for tests.

**Spec:** `docs/superpowers/specs/2026-10-04-self-hosting-oidc-garage-design.md`

## Global Constraints

- Node 22+ runtime (Docker base `node:22-alpine`); server code is ESM `.mjs`.
- PostgreSQL 14+; schema changes are additive only — never add `DROP` statements.
- Garage image pinned to `dxflrs/garage:v2.4.1` (never `latest`); setup uses Garage admin API v2.
- Dependencies: `openid-client@^6.8.8`, `@aws-sdk/client-s3@^3.1146.0`, `multer@^2.4.0`; no other new runtime dependencies.
- Never print secret values: errors and logs name variables or components only.
- Photos: JPEG, PNG, or WebP detected from file bytes; max 8 MiB (`8 * 1024 * 1024`); caption trimmed, max 160 characters (longer → 400, never truncated).
- Cookies: `smooth_coach_session` (30 days, `Path=/`) and `smooth_coach_login` (10 minutes, `Path=/api/auth`); both `HttpOnly`, `Secure`, `SameSite=Lax`.
- Account ID stored in `open_id` is `${issuer}|${sub}`.
- Required env: `DATABASE_URL`, `APP_URL`, `SESSION_SECRET`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Optional: `S3_REGION` (default `us-east-1`), `S3_FORCE_PATH_STYLE` (default `true`), `PORT` (default `3000`).
- Conventional Commits; every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work on branch `feat/self-hosting`; nothing is pushed to the remote or Docker Hub without the user's explicit confirmation.
- Integration tests need the test stack: `npm run test:stack:up` (Docker). Unit tests run without it.
- `npm test` runs `node --test "test/*.test.mjs"` (explicit glob). A bare `node --test` would also run every `.mjs` under `test/` (helpers, smoke script) as test files on Node 22+.

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `server/config.mjs` | Create | Read and validate env; `loadConfig`, `ConfigError`, `requiredVariables` |
| `server/db.mjs` | Create | `createPool`, `ensureSchema` |
| `server/auth.mjs` | Create | OIDC discovery, login/callback/logout/me, session cookie, `requireUser` |
| `server/photoStorage.mjs` | Create | S3 client for Garage, `sniffImageType`, error descriptions |
| `server/index.mjs` | Rewrite | Startup sequence, Express wiring, coach-state/weight/photo routes, serving |
| `deploy/garage/garage.toml` | Create | Single-node Garage config (no secrets) |
| `deploy/garage/setup.mjs` | Create | Idempotent Garage setup logic (admin API v2) |
| `deploy/garage/init.mjs` | Create | Container entry point for `garage-init` |
| `deploy/postgres/smooth-coach-schema.sql` | Modify | Drop `progress_photo_uploads` creation; document `open_id` |
| `deploy/postgres/setup-smooth-coach-postgres.sh` | Modify | Verify 4 tables |
| `docker-compose.yml` | Create | `app`, `garage`, `garage-init` |
| `.env.example` | Rewrite | 3.0.0 variables |
| `src/App.tsx` | Modify | Single multipart photo upload |
| `test/compose.yml` | Create | Throwaway PostgreSQL + Garage for tests |
| `test/helpers/*.mjs` | Create | Stack details, fake OIDC provider, server spawning, sessions, image fixtures, TCP proxy |
| `test/*.test.mjs` | Create | Unit and integration tests |
| `test/fixtures/compose.env` | Create | Dummy values for compose validation |
| `test/smoke/*` | Create | Container smoke test of the built image |
| `README.md` | Create | Self-hosting guide |
| `plan.md`, `TODO.md`, `deploy/CLAUDE_DATABASE_SETUP.md` | Modify | Remove Manus and upload-intent references |
| `app.config.ts`, `public/manus-routes.json` | Delete | Unreferenced Manus leftovers |
| `vite.config.ts` | Modify | Remove Manus sandbox host |
| `CHANGELOG.md`, `package.json`, `package-lock.json` | Modify | 3.0.0 release |

---

### Task 1: Configuration module

**Files:**
- Create: `server/config.mjs`
- Create: `test/config.test.mjs`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `requiredVariables: string[]` — the 10 required names in the order listed in Global Constraints.
  - `class ConfigError extends Error` (`name === "ConfigError"`).
  - `loadConfig(env = process.env)` → frozen `{ databaseUrl, appUrl /* origin, no trailing slash */, sessionSecret, oidc: { issuer, clientId, clientSecret }, s3: { endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle /* boolean */ }, port /* number */, isProduction /* boolean */ }`. Missing variables → `ConfigError("Smooth Coach requires these environment variables: A, B")`; invalid values → `ConfigError("Smooth Coach configuration is invalid: problem; problem")`.

- [ ] **Step 1: Create the feature branch**

```bash
git switch -c feat/self-hosting
```

- [ ] **Step 2: Add test scripts to `package.json`**

Replace the `"scripts"` block with:

```json
  "scripts": {
    "dev": "node server/index.mjs",
    "build": "tsc --noEmit && vite build",
    "start": "node server/index.mjs",
    "test": "node --test \"test/*.test.mjs\"",
    "test:stack:up": "docker compose -f test/compose.yml up -d",
    "test:stack:down": "docker compose -f test/compose.yml down -v"
  },
```

- [ ] **Step 3: Write the failing test** — `test/config.test.mjs`

```js
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, loadConfig, requiredVariables } from "../server/config.mjs";

const secretValue = "do-not-print-this-secret-value-0123456789";

const validEnv = () => ({
  DATABASE_URL: "postgresql://app:pw@db.example.com:5432/smooth_coach?sslmode=verify-full",
  APP_URL: "https://coach.example.com",
  SESSION_SECRET: secretValue,
  OIDC_ISSUER: "https://accounts.google.com",
  OIDC_CLIENT_ID: "client-id.apps.googleusercontent.com",
  OIDC_CLIENT_SECRET: secretValue,
  S3_ENDPOINT: "http://garage:3900",
  S3_BUCKET: "smooth-coach-photos",
  S3_ACCESS_KEY_ID: "GK0123456789abcdef01234567",
  S3_SECRET_ACCESS_KEY: secretValue
});

function configErrorMessage(env) {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${error}`);
    return error.message;
  }
  assert.fail("expected loadConfig to throw");
}

describe("loadConfig", () => {
  it("returns a frozen config with defaults", () => {
    const config = loadConfig(validEnv());
    assert.equal(Object.isFrozen(config), true);
    assert.equal(Object.isFrozen(config.s3), true);
    assert.equal(config.appUrl, "https://coach.example.com");
    assert.equal(config.oidc.issuer, "https://accounts.google.com");
    assert.equal(config.s3.region, "us-east-1");
    assert.equal(config.s3.forcePathStyle, true);
    assert.equal(config.s3.bucket, "smooth-coach-photos");
    assert.equal(config.port, 3000);
    assert.equal(config.isProduction, false);
  });

  it("normalizes APP_URL to its origin", () => {
    assert.equal(loadConfig({ ...validEnv(), APP_URL: "https://coach.example.com/" }).appUrl, "https://coach.example.com");
  });

  it("reads optional values", () => {
    const config = loadConfig({ ...validEnv(), S3_REGION: "garage", S3_FORCE_PATH_STYLE: "FALSE", PORT: "8080", NODE_ENV: "production" });
    assert.equal(config.s3.region, "garage");
    assert.equal(config.s3.forcePathStyle, false);
    assert.equal(config.port, 8080);
    assert.equal(config.isProduction, true);
  });

  it("allows plain http only for loopback hosts", () => {
    assert.equal(loadConfig({ ...validEnv(), APP_URL: "http://localhost:3000" }).appUrl, "http://localhost:3000");
    assert.equal(loadConfig({ ...validEnv(), OIDC_ISSUER: "http://127.0.0.1:9000" }).oidc.issuer, "http://127.0.0.1:9000");
  });

  it("names every missing variable", () => {
    const message = configErrorMessage({});
    assert.equal(message, `Smooth Coach requires these environment variables: ${requiredVariables.join(", ")}`);
  });

  it("names only the missing variables and treats empty values as missing", () => {
    const message = configErrorMessage({ ...validEnv(), OIDC_CLIENT_SECRET: "", S3_BUCKET: undefined });
    assert.equal(message, "Smooth Coach requires these environment variables: OIDC_CLIENT_SECRET, S3_BUCKET");
  });

  for (const [name, overrides, expected] of [
    ["http APP_URL on a public host", { APP_URL: "http://coach.example.com" }, /APP_URL must use https:\/\//],
    ["APP_URL with a path", { APP_URL: "https://example.com/coach" }, /APP_URL must be an origin/],
    ["APP_URL that is not a URL", { APP_URL: "not a url" }, /APP_URL must be an origin/],
    ["short SESSION_SECRET", { SESSION_SECRET: "x".repeat(31) }, /SESSION_SECRET must be at least 32 characters/],
    ["http OIDC_ISSUER on a public host", { OIDC_ISSUER: "http://accounts.example.com" }, /OIDC_ISSUER must be an https:\/\/ URL/],
    ["non-http S3_ENDPOINT", { S3_ENDPOINT: "ftp://garage:3900" }, /S3_ENDPOINT must be an http:\/\/ or https:\/\/ URL/],
    ["bad S3_FORCE_PATH_STYLE", { S3_FORCE_PATH_STYLE: "maybe" }, /S3_FORCE_PATH_STYLE must be true or false/],
    ["bad PORT", { PORT: "eighty" }, /PORT must be a whole number/]
  ]) {
    it(`rejects ${name} without printing values`, () => {
      const message = configErrorMessage({ ...validEnv(), ...overrides });
      assert.match(message, /^Smooth Coach configuration is invalid: /);
      assert.match(message, expected);
      assert.ok(!message.includes(secretValue), "message must not include secret values");
      for (const value of Object.values(overrides)) assert.ok(!message.includes(value), `message must not include ${value}`);
    });
  }
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test test/config.test.mjs`
Expected: FAIL — `Cannot find module '.../server/config.mjs'`.

- [ ] **Step 5: Write the implementation** — `server/config.mjs`

```js
// Reads and validates Smooth Coach configuration from the environment once at startup.
// Error messages name variables but never include their values.

export const requiredVariables = [
  "DATABASE_URL",
  "APP_URL",
  "SESSION_SECRET",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY"
];

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

// https:// everywhere; plain http:// only for local development on a loopback host.
const isSecureOrLocal = (url) => url.protocol === "https:" || (url.protocol === "http:" && loopbackHosts.has(url.hostname));

export function loadConfig(env = process.env) {
  const missing = requiredVariables.filter((name) => !env[name]);
  if (missing.length) {
    throw new ConfigError(`Smooth Coach requires these environment variables: ${missing.join(", ")}`);
  }

  const problems = [];
  const appUrl = parseUrl(env.APP_URL);
  if (!appUrl || appUrl.pathname !== "/" || appUrl.search || appUrl.hash || appUrl.username || appUrl.password) {
    problems.push("APP_URL must be an origin such as https://coach.example.com with no path");
  } else if (!isSecureOrLocal(appUrl)) {
    problems.push("APP_URL must use https:// (http:// is only allowed for localhost)");
  }
  if (env.SESSION_SECRET.length < 32) problems.push("SESSION_SECRET must be at least 32 characters");
  const issuer = parseUrl(env.OIDC_ISSUER);
  if (!issuer || !isSecureOrLocal(issuer)) problems.push("OIDC_ISSUER must be an https:// URL (http:// is only allowed for localhost)");
  const s3Endpoint = parseUrl(env.S3_ENDPOINT);
  if (!s3Endpoint || !["http:", "https:"].includes(s3Endpoint.protocol)) problems.push("S3_ENDPOINT must be an http:// or https:// URL");
  const forcePathStyle = (env.S3_FORCE_PATH_STYLE || "true").toLowerCase();
  if (!["true", "false"].includes(forcePathStyle)) problems.push("S3_FORCE_PATH_STYLE must be true or false");
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push("PORT must be a whole number between 1 and 65535");

  if (problems.length) throw new ConfigError(`Smooth Coach configuration is invalid: ${problems.join("; ")}`);

  return Object.freeze({
    databaseUrl: env.DATABASE_URL,
    appUrl: appUrl.origin,
    sessionSecret: env.SESSION_SECRET,
    oidc: Object.freeze({ issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET }),
    s3: Object.freeze({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION || "us-east-1",
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: forcePathStyle === "true"
    }),
    port,
    isProduction: env.NODE_ENV === "production"
  });
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test test/config.test.mjs`
Expected: PASS — 14 tests, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add package.json server/config.mjs test/config.test.mjs
git commit -m "feat: add validated configuration module" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Garage setup, test stack, and photo storage module

**Files:**
- Create: `deploy/garage/garage.toml`, `deploy/garage/setup.mjs`, `deploy/garage/init.mjs`
- Create: `test/compose.yml`, `test/helpers/stack.mjs`
- Create: `server/photoStorage.mjs`
- Create: `test/garage-setup.test.mjs`, `test/photo-storage.unit.test.mjs`, `test/photo-storage.test.mjs`
- Modify: `package.json`, `package-lock.json` (add `@aws-sdk/client-s3`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `deploy/garage/setup.mjs`: `setupVariables: string[]`; `missingSetupVariables(env) → string[]`; `parseCapacity(value) → number` (bytes, powers of 1000); `runSetup({ adminUrl, adminToken, bucket, accessKeyId, secretAccessKey, capacity = "10G", log = console.log, retries = 30, retryDelayMs = 2000 }) → Promise<void>`.
  - `server/photoStorage.mjs`: `photoTypes = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }`; `sniffImageType(buffer) → "image/jpeg" | "image/png" | "image/webp" | null`; `contentTypeForKey(key) → string`; `describeBucketError(error, bucket) → string`; `class PhotoStorageError extends Error`; `createPhotoStorage({ endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle }) → { checkBucket(), putPhoto(key, body, contentType), getPhotoStream(key) /* Readable | null */, deletePhoto(key), destroy() }`.
  - `test/helpers/stack.mjs`: `stack` (frozen: `adminDatabaseUrl`, `garageAdminUrl`, `garageAdminToken`, `s3` config object); `waitForStack(timeoutMs = 90000)`; `createTestDatabase() → { databaseUrl, drop() }`.

- [ ] **Step 0: Restrict `npm test` to test files** (plan amendment after Task 1)

In `package.json`, replace `"test": "node --test",` with:

```json
    "test": "node --test \"test/*.test.mjs\"",
```

Run `npm test` and confirm only `test/config.test.mjs` runs (14 tests pass). Include `package.json` in this task's commit.

- [ ] **Step 1: Install the S3 client**

```bash
npm install @aws-sdk/client-s3@^3.1146.0
```

- [ ] **Step 2: Create `deploy/garage/garage.toml`**

```toml
# Single-node Garage for Smooth Coach photos. Secrets come from the environment
# (GARAGE_RPC_SECRET, GARAGE_ADMIN_TOKEN), never from this file.
replication_factor = 1
db_engine = "lmdb"
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"

[s3_api]
api_bind_addr = "[::]:3900"
s3_region = "garage"

[admin]
api_bind_addr = "[::]:3903"
```

- [ ] **Step 3: Write the failing unit test** — `test/garage-setup.test.mjs`

```js
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { missingSetupVariables, parseCapacity } from "../deploy/garage/setup.mjs";

describe("parseCapacity", () => {
  for (const [input, bytes] of [["10G", 10e9], ["10GB", 10e9], ["10g", 10e9], ["500M", 500e6], ["1T", 1e12], ["64K", 64e3], ["2048", 2048]]) {
    it(`parses ${input}`, () => assert.equal(parseCapacity(input), bytes));
  }
  for (const input of ["", "ten", "0G", "10X", "-5G"]) {
    it(`rejects ${JSON.stringify(input)}`, () => assert.throws(() => parseCapacity(input), /GARAGE_CAPACITY must look like/));
  }
});

describe("missingSetupVariables", () => {
  it("names unset and empty variables", () => {
    assert.deepEqual(missingSetupVariables({ GARAGE_ADMIN_TOKEN: "t", S3_BUCKET: "", S3_ACCESS_KEY_ID: "k" }), ["S3_BUCKET", "S3_SECRET_ACCESS_KEY"]);
  });
  it("returns nothing when all are set", () => {
    assert.deepEqual(missingSetupVariables({ GARAGE_ADMIN_TOKEN: "t", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" }), []);
  });
});
```

- [ ] **Step 4: Write the failing unit test** — `test/photo-storage.unit.test.mjs`

```js
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contentTypeForKey, describeBucketError, PhotoStorageError, sniffImageType } from "../server/photoStorage.mjs";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 1, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(16)]);

describe("sniffImageType", () => {
  it("recognizes PNG, JPEG, and WebP by their signatures", () => {
    assert.equal(sniffImageType(png), "image/png");
    assert.equal(sniffImageType(jpeg), "image/jpeg");
    assert.equal(sniffImageType(webp), "image/webp");
  });
  it("rejects other content", () => {
    assert.equal(sniffImageType(Buffer.from("GIF89a-not-allowed")), null);
    assert.equal(sniffImageType(Buffer.from("just some text here")), null);
    assert.equal(sniffImageType(Buffer.from("RIFF0000WAVE")), null);
    assert.equal(sniffImageType(png.subarray(0, 7)), null);
    assert.equal(sniffImageType(Buffer.alloc(0)), null);
    assert.equal(sniffImageType(undefined), null);
  });
});

describe("contentTypeForKey", () => {
  it("maps photo extensions to content types", () => {
    assert.equal(contentTypeForKey("progress-photos/a/2026-09-01/x.jpg"), "image/jpeg");
    assert.equal(contentTypeForKey("progress-photos/a/2026-09-01/x.png"), "image/png");
    assert.equal(contentTypeForKey("progress-photos/a/2026-09-01/x.webp"), "image/webp");
    assert.equal(contentTypeForKey("progress-photos/a/2026-09-01/x.gif"), "application/octet-stream");
  });
});

describe("describeBucketError", () => {
  const withStatus = (status) => Object.assign(new Error("x"), { name: "Unknown", $metadata: { httpStatusCode: status } });
  it("explains the common startup failures", () => {
    assert.equal(describeBucketError(withStatus(404), "photos"), 'bucket "photos" does not exist');
    assert.match(describeBucketError(withStatus(403), "photos"), /access denied; check S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY/);
    assert.match(describeBucketError(withStatus(400), "photos"), /S3_REGION/);
    assert.match(describeBucketError(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }), "photos"), /cannot reach the storage server \(ECONNREFUSED\); check S3_ENDPOINT/);
    assert.match(describeBucketError(Object.assign(new Error("odd"), { name: "Weird" }), "photos"), /unexpected error \(Weird\)/);
  });
});

describe("PhotoStorageError", () => {
  it("names the operation and the cause without secrets", () => {
    const error = new PhotoStorageError("upload", Object.assign(new Error("boom"), { code: "ECONNREFUSED" }));
    assert.equal(error.name, "PhotoStorageError");
    assert.equal(error.message, "photo storage upload failed (Error, ECONNREFUSED)");
  });
});
```

- [ ] **Step 5: Run the unit tests to verify they fail**

Run: `node --test test/garage-setup.test.mjs test/photo-storage.unit.test.mjs`
Expected: FAIL — `Cannot find module` for `deploy/garage/setup.mjs` and `server/photoStorage.mjs`.

- [ ] **Step 6: Create `deploy/garage/setup.mjs`**

```js
// Idempotent Garage setup for Smooth Coach: node layout, app key, bucket, and grant.
// Targets the Garage admin API v2 as shipped in Garage v2.4.1. Never logs secrets.

export const setupVariables = ["GARAGE_ADMIN_TOKEN", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];

export function missingSetupVariables(env) {
  return setupVariables.filter((name) => !env[name]);
}

export function parseCapacity(value) {
  const match = /^(\d+)\s*([KMGT]?)B?$/i.exec(String(value).trim());
  if (!match || Number(match[1]) === 0) throw new Error("GARAGE_CAPACITY must look like 10G, 500M, or 1T");
  const power = { "": 0, K: 1, M: 2, G: 3, T: 4 }[match[2].toUpperCase()];
  return Number(match[1]) * 1000 ** power;
}

export async function runSetup({ adminUrl, adminToken, bucket, accessKeyId, secretAccessKey, capacity = "10G", log = console.log, retries = 30, retryDelayMs = 2000 }) {
  const capacityBytes = parseCapacity(capacity);

  async function admin(method, endpoint, { query, body, allowMissing = false } = {}) {
    const url = new URL(endpoint, adminUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${adminToken}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    // Garage answers lookups of unknown keys and buckets with 400 or 404.
    if (allowMissing && (response.status === 404 || response.status === 400)) return null;
    if (!response.ok) throw new Error(`${method} ${endpoint} failed with HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async function waitForGarage() {
    let lastError = "no response";
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const status = await admin("GET", "/v2/GetClusterStatus");
        if (status?.nodes?.length) return status;
        lastError = "cluster status listed no nodes";
      } catch (error) {
        lastError = error.cause?.code ?? error.message;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    throw new Error(`Garage admin API at ${adminUrl} did not become ready (last error: ${lastError})`);
  }

  const status = await waitForGarage();

  const layout = await admin("GET", "/v2/GetClusterLayout");
  if (layout.roles.length > 0) {
    log(`garage-init: layout already applied (version ${layout.version})`);
  } else {
    await admin("POST", "/v2/UpdateClusterLayout", { body: { roles: [{ id: status.nodes[0].id, zone: "dc1", capacity: capacityBytes, tags: [] }] } });
    await admin("POST", "/v2/ApplyClusterLayout", { body: { version: layout.version + 1 } });
    log(`garage-init: assigned node with ${capacity} capacity and applied layout version ${layout.version + 1}`);
  }

  if (await admin("GET", "/v2/GetKeyInfo", { query: { id: accessKeyId }, allowMissing: true })) {
    log("garage-init: app key already exists");
  } else {
    await admin("POST", "/v2/ImportKey", { body: { accessKeyId, secretAccessKey, name: "smooth-coach-app" } });
    log("garage-init: imported app key");
  }

  let bucketInfo = await admin("GET", "/v2/GetBucketInfo", { query: { globalAlias: bucket }, allowMissing: true });
  if (bucketInfo) {
    log(`garage-init: bucket ${bucket} already exists`);
  } else {
    bucketInfo = await admin("POST", "/v2/CreateBucket", { body: { globalAlias: bucket } });
    log(`garage-init: created bucket ${bucket}`);
  }

  const permissions = bucketInfo.keys?.find((key) => key.accessKeyId === accessKeyId)?.permissions;
  if (permissions?.read && permissions?.write) {
    log("garage-init: app key already has read/write on the bucket");
  } else {
    await admin("POST", "/v2/AllowBucketKey", { body: { bucketId: bucketInfo.id, accessKeyId, permissions: { read: true, write: true, owner: false } } });
    log("garage-init: granted app key read/write on the bucket");
  }
  log("garage-init: done");
}
```

- [ ] **Step 7: Create `deploy/garage/init.mjs`**

```js
// Container entry point for garage-init: reads settings from the environment and runs setup.
import { missingSetupVariables, runSetup } from "./setup.mjs";

const missing = missingSetupVariables(process.env);
if (missing.length) {
  console.error(`garage-init: missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

try {
  await runSetup({
    adminUrl: process.env.GARAGE_ADMIN_URL || "http://garage:3903",
    adminToken: process.env.GARAGE_ADMIN_TOKEN,
    bucket: process.env.S3_BUCKET,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    capacity: process.env.GARAGE_CAPACITY || "10G"
  });
} catch (error) {
  console.error(`garage-init: ${error.message}`);
  process.exit(1);
}
```

- [ ] **Step 8: Create `server/photoStorage.mjs`**

```js
// Private photo storage in an S3-compatible bucket (Garage in the default deployment).
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export const photoTypes = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const typesByExtension = Object.fromEntries(Object.entries(photoTypes).map(([type, extension]) => [extension, type]));
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Identifies the image type from the file's leading bytes; the browser-declared type is not trusted.
export function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(pngSignature)) return "image/png";
  if (buffer.length >= 12 && buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export function contentTypeForKey(key) {
  return typesByExtension[key.split(".").pop()] ?? "application/octet-stream";
}

export function describeBucketError(error, bucket) {
  const status = error.$metadata?.httpStatusCode;
  if (status === 404) return `bucket "${bucket}" does not exist`;
  if (status === 403) return "access denied; check S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY";
  if (status === 400) return "request rejected; check that S3_REGION matches the storage server's region";
  const code = error.code ?? error.cause?.code;
  if (code) return `cannot reach the storage server (${code}); check S3_ENDPOINT`;
  return `unexpected error (${error.name})`;
}

function failureDetail(error) {
  const status = error.$metadata?.httpStatusCode;
  const code = error.code ?? error.cause?.code;
  return [error.name, status ? `HTTP ${status}` : null, code].filter(Boolean).join(", ");
}

export class PhotoStorageError extends Error {
  constructor(operation, cause) {
    super(`photo storage ${operation} failed (${failureDetail(cause)})`, { cause });
    this.name = "PhotoStorageError";
  }
}

export function createPhotoStorage({ endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle }) {
  const client = new S3Client({ endpoint, region, forcePathStyle, credentials: { accessKeyId, secretAccessKey } });

  return {
    async checkBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        throw new Error(describeBucketError(error, bucket));
      }
    },
    async putPhoto(key, body, contentType) {
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
      } catch (error) {
        throw new PhotoStorageError("upload", error);
      }
    },
    // Resolves to a readable stream, or null when the object does not exist.
    async getPhotoStream(key) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return response.Body;
      } catch (error) {
        if (error.name === "NoSuchKey") return null;
        throw new PhotoStorageError("download", error);
      }
    },
    async deletePhoto(key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (error) {
        throw new PhotoStorageError("delete", error);
      }
    },
    destroy() {
      client.destroy();
    }
  };
}
```

- [ ] **Step 9: Run the unit tests to verify they pass**

Run: `node --test test/garage-setup.test.mjs test/photo-storage.unit.test.mjs`
Expected: PASS — all tests, 0 failures.

- [ ] **Step 10: Create `test/compose.yml`**

```yaml
# Throwaway services for the integration tests. All values here are test-only.
name: smooth-coach-test

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: smooth-coach-test
    ports:
      - "127.0.0.1:55433:5432"
    volumes:
      - ../deploy/postgres:/deploy/postgres:ro
    tmpfs:
      - /var/lib/postgresql/data

  garage:
    image: dxflrs/garage:v2.4.1
    environment:
      GARAGE_RPC_SECRET: abababababababababababababababababababababababababababababababab
      GARAGE_ADMIN_TOKEN: smooth-coach-test-admin-token
    volumes:
      - ../deploy/garage/garage.toml:/etc/garage.toml:ro
    tmpfs:
      - /var/lib/garage/meta
      - /var/lib/garage/data
    ports:
      - "127.0.0.1:39900:3900"
      - "127.0.0.1:39903:3903"

  garage-init:
    image: node:22-alpine
    depends_on:
      - garage
    environment:
      GARAGE_ADMIN_URL: http://garage:3903
      GARAGE_ADMIN_TOKEN: smooth-coach-test-admin-token
      S3_BUCKET: smooth-coach-test
      S3_ACCESS_KEY_ID: GK0123456789abcdef01234567
      S3_SECRET_ACCESS_KEY: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      GARAGE_CAPACITY: 1G
    volumes:
      - ../deploy/garage:/garage-setup:ro
    command: ["node", "/garage-setup/init.mjs"]
```

- [ ] **Step 11: Create `test/helpers/stack.mjs`**

```js
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
```

- [ ] **Step 12: Write the integration test** — `test/photo-storage.test.mjs`

```js
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { before, describe, it } from "node:test";
import { runSetup } from "../deploy/garage/setup.mjs";
import { createPhotoStorage, PhotoStorageError } from "../server/photoStorage.mjs";
import { stack, waitForStack } from "./helpers/stack.mjs";

async function withStorage(overrides, fn) {
  const storage = createPhotoStorage({ ...stack.s3, ...overrides });
  try {
    return await fn(storage);
  } finally {
    storage.destroy();
  }
}

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(512)]);

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe("Garage setup", () => {
  before(() => waitForStack());

  it("is idempotent", async () => {
    const bucket = `setup-${crypto.randomBytes(4).toString("hex")}`;
    const options = { adminUrl: stack.garageAdminUrl, adminToken: stack.garageAdminToken, bucket, accessKeyId: stack.s3.accessKeyId, secretAccessKey: stack.s3.secretAccessKey, retries: 5, retryDelayMs: 500 };
    const first = [];
    await runSetup({ ...options, log: (line) => first.push(line) });
    assert.ok(first.includes(`garage-init: created bucket ${bucket}`), first.join("\n"));
    assert.ok(first.includes("garage-init: granted app key read/write on the bucket"), first.join("\n"));
    const second = [];
    await runSetup({ ...options, log: (line) => second.push(line) });
    assert.deepEqual(second, [
      "garage-init: layout already applied (version 1)",
      "garage-init: app key already exists",
      `garage-init: bucket ${bucket} already exists`,
      "garage-init: app key already has read/write on the bucket",
      "garage-init: done"
    ]);
    await withStorage({ bucket }, (storage) => storage.checkBucket());
  });
});

describe("photo storage (Garage)", () => {
  before(() => waitForStack());

  it("passes the bucket check with valid settings", () => withStorage({}, (storage) => storage.checkBucket()));

  it("explains a missing bucket", () =>
    withStorage({ bucket: "no-such-bucket" }, (storage) => assert.rejects(storage.checkBucket(), /bucket "no-such-bucket" does not exist/)));

  it("explains wrong credentials", () =>
    withStorage({ secretAccessKey: "f".repeat(64) }, (storage) => assert.rejects(storage.checkBucket(), /access denied/)));

  it("explains a region mismatch", () =>
    withStorage({ region: "us-east-1" }, (storage) => assert.rejects(storage.checkBucket(), /S3_REGION/)));

  it("explains an unreachable endpoint", () =>
    withStorage({ endpoint: "http://127.0.0.1:1" }, (storage) => assert.rejects(storage.checkBucket(), /cannot reach the storage server/)));

  it("stores, streams, and deletes a photo", () =>
    withStorage({}, async (storage) => {
      const key = `progress-photos/test/2026-09-01/${crypto.randomUUID()}.png`;
      await storage.putPhoto(key, png, "image/png");
      const stream = await storage.getPhotoStream(key);
      assert.ok((await readAll(stream)).equals(png));
      await storage.deletePhoto(key);
      assert.equal(await storage.getPhotoStream(key), null);
    }));

  it("returns null for a missing object", () =>
    withStorage({}, async (storage) => assert.equal(await storage.getPhotoStream("progress-photos/missing.png"), null)));

  it("wraps upload failures as photo storage errors", () =>
    withStorage({ endpoint: "http://127.0.0.1:1" }, (storage) =>
      assert.rejects(storage.putPhoto("progress-photos/x.png", png, "image/png"), (error) => error instanceof PhotoStorageError && /photo storage upload failed/.test(error.message))));
});
```

- [ ] **Step 13: Start the test stack and run the integration test**

Run: `npm run test:stack:up` then `node --test test/photo-storage.test.mjs`
Expected: PASS — 9 tests. (If it fails with "Test stack is not ready", run `docker compose -f test/compose.yml logs garage-init` and fix the reported problem.)

- [ ] **Step 14: Commit**

```bash
git add package.json package-lock.json deploy/garage server/photoStorage.mjs test/compose.yml test/helpers/stack.mjs test/garage-setup.test.mjs test/photo-storage.unit.test.mjs test/photo-storage.test.mjs
git commit -m "feat: add Garage setup and S3 photo storage module" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Database module and schema update

**Files:**
- Create: `server/db.mjs`, `test/db.test.mjs`
- Modify: `server/index.mjs` (use `db.mjs`), `deploy/postgres/smooth-coach-schema.sql`, `deploy/postgres/setup-smooth-coach-postgres.sh`

**Interfaces:**
- Consumes: `test/helpers/stack.mjs` → `createTestDatabase()` (Task 2).
- Produces: `createPool(databaseUrl) → pg.Pool` (max 6, logs idle-client errors); `ensureSchema(pool) → Promise<void>` (applies the schema file under advisory lock `7317204517`).

Note: between this task and Task 6 the old Manus photo-presign route can fail on fresh databases (its table is no longer created). That route is deleted in Task 5.

- [ ] **Step 1: Write the failing test** — `test/db.test.mjs`

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/db.test.mjs`
Expected: FAIL — `Cannot find module '.../server/db.mjs'`.

- [ ] **Step 3: Create `server/db.mjs`**

```js
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
```

- [ ] **Step 4: Remove the upload-intent table from the schema**

In `deploy/postgres/smooth-coach-schema.sql`, delete this block (including the blank line after it):

```sql
CREATE TABLE IF NOT EXISTS progress_photo_uploads (
  storage_key TEXT PRIMARY KEY,
  open_id TEXT NOT NULL REFERENCES user_profiles(open_id) ON DELETE CASCADE,
  content_type VARCHAR(50) NOT NULL,
  declared_size INTEGER NOT NULL CHECK (declared_size > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS progress_photo_uploads_owner
  ON progress_photo_uploads (open_id, expires_at);

```

Then replace:

```sql
CREATE TABLE IF NOT EXISTS user_profiles (
```

with:

```sql
-- open_id holds the account ID "<OIDC issuer>|<subject>" (name kept from earlier versions).
-- Databases created by 2.x may also contain an unused progress_photo_uploads table; it is left in place.
CREATE TABLE IF NOT EXISTS user_profiles (
```

- [ ] **Step 5: Update the provisioning script's table check**

In `deploy/postgres/setup-smooth-coach-postgres.sh`, replace:

```bash
expected_tables=5
actual_table_count="$(run_app --tuples-only --no-align --command "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('user_profiles', 'user_coach_state', 'weight_entries', 'progress_photos', 'progress_photo_uploads');")"
```

with:

```bash
expected_tables=4
actual_table_count="$(run_app --tuples-only --no-align --command "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('user_profiles', 'user_coach_state', 'weight_entries', 'progress_photos');")"
```

- [ ] **Step 6: Make `server/index.mjs` use the new module**

In `server/index.mjs`: delete `import { readFile } from "node:fs/promises";` and `import pg from "pg";`; add `import { createPool, ensureSchema } from "./db.mjs";` after the `jsonwebtoken` import. Replace the block from `// TLS is configured through DATABASE_URL` through `const schemaLockId = 7317204517;` with:

```js
const pool = createPool(databaseUrl);
```

Delete the whole `async function ensureSchema() { ... }` function including its two comment lines above it, and replace `await ensureSchema();` with `await ensureSchema(pool);`.

- [ ] **Step 7: Run the tests**

Run: `node --test test/db.test.mjs` and `node --check server/index.mjs`
Expected: PASS — 1 test; `node --check` prints nothing.

- [ ] **Step 8: Verify the provisioning script against the test PostgreSQL**

Run:

```bash
docker compose -f test/compose.yml exec -e PG_ADMIN_HOST=localhost -e PG_ADMIN_USERNAME=postgres -e PG_ADMIN_PASSWORD=smooth-coach-test -e SMOOTH_COACH_DB_PASSWORD=provision-check-password -e PG_ADMIN_SSLMODE=disable -e SMOOTH_COACH_DATABASE=provision_check postgres bash /deploy/postgres/setup-smooth-coach-postgres.sh
```

Expected: output ends with `Tables verified: 4`.

- [ ] **Step 9: Commit**

```bash
git add server/db.mjs server/index.mjs test/db.test.mjs deploy/postgres/smooth-coach-schema.sql deploy/postgres/setup-smooth-coach-postgres.sh
git commit -m "refactor: extract database module and retire upload-intent table" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: OIDC sign-in module

**Files:**
- Create: `server/auth.mjs`
- Create: `test/helpers/fake-oidc.mjs`, `test/helpers/fake-oidc-server.mjs`, `test/helpers/server.mjs`, `test/helpers/session.mjs`
- Create: `test/auth.test.mjs`
- Modify: `package.json`, `package-lock.json` (add `openid-client`)

**Interfaces:**
- Consumes: `loadConfig` (Task 1); `createPool`, `ensureSchema` (Task 3); `stack`, `createTestDatabase` (Task 2).
- Produces:
  - `server/auth.mjs`: `sessionCookie = "smooth_coach_session"`, `loginCookie = "smooth_coach_login"`; `upsertUser(pool, { openId, name, email })`; `createAuth({ config, pool }) → Promise<{ router /* mount at /api/auth */, requireUser /* sets req.smoothCoachUser = { openId, name, email } */, readSession(req) → user | null }>`. Discovery failures reject with `Error("could not load provider configuration from OIDC_ISSUER (<code>)")`.
  - `test/helpers/fake-oidc.mjs`: `startFakeOidc({ clientId = "test-client", clientSecret = "test-secret", host = "127.0.0.1", port = 0, issuer } = {}) → Promise<provider>` where `provider` has `issuer`, `clientId`, `clientSecret`, mutable `user` (`{ sub, name, email }`), one-shot `next` (`{ nonce, aud, iss, signWithRogueKey }`), `close()`.
  - `test/helpers/server.mjs`: `freePort()`, `baseEnv({ databaseUrl, provider, port, s3 = stack.s3 })`, `startServer(env) → { url, output(), stop() }`, `runServerUntilExit(env, timeoutMs = 60000) → { code, output }`.
  - `test/helpers/session.mjs`: `cookieValue(response, name)`, `startSignIn(server, provider, { user, tamper } = {}) → { loginCookie, callbackUrl }`, `finishSignIn(callbackUrl, loginCookie) → Response`, `signIn(server, provider, user) → { cookie, callback }`, `api(server, pathname, { cookie, method, json, form } = {}) → { status, headers, data }`.

- [ ] **Step 1: Install openid-client**

```bash
npm install openid-client@^6.8.8
```

- [ ] **Step 2: Create `test/helpers/fake-oidc.mjs`**

```js
// Minimal OpenID Connect provider for tests: discovery, JWKS, authorize, token.
// Issues real RS256-signed ID tokens; `provider.next` tampers with the next token only.
import crypto from "node:crypto";
import http from "node:http";

const base64url = (value) => Buffer.from(value).toString("base64url");

function signJwt(payload, privateKey, kid) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const body = base64url(JSON.stringify(payload));
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey).toString("base64url");
  return `${header}.${body}.${signature}`;
}

export async function startFakeOidc({ clientId = "test-client", clientSecret = "test-secret", host = "127.0.0.1", port = 0, issuer } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rogue = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "test-key";
  const codes = new Map();
  const provider = {
    issuer: "",
    clientId,
    clientSecret,
    user: { sub: "user-1", name: "Test User", email: "test@example.test" },
    next: {}
  };

  const sendJson = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, provider.issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      return sendJson(res, 200, {
        issuer: provider.issuer,
        authorization_endpoint: `${provider.issuer}/authorize`,
        token_endpoint: `${provider.issuer}/token`,
        jwks_uri: `${provider.issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"]
      });
    }
    if (url.pathname === "/jwks") {
      return sendJson(res, 200, { keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] });
    }
    if (url.pathname === "/authorize") {
      const code = crypto.randomBytes(16).toString("hex");
      codes.set(code, {
        nonce: url.searchParams.get("nonce"),
        challenge: url.searchParams.get("code_challenge"),
        redirectUri: url.searchParams.get("redirect_uri"),
        user: { ...provider.user }
      });
      const redirect = new URL(url.searchParams.get("redirect_uri"));
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", url.searchParams.get("state"));
      res.writeHead(302, { location: redirect.toString() });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const [id, secret] = req.headers.authorization?.startsWith("Basic ")
        ? Buffer.from(req.headers.authorization.slice(6), "base64").toString().split(":").map(decodeURIComponent)
        : [form.get("client_id"), form.get("client_secret")];
      const grant = codes.get(form.get("code"));
      codes.delete(form.get("code"));
      const verifierMatches = grant && crypto.createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === grant.challenge;
      if (id !== clientId || secret !== clientSecret || !grant || !verifierMatches || form.get("redirect_uri") !== grant.redirectUri) {
        return sendJson(res, 400, { error: "invalid_grant" });
      }
      const tamper = provider.next;
      provider.next = {};
      const now = Math.floor(Date.now() / 1000);
      const idToken = signJwt({
        iss: tamper.iss ?? provider.issuer,
        aud: tamper.aud ?? clientId,
        sub: grant.user.sub,
        name: grant.user.name,
        email: grant.user.email,
        nonce: tamper.nonce ?? grant.nonce,
        iat: now,
        exp: now + 300
      }, tamper.signWithRogueKey ? rogue.privateKey : privateKey, kid);
      return sendJson(res, 200, { access_token: crypto.randomBytes(16).toString("hex"), token_type: "Bearer", expires_in: 300, id_token: idToken }, { "cache-control": "no-store" });
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  provider.issuer = issuer ?? `http://127.0.0.1:${server.address().port}`;
  provider.close = () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
  return provider;
}
```

- [ ] **Step 3: Create `test/helpers/fake-oidc-server.mjs`** (standalone runner used by the container smoke test in Task 9)

```js
// Runs the fake OIDC provider as its own process for the container smoke test.
import { startFakeOidc } from "./fake-oidc.mjs";

const port = Number(process.env.FAKE_OIDC_PORT || 39556);
const provider = await startFakeOidc({
  host: "0.0.0.0",
  port,
  issuer: process.env.FAKE_OIDC_ISSUER || `http://127.0.0.1:${port}`,
  clientId: process.env.FAKE_OIDC_CLIENT_ID || "smoke-client",
  clientSecret: process.env.FAKE_OIDC_CLIENT_SECRET || "smoke-secret"
});
console.log(`fake OIDC provider listening at ${provider.issuer}`);
```

- [ ] **Step 4: Create `test/helpers/server.mjs`**

```js
// Starts the real server (server/index.mjs) as a child process with a test environment.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stack } from "./stack.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const inheritedVariables = ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"];
export const testSessionSecret = "test-session-secret-0123456789abcdef";

export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export function baseEnv({ databaseUrl, provider, port, s3 = stack.s3 }) {
  return {
    NODE_ENV: "production",
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    APP_URL: `http://127.0.0.1:${port}`,
    SESSION_SECRET: testSessionSecret,
    OIDC_ISSUER: provider.issuer,
    OIDC_CLIENT_ID: provider.clientId,
    OIDC_CLIENT_SECRET: provider.clientSecret,
    S3_ENDPOINT: s3.endpoint,
    S3_REGION: s3.region,
    S3_BUCKET: s3.bucket,
    S3_ACCESS_KEY_ID: s3.accessKeyId,
    S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
    S3_FORCE_PATH_STYLE: String(s3.forcePathStyle)
  };
}

function spawnServer(env) {
  const inherited = Object.fromEntries(inheritedVariables.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  const child = spawn(process.execPath, ["server/index.mjs"], { cwd: root, env: { ...inherited, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  return { child, output: () => output };
}

export async function startServer(env) {
  const { child, output } = spawnServer(env);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start within 30s:\n${output()}`)), 30000);
    child.stdout.on("data", () => {
      if (output().includes("Smooth Coach is ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code}:\n${output()}`));
    });
  });
  return {
    url: `http://127.0.0.1:${env.PORT}`,
    output,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
  };
}

export async function runServerUntilExit(env, timeoutMs = 60000) {
  const { child, output } = spawnServer(env);
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server kept running instead of exiting:\n${output()}`));
    }, timeoutMs);
    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  return { code, output: output() };
}
```

- [ ] **Step 5: Create `test/helpers/session.mjs`**

```js
// Drives the sign-in flow against a running server and the fake provider, and calls the API.
export function cookieValue(response, name) {
  const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
  return header ? header.slice(name.length + 1).split(";")[0] : null;
}

export async function startSignIn(server, provider, { user, tamper } = {}) {
  if (user) provider.user = user;
  provider.next = tamper ?? {};
  const login = await fetch(`${server.url}/api/auth/login`, { redirect: "manual" });
  const loginCookie = cookieValue(login, "smooth_coach_login");
  const authorize = await fetch(login.headers.get("location"), { redirect: "manual" });
  return { loginCookie, callbackUrl: authorize.headers.get("location") };
}

export function finishSignIn(callbackUrl, loginCookie) {
  return fetch(callbackUrl, { redirect: "manual", headers: loginCookie ? { cookie: `smooth_coach_login=${loginCookie}` } : {} });
}

export async function signIn(server, provider, user) {
  const { loginCookie, callbackUrl } = await startSignIn(server, provider, { user });
  const callback = await finishSignIn(callbackUrl, loginCookie);
  const session = cookieValue(callback, "smooth_coach_session");
  if (callback.status !== 302 || !session) throw new Error(`sign-in failed with HTTP ${callback.status}: ${await callback.text()}`);
  return { cookie: `smooth_coach_session=${session}`, callback };
}

export async function api(server, pathname, { cookie, method = "GET", json, form } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  let body;
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  }
  if (form) body = form;
  const response = await fetch(`${server.url}${pathname}`, { method, headers, body, redirect: "manual" });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, headers: response.headers, data };
}
```

- [ ] **Step 6: Write the failing test** — `test/auth.test.mjs`

```js
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import jwt from "jsonwebtoken";
import { createAuth } from "../server/auth.mjs";
import { loadConfig } from "../server/config.mjs";
import { createPool, ensureSchema } from "../server/db.mjs";
import { startFakeOidc } from "./helpers/fake-oidc.mjs";
import { baseEnv, freePort } from "./helpers/server.mjs";
import { api, finishSignIn, signIn, startSignIn } from "./helpers/session.mjs";
import { createTestDatabase } from "./helpers/stack.mjs";

const verificationFailed = "The sign-in request could not be verified. Return to Smooth Coach and try again.";

describe("OIDC sign-in", () => {
  let provider;
  let database;
  let pool;
  let config;
  let httpServer;
  let server;

  before(async () => {
    provider = await startFakeOidc();
    database = await createTestDatabase();
    pool = createPool(database.databaseUrl);
    await ensureSchema(pool);
    const port = await freePort();
    config = loadConfig(baseEnv({ databaseUrl: database.databaseUrl, provider, port }));
    const auth = await createAuth({ config, pool });
    const app = express();
    app.use(cookieParser());
    app.use("/api/auth", auth.router);
    app.get("/api/private", auth.requireUser, (req, res) => res.json({ user: req.smoothCoachUser }));
    httpServer = await new Promise((resolve) => {
      const listening = app.listen(port, "127.0.0.1", () => resolve(listening));
    });
    server = { url: `http://127.0.0.1:${port}` };
  });

  after(async () => {
    httpServer.closeAllConnections();
    await new Promise((resolve) => httpServer.close(resolve));
    await pool.end();
    await database.drop();
    await provider.close();
  });

  async function expectRejected(callback) {
    assert.equal(callback.status, 400);
    assert.equal(await callback.text(), verificationFailed);
    assert.equal(callback.headers.getSetCookie().some((cookie) => cookie.startsWith("smooth_coach_session=") && !cookie.startsWith("smooth_coach_session=;")), false);
  }

  it("redirects to the provider with PKCE, state, and nonce and sets a scoped login cookie", async () => {
    const response = await fetch(`${server.url}/api/auth/login`, { redirect: "manual" });
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location"));
    assert.equal(`${location.origin}${location.pathname}`, `${provider.issuer}/authorize`);
    assert.equal(location.searchParams.get("redirect_uri"), `${server.url}/api/auth/callback`);
    assert.equal(location.searchParams.get("response_type"), "code");
    assert.equal(location.searchParams.get("scope"), "openid email profile");
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    for (const name of ["code_challenge", "state", "nonce", "client_id"]) assert.ok(location.searchParams.get(name), `${name} is missing`);
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith("smooth_coach_login="));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\/api\/auth/);
  });

  it("signs in, sets a secure session cookie, and stores the profile", async () => {
    const { cookie, callback } = await signIn(server, provider, { sub: "alice", name: "Alice Example", email: "alice@example.test" });
    assert.equal(callback.headers.get("location"), "/");
    const sessionHeader = callback.headers.getSetCookie().find((value) => value.startsWith("smooth_coach_session="));
    assert.match(sessionHeader, /HttpOnly/);
    assert.match(sessionHeader, /Secure/);
    assert.match(sessionHeader, /SameSite=Lax/);
    assert.match(sessionHeader, /Path=\//);
    const me = await api(server, "/api/auth/me", { cookie });
    assert.deepEqual(me.data, { user: { openId: `${provider.issuer}|alice`, name: "Alice Example", email: "alice@example.test" } });
    const { rows } = await pool.query("SELECT display_name, email FROM user_profiles WHERE open_id = $1", [`${provider.issuer}|alice`]);
    assert.deepEqual(rows, [{ display_name: "Alice Example", email: "alice@example.test" }]);
    const privateRoute = await api(server, "/api/private", { cookie });
    assert.equal(privateRoute.data.user.openId, `${provider.issuer}|alice`);
  });

  it("falls back to the email, then a default display name", async () => {
    const { cookie: bob } = await signIn(server, provider, { sub: "bob", email: "bob@example.test" });
    assert.equal((await api(server, "/api/auth/me", { cookie: bob })).data.user.name, "bob@example.test");
    const { cookie: carol } = await signIn(server, provider, { sub: "carol" });
    assert.deepEqual((await api(server, "/api/auth/me", { cookie: carol })).data.user, { openId: `${provider.issuer}|carol`, name: "Smooth Coach member", email: "" });
  });

  it("rejects a tampered state", async () => {
    const { loginCookie, callbackUrl } = await startSignIn(server, provider);
    const tampered = new URL(callbackUrl);
    tampered.searchParams.set("state", "attacker-state");
    await expectRejected(await finishSignIn(tampered.href, loginCookie));
  });

  it("rejects a missing login cookie", async () => {
    const { callbackUrl } = await startSignIn(server, provider);
    await expectRejected(await finishSignIn(callbackUrl, null));
  });

  it("rejects a login cookie signed with another secret", async () => {
    const { callbackUrl } = await startSignIn(server, provider);
    const state = new URL(callbackUrl).searchParams.get("state");
    const forged = jwt.sign({ codeVerifier: "x".repeat(43), state, nonce: "n" }, "another-secret-0123456789abcdefghij", { algorithm: "HS256", issuer: "smooth-coach", audience: "smooth-coach-login" });
    await expectRejected(await finishSignIn(callbackUrl, forged));
  });

  it("rejects an expired login cookie", async () => {
    const { callbackUrl } = await startSignIn(server, provider);
    const state = new URL(callbackUrl).searchParams.get("state");
    const expired = jwt.sign({ codeVerifier: "x".repeat(43), state, nonce: "n", exp: Math.floor(Date.now() / 1000) - 60 }, config.sessionSecret, { algorithm: "HS256", issuer: "smooth-coach", audience: "smooth-coach-login" });
    await expectRejected(await finishSignIn(callbackUrl, expired));
  });

  it("rejects a replayed callback", async () => {
    const { loginCookie, callbackUrl } = await startSignIn(server, provider);
    assert.equal((await finishSignIn(callbackUrl, loginCookie)).status, 302);
    await expectRejected(await finishSignIn(callbackUrl, loginCookie));
  });

  for (const [name, tamper] of [
    ["a wrong nonce", { nonce: "attacker-nonce" }],
    ["a wrong audience", { aud: "another-client" }],
    ["a wrong issuer", { iss: "http://attacker.example" }],
    ["an ID token signed by an unknown key", { signWithRogueKey: true }]
  ]) {
    it(`rejects ${name}`, async () => {
      const { loginCookie, callbackUrl } = await startSignIn(server, provider, { tamper });
      await expectRejected(await finishSignIn(callbackUrl, loginCookie));
    });
  }

  it("signs out by clearing the session cookie", async () => {
    const { cookie } = await signIn(server, provider, { sub: "dave", name: "Dave" });
    const response = await fetch(`${server.url}/api/auth/logout`, { method: "POST", headers: { cookie } });
    assert.equal(response.status, 204);
    const cleared = response.headers.getSetCookie().find((value) => value.startsWith("smooth_coach_session="));
    assert.match(cleared, /^smooth_coach_session=;/);
    assert.match(cleared, /Expires=Thu, 01 Jan 1970/);
  });

  it("rejects missing, forged, and wrong-audience sessions", async () => {
    assert.equal((await api(server, "/api/auth/me")).status, 401);
    assert.equal((await api(server, "/api/private")).status, 401);
    const forged = jwt.sign({ sub: `${provider.issuer}|alice`, name: "Mallory" }, "another-secret-0123456789abcdefghij", { algorithm: "HS256", issuer: "smooth-coach", audience: "smooth-coach", expiresIn: "1h" });
    assert.equal((await api(server, "/api/auth/me", { cookie: `smooth_coach_session=${forged}` })).status, 401);
    const wrongAudience = jwt.sign({ sub: `${provider.issuer}|alice` }, config.sessionSecret, { algorithm: "HS256", issuer: "smooth-coach", audience: "smooth-coach-login", expiresIn: "1h" });
    assert.equal((await api(server, "/api/private", { cookie: `smooth_coach_session=${wrongAudience}` })).status, 401);
  });

  it("fails clearly when the provider cannot be reached", async () => {
    const unreachable = loadConfig({ ...baseEnv({ databaseUrl: database.databaseUrl, provider, port: 3000 }), OIDC_ISSUER: "http://127.0.0.1:1" });
    await assert.rejects(createAuth({ config: unreachable, pool }), /could not load provider configuration from OIDC_ISSUER/);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `node --test test/auth.test.mjs`
Expected: FAIL — `Cannot find module '.../server/auth.mjs'`.

- [ ] **Step 8: Create `server/auth.mjs`**

```js
// OpenID Connect sign-in (any standard provider, Google by default) and the app's own session cookie.
import express from "express";
import jwt from "jsonwebtoken";
import * as client from "openid-client";

export const sessionCookie = "smooth_coach_session";
export const loginCookie = "smooth_coach_login";
const tokenIssuer = "smooth-coach";
const sessionAudience = "smooth-coach";
const loginAudience = "smooth-coach-login";
const sessionMaxAgeMs = 30 * 24 * 60 * 60 * 1000;
const loginMaxAgeMs = 10 * 60 * 1000;
const verificationFailed = "The sign-in request could not be verified. Return to Smooth Coach and try again.";

const cookieOptions = (cookiePath, maxAge) => ({
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: cookiePath,
  ...(maxAge ? { maxAge } : {})
});

export async function upsertUser(pool, user) {
  await pool.query(
    `INSERT INTO user_profiles (open_id, display_name, email)
     VALUES ($1, $2, $3)
     ON CONFLICT (open_id) DO UPDATE SET display_name = EXCLUDED.display_name, email = EXCLUDED.email`,
    [user.openId, user.name, user.email]
  );
}

function displayName(claims) {
  for (const value of [claims.name, claims.email]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "Smooth Coach member";
}

async function discover(config) {
  const issuerUrl = new URL(config.oidc.issuer);
  // ID token signatures are always verified against the provider's keys. Plain http only
  // reaches this point for loopback issuers (enforced by loadConfig), i.e. local testing.
  const execute = [client.enableNonRepudiationChecks];
  if (issuerUrl.protocol === "http:") execute.push(client.allowInsecureRequests);
  try {
    return await client.discovery(issuerUrl, config.oidc.clientId, config.oidc.clientSecret, undefined, { execute });
  } catch (error) {
    throw new Error(`could not load provider configuration from OIDC_ISSUER (${error.cause?.code ?? error.code ?? error.message})`);
  }
}

export async function createAuth({ config, pool }) {
  const oidc = await discover(config);
  const issuer = oidc.serverMetadata().issuer;
  const redirectUri = `${config.appUrl}/api/auth/callback`;

  function readSession(req) {
    const token = req.cookies[sessionCookie];
    if (!token) return null;
    try {
      const payload = jwt.verify(token, config.sessionSecret, { algorithms: ["HS256"], issuer: tokenIssuer, audience: sessionAudience });
      if (typeof payload.sub !== "string" || !payload.sub) return null;
      return {
        openId: payload.sub,
        name: typeof payload.name === "string" ? payload.name : "Smooth Coach member",
        email: typeof payload.email === "string" ? payload.email : ""
      };
    } catch {
      return null;
    }
  }

  // Verifies the session only; the profile row is written at sign-in and by /me.
  function requireUser(req, res, next) {
    const user = readSession(req);
    if (!user) return res.status(401).json({ error: "Sign in is required for this private account data." });
    req.smoothCoachUser = user;
    next();
  }

  function rejectSignIn(res, reason) {
    console.warn(`Smooth Coach sign-in rejected: ${reason}`);
    res.status(400).send(verificationFailed);
  }

  const router = express.Router();

  router.get("/login", async (_req, res, next) => {
    try {
      const codeVerifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const nonce = client.randomNonce();
      const loginToken = jwt.sign({ codeVerifier, state, nonce }, config.sessionSecret, { algorithm: "HS256", issuer: tokenIssuer, audience: loginAudience, expiresIn: "10m" });
      res.cookie(loginCookie, loginToken, cookieOptions("/api/auth", loginMaxAgeMs));
      const authorizationUrl = client.buildAuthorizationUrl(oidc, {
        redirect_uri: redirectUri,
        scope: "openid email profile",
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: "S256",
        state,
        nonce
      });
      res.redirect(authorizationUrl.href);
    } catch (error) {
      next(error);
    }
  });

  router.get("/callback", async (req, res, next) => {
    const loginToken = req.cookies[loginCookie];
    res.clearCookie(loginCookie, cookieOptions("/api/auth"));
    let login;
    try {
      login = jwt.verify(loginToken ?? "", config.sessionSecret, { algorithms: ["HS256"], issuer: tokenIssuer, audience: loginAudience });
    } catch {
      return rejectSignIn(res, "missing, expired, or invalid login cookie");
    }

    let claims;
    try {
      // The callback URL is rebuilt from APP_URL, never from request Host headers.
      const currentUrl = new URL(redirectUri);
      const queryStart = req.originalUrl.indexOf("?");
      currentUrl.search = queryStart >= 0 ? req.originalUrl.slice(queryStart) : "";
      const tokens = await client.authorizationCodeGrant(oidc, currentUrl, {
        pkceCodeVerifier: login.codeVerifier,
        expectedState: login.state,
        expectedNonce: login.nonce,
        idTokenExpected: true
      });
      claims = tokens.claims();
    } catch (error) {
      return rejectSignIn(res, error.code ?? error.name);
    }
    if (typeof claims?.sub !== "string" || !claims.sub) return rejectSignIn(res, "ID token had no subject");

    try {
      const user = { openId: `${issuer}|${claims.sub}`, name: displayName(claims), email: typeof claims.email === "string" ? claims.email : "" };
      await upsertUser(pool, user);
      const session = jwt.sign({ sub: user.openId, name: user.name, email: user.email }, config.sessionSecret, { algorithm: "HS256", issuer: tokenIssuer, audience: sessionAudience, expiresIn: "30d" });
      res.cookie(sessionCookie, session, cookieOptions("/", sessionMaxAgeMs));
      res.redirect("/");
    } catch (error) {
      next(error);
    }
  });

  router.post("/logout", (_req, res) => {
    res.clearCookie(sessionCookie, cookieOptions("/"));
    res.status(204).end();
  });

  router.get("/me", async (req, res, next) => {
    try {
      const user = readSession(req);
      if (!user) return res.status(401).json({ error: "Not signed in" });
      await upsertUser(pool, user);
      res.json({ user });
    } catch (error) {
      next(error);
    }
  });

  return { router, requireUser, readSession };
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `node --test test/auth.test.mjs`
Expected: PASS — 15 tests, 0 failures.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json server/auth.mjs test/helpers/fake-oidc.mjs test/helpers/fake-oidc-server.mjs test/helpers/server.mjs test/helpers/session.mjs test/auth.test.mjs
git commit -m "feat: add OpenID Connect sign-in module" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Rewire the server (startup, sign-in, coach state, weights)

**Files:**
- Rewrite: `server/index.mjs`
- Create: `test/server.test.mjs`

**Interfaces:**
- Consumes: `loadConfig`, `ConfigError`, `requiredVariables` (Task 1); `createPhotoStorage` (Task 2); `createPool`, `ensureSchema` (Task 3); `createAuth` (Task 4); test helpers from Tasks 2 and 4.
- Produces: a server that prints `Smooth Coach is ready on port <port>` when listening; startup failures print `Smooth Coach could not start: <database|sign-in provider|photo storage>: <reason>` and exit 1; missing config prints the `ConfigError` message and exits 1. In-file helpers later tasks use: `isRealDate(value)`, `requireUser`, `pool`, `photoStorage`, `app`.

- [ ] **Step 1: Write the failing test** — `test/server.test.mjs`

```js
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { requiredVariables } from "../server/config.mjs";
import { startFakeOidc } from "./helpers/fake-oidc.mjs";
import { baseEnv, freePort, runServerUntilExit, startServer, testSessionSecret } from "./helpers/server.mjs";
import { api, signIn } from "./helpers/session.mjs";
import { createTestDatabase } from "./helpers/stack.mjs";

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
    const env = baseEnv({ databaseUrl: "postgresql://postgres:nope@127.0.0.1:1/none?sslmode=disable", provider, port: await freePort() });
    await expectStartupFailure(env, /Smooth Coach could not start: database:/);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/server.test.mjs`
Expected: FAIL — the current server throws its Manus environment error (`Smooth Coach requires the managed OAuth...`), so the assertions on the new messages fail.

- [ ] **Step 3: Rewrite `server/index.mjs`** (complete file; photo routes are added in Task 6)

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/server.test.mjs`
Expected: PASS — 8 tests, 0 failures.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS — all test files.

- [ ] **Step 6: Commit**

```bash
git add server/index.mjs test/server.test.mjs
git commit -m "feat!: run on OIDC sign-in and validated config instead of Manus" -m "BREAKING CHANGE: MANUS_* variables are replaced by APP_URL, SESSION_SECRET, OIDC_* and S3_* settings, and the session cookie is renamed to smooth_coach_session." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Photo routes through the server, and the frontend upload

**Files:**
- Modify: `server/index.mjs`, `src/App.tsx`
- Create: `test/helpers/images.mjs`, `test/helpers/tcp-proxy.mjs`, `test/photos.test.mjs`
- Modify: `package.json`, `package-lock.json` (add `multer`)

**Interfaces:**
- Consumes: from `server/photoStorage.mjs` (Task 2) `photoTypes`, `sniffImageType`, `contentTypeForKey`; from `server/index.mjs` (Task 5) `app`, `pool`, `photoStorage`, `requireUser`, `isRealDate`; test helpers from Tasks 2 and 4.
- Produces: `GET /api/progress-photos`, `POST /api/progress-photos` (multipart fields `photo`, `capturedAt`, `caption`), `GET /api/progress-photos/:id/image`. Test helpers: `images` (`{ png, jpeg, webp }` buffers), `photoForm({ bytes, filename, type, capturedAt, caption })`, `startTcpProxy(targetPort, targetHost) → { port, close() }`.

- [ ] **Step 1: Install multer**

```bash
npm install multer@^2.4.0
```

- [ ] **Step 2: Create `test/helpers/images.mjs`**

```js
// Small byte sequences with real image signatures; the server checks signatures, not full decoding.
export const images = {
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256, 1)]),
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(256, 2)]),
  webp: Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 1, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(256, 3)])
};

export function photoForm({ bytes, filename = "photo.png", type = "image/png", capturedAt = "2026-09-01", caption } = {}) {
  const form = new FormData();
  form.append("capturedAt", capturedAt);
  if (caption !== undefined) form.append("caption", caption);
  if (bytes) form.append("photo", new Blob([bytes], { type }), filename);
  return form;
}
```

- [ ] **Step 3: Create `test/helpers/tcp-proxy.mjs`**

```js
// A TCP pass-through that tests can close to simulate the storage server going away.
import net from "node:net";

export async function startTcpProxy(targetPort, targetHost = "127.0.0.1") {
  const sockets = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, targetHost);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
```

- [ ] **Step 4: Write the failing test** — `test/photos.test.mjs`

```js
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import { startFakeOidc } from "./helpers/fake-oidc.mjs";
import { images, photoForm } from "./helpers/images.mjs";
import { baseEnv, freePort, startServer } from "./helpers/server.mjs";
import { api, signIn } from "./helpers/session.mjs";
import { createTestDatabase, stack } from "./helpers/stack.mjs";
import { startTcpProxy } from "./helpers/tcp-proxy.mjs";

const photoPrefix = (issuer, sub) => `progress-photos/${crypto.createHash("sha256").update(`${issuer}|${sub}`).digest("hex").slice(0, 32)}/`;

describe("progress photos API", () => {
  let provider;
  let database;
  let pool;
  let server;
  let s3;
  let alice;
  let bob;

  before(async () => {
    provider = await startFakeOidc();
    database = await createTestDatabase();
    server = await startServer(baseEnv({ databaseUrl: database.databaseUrl, provider, port: await freePort() }));
    pool = new pg.Pool({ connectionString: database.databaseUrl });
    s3 = new S3Client({ endpoint: stack.s3.endpoint, region: stack.s3.region, forcePathStyle: true, credentials: { accessKeyId: stack.s3.accessKeyId, secretAccessKey: stack.s3.secretAccessKey } });
    ({ cookie: alice } = await signIn(server, provider, { sub: "alice", name: "Alice" }));
    ({ cookie: bob } = await signIn(server, provider, { sub: "bob", name: "Bob" }));
  });
  after(async () => {
    s3?.destroy();
    await pool?.end();
    await server?.stop();
    await provider?.close();
    await database?.drop();
  });

  const upload = (cookie, options) => api(server, "/api/progress-photos", { cookie, method: "POST", form: photoForm(options) });

  it("requires a session", async () => {
    assert.equal((await api(server, "/api/progress-photos")).status, 401);
    assert.equal((await upload(undefined, { bytes: images.png })).status, 401);
    assert.equal((await api(server, "/api/progress-photos/1/image")).status, 401);
  });

  for (const [kind, type, filename] of [["png", "image/png", "a.png"], ["jpeg", "image/jpeg", "a.jpg"], ["webp", "image/webp", "a.webp"]]) {
    it(`accepts a ${kind} upload and streams it back privately`, async () => {
      const response = await upload(alice, { bytes: images[kind], type, filename, capturedAt: "2026-09-01", caption: `  ${kind} day  ` });
      assert.equal(response.status, 201, JSON.stringify(response.data));
      const photo = response.data.photos.at(-1);
      assert.equal(photo.caption, `${kind} day`);
      assert.equal(photo.capturedAt, "2026-09-01");
      assert.match(photo.imageUrl, /^\/api\/progress-photos\/\d+\/image$/);
      const image = await fetch(`${server.url}${photo.imageUrl}`, { headers: { cookie: alice } });
      assert.equal(image.status, 200);
      assert.equal(image.headers.get("content-type"), type);
      assert.equal(image.headers.get("cache-control"), "private, max-age=3600");
      assert.equal(image.headers.get("x-content-type-options"), "nosniff");
      assert.ok(Buffer.from(await image.arrayBuffer()).equals(images[kind]));
    });
  }

  it("lists photos in date order", async () => {
    await upload(alice, { bytes: images.png, capturedAt: "2026-08-15", caption: "earliest" });
    const { data } = await api(server, "/api/progress-photos", { cookie: alice });
    assert.equal(data.photos[0].caption, "earliest");
    assert.deepEqual(data.photos.map((photo) => photo.capturedAt), [...data.photos.map((photo) => photo.capturedAt)].sort());
    assert.ok(data.photos.every((photo) => Object.keys(photo).sort().join() === "capturedAt,caption,id,imageUrl"));
  });

  it("rejects files that are not really JPEG, PNG, or WebP", async () => {
    const response = await upload(alice, { bytes: Buffer.from("this is not an image at all"), type: "image/png", filename: "evil.png" });
    assert.equal(response.status, 400);
    assert.match(response.data.error, /JPEG, PNG, or WebP/);
  });

  it("rejects uploads over 8 MB with 413", async () => {
    const tooLarge = Buffer.concat([images.png, Buffer.alloc(8 * 1024 * 1024)]);
    const response = await upload(alice, { bytes: tooLarge });
    assert.equal(response.status, 413);
    assert.match(response.data.error, /up to 8 MB/);
  });

  it("validates the date, the caption, and the presence of a file", async () => {
    assert.equal((await upload(alice, { bytes: images.png, capturedAt: "2026-02-30" })).status, 400);
    assert.equal((await upload(alice, { bytes: images.png, caption: "x".repeat(161) })).status, 400);
    assert.equal((await upload(alice, { bytes: images.png, caption: `  ${"x".repeat(160)}  ` })).status, 201);
    assert.equal((await upload(alice, {})).status, 400);
  });

  it("hides other accounts' photos", async () => {
    const { data } = await api(server, "/api/progress-photos", { cookie: alice });
    const image = await fetch(`${server.url}${data.photos[0].imageUrl}`, { headers: { cookie: bob } });
    assert.equal(image.status, 404);
    assert.deepEqual((await api(server, "/api/progress-photos", { cookie: bob })).data.photos, []);
  });

  it("returns 404 for malformed and unknown photo ids", async () => {
    for (const id of ["abc", "0", "-1", "1.5", "999999999"]) {
      assert.equal((await api(server, `/api/progress-photos/${id}/image`, { cookie: alice })).status, 404, id);
    }
  });

  it("returns 404 when the stored object has disappeared", async () => {
    const { data } = await upload(alice, { bytes: images.png, capturedAt: "2026-09-05" });
    const photo = data.photos.find((entry) => entry.capturedAt === "2026-09-05");
    const { rows } = await pool.query("SELECT storage_key FROM progress_photos WHERE id = $1", [photo.id]);
    await s3.send(new DeleteObjectCommand({ Bucket: stack.s3.bucket, Key: rows[0].storage_key }));
    assert.equal((await api(server, photo.imageUrl, { cookie: alice })).status, 404);
  });

  it("removes the stored object when the database insert fails", async () => {
    const { cookie: carol } = await signIn(server, provider, { sub: "carol", name: "Carol" });
    await pool.query("DELETE FROM user_profiles WHERE open_id = $1", [`${provider.issuer}|carol`]);
    const response = await upload(carol, { bytes: images.png });
    assert.equal(response.status, 500);
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: stack.s3.bucket, Prefix: photoPrefix(provider.issuer, "carol") }));
    assert.equal(listing.KeyCount, 0);
  });

  it("answers 500 and logs photo storage when storage goes away", async () => {
    const proxy = await startTcpProxy(Number(new URL(stack.s3.endpoint).port));
    const outageServer = await startServer(baseEnv({ databaseUrl: database.databaseUrl, provider, port: await freePort(), s3: { ...stack.s3, endpoint: `http://127.0.0.1:${proxy.port}` } }));
    try {
      const { cookie } = await signIn(outageServer, provider, { sub: "erin", name: "Erin" });
      await proxy.close();
      const response = await api(outageServer, "/api/progress-photos", { cookie, method: "POST", form: photoForm({ bytes: images.png }) });
      assert.equal(response.status, 500);
      assert.equal(response.data.error, "Smooth Coach could not complete that request. Please try again.");
      assert.match(outageServer.output(), /photo storage upload failed/);
    } finally {
      await outageServer.stop();
    }
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `node --test test/photos.test.mjs`
Expected: FAIL — photo routes do not exist yet (`/api/progress-photos` falls through to the static handler, so status assertions fail).

- [ ] **Step 6: Add the photo routes to `server/index.mjs`**

Replace the imports at the top:

```js
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";
import { createAuth } from "./auth.mjs";
import { ConfigError, loadConfig } from "./config.mjs";
import { createPool, ensureSchema } from "./db.mjs";
import { createPhotoStorage } from "./photoStorage.mjs";
```

with:

```js
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";
import multer from "multer";
import { createAuth } from "./auth.mjs";
import { ConfigError, loadConfig } from "./config.mjs";
import { createPool, ensureSchema } from "./db.mjs";
import { contentTypeForKey, createPhotoStorage, photoTypes, sniffImageType } from "./photoStorage.mjs";
```

Then insert this block immediately before the line `app.use((error, _req, res, _next) => {`:

```js
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
    stream.on("error", (error) => {
      console.error("Smooth Coach photo storage stream failed", error.message);
      res.destroy(error);
    });
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
});

```

- [ ] **Step 7: Run test to verify it passes**

Run: `node --test test/photos.test.mjs`
Expected: PASS — 13 tests, 0 failures.

- [ ] **Step 8: Switch the frontend to one multipart upload**

In `src/App.tsx`, replace the whole `handlePhotoUpload` function (from `const handlePhotoUpload = async (input: { file: File; capturedAt: string; caption: string }) => {` through its closing `};`) with:

```tsx
  const handlePhotoUpload = async (input: { file: File; capturedAt: string; caption: string }) => {
    const form = new FormData();
    form.append("capturedAt", input.capturedAt);
    form.append("caption", input.caption);
    form.append("photo", input.file);
    const response = await fetch("/api/progress-photos", { method: "POST", credentials: "same-origin", body: form });
    const payload = await response.json().catch(() => ({})) as { error?: string; photos?: ProgressPhoto[] };
    if (!response.ok) throw new Error(payload.error ?? (response.status === 413 ? "That picture is larger than the server accepts. Choose an image up to 8 MB." : "The picture could not be added. Please try again."));
    setPhotos(payload.photos ?? []);
  };
```

- [ ] **Step 9: Typecheck/build and run the whole suite**

Run: `npm run build` then `npm test`
Expected: build succeeds with no TypeScript errors; all tests PASS.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json server/index.mjs src/App.tsx test/helpers/images.mjs test/helpers/tcp-proxy.mjs test/photos.test.mjs
git commit -m "feat: upload and serve progress photos through the server" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Docker Compose packaging and Manus cleanup

**Files:**
- Create: `docker-compose.yml`, `test/fixtures/compose.env`, `test/packaging.test.mjs`
- Rewrite: `.env.example`
- Delete: `app.config.ts`, `public/manus-routes.json`
- Modify: `vite.config.ts`

**Interfaces:**
- Consumes: `deploy/garage/garage.toml`, `deploy/garage/init.mjs` (Task 2); image `venturesconsulting/smooth-coach:3.0.0` (published in Task 9).
- Produces: compose services `app`, `garage`, `garage-init`; volumes `garage-meta`, `garage-data`; run command `docker compose --env-file smooth-coach.env up -d`.

- [ ] **Step 1: Create `test/fixtures/compose.env`** (dummy values for validation only)

```
APP_URL=https://coach.example.com
DATABASE_URL=postgresql://smooth_coach_app:pw@host.docker.internal:5432/smooth_coach?sslmode=disable
SESSION_SECRET=compose-validation-session-secret-0123456789
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=compose-client
OIDC_CLIENT_SECRET=compose-secret
S3_ACCESS_KEY_ID=GK0123456789abcdef01234567
S3_SECRET_ACCESS_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
GARAGE_RPC_SECRET=abababababababababababababababababababababababababababababababab
GARAGE_ADMIN_TOKEN=compose-admin-token
```

- [ ] **Step 2: Write the failing test** — `test/packaging.test.mjs`

```js
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(root, "docker-compose.yml");

function composeConfig(envFile) {
  return JSON.parse(execFileSync("docker", ["compose", "-f", composeFile, "--env-file", envFile, "config", "--format", "json"], { cwd: root, encoding: "utf8" }));
}

describe("docker-compose.yml", () => {
  const config = composeConfig(path.join(root, "test", "fixtures", "compose.env"));
  const envKeys = (service) => Object.keys(config.services[service].environment ?? {}).sort();

  it("defines exactly the app, garage, and garage-init services", () => {
    assert.deepEqual(Object.keys(config.services).sort(), ["app", "garage", "garage-init"]);
  });

  it("gives each service only the variables it needs", () => {
    assert.deepEqual(envKeys("app"), ["APP_URL", "DATABASE_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_ISSUER", "S3_ACCESS_KEY_ID", "S3_BUCKET", "S3_ENDPOINT", "S3_FORCE_PATH_STYLE", "S3_REGION", "S3_SECRET_ACCESS_KEY", "SESSION_SECRET"]);
    assert.deepEqual(envKeys("garage"), ["GARAGE_ADMIN_TOKEN", "GARAGE_RPC_SECRET"]);
    assert.deepEqual(envKeys("garage-init"), ["GARAGE_ADMIN_TOKEN", "GARAGE_ADMIN_URL", "GARAGE_CAPACITY", "S3_ACCESS_KEY_ID", "S3_BUCKET", "S3_SECRET_ACCESS_KEY"]);
  });

  it("publishes only the app, and only on localhost", () => {
    const [port] = config.services.app.ports;
    assert.equal(config.services.app.ports.length, 1);
    assert.equal(port.host_ip, "127.0.0.1");
    assert.equal(String(port.published), "3000");
    assert.equal(port.target, 3000);
    assert.equal(config.services.garage.ports, undefined);
    assert.equal(config.services["garage-init"].ports, undefined);
  });

  it("pins images and starts the app after garage-init succeeds", () => {
    assert.equal(config.services.app.image, "venturesconsulting/smooth-coach:3.0.0");
    assert.equal(config.services.garage.image, "dxflrs/garage:v2.4.1");
    for (const service of Object.values(config.services)) assert.ok(!service.image.endsWith(":latest"), service.image);
    assert.equal(config.services.app.depends_on["garage-init"].condition, "service_completed_successfully");
    assert.equal(config.services.app.environment.S3_ENDPOINT, "http://garage:3900");
    assert.equal(config.services.app.environment.S3_BUCKET, "smooth-coach-photos");
  });

  it("refuses to render without required settings", () => {
    const emptyEnv = path.join(mkdtempSync(path.join(os.tmpdir(), "smooth-coach-")), "empty.env");
    writeFileSync(emptyEnv, "");
    const result = spawnSync("docker", ["compose", "-f", composeFile, "--env-file", emptyEnv, "config"], { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /set .* in smooth-coach\.env/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/packaging.test.mjs`
Expected: FAIL — `docker compose` reports that `docker-compose.yml` does not exist.

- [ ] **Step 4: Create `docker-compose.yml`**

```yaml
# Smooth Coach on your own Docker host.
# Start with:  docker compose --env-file smooth-coach.env up -d
# PostgreSQL is your existing server (DATABASE_URL); photos live in the bundled Garage.
name: smooth-coach

services:
  app:
    image: venturesconsulting/smooth-coach:3.0.0
    restart: unless-stopped
    depends_on:
      garage-init:
        condition: service_completed_successfully
    # Only your reverse proxy on this host should reach the app.
    ports:
      - "127.0.0.1:3000:3000"
    # Lets DATABASE_URL use host.docker.internal for a PostgreSQL server on this host.
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      APP_URL: ${APP_URL:?set APP_URL in smooth-coach.env}
      DATABASE_URL: ${DATABASE_URL:?set DATABASE_URL in smooth-coach.env}
      SESSION_SECRET: ${SESSION_SECRET:?set SESSION_SECRET in smooth-coach.env}
      OIDC_ISSUER: ${OIDC_ISSUER:?set OIDC_ISSUER in smooth-coach.env}
      OIDC_CLIENT_ID: ${OIDC_CLIENT_ID:?set OIDC_CLIENT_ID in smooth-coach.env}
      OIDC_CLIENT_SECRET: ${OIDC_CLIENT_SECRET:?set OIDC_CLIENT_SECRET in smooth-coach.env}
      S3_ENDPOINT: http://garage:3900
      S3_REGION: garage
      S3_FORCE_PATH_STYLE: "true"
      S3_BUCKET: ${S3_BUCKET:-smooth-coach-photos}
      S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID:?set S3_ACCESS_KEY_ID in smooth-coach.env}
      S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY:?set S3_SECRET_ACCESS_KEY in smooth-coach.env}

  garage:
    image: dxflrs/garage:v2.4.1
    restart: unless-stopped
    environment:
      GARAGE_RPC_SECRET: ${GARAGE_RPC_SECRET:?set GARAGE_RPC_SECRET in smooth-coach.env}
      GARAGE_ADMIN_TOKEN: ${GARAGE_ADMIN_TOKEN:?set GARAGE_ADMIN_TOKEN in smooth-coach.env}
    volumes:
      - ./deploy/garage/garage.toml:/etc/garage.toml:ro
      - garage-meta:/var/lib/garage/meta
      - garage-data:/var/lib/garage/data

  # One-shot, idempotent setup: storage layout, the app's key, the bucket, and its permissions.
  garage-init:
    image: node:22-alpine
    restart: "no"
    depends_on:
      - garage
    environment:
      GARAGE_ADMIN_URL: http://garage:3903
      GARAGE_ADMIN_TOKEN: ${GARAGE_ADMIN_TOKEN:?set GARAGE_ADMIN_TOKEN in smooth-coach.env}
      GARAGE_CAPACITY: ${GARAGE_CAPACITY:-10G}
      S3_BUCKET: ${S3_BUCKET:-smooth-coach-photos}
      S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID:?set S3_ACCESS_KEY_ID in smooth-coach.env}
      S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY:?set S3_SECRET_ACCESS_KEY in smooth-coach.env}
    volumes:
      - ./deploy/garage:/garage-setup:ro
    command: ["node", "/garage-setup/init.mjs"]

volumes:
  garage-meta:
  garage-data:
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/packaging.test.mjs`
Expected: PASS — 5 tests.

- [ ] **Step 6: Rewrite `.env.example`**

```
# Smooth Coach 3.x configuration for docker compose
#
# Copy to smooth-coach.env (ignored by git), fill in every value, then start:
#   docker compose --env-file smooth-coach.env up -d
#
# Format rules: one NAME=value per line, no quotes around values, no inline comments.
# Keep the filled-in file out of git and store the values in a secret manager.

# --- Public address (required) --------------------------------------------------------
# The HTTPS address your reverse proxy serves, with no path. Sign-in callbacks go to
# APP_URL/api/auth/callback, which must also be registered with your sign-in provider.
APP_URL=

# --- Database (required) --------------------------------------------------------------
# PostgreSQL 14+ connection string for the app role created by
# deploy/postgres/setup-smooth-coach-postgres.sh. URL-encode the password.
# For a PostgreSQL server on this Docker host, use host.docker.internal as the host.
# TLS: sslmode=verify-full validates the server certificate; add &sslrootcert=/path/ca.pem
# if your provider uses its own CA (mount the file into the app container). Use
# sslmode=disable only when the database is on this host or a trusted private network.
# Example: postgresql://smooth_coach_app:URL_ENCODED_PASSWORD@host.docker.internal:5432/smooth_coach?sslmode=disable
DATABASE_URL=

# --- Sessions (required) --------------------------------------------------------------
# Signs the login cookies. At least 32 characters; changing it signs everyone out.
#   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
SESSION_SECRET=

# --- Sign-in with Google or another OpenID Connect provider (required) ----------------
# Google: keep the issuer below and paste the Web application client's ID and secret.
# Other providers: their issuer URL, e.g. https://auth.example.com/realms/home (Keycloak).
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=

# --- Photo storage key (required) -----------------------------------------------------
# The app's Garage access key; garage-init creates it from these values.
# Access key ID: GK followed by 24 hex characters
#   node -e "console.log('GK' + require('crypto').randomBytes(12).toString('hex'))"
# Secret: 64 hex characters
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
# Bucket name (optional, default smooth-coach-photos)
# S3_BUCKET=smooth-coach-photos

# --- Garage internals (required; only the garage and garage-init containers see these) -
# 64 hex characters:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
GARAGE_RPC_SECRET=
# Any long random value:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
GARAGE_ADMIN_TOKEN=
# Disk space Garage may use for photos (optional, default 10G)
# GARAGE_CAPACITY=10G

# --- Set by docker-compose.yml; only needed when running the image without compose ----
# S3_ENDPOINT=http://garage:3900
# S3_REGION=garage
# S3_FORCE_PATH_STYLE=true
# PORT=3000
```

- [ ] **Step 7: Remove the Manus leftovers**

```bash
git rm app.config.ts public/manus-routes.json
```

In `vite.config.ts`, replace:

```ts
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    allowedHosts: ["3000-ib3vbyzbr7mjbrj277k6g-7125f901.us1.manus.computer"]
  }
```

with:

```ts
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true
  }
```

- [ ] **Step 8: Verify nothing references Manus and the build still works**

Run: `git grep -n -i manus -- ':!CHANGELOG.md' ':!docs/' ':!plan.md' ':!TODO.md' ':!deploy/CLAUDE_DATABASE_SETUP.md'` then `npm run build`
Expected: `git grep` prints nothing (exit code 1); build succeeds. (`plan.md`, `TODO.md`, and `deploy/CLAUDE_DATABASE_SETUP.md` are updated in Task 8.)

- [ ] **Step 9: Commit**

```bash
git add docker-compose.yml .env.example test/fixtures/compose.env test/packaging.test.mjs vite.config.ts
git commit -m "feat: add Docker Compose deployment with Garage and remove Manus files" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Documentation

**Files:**
- Create: `README.md`
- Modify: `plan.md`, `TODO.md`, `deploy/CLAUDE_DATABASE_SETUP.md`

**Interfaces:**
- Consumes: file names, variables, and commands from Tasks 1–7.
- Produces: user-facing self-hosting guide.

- [ ] **Step 1: Create `README.md`**

````markdown
# Smooth Coach

A calm, day-by-day companion for a 10-day green smoothie routine: today's recipe and routine, a water tracker, reflections, a recipe library, and prep notes. Signed-in users also get a private weight timeline and a private progress-photo timeline.

Smooth Coach organizes user-supplied source material. It is not medical advice.

## Self-hosting

Smooth Coach runs on your own Docker host:

- **app** — the Smooth Coach container, reachable only by your reverse proxy
- **garage** — [Garage](https://garagehq.deuxfleurs.fr/), a small S3-compatible store that keeps photos on your server
- **garage-init** — a one-shot container that sets up Garage's storage, the app's key, and the bucket
- **PostgreSQL** — your existing server (not part of the compose file)
- **Sign-in** — Google, or any OpenID Connect provider

### What you need

- Docker with Compose v2
- A domain, and a reverse proxy that terminates HTTPS for it
- PostgreSQL 14 or newer
- A Google account (or another OpenID Connect provider)
- Node.js on any machine, only to generate secrets with the commands below (or use any other random generator)

### 1. Get the files

```bash
git clone https://github.com/kevinpalmer-ventures/smooth-coach.git
cd smooth-coach
```

The deployment uses `docker-compose.yml`, `deploy/garage/`, and `.env.example`.

### 2. Create the database

On a machine with `psql` that can reach your PostgreSQL server:

```bash
export PG_ADMIN_HOST='your-postgresql-host'
export PG_ADMIN_USERNAME='your-admin-role'
export PG_ADMIN_PASSWORD='admin-password-from-your-secret-manager'
export SMOOTH_COACH_DB_PASSWORD='long-unique-app-password'
./deploy/postgres/setup-smooth-coach-postgres.sh
```

This creates the `smooth_coach` database and the `smooth_coach_app` role, applies the schema, and prints `Tables verified: 4`. The app keeps the schema up to date itself on every start.

If PostgreSQL runs on the Docker host itself, the app reaches it at `host.docker.internal`. PostgreSQL must listen on an address the containers can reach (for example `listen_addresses = '*'`), and `pg_hba.conf` must allow the Docker network (for example `host smooth_coach smooth_coach_app 172.16.0.0/12 scram-sha-256`).

### 3. Create a Google sign-in client

1. In [Google Cloud Console](https://console.cloud.google.com/), create or pick a project.
2. **APIs & Services → OAuth consent screen**: choose **External**, fill in the app name and support email, and add the scopes `openid`, `email`, and `profile`.
3. **Publish the app.** While the consent screen is in "Testing", only the test users you list can sign in. These basic scopes do not need Google verification.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Web application**.
5. Add the authorized redirect URI `https://coach.example.com/api/auth/callback` (your domain).
6. Copy the client ID and client secret.

### 4. Configure

```bash
cp .env.example smooth-coach.env
```

Fill in every value in `smooth-coach.env`; the file explains each one and how to generate the secrets. `smooth-coach.env` is ignored by git — keep it that way and store the values in a secret manager.

### 5. Start

```bash
docker compose --env-file smooth-coach.env up -d
docker compose --env-file smooth-coach.env logs -f app
```

Wait for `Smooth Coach is ready on port 3000`. If something is wrong, the app stops with a message naming the problem — for example `Smooth Coach requires these environment variables: …` or `Smooth Coach could not start: database: …` — and never prints secret values.

### 6. Point your reverse proxy at it

The app listens on `127.0.0.1:3000`. Photo uploads can be up to 8 MB, so the proxy must accept request bodies of at least 10 MB.

**Caddy** (no body limit by default):

```
coach.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

**nginx** (the default 1 MB limit blocks photo uploads):

```nginx
server {
    listen 443 ssl;
    server_name coach.example.com;
    # ssl_certificate and ssl_certificate_key as usual

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Nginx Proxy Manager, Traefik, or another proxy running in Docker:** a proxy container cannot reach the host's `127.0.0.1`. Put the app on the proxy's Docker network instead with a `docker-compose.override.yml` next to `docker-compose.yml`:

```yaml
services:
  app:
    ports: !reset []
    networks: [default, proxy]

networks:
  proxy:
    external: true
    name: your-proxy-network
```

Then forward to `smooth-coach-app-1` port `3000`. In Nginx Proxy Manager, also add `client_max_body_size 10m;` under the proxy host's **Advanced** tab.

### 7. First sign-in checklist

1. Open `https://coach.example.com` and click **Sign in**.
2. Google shows your app name; choose an account and continue.
3. You return to Smooth Coach and see "Signed in as …".
4. Add a weight on the **Progress** page, then upload a small photo; both appear in your timeline.
5. Sign out, then sign in with a second Google account: it must not see the first account's weight or photo.

If sign-in shows "The sign-in request could not be verified", check that `APP_URL` exactly matches the address in your browser and that the redirect URI in Google is `APP_URL/api/auth/callback`. The app log names the reason.

### Backups

- **Database:** `pg_dump --format=custom --file=smooth-coach.dump "postgresql://…/smooth_coach"`
- **Photos:** stop the app and Garage, archive both Garage volumes, then start again:

```bash
docker compose --env-file smooth-coach.env stop app garage
docker run --rm -v smooth-coach_garage-meta:/meta -v smooth-coach_garage-data:/data -v "$PWD":/backup alpine tar czf /backup/garage-backup.tgz /meta /data
docker compose --env-file smooth-coach.env start garage app
```

Back up the database and the Garage volumes together; each photo row points at an object in Garage.

### Upgrading from 2.x

3.0.0 removes the Manus integration. Accounts are now keyed by your sign-in provider, so 2.x accounts and their data do not carry over — start with a fresh database. Remove every `MANUS_*` variable and set the variables in `.env.example`. Everyone signs in again, because the session cookie changed.

### Other sign-in providers

Any OpenID Connect provider works: set `OIDC_ISSUER` to its issuer URL (for example `https://your-tenant.auth0.com/`, `https://auth.example.com/realms/home` for Keycloak, or `https://auth.example.com/application/o/smooth-coach/` for Authentik), create a confidential client with the redirect URI `APP_URL/api/auth/callback`, and allow the scopes `openid email profile`.

### Other S3 storage

To use Cloudflare R2, AWS S3, or another S3-compatible service instead of Garage, delete the `garage` and `garage-init` services and the app's `depends_on`, then set `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` for that service in the app's `environment`. Keep the bucket private; the app never exposes it.

## Development

```bash
npm install
npm run test:stack:up   # throwaway PostgreSQL and Garage in Docker
npm test                # unit and integration tests
npm run test:stack:down
```

`npm run dev` starts the server with Vite's development middleware. It needs the same environment variables as production; for local work you can point `DATABASE_URL` and the `S3_*` variables at the test stack (see `test/helpers/stack.mjs`) and use `APP_URL=http://localhost:3000` with a Google client that allows the redirect URI `http://localhost:3000/api/auth/callback`.
````

- [ ] **Step 2: Update `plan.md`**

Replace:

```
- Manus account login with an authenticated application session. Signed-in users have their coaching check-ins stored under their account; a logged-out visitor can still read the source guide.
```

with:

```
- Sign-in with Google or any OpenID Connect provider, with an authenticated application session. Signed-in users have their coaching check-ins stored under their account; a logged-out visitor can still read the source guide.
```

Replace:

```
The browser uploads directly to a short-lived storage URL; the server records only the owned object key and returns a short-lived download URL only to that account.
```

with:

```
The browser sends the picture to the server, which checks its file signature, stores it in the private Garage bucket, and serves it back only to that account through an authenticated image route.
```

Replace the whole `## Architecture` paragraph (the line starting `React + TypeScript + Vite provide the browser experience.`) with:

```
React + TypeScript + Vite provide the browser experience. An Express server hosts the Vite development middleware and production static bundle, exposes authenticated APIs, and signs users in through any OpenID Connect provider (Google by default) using `openid-client` with PKCE, state, nonce, and verified ID-token signatures. A PostgreSQL 14+ database (via the `pg` driver and `DATABASE_URL`) holds `user_profiles`, `user_coach_state`, `weight_entries`, and `progress_photos`; a self-hosted Garage bucket on the internal Docker network holds the private photo bytes, which only ever pass through the app server. Account sessions use the `smooth_coach_session` cookie (HS256 JWT, `HttpOnly`, `Secure`, `SameSite=Lax`), and every database query is scoped to the account ID (`issuer|subject`) stored in `open_id`. At startup the server validates its configuration, applies the idempotent, additive `deploy/postgres/smooth-coach-schema.sql` under an advisory lock, loads the sign-in provider's configuration, and checks the photo bucket; no destructive database operation is used.
```

In the project structure table, replace the row:

```
| `server/index.mjs` | OAuth flow, validated session handling, database/storage initialization, private media APIs, and static/dev serving. |
```

with:

```
| `server/index.mjs` | Startup sequence, coaching, weight, and private photo APIs, and static/dev serving. |
| `server/config.mjs` | Environment validation that names missing or invalid settings without printing values. |
| `server/auth.mjs` | OpenID Connect sign-in and the application session cookie. |
| `server/db.mjs` | PostgreSQL pool and startup schema application. |
| `server/photoStorage.mjs` | Private S3-compatible photo storage and image signature checks. |
| `docker-compose.yml` | Self-hosted deployment: app, Garage, and Garage setup. |
| `deploy/garage/` | Garage configuration and idempotent setup script. |
```

and delete the row:

```
| `public/manus-routes.json` | Declares the single browser route. |
```

- [ ] **Step 3: Update `TODO.md`**

Replace `Allows a user to sign in to their own Manus account,` with `Allows a user to sign in with Google or another OpenID Connect provider,`.

- [ ] **Step 4: Update `deploy/CLAUDE_DATABASE_SETUP.md`**

- Replace `Verify exactly five application tables exist` with `Verify exactly four application tables exist`.
- Replace `   - keep all account-scoping, foreign keys, upload-intent expiration, and photo type/size verification intact` with `   - keep all account-scoping, foreign keys, and photo type/size verification intact`.
- Replace `a weight entry, and a photo-upload intent.` with `a weight entry, and a photo upload.`
- Delete the table row `| \`progress_photo_uploads\` | Short-lived, app-authorized photo upload intents |`.

- [ ] **Step 5: Verify**

Run: `git grep -n -i "manus" -- ':!CHANGELOG.md' ':!docs/'` and `git grep -n "progress_photo_uploads\|upload intent\|upload-intent" -- ':!CHANGELOG.md' ':!docs/'`
Expected: the first prints only the README's "Upgrading from 2.x" lines that mention Manus and `MANUS_*`; the second prints only the schema comment in `deploy/postgres/smooth-coach-schema.sql`.

- [ ] **Step 6: Commit**

```bash
git add README.md plan.md TODO.md deploy/CLAUDE_DATABASE_SETUP.md
git commit -m "docs: add self-hosting guide and remove Manus references" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Container smoke test and 3.0.0 release

**Files:**
- Create: `test/smoke/compose.smoke.yml`, `test/smoke/smoke.env`, `test/smoke/smoke.mjs`
- Modify: `CHANGELOG.md`, `package.json`, `package-lock.json`

**Interfaces:**
- Consumes: everything above; `test/helpers/fake-oidc-server.mjs`, `test/helpers/session.mjs`, `test/helpers/images.mjs`.
- Produces: tag `v3.0.0` and image `venturesconsulting/smooth-coach:3.0.0`.

- [ ] **Step 1: Create `test/smoke/compose.smoke.yml`**

Paths are relative to the project directory (the first compose file's folder).

```yaml
# Container smoke test: the locally built image, a throwaway PostgreSQL, and the fake OIDC
# provider running inside the app container so its http:// issuer is a loopback address.
services:
  app:
    image: smooth-coach:smoke
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "127.0.0.1:39556:39556"
    volumes:
      - ./test/helpers:/helpers:ro
    command: ["sh", "-c", "node /helpers/fake-oidc-server.mjs & sleep 1 && exec node server/index.mjs"]

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: smoke-test
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
      interval: 2s
      retries: 30
    tmpfs:
      - /var/lib/postgresql/data
```

- [ ] **Step 2: Create `test/smoke/smoke.env`** (test-only values)

```
APP_URL=http://127.0.0.1:3000
DATABASE_URL=postgresql://postgres:smoke-test@postgres:5432/postgres?sslmode=disable
SESSION_SECRET=smoke-session-secret-0123456789abcdef
OIDC_ISSUER=http://127.0.0.1:39556
OIDC_CLIENT_ID=smoke-client
OIDC_CLIENT_SECRET=smoke-secret
S3_ACCESS_KEY_ID=GKabcdefabcdefabcdefabcdef
S3_SECRET_ACCESS_KEY=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
GARAGE_RPC_SECRET=cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd
GARAGE_ADMIN_TOKEN=smoke-admin-token
GARAGE_CAPACITY=1G
```

- [ ] **Step 3: Create `test/smoke/smoke.mjs`**

```js
// End-to-end check of the built image through Docker Compose: health, sign-in through the
// fake provider, coach state, a weight entry, and a photo upload and download.
import assert from "node:assert/strict";
import { images, photoForm } from "../helpers/images.mjs";
import { api, signIn } from "../helpers/session.mjs";

const server = { url: "http://127.0.0.1:3000" };
// The fake provider runs inside the app container, so tampering hooks are not used here.
const provider = {};

async function waitForHealth(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${server.url}/api/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("app did not become healthy within 2 minutes");
}

await waitForHealth();
assert.equal((await api(server, "/api/weights")).status, 401);
const { cookie } = await signIn(server, provider);
assert.equal((await api(server, "/api/auth/me", { cookie })).data.user.name, "Test User");
const coachState = { activeDay: 2, planMode: "full", days: {}, reminders: false };
assert.equal((await api(server, "/api/coach-state", { cookie, method: "PUT", json: { coachState } })).status, 204);
assert.equal((await api(server, "/api/weights", { cookie, method: "POST", json: { weight: 150, unit: "lb", loggedAt: "2026-09-01" } })).status, 201);
const uploaded = await api(server, "/api/progress-photos", { cookie, method: "POST", form: photoForm({ bytes: images.png, caption: "smoke" }) });
assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
const image = await fetch(`${server.url}${uploaded.data.photos[0].imageUrl}`, { headers: { cookie } });
assert.equal(image.status, 200);
assert.ok(Buffer.from(await image.arrayBuffer()).equals(images.png));
console.log("smoke test passed");
```

- [ ] **Step 4: Run the full suite and build**

Run: `npm run test:stack:up`, `npm test`, `npm run build`
Expected: all tests PASS; build succeeds.

- [ ] **Step 5: Build the image and run the smoke test**

```bash
docker build -t smooth-coach:smoke .
docker compose -p smooth-coach-smoke -f docker-compose.yml -f test/smoke/compose.smoke.yml --env-file test/smoke/smoke.env up -d
node test/smoke/smoke.mjs
docker compose -p smooth-coach-smoke -f docker-compose.yml -f test/smoke/compose.smoke.yml --env-file test/smoke/smoke.env logs app | tail -20
docker compose -p smooth-coach-smoke -f docker-compose.yml -f test/smoke/compose.smoke.yml --env-file test/smoke/smoke.env down -v
```

Expected: `smoke test passed`; the app log shows `Smooth Coach is ready on port 3000` and no `server error` lines. (Port 3000 on the host must be free.)

- [ ] **Step 6: Commit the smoke test**

```bash
git add test/smoke
git commit -m "test: add container smoke test" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Merge into main**

```bash
git switch main
git merge --ff-only feat/self-hosting
git log --oneline v2.0.1..HEAD
```

Expected: fast-forward succeeds; the log lists this plan's commits plus the earlier `.env.example` and spec commits. The highest bump is MAJOR (the `feat!` commit), so the release is 3.0.0.

- [ ] **Step 8: Bump the version**

```bash
npm version 3.0.0 --no-git-tag-version
```

- [ ] **Step 9: Write the 3.0.0 changelog section**

In `CHANGELOG.md`, replace everything from `## [Unreleased]` up to (not including) `## [2.0.1] - 2026-10-04` with the following, using the release date (`YYYY-MM-DD`, today):

```markdown
## [Unreleased]

## [3.0.0] - YYYY-MM-DD

### Added
- Self-hosting with Docker Compose: the app plus a bundled Garage S3-compatible store and a one-shot, idempotent `garage-init` setup container. PostgreSQL stays your existing server.
- Sign-in with Google or any OpenID Connect provider (PKCE, state, nonce, and verified ID-token signatures via `openid-client`).
- `README.md` self-hosting guide: database provisioning, Google client setup, reverse proxy snippets (including the 10 MB upload limit nginx needs), backups, and a first sign-in checklist.
- `.env.example` documenting every setting, where each value comes from, and how to generate secrets.
- Automated tests (`npm test`) with a throwaway PostgreSQL and Garage stack, a fake OpenID Connect provider for sign-in attack cases, and a container smoke test.

### Changed
- **BREAKING:** Configuration uses `APP_URL`, `SESSION_SECRET`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (plus optional `S3_REGION`, `S3_FORCE_PATH_STYLE`, `PORT`) instead of `MANUS_*`. Startup names any missing or invalid setting without printing values, and names the failing component (database, sign-in provider, or photo storage).
- **BREAKING:** The session cookie is now `smooth_coach_session` with `SameSite=Lax`; everyone signs in again after upgrading. Accounts are keyed by the sign-in provider (`issuer|subject`), so 2.x accounts do not carry over.
- Progress photos are uploaded to and served by the app server; listing photos no longer calls the storage service.
- Protected API requests no longer write the user profile on every call; it is written at sign-in and when the app loads.

### Removed
- The Manus integration: Manus OAuth, the Manus storage presign API, `app.config.ts`, and `public/manus-routes.json`.
- `POST /api/progress-photos/presign` and the `progress_photo_uploads` table from the schema (existing tables are left untouched).

### Security
- Photo files are checked by their actual bytes (JPEG, PNG, or WebP) instead of the browser-declared type, and every image request requires the owner's session; the bucket is never publicly reachable.
- ID-token signatures are verified against the provider's published keys, in addition to TLS.
- `*.env` files (such as `smooth-coach.env`) are ignored by git and excluded from Docker build contexts.
```

- [ ] **Step 10: Commit and tag the release**

```bash
git add CHANGELOG.md package.json package-lock.json
git commit -m "chore(release): v3.0.0" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git tag -a v3.0.0 -m "v3.0.0"
```

- [ ] **Step 11: Ask the user before pushing**

Ask the user to confirm pushing `main` and tag `v3.0.0`. Only after a clear yes:

```bash
git push origin main
git push origin v3.0.0
```

- [ ] **Step 12: Build and smoke-test the release image from the tag**

```bash
docker manifest inspect venturesconsulting/smooth-coach:3.0.0 >/dev/null 2>&1 && echo "3.0.0 ALREADY EXISTS - stop" || echo "3.0.0 is free"
git -c core.autocrlf=false archive --format=tar v3.0.0 | docker build --platform linux/amd64 -t venturesconsulting/smooth-coach:3.0.0 --label org.opencontainers.image.version=3.0.0 --label org.opencontainers.image.revision=$(git rev-parse v3.0.0^{commit}) --label org.opencontainers.image.source=https://github.com/kevinpalmer-ventures/smooth-coach -
docker tag venturesconsulting/smooth-coach:3.0.0 smooth-coach:smoke
docker compose -p smooth-coach-smoke -f docker-compose.yml -f test/smoke/compose.smoke.yml --env-file test/smoke/smoke.env up -d
node test/smoke/smoke.mjs
docker compose -p smooth-coach-smoke -f docker-compose.yml -f test/smoke/compose.smoke.yml --env-file test/smoke/smoke.env down -v
```

Expected: `3.0.0 is free`, then `smoke test passed`.

- [ ] **Step 13: Ask the user before publishing the image**

Ask the user to confirm pushing `venturesconsulting/smooth-coach:3.0.0`. Only after a clear yes:

```bash
docker push venturesconsulting/smooth-coach:3.0.0
```

Report the pushed digest. Do **not** move `latest` unless the user explicitly asks; `latest` currently points to 2.0.1.

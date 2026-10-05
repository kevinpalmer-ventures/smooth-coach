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
    assert.equal(config.databaseStartupTimeoutMs, 30000);
    assert.equal(config.isProduction, false);
  });

  it("normalizes APP_URL to its origin", () => {
    assert.equal(loadConfig({ ...validEnv(), APP_URL: "https://coach.example.com/" }).appUrl, "https://coach.example.com");
  });

  it("reads optional values", () => {
    const config = loadConfig({ ...validEnv(), S3_REGION: "garage", S3_FORCE_PATH_STYLE: "FALSE", PORT: "8080", NODE_ENV: "production", DATABASE_STARTUP_TIMEOUT: "5" });
    assert.equal(config.s3.region, "garage");
    assert.equal(config.s3.forcePathStyle, false);
    assert.equal(config.port, 8080);
    assert.equal(config.isProduction, true);
    assert.equal(config.databaseStartupTimeoutMs, 5000);
    assert.equal(loadConfig({ ...validEnv(), DATABASE_STARTUP_TIMEOUT: "0" }).databaseStartupTimeoutMs, 0);
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
    ["bad PORT", { PORT: "eighty" }, /PORT must be a whole number/],
    ["non-numeric DATABASE_STARTUP_TIMEOUT", { DATABASE_STARTUP_TIMEOUT: "soon" }, /DATABASE_STARTUP_TIMEOUT must be a whole number of seconds/],
    ["negative DATABASE_STARTUP_TIMEOUT", { DATABASE_STARTUP_TIMEOUT: "-1" }, /DATABASE_STARTUP_TIMEOUT must be a whole number of seconds/]
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

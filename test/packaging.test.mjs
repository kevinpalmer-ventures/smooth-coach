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

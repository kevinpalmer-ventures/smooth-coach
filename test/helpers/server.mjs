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

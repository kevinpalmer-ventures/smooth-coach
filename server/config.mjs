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
  const databaseStartupTimeoutText = env.DATABASE_STARTUP_TIMEOUT || "30";
  const databaseStartupTimeout = /^\d+$/.test(databaseStartupTimeoutText) ? Number(databaseStartupTimeoutText) : NaN;
  if (!Number.isInteger(databaseStartupTimeout)) problems.push("DATABASE_STARTUP_TIMEOUT must be a whole number of seconds");

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
    databaseStartupTimeoutMs: databaseStartupTimeout * 1000,
    isProduction: env.NODE_ENV === "production"
  });
}

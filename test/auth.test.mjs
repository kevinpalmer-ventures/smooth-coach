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

  // Silences the expected "Smooth Coach sign-in rejected: ..." warning and records what was logged.
  function captureWarnings(t) {
    const logged = [];
    t.mock.method(console, "warn", (...args) => { logged.push(args.join(" ")); });
    return logged;
  }

  // `loginCookieRejected` says whether the logged reason must be the login-cookie check (true)
  // or some other check, such as the provider or token validation (false).
  async function expectRejected(callback, logged, { loginCookieRejected, callbackUrl, loginCookie }) {
    assert.equal(callback.status, 400);
    assert.equal(await callback.text(), verificationFailed);
    assert.equal(callback.headers.getSetCookie().some((cookie) => cookie.startsWith("smooth_coach_session=") && !cookie.startsWith("smooth_coach_session=;")), false);
    assert.equal(logged.length, 1, `expected one rejection warning, got: ${JSON.stringify(logged)}`);
    assert.match(logged[0], /^Smooth Coach sign-in rejected: /);
    assert.equal(logged[0].includes("missing, expired, or invalid login cookie"), loginCookieRejected, `unexpected rejection reason: ${logged[0]}`);
    const code = new URL(callbackUrl).searchParams.get("code");
    assert.ok(code);
    assert.equal(logged[0].includes(code), false, "the log line contains the authorization code");
    if (loginCookie) assert.equal(logged[0].includes(loginCookie), false, "the log line contains the login cookie");
  }

  // Re-signs the real login cookie's verifier, state, and nonce so that only the signature or expiry can fail.
  function resignLoginCookie(loginCookie, secret, extra = {}) {
    const { codeVerifier, state, nonce } = jwt.decode(loginCookie);
    return jwt.sign({ codeVerifier, state, nonce, ...extra }, secret, { algorithm: "HS256", issuer: "smooth-coach", audience: "smooth-coach-login" });
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

  it("rejects a tampered state", async (t) => {
    const logged = captureWarnings(t);
    const { loginCookie, callbackUrl } = await startSignIn(server, provider);
    const tampered = new URL(callbackUrl);
    tampered.searchParams.set("state", "attacker-state");
    await expectRejected(await finishSignIn(tampered.href, loginCookie), logged, { loginCookieRejected: false, callbackUrl, loginCookie });
  });

  it("rejects a missing login cookie", async (t) => {
    const logged = captureWarnings(t);
    const { callbackUrl } = await startSignIn(server, provider);
    await expectRejected(await finishSignIn(callbackUrl, null), logged, { loginCookieRejected: true, callbackUrl });
  });

  it("rejects a login cookie signed with another secret", async (t) => {
    const logged = captureWarnings(t);
    const { loginCookie, callbackUrl } = await startSignIn(server, provider);
    // Real verifier, state, and nonce: only the signature check can reject this cookie.
    const forged = resignLoginCookie(loginCookie, "another-secret-0123456789abcdefghij");
    await expectRejected(await finishSignIn(callbackUrl, forged), logged, { loginCookieRejected: true, callbackUrl, loginCookie: forged });
  });

  it("rejects an expired login cookie", async (t) => {
    const logged = captureWarnings(t);
    const { loginCookie, callbackUrl } = await startSignIn(server, provider);
    // Real verifier, state, and nonce, correct secret: only the expiry check can reject this cookie.
    const expired = resignLoginCookie(loginCookie, config.sessionSecret, { exp: Math.floor(Date.now() / 1000) - 60 });
    await expectRejected(await finishSignIn(callbackUrl, expired), logged, { loginCookieRejected: true, callbackUrl, loginCookie: expired });
  });

  it("rejects a replayed callback (provider rejects the reused code)", async (t) => {
    const logged = captureWarnings(t);
    const { loginCookie, callbackUrl } = await startSignIn(server, provider);
    assert.equal((await finishSignIn(callbackUrl, loginCookie)).status, 302);
    assert.equal(logged.length, 0);
    await expectRejected(await finishSignIn(callbackUrl, loginCookie), logged, { loginCookieRejected: false, callbackUrl, loginCookie });
  });

  for (const [name, tamper] of [
    ["a wrong nonce", { nonce: "attacker-nonce" }],
    ["a wrong audience", { aud: "another-client" }],
    ["a wrong issuer", { iss: "http://attacker.example" }],
    ["an ID token signed by an unknown key", { signWithRogueKey: true }]
  ]) {
    it(`rejects ${name}`, async (t) => {
      const logged = captureWarnings(t);
      const { loginCookie, callbackUrl } = await startSignIn(server, provider, { tamper });
      await expectRejected(await finishSignIn(callbackUrl, loginCookie), logged, { loginCookieRejected: false, callbackUrl, loginCookie });
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

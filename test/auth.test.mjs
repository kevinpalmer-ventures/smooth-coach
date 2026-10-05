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

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

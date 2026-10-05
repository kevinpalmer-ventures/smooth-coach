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

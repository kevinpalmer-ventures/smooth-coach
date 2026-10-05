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

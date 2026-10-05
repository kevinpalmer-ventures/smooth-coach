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

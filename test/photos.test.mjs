import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import { startFakeOidc } from "./helpers/fake-oidc.mjs";
import { images, photoForm } from "./helpers/images.mjs";
import { baseEnv, freePort, startServer } from "./helpers/server.mjs";
import { api, signIn } from "./helpers/session.mjs";
import { createTestDatabase, stack } from "./helpers/stack.mjs";
import { startTcpProxy } from "./helpers/tcp-proxy.mjs";

const photoPrefix = (issuer, sub) => `progress-photos/${crypto.createHash("sha256").update(`${issuer}|${sub}`).digest("hex").slice(0, 32)}/`;

describe("progress photos API", () => {
  let provider;
  let database;
  let pool;
  let server;
  let s3;
  let alice;
  let bob;

  before(async () => {
    provider = await startFakeOidc();
    database = await createTestDatabase();
    server = await startServer(baseEnv({ databaseUrl: database.databaseUrl, provider, port: await freePort() }));
    pool = new pg.Pool({ connectionString: database.databaseUrl });
    s3 = new S3Client({ endpoint: stack.s3.endpoint, region: stack.s3.region, forcePathStyle: true, credentials: { accessKeyId: stack.s3.accessKeyId, secretAccessKey: stack.s3.secretAccessKey } });
    ({ cookie: alice } = await signIn(server, provider, { sub: "alice", name: "Alice" }));
    ({ cookie: bob } = await signIn(server, provider, { sub: "bob", name: "Bob" }));
  });
  after(async () => {
    s3?.destroy();
    await pool?.end();
    await server?.stop();
    await provider?.close();
    await database?.drop();
  });

  const upload = (cookie, options) => api(server, "/api/progress-photos", { cookie, method: "POST", form: photoForm(options) });

  it("requires a session", async () => {
    assert.equal((await api(server, "/api/progress-photos")).status, 401);
    assert.equal((await upload(undefined, { bytes: images.png })).status, 401);
    assert.equal((await api(server, "/api/progress-photos/1/image")).status, 401);
  });

  for (const [kind, type, filename] of [["png", "image/png", "a.png"], ["jpeg", "image/jpeg", "a.jpg"], ["webp", "image/webp", "a.webp"]]) {
    it(`accepts a ${kind} upload and streams it back privately`, async () => {
      const response = await upload(alice, { bytes: images[kind], type, filename, capturedAt: "2026-09-01", caption: `  ${kind} day  ` });
      assert.equal(response.status, 201, JSON.stringify(response.data));
      const photo = response.data.photos.at(-1);
      assert.equal(photo.caption, `${kind} day`);
      assert.equal(photo.capturedAt, "2026-09-01");
      assert.match(photo.imageUrl, /^\/api\/progress-photos\/\d+\/image$/);
      const image = await fetch(`${server.url}${photo.imageUrl}`, { headers: { cookie: alice } });
      assert.equal(image.status, 200);
      assert.equal(image.headers.get("content-type"), type);
      assert.equal(image.headers.get("cache-control"), "private, max-age=3600");
      assert.equal(image.headers.get("x-content-type-options"), "nosniff");
      assert.ok(Buffer.from(await image.arrayBuffer()).equals(images[kind]));
    });
  }

  it("lists photos in date order", async () => {
    await upload(alice, { bytes: images.png, capturedAt: "2026-08-15", caption: "earliest" });
    const { data } = await api(server, "/api/progress-photos", { cookie: alice });
    assert.equal(data.photos[0].caption, "earliest");
    assert.deepEqual(data.photos.map((photo) => photo.capturedAt), [...data.photos.map((photo) => photo.capturedAt)].sort());
    assert.ok(data.photos.every((photo) => Object.keys(photo).sort().join() === "caption,capturedAt,id,imageUrl"));
  });

  it("rejects files that are not really JPEG, PNG, or WebP", async () => {
    const response = await upload(alice, { bytes: Buffer.from("this is not an image at all"), type: "image/png", filename: "evil.png" });
    assert.equal(response.status, 400);
    assert.match(response.data.error, /JPEG, PNG, or WebP/);
  });

  it("rejects uploads over 8 MB with 413", async () => {
    const tooLarge = Buffer.concat([images.png, Buffer.alloc(8 * 1024 * 1024)]);
    const response = await upload(alice, { bytes: tooLarge });
    assert.equal(response.status, 413);
    assert.match(response.data.error, /up to 8 MB/);
  });

  it("validates the date, the caption, and the presence of a file", async () => {
    assert.equal((await upload(alice, { bytes: images.png, capturedAt: "2026-02-30" })).status, 400);
    assert.equal((await upload(alice, { bytes: images.png, caption: "x".repeat(161) })).status, 400);
    assert.equal((await upload(alice, { bytes: images.png, caption: `  ${"x".repeat(160)}  ` })).status, 201);
    assert.equal((await upload(alice, {})).status, 400);
  });

  it("hides other accounts' photos", async () => {
    const { data } = await api(server, "/api/progress-photos", { cookie: alice });
    const image = await fetch(`${server.url}${data.photos[0].imageUrl}`, { headers: { cookie: bob } });
    assert.equal(image.status, 404);
    assert.deepEqual((await api(server, "/api/progress-photos", { cookie: bob })).data.photos, []);
  });

  it("returns 404 for malformed and unknown photo ids", async () => {
    for (const id of ["abc", "0", "-1", "1.5", "999999999"]) {
      assert.equal((await api(server, `/api/progress-photos/${id}/image`, { cookie: alice })).status, 404, id);
    }
  });

  it("returns 404 when the stored object has disappeared", async () => {
    const { data } = await upload(alice, { bytes: images.png, capturedAt: "2026-09-05" });
    const photo = data.photos.find((entry) => entry.capturedAt === "2026-09-05");
    const { rows } = await pool.query("SELECT storage_key FROM progress_photos WHERE id = $1", [photo.id]);
    await s3.send(new DeleteObjectCommand({ Bucket: stack.s3.bucket, Key: rows[0].storage_key }));
    assert.equal((await api(server, photo.imageUrl, { cookie: alice })).status, 404);
  });

  it("removes the stored object when the database insert fails", async () => {
    const { cookie: carol } = await signIn(server, provider, { sub: "carol", name: "Carol" });
    await pool.query("DELETE FROM user_profiles WHERE open_id = $1", [`${provider.issuer}|carol`]);
    const response = await upload(carol, { bytes: images.png });
    assert.equal(response.status, 500);
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: stack.s3.bucket, Prefix: photoPrefix(provider.issuer, "carol") }));
    assert.equal(listing.KeyCount, 0);
  });

  it("answers 500 and logs photo storage when storage goes away", async () => {
    const proxy = await startTcpProxy(Number(new URL(stack.s3.endpoint).port));
    const outageServer = await startServer(baseEnv({ databaseUrl: database.databaseUrl, provider, port: await freePort(), s3: { ...stack.s3, endpoint: `http://127.0.0.1:${proxy.port}` } }));
    try {
      const { cookie } = await signIn(outageServer, provider, { sub: "erin", name: "Erin" });
      await proxy.close();
      const response = await api(outageServer, "/api/progress-photos", { cookie, method: "POST", form: photoForm({ bytes: images.png }) });
      assert.equal(response.status, 500);
      assert.equal(response.data.error, "Smooth Coach could not complete that request. Please try again.");
      assert.match(outageServer.output(), /photo storage upload failed/);
    } finally {
      await outageServer.stop();
    }
  });
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { before, describe, it } from "node:test";
import { runSetup } from "../deploy/garage/setup.mjs";
import { createPhotoStorage, PhotoStorageError } from "../server/photoStorage.mjs";
import { stack, waitForStack } from "./helpers/stack.mjs";

async function withStorage(overrides, fn) {
  const storage = createPhotoStorage({ ...stack.s3, ...overrides });
  try {
    return await fn(storage);
  } finally {
    storage.destroy();
  }
}

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(512)]);

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe("Garage setup", () => {
  before(() => waitForStack());

  it("is idempotent", async () => {
    const bucket = `setup-${crypto.randomBytes(4).toString("hex")}`;
    const options = { adminUrl: stack.garageAdminUrl, adminToken: stack.garageAdminToken, bucket, accessKeyId: stack.s3.accessKeyId, secretAccessKey: stack.s3.secretAccessKey, retries: 5, retryDelayMs: 500 };
    const first = [];
    await runSetup({ ...options, log: (line) => first.push(line) });
    assert.ok(first.includes(`garage-init: created bucket ${bucket}`), first.join("\n"));
    assert.ok(first.includes("garage-init: granted app key read/write on the bucket"), first.join("\n"));
    const second = [];
    await runSetup({ ...options, log: (line) => second.push(line) });
    assert.deepEqual(second, [
      "garage-init: layout already applied (version 1)",
      "garage-init: app key already exists",
      `garage-init: bucket ${bucket} already exists`,
      "garage-init: app key already has read/write on the bucket",
      "garage-init: done"
    ]);
    await withStorage({ bucket }, (storage) => storage.checkBucket());
  });
});

describe("photo storage (Garage)", () => {
  before(() => waitForStack());

  it("passes the bucket check with valid settings", () => withStorage({}, (storage) => storage.checkBucket()));

  it("explains a missing bucket", () =>
    withStorage({ bucket: "no-such-bucket" }, (storage) => assert.rejects(storage.checkBucket(), /bucket "no-such-bucket" does not exist/)));

  it("explains wrong credentials", () =>
    withStorage({ secretAccessKey: "f".repeat(64) }, (storage) => assert.rejects(storage.checkBucket(), /access denied/)));

  it("explains a region mismatch", () =>
    withStorage({ region: "us-east-1" }, (storage) => assert.rejects(storage.checkBucket(), /S3_REGION/)));

  it("explains an unreachable endpoint", () =>
    withStorage({ endpoint: "http://127.0.0.1:1" }, (storage) => assert.rejects(storage.checkBucket(), /cannot reach the storage server/)));

  it("stores, streams, and deletes a photo", () =>
    withStorage({}, async (storage) => {
      const key = `progress-photos/test/2026-09-01/${crypto.randomUUID()}.png`;
      await storage.putPhoto(key, png, "image/png");
      const stream = await storage.getPhotoStream(key);
      assert.ok((await readAll(stream)).equals(png));
      await storage.deletePhoto(key);
      assert.equal(await storage.getPhotoStream(key), null);
    }));

  it("returns null for a missing object", () =>
    withStorage({}, async (storage) => assert.equal(await storage.getPhotoStream("progress-photos/missing.png"), null)));

  it("wraps upload failures as photo storage errors", () =>
    withStorage({ endpoint: "http://127.0.0.1:1" }, (storage) =>
      assert.rejects(storage.putPhoto("progress-photos/x.png", png, "image/png"), (error) => error instanceof PhotoStorageError && /photo storage upload failed/.test(error.message))));
});

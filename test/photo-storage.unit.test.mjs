import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contentTypeForKey, describeBucketError, PhotoStorageError, sniffImageType } from "../server/photoStorage.mjs";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 1, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(16)]);

describe("sniffImageType", () => {
  it("recognizes PNG, JPEG, and WebP by their signatures", () => {
    assert.equal(sniffImageType(png), "image/png");
    assert.equal(sniffImageType(jpeg), "image/jpeg");
    assert.equal(sniffImageType(webp), "image/webp");
  });
  it("rejects other content", () => {
    assert.equal(sniffImageType(Buffer.from("GIF89a-not-allowed")), null);
    assert.equal(sniffImageType(Buffer.from("just some text here")), null);
    assert.equal(sniffImageType(Buffer.from("RIFF0000WAVE")), null);
    assert.equal(sniffImageType(png.subarray(0, 7)), null);
    assert.equal(sniffImageType(Buffer.alloc(0)), null);
    assert.equal(sniffImageType(undefined), null);
  });
});

describe("contentTypeForKey", () => {
  it("maps photo extensions to content types", () => {
    assert.equal(contentTypeForKey("progress-photos/a/2026-09-01/x.jpg"), "image/jpeg");
    assert.equal(contentTypeForKey("progress-photos/a/2026-09-01/x.png"), "image/png");
    assert.equal(contentTypeForKey("progress-photos/a/2026-09-01/x.webp"), "image/webp");
    assert.equal(contentTypeForKey("progress-photos/a/2026-09-01/x.gif"), "application/octet-stream");
  });
});

describe("describeBucketError", () => {
  const withStatus = (status) => Object.assign(new Error("x"), { name: "Unknown", $metadata: { httpStatusCode: status } });
  it("explains the common startup failures", () => {
    assert.equal(describeBucketError(withStatus(404), "photos"), 'bucket "photos" does not exist');
    assert.match(describeBucketError(withStatus(403), "photos"), /access denied; check S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY/);
    assert.match(describeBucketError(withStatus(400), "photos"), /S3_REGION/);
    assert.match(describeBucketError(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }), "photos"), /cannot reach the storage server \(ECONNREFUSED\); check S3_ENDPOINT/);
    assert.match(describeBucketError(Object.assign(new Error("odd"), { name: "Weird" }), "photos"), /unexpected error \(Weird\)/);
  });
});

describe("PhotoStorageError", () => {
  it("names the operation and the cause without secrets", () => {
    const error = new PhotoStorageError("upload", Object.assign(new Error("boom"), { code: "ECONNREFUSED" }));
    assert.equal(error.name, "PhotoStorageError");
    assert.equal(error.message, "photo storage upload failed (Error, ECONNREFUSED)");
  });
});

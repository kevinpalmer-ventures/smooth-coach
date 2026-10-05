import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { missingSetupVariables, parseCapacity } from "../deploy/garage/setup.mjs";

describe("parseCapacity", () => {
  for (const [input, bytes] of [["10G", 10e9], ["10GB", 10e9], ["10g", 10e9], ["500M", 500e6], ["1T", 1e12], ["64K", 64e3], ["2048", 2048]]) {
    it(`parses ${input}`, () => assert.equal(parseCapacity(input), bytes));
  }
  for (const input of ["", "ten", "0G", "10X", "-5G"]) {
    it(`rejects ${JSON.stringify(input)}`, () => assert.throws(() => parseCapacity(input), /GARAGE_CAPACITY must look like/));
  }
});

describe("missingSetupVariables", () => {
  it("names unset and empty variables", () => {
    assert.deepEqual(missingSetupVariables({ GARAGE_ADMIN_TOKEN: "t", S3_BUCKET: "", S3_ACCESS_KEY_ID: "k" }), ["S3_BUCKET", "S3_SECRET_ACCESS_KEY"]);
  });
  it("returns nothing when all are set", () => {
    assert.deepEqual(missingSetupVariables({ GARAGE_ADMIN_TOKEN: "t", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" }), []);
  });
});

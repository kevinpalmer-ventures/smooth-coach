import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeDatabaseError } from "../server/db.mjs";
import { describeError } from "../server/errors.mjs";

describe("describeError", () => {
  it("uses the message of a plain Error", () => {
    assert.equal(describeError(new Error("boom")), "boom");
  });

  it("joins the messages inside an AggregateError with an empty message", () => {
    const error = new AggregateError([new Error("connect ECONNREFUSED ::1:1"), new Error("connect ECONNREFUSED 127.0.0.1:1")], "");
    error.code = "ECONNREFUSED";
    assert.equal(describeError(error), "connect ECONNREFUSED ::1:1; connect ECONNREFUSED 127.0.0.1:1");
  });

  it("falls back to the code, then the name, when there is no message", () => {
    assert.equal(describeError(Object.assign(new Error(""), { code: "ECONNREFUSED" })), "ECONNREFUSED");
    assert.equal(describeError(new AggregateError([], "")), "AggregateError");
  });

  it("skips empty nested messages and handles non-Error values", () => {
    assert.equal(describeError(new AggregateError([new Error(""), Object.assign(new Error(""), { code: "ETIMEDOUT" })], "")), "ETIMEDOUT");
    assert.equal(describeError("plain text"), "plain text");
    assert.equal(describeError(undefined), "unknown error");
  });

  it("walks the cause chain for a fetch failure", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    assert.equal(describeError(new TypeError("fetch failed", { cause })), "fetch failed: connect ECONNREFUSED 127.0.0.1:1");
    const nested = new TypeError("fetch failed", { cause: new AggregateError([cause], "") });
    assert.equal(describeError(nested), "fetch failed: connect ECONNREFUSED 127.0.0.1:1");
  });
});

describe("describeDatabaseError", () => {
  const refused = Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" });

  it("explains localhost for a refused connection without echoing the URL", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const text = describeDatabaseError(refused, `postgresql://user:s3cret@${host}:5432/db`);
      assert.match(text, /ECONNREFUSED/);
      assert.match(text, /host\.docker\.internal/);
      assert.ok(!text.includes("s3cret") && !text.includes("postgresql://"), text);
    }
  });

  it("adds no hint for other hosts, other errors, or an unparseable URL", () => {
    assert.ok(!describeDatabaseError(refused, "postgresql://user:pw@db.example.com/db").includes("host.docker.internal"));
    assert.ok(!describeDatabaseError(new Error("password authentication failed"), "postgresql://u:p@localhost/db").includes("host.docker.internal"));
    assert.equal(describeDatabaseError(new Error("bad"), "not a url"), "bad");
  });
});

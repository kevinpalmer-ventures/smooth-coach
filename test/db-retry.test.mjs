import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTransientConnectionError, retryTransient } from "../server/db.mjs";

const withCode = (code, message = `connect ${code} 192.168.2.42:5432`) => Object.assign(new Error(message), { code });

describe("isTransientConnectionError", () => {
  it("treats a network that is not ready yet as transient", () => {
    for (const code of ["EHOSTUNREACH", "ENETUNREACH", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "57P03"]) {
      assert.equal(isTransientConnectionError(withCode(code)), true, code);
    }
    // localhost resolves to ::1 and 127.0.0.1, so Node reports both refusals in an AggregateError.
    assert.equal(isTransientConnectionError(new AggregateError([withCode("ECONNREFUSED"), withCode("ECONNREFUSED")], "")), true);
    // pg-pool's connectionTimeoutMillis error carries no code.
    assert.equal(isTransientConnectionError(new Error("timeout exceeded when trying to connect")), true);
  });

  it("treats configuration problems as permanent", () => {
    for (const [code, message] of [
      ["28P01", 'password authentication failed for user "smooth_coach_app"'],
      ["3D000", 'database "nope" does not exist'],
      ["ENOTFOUND", "getaddrinfo ENOTFOUND db.example.invalid"]
    ]) {
      assert.equal(isTransientConnectionError(withCode(code, message)), false, code);
    }
    assert.equal(isTransientConnectionError(new Error('syntax error at or near "CREATE"')), false);
    assert.equal(isTransientConnectionError(undefined), false);
  });
});

describe("retryTransient", () => {
  it("retries transient failures until the operation succeeds", async () => {
    let attempts = 0;
    const retried = [];
    const result = await retryTransient(async () => {
      attempts++;
      if (attempts < 3) throw withCode("EHOSTUNREACH");
      return "ready";
    }, { timeoutMs: 1000, delayMs: 10, onRetry: (error) => retried.push(error.code) });
    assert.equal(result, "ready");
    assert.equal(attempts, 3);
    assert.deepEqual(retried, ["EHOSTUNREACH", "EHOSTUNREACH"]);
  });

  it("fails immediately on a permanent error", async () => {
    let attempts = 0;
    await assert.rejects(retryTransient(async () => {
      attempts++;
      throw withCode("28P01", "password authentication failed");
    }, { timeoutMs: 1000, delayMs: 10 }), /password authentication failed/);
    assert.equal(attempts, 1);
  });

  it("gives up with the last error once the time budget is spent", async () => {
    let attempts = 0;
    const started = Date.now();
    await assert.rejects(retryTransient(async () => {
      attempts++;
      throw withCode("ECONNREFUSED");
    }, { timeoutMs: 200, delayMs: 50 }), (error) => error.code === "ECONNREFUSED");
    const elapsed = Date.now() - started;
    assert.ok(attempts >= 3 && attempts <= 6, `expected 3-6 attempts, got ${attempts}`);
    assert.ok(elapsed < 600, `expected to stop near the 200 ms budget, took ${elapsed} ms`);
  });

  it("makes a single attempt when the budget is zero", async () => {
    let attempts = 0;
    await assert.rejects(retryTransient(async () => {
      attempts++;
      throw withCode("ECONNREFUSED");
    }, { timeoutMs: 0, delayMs: 10 }));
    assert.equal(attempts, 1);
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIRST_JOB_READ_ATTEMPTS,
  firstJobReadRetry,
  readFirstJobCompanyRecord,
} from "./firstJobRelayRead.ts";

const ok = { ok: true, value: { profile: "read" } };
const busy = (
  message = "Company records could not be read: Error: offline",
) => ({
  ok: false,
  code: "unavailable",
  message,
});
const quota = (seconds) =>
  busy(
    `Company records could not be read: rate-limited: quota exceeded; retry in ${seconds}s`,
  );

/** A deadline that never fires, so only the read itself decides an attempt. */
const patientDeadline = () => ({ expired: new Promise(() => {}), cancel() {} });

function fixture(results, options = {}) {
  const waits = [];
  const reads = [];
  return {
    waits,
    reads,
    run: () =>
      readFirstJobCompanyRecord({
        read: async () => {
          const result = results[reads.length] ?? busy();
          reads.push(result);
          return result;
        },
        assertCurrent: async () => {},
        delay: async (ms) => {
          waits.push(ms);
        },
        deadline: patientDeadline,
        ...options,
      }),
  };
}

test("a transient failure followed by success reads the record without alerting", async () => {
  const f = fixture([busy(), ok]);
  assert.deepEqual(await f.run(), ok);
  assert.equal(f.reads.length, 2);
  assert.deepEqual(f.waits, [150]);
});

test("a zero-second quota refusal retries on the local backoff, not instantly", async () => {
  const f = fixture([quota(0), quota(0), ok]);
  assert.deepEqual(await f.run(), ok);
  assert.deepEqual(f.waits, [150, 300]);
});

test("a relay cooldown longer than the local backoff is respected", async () => {
  const f = fixture([quota(2), ok]);
  assert.deepEqual(await f.run(), ok);
  assert.deepEqual(f.waits, [2_000]);
});

test("a cooldown a click cannot wait through stops the ladder", async () => {
  const f = fixture([quota(30), ok]);
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.waits, []);
});

test("the ladder is bounded and returns the last failure for the caller to alert on", async () => {
  const f = fixture([]);
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(f.reads.length, FIRST_JOB_READ_ATTEMPTS);
  assert.deepEqual(f.waits, [150, 300]);
});

for (const code of [
  "invalid-event",
  "wrong-author",
  "invalid-head",
  "invalid-record",
  "cancelled",
]) {
  test(`a ${code} record is answered once and never retried`, async () => {
    const f = fixture([{ ok: false, code, message: "bad head" }, ok]);
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(f.reads.length, 1);
    assert.deepEqual(f.waits, []);
  });
}

test("a read the relay never answers is retried as unavailable", async () => {
  const reads = [];
  const waits = [];
  let cancelled = 0;
  const result = await readFirstJobCompanyRecord({
    read: () => {
      reads.push("issued");
      return reads.length < 3 ? new Promise(() => {}) : Promise.resolve(ok);
    },
    assertCurrent: async () => {},
    delay: async (ms) => {
      waits.push(ms);
    },
    deadline: () => ({
      expired: Promise.resolve(),
      cancel: () => {
        cancelled += 1;
      },
    }),
    deadlineMs: 6_000,
  });
  assert.deepEqual(result, ok);
  assert.equal(reads.length, 3);
  assert.deepEqual(waits, [150, 300]);
  assert.equal(cancelled, 3);
});

test("a community switch between attempts stops the ladder", async () => {
  const reads = [];
  await assert.rejects(
    readFirstJobCompanyRecord({
      read: async () => {
        reads.push("issued");
        return busy();
      },
      assertCurrent: async () => {
        if (reads.length) throw new Error("scope changed");
      },
      delay: async () => {},
      deadline: patientDeadline,
    }),
    /scope changed/,
  );
  assert.equal(reads.length, 1);
});

test("a successful read is never retried", async () => {
  const f = fixture([ok, busy()]);
  assert.deepEqual(await f.run(), ok);
  assert.equal(f.reads.length, 1);
  assert.equal(firstJobReadRetry(ok, 0), null);
});

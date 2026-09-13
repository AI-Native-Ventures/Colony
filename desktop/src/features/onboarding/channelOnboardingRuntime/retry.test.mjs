import assert from "node:assert/strict";
import test from "node:test";

import { readWithRateLimitRetry } from "./retry.ts";

const quotaError = () => new Error("rate-limited: quota exceeded; retry in 1s");

test("bounded relay read retry returns the original error after exhaustion", async () => {
  let reads = 0;
  const delays = [];

  await assert.rejects(
    readWithRateLimitRetry({
      read: () => {
        reads += 1;
        throw quotaError();
      },
      assertCurrent: () => {},
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
    }),
    /rate-limited: quota exceeded; retry in 1s/,
  );

  assert.equal(reads, 3);
  assert.deepEqual(delays, [1_000, 1_000]);
});

test("a scope switch during cooldown prevents a subsequent relay read", async () => {
  let reads = 0;
  let active = true;
  const delays = [];

  await assert.rejects(
    readWithRateLimitRetry({
      read: () => {
        reads += 1;
        throw quotaError();
      },
      assertCurrent: () => {
        if (!active) throw new Error("owner or relay changed");
      },
      delay: async (milliseconds) => {
        delays.push(milliseconds);
        active = false;
      },
    }),
    /owner or relay changed/,
  );

  assert.equal(reads, 1);
  assert.deepEqual(delays, [1_000]);
});

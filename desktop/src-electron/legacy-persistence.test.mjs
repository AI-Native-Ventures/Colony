import assert from "node:assert/strict";
import { test } from "node:test";
import { persistLegacyFixture } from "./onboarding-fixture/legacy-persistence.mjs";

const source = [
  ["buzz-theme", "github-dark"],
  ["buzz-active-community-id", "proof-alpha"],
];

test("legacy writer settles alone and exits before exactly one independent read", async () => {
  const trace = [];
  let closed = false;
  const actual = await persistLegacyFixture({
    writer: {
      read: async () => {
        trace.push("seed");
        return source;
      },
      close: async () => {
        trace.push("close-writer");
        closed = true;
      },
    },
    settle: async () => {
      trace.push("settle");
      assert.equal(closed, false);
      assert.ok(!trace.includes("independent-read"));
    },
    read: async () => {
      assert.equal(closed, true);
      trace.push("independent-read");
      return [...source].reverse();
    },
  });
  assert.deepEqual(actual, [...source].reverse());
  assert.deepEqual(trace, [
    "seed",
    "settle",
    "close-writer",
    "independent-read",
  ]);
});

test("empty or changed post-exit storage fails after one read without retry or reseeding", async () => {
  for (const result of [[], [["buzz-theme", "changed"]]]) {
    const calls = { seed: 0, settle: 0, close: 0, read: 0 };
    await assert.rejects(
      persistLegacyFixture({
        writer: {
          read: async () => {
            calls.seed++;
            return source;
          },
          close: async () => {
            calls.close++;
          },
        },
        settle: async () => {
          calls.settle++;
        },
        read: async () => {
          assert.equal(calls.close, 1);
          calls.read++;
          return result;
        },
      }),
      /Legacy source did not survive writer exit/,
    );
    assert.deepEqual(calls, { seed: 1, settle: 1, close: 1, read: 1 });
  }
});

test("invalid seed, setup, settle or close failures never open an independent reader", async () => {
  for (const stage of ["empty", "setup", "settle", "close"]) {
    const trace = [];
    await assert.rejects(
      persistLegacyFixture({
        writer: {
          read: async () => {
            trace.push("seed");
            if (stage === "setup") throw new Error("setup failed");
            return stage === "empty" ? [] : source;
          },
          close: async () => {
            trace.push("close-writer");
            if (stage === "close") throw new Error("abnormal writer exit");
          },
        },
        settle: async () => {
          trace.push("settle");
          if (stage === "settle") throw new Error("settle failed");
        },
        read: async () => {
          trace.push("independent-read");
          return source;
        },
      }),
      stage === "empty"
        ? /nonempty source data/
        : stage === "close"
          ? /abnormal writer exit/
          : new RegExp(`${stage} failed`),
    );
    assert.deepEqual(
      trace,
      ["empty", "setup"].includes(stage)
        ? ["seed", "close-writer"]
        : ["seed", "settle", "close-writer"],
    );
  }
});

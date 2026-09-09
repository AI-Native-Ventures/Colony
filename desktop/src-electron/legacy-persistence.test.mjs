import assert from "node:assert/strict";
import { test } from "node:test";
import { persistLegacyFixture } from "./onboarding-fixture/legacy-persistence.mjs";

const source = [["buzz-theme", "github-dark"]];
test("legacy writer stays alive until observed, then a fresh read proves persistence", async () => {
  const trace = [];
  let observations = 0;
  const actual = await persistLegacyFixture({
    writer: {
      read: async () => {
        trace.push("seed");
        return source;
      },
      close: async () => {
        trace.push("close-writer");
      },
    },
    read: async () => {
      trace.push("independent-read");
      return ++observations === 1 ? [] : source;
    },
    pause: async () => {
      trace.push("wait");
    },
  });
  assert.deepEqual(actual, source);
  assert.deepEqual(trace, [
    "seed",
    "independent-read",
    "wait",
    "independent-read",
    "close-writer",
    "independent-read",
  ]);
});

test("empty store exhaustion and changed data fail with writer closed, never reseeded", async () => {
  for (const result of [[], [["buzz-theme", "changed"]]]) {
    let seeds = 0;
    let closed = 0;
    await assert.rejects(
      persistLegacyFixture({
        writer: {
          read: async () => {
            seeds++;
            return source;
          },
          close: async () => {
            closed++;
          },
        },
        read: async () => result,
        pause: async () => {},
        attempts: 2,
      }),
    );
    assert.equal(seeds, 1);
    assert.equal(closed, 1);
  }
});

test("visibility while writer runs cannot stand in for persistence after exit", async () => {
  let closed = false;
  await assert.rejects(
    persistLegacyFixture({
      writer: {
        read: async () => source,
        close: async () => {
          closed = true;
        },
      },
      read: async () => (closed ? [] : source),
    }),
    /did not survive writer exit/,
  );
});

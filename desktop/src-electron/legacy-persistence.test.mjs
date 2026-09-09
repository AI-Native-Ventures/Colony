import assert from "node:assert/strict";
import { test } from "node:test";
import { persistLegacyFixture } from "./onboarding-fixture/legacy-persistence.mjs";

const source = [["buzz-theme", "github-dark"]];
test("the first independent observer cannot remove the writer's uncommitted store", async () => {
  let committed = false;
  let lost = false;
  let closed = false;
  const actual = await persistLegacyFixture({
    writer: {
      read: async () => source,
      close: async () => {
        closed = true;
      },
    },
    settle: async () => {
      committed = true;
    },
    read: async () => {
      // An independent WebKit process caches empty data before the writer
      // commits, then deletes that apparently empty database when it exits.
      if (!committed) lost = true;
      return committed && !lost ? source : [];
    },
    pause: async () => {},
    attempts: 2,
  });
  assert.deepEqual(actual, source);
  assert.equal(closed, true);
});
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
    settle: async () => {
      trace.push("settle-writer");
    },
    pause: async () => {
      trace.push("wait");
    },
  });
  assert.deepEqual(actual, source);
  assert.deepEqual(trace, [
    "seed",
    "settle-writer",
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
        settle: async () => {},
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
      settle: async () => {},
    }),
    /did not survive writer exit/,
  );
});

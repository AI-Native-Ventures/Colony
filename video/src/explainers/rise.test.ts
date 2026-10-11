import assert from "node:assert/strict";
import { test } from "node:test";
import { RISE, RISE_POSTS } from "./rise.ts";

test("Rise Bakery posts go out this week, one per idea, in order", () => {
  assert.deepEqual(
    RISE_POSTS.map((p) => p.id),
    ["sourdough", "market", "croissant"],
  );
  assert.deepEqual(
    RISE_POSTS.map((p) => p.when),
    ["Tue 7:00", "Thu 12:30", "Sat 6:30"],
  );
  assert.equal(RISE.name, "Rise Bakery");
});

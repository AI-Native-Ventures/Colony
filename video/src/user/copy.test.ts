import assert from "node:assert/strict";
import { test } from "node:test";
import { copyProblems } from "./copy.ts";

test("plain lines pass", () => {
  assert.deepEqual(copyProblems("Scout suggests the simplest setup."), []);
});

test("em dashes, freebies, phone calls and prices are refused", () => {
  assert.equal(copyProblems("Your team — ready").length, 1);
  assert.equal(copyProblems("Get it free today").length, 1);
  assert.equal(copyProblems("It calls your customers").length, 1);
  assert.equal(copyProblems("Pay R119 for credits").length, 1);
  assert.equal(copyProblems("Only $5 a month").length, 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import { parsePidCols } from "./terminal-smoke.mjs";

test("parsePidCols parses <pid> <cols>", () => {
  assert.deepStrictEqual(parsePidCols("123 80\n"), { pid: 123, cols: 80 });
  assert.deepStrictEqual(parsePidCols("456 120"), { pid: 456, cols: 120 });
  assert.deepStrictEqual(parsePidCols("  999  30  "), { pid: 999, cols: 30 });
});

test("parsePidCols parses <pid> alone", () => {
  assert.deepStrictEqual(parsePidCols("42"), { pid: 42, cols: null });
  assert.deepStrictEqual(parsePidCols("42\n"), { pid: 42, cols: null });
});

test("parsePidCols rejects empty or invalid input", () => {
  assert.strictEqual(parsePidCols(""), null);
  assert.strictEqual(parsePidCols("hello"), null);
  assert.strictEqual(parsePidCols("123 -5"), null);
  assert.strictEqual(parsePidCols("0 80"), null);
  assert.strictEqual(parsePidCols("-1"), null);
  assert.strictEqual(parsePidCols("not 80"), null);
});

test("parsePidCols handles whitespace-only strings", () => {
  assert.strictEqual(parsePidCols("   "), null);
  assert.strictEqual(parsePidCols("\n\t"), null);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  countChunkBytes,
  decodeChunkArrays,
  parsePidCols,
} from "./terminal-smoke.mjs";

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

test("decodeChunkArrays joins chunks before decoding utf8", () => {
  assert.strictEqual(decodeChunkArrays([[104, 105]]), "hi");
  assert.strictEqual(
    decodeChunkArrays([
      [104, 105],
      [33, 10],
    ]),
    "hi!\n",
  );
  // A multi-byte sequence split across two chunks must still decode.
  assert.strictEqual(
    decodeChunkArrays([
      [240, 159],
      [154, 128],
    ]),
    "🚀",
  );
});

test("decodeChunkArrays tolerates missing or malformed input", () => {
  assert.strictEqual(decodeChunkArrays([]), "");
  assert.strictEqual(decodeChunkArrays(undefined), "");
  assert.strictEqual(decodeChunkArrays([null, [97]]), "a");
});

test("countChunkBytes totals the collected chunk lengths", () => {
  assert.strictEqual(countChunkBytes([]), 0);
  assert.strictEqual(countChunkBytes(undefined), 0);
  assert.strictEqual(
    countChunkBytes([
      [1, 2, 3],
      [4, 5],
    ]),
    5,
  );
  assert.strictEqual(countChunkBytes([null, [1, 2]]), 2);
});

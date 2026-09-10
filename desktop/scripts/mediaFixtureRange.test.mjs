import assert from "node:assert/strict";
import test from "node:test";
import { mediaFixtureRange } from "../tests/helpers/mediaFixtureRange.ts";

test("real fixture ranges return exact bytes and matching headers", () => {
  const bytes = Buffer.from("0123456789");
  for (const [request, expected, range] of [
    ["bytes=2-5", "2345", "bytes 2-5/10"],
    ["bytes=6-", "6789", "bytes 6-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
    ["bytes=-20", "0123456789", "bytes 0-9/10"],
    ["bytes=8-20", "89", "bytes 8-9/10"],
  ]) {
    const response = mediaFixtureRange(bytes, request);
    assert.equal(response.status, 206);
    assert.equal(response.body.toString(), expected);
    assert.equal(response.headers["content-range"], range);
    assert.equal(response.headers["content-length"], String(expected.length));
    assert.equal(response.headers["accept-ranges"], "bytes");
  }
  assert.equal(mediaFixtureRange(bytes, undefined).body, bytes);
  for (const request of [
    "bytes=20-",
    "bytes=5-2",
    "bytes=-0",
    "bytes=",
    "bytes=1-2,4-5",
  ])
    assert.equal(mediaFixtureRange(bytes, request).status, 416);
});

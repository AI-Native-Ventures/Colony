// The post head a render writes back.
//
// Two of these are the relay's own refusals reached one round trip early, and
// the third is the product rule the whole feature rests on: pixels measuring
// well is not permission to call a card ready.

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRenderedPostEvent,
  reportToWire,
  SCHEMA_CONTENT_POST,
} from "./renderedPostEvent.ts";

const image = (sha256) => ({
  height: 1350,
  sha256,
  url: `https://m/${sha256}`,
  width: 1080,
});
const report = (imageHash) => ({
  gates: [
    { bar: 4.5, detail: "ok", id: "contrast", measured: 13.07, status: "pass" },
  ],
  imageHash,
  renderedAt: "2026-08-27T10:00:00Z",
  renderer: { engine: "WebKit" },
});

const body = {
  headline: "One phrase",
  schema: SCHEMA_CONTENT_POST,
  scheduled_for: "2026-09-01",
  status: "draft",
  style: { family: "night", hues: ["violet"] },
  week: 1,
};

test("fields the relay stores opaquely survive the write", () => {
  const draft = buildRenderedPostEvent(
    "launch:day-one",
    body,
    [image("aa")],
    [report("aa")],
    null,
  );
  assert.ok(draft.ok);
  const written = JSON.parse(draft.event.content);
  assert.deepEqual(written.style, { family: "night", hues: ["violet"] });
  assert.equal(written.week, 1);
});

test("a passing render does not promote a draft to ready", () => {
  const draft = buildRenderedPostEvent(
    "launch:day-one",
    body,
    [image("aa")],
    [report("aa")],
    null,
  );
  assert.ok(draft.ok);
  assert.equal(JSON.parse(draft.event.content).status, "draft");
});

test("a report naming bytes nobody uploaded is refused", () => {
  const draft = buildRenderedPostEvent(
    "launch:day-one",
    body,
    [image("aa")],
    [report("bb")],
    null,
  );
  assert.equal(draft.ok, false);
  assert.match(draft.reason, /was not uploaded/);
});

test("a carousel needs one report per slide", () => {
  const draft = buildRenderedPostEvent(
    "launch:day-one",
    body,
    [image("aa"), image("bb")],
    [report("aa")],
    null,
  );
  assert.equal(draft.ok, false);
  assert.match(draft.reason, /2 image\(s\) but 1 report\(s\)/);
});

test("a render with no images is refused rather than written empty", () => {
  const draft = buildRenderedPostEvent("launch:day-one", body, [], [], null);
  assert.equal(draft.ok, false);
  assert.match(draft.reason, /no images/);
});

test("a body built for another record is refused", () => {
  const draft = buildRenderedPostEvent(
    "launch:day-one",
    { ...body, schema: "colony/content-campaign/v1" },
    [image("aa")],
    [report("aa")],
    null,
  );
  assert.equal(draft.ok, false);
  assert.match(draft.reason, /not a content post/);
});

test("the wire report uses the relay's key and declares no verdict of its own", () => {
  const wire = reportToWire(report("aa"), "v3");
  assert.equal(wire.image_hash, "aa");
  assert.equal(wire.style_version, "v3");
  assert.equal("verdict" in wire, false);
  assert.equal("imageHash" in wire, false);
});

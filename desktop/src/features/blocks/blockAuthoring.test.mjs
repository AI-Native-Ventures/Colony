import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { validateBlockData, validateBlockManifest } from "./blockValidation.ts";
import {
  resolveDetails,
  resolveMedia,
  resolveStatus,
} from "./ui/primitives/resolvers.ts";
import { BlockQuestion } from "./ui/primitives/BlockQuestion.tsx";

const core = new URL(
  "../../../../crates/buzz-relay/src/core_blocks/",
  import.meta.url,
);
async function manifest(path) {
  const value = JSON.parse(await readFile(new URL(path, core), "utf8"));
  const result = validateBlockManifest(value);
  assert.equal(result.ok, true, result.message);
  return result.value;
}

test("real question payload fails the old demo contract and renders native choices under the new pinned contract", async () => {
  const current = await manifest("primitives/question.json");
  const legacy = await manifest("legacy/question-1.0.0.json");
  const data = current.examples[0].data;
  assert.equal(
    validateBlockData(legacy, data).ok,
    false,
    "old demo cannot accept a real prompt and choices",
  );
  assert.equal(validateBlockData(current, data).ok, true);
  assert.equal(
    validateBlockData(legacy, legacy.examples[0].data).ok,
    true,
    "posted legacy cards remain valid",
  );
  assert.equal(validateBlockData(current, { ...data, mode: null }).ok, false);
  assert.equal(
    validateBlockData(current, {
      ...data,
      choices: [data.choices[0], data.choices[0]],
    }).ok,
    false,
  );
  const html = renderToStaticMarkup(
    React.createElement(BlockQuestion, {
      node: current.tree,
      data,
      environment: {
        origin: "core",
        trusted: true,
        declaredActionIds: new Set(["question.submit"]),
        submitSigned() {},
      },
    }),
  );
  assert.equal(html.match(/type="radio"/g)?.length, data.choices.length);
  assert.match(html, /Which direction should lead the launch/);
  assert.doesNotMatch(html, /type="checkbox"/);
});

test("Details populated facts preserve literal data and formatting while the old contract stays readable", async () => {
  const current = await manifest("primitives/details.json");
  const legacy = await manifest("legacy/details-1.0.0.json");
  const data = {
    items: [
      { label: "Caption", value: "Keep {{value}} literal" },
      { label: "Approved", value: "false", format: "boolean" },
    ],
  };
  assert.equal(validateBlockData(legacy, data).ok, false);
  assert.equal(validateBlockData(current, data).ok, true);
  assert.deepEqual(resolveDetails(current.tree, data), [
    { label: "Caption", value: "Keep {{value}} literal" },
    { label: "Approved", value: "No" },
  ]);
  const oldData = legacy.examples[0].data;
  assert.equal(validateBlockData(current, oldData).ok, true);
  assert.deepEqual(
    resolveDetails(current.tree, oldData),
    resolveDetails(legacy.tree, oldData),
  );
  for (const items of [
    [],
    Array(25).fill(data.items[0]),
    [{ label: "X", value: "Y", html: "<script/>" }],
  ])
    assert.equal(validateBlockData(current, { items }).ok, false);
  assert.deepEqual(
    resolveDetails(
      {
        type: "details",
        items: [{ label: "Missing", value: "{{absent}}", format: "date" }],
      },
      {},
    ),
    [{ label: "Missing", value: "" }],
  );
});

test("optional native presentations are closed and Status paths are paired with bounded step resolution", async () => {
  const current = await manifest("primitives/details.json");
  for (const tree of [
    {
      type: "section",
      presentation: "callout",
      omit_empty_text: true,
      text: "{{label}}",
    },
    {
      type: "card",
      presentation: "rail",
      eyebrow: "Context",
      subtitle: "Subhead",
      children: [],
    },
    { type: "metric", label: "Sales", value: "1", comparison: "+2" },
    {
      type: "details",
      presentation: "disclosure",
      summary: "More",
      items: [{ label: "Ready", value: "true", format: "boolean" }],
    },
    {
      type: "table",
      columns: [{ key: "price", label: "Price", format: "currency" }],
      rows_path: "/items",
    },
    {
      type: "status",
      label: "Research",
      progress_path: "/progress",
      position_path: "/position",
      total_path: "/total",
    },
  ]) {
    assert.equal(
      validateBlockManifest({ ...current, tree }).ok,
      true,
      JSON.stringify(tree),
    );
    assert.equal(
      validateBlockManifest({
        ...current,
        tree: { ...tree, style: "color:red" },
      }).ok,
      false,
    );
  }
  assert.equal(
    validateBlockManifest({
      ...current,
      tree: { ...current.tree, presentation: "arbitrary" },
    }).ok,
    false,
  );
  const status = {
    type: "status",
    label: "Research",
    progress_path: "/progress",
    position_path: "/position",
    total_path: "/total",
  };
  assert.equal(
    validateBlockManifest({
      ...current,
      tree: { ...status, total_path: undefined },
    }).ok,
    false,
  );
  assert.deepEqual(
    resolveStatus(status, { progress: 120, position: 3, total: 6 }),
    {
      label: "Research",
      state: "Research",
      tone: "neutral",
      progress: 100,
      position: 3,
      total: 6,
    },
  );
  for (const step of [
    { position: 0, total: 6 },
    { position: 3.5, total: 6 },
    { position: 7, total: 6 },
    { position: 1, total: 21 },
  ])
    assert.equal(resolveStatus(status, step).position, undefined);
});

test("bounded media retains ordered invalid entries and explicitly reports omitted files", () => {
  const values = Array.from({ length: 27 }, (_, index) =>
    index === 2
      ? "javascript:alert(1)"
      : `https://files.example/item-${index}.png`,
  );
  const result = resolveMedia(
    { type: "media", url_path: "/files", alt: "Files" },
    { files: values },
  );
  assert.equal(result.length, 25);
  assert.equal(result[0].item.url, values[0]);
  assert.ok(result[2].reason);
  assert.equal(result[23].item.url, values[23]);
  assert.equal(result[24].omittedCount, 3);
  assert.match(result[24].reason, /3 additional files/);
});

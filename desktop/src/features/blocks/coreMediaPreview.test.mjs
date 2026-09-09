import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateBlockData, validateBlockManifest } from "./blockValidation.ts";
import { resolveMedia } from "./ui/primitives/resolvers.ts";

const source = JSON.parse(
  await readFile(
    new URL(
      "../../../../crates/buzz-relay/src/core_blocks/primitives/media.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

test("bundled media supports legacy single sources and ordered rich descriptors", () => {
  assert.equal(validateBlockManifest(source).ok, true);
  for (const data of [
    { url: "https://example.test/cover.png", alt: "Cover" },
    {
      url: "https://example.test/hash",
      alt: "Workbook",
      filename: "Plan.xlsx",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    {
      alt: "Campaign",
      items: [
        "https://example.test/one.svg",
        {
          url: "https://example.test/clip.mp4",
          poster: "https://example.test/poster.jpg",
          filename: "Clip.mp4",
        },
      ],
    },
  ]) {
    assert.equal(validateBlockData(source, data).ok, true);
    assert.ok(resolveMedia(source.tree, data).every((entry) => entry.item));
  }
});

test("bundled media requires exactly one source, bounded items and safe metadata", () => {
  for (const data of [
    { alt: "Missing" },
    {
      url: "https://example.test/a.png",
      items: ["https://example.test/b.png"],
      alt: "Ambiguous",
    },
    { items: [], alt: "Empty" },
    { items: Array(25).fill("https://example.test/a.png"), alt: "Too many" },
    {
      url: "https://example.test/a.mp4",
      poster: "javascript:alert(1)",
      alt: "Unsafe",
    },
    { url: "https://example.test/a.png", width: -1, alt: "Invalid dimensions" },
  ])
    assert.equal(validateBlockData(source, data).ok, false);
});

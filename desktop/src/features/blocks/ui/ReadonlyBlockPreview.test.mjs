import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, mock, test } from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const collections = [];
mock.module("@/shared/ui/media-preview/MediaCollection", {
  namedExports: {
    MediaCollection({ entries }) {
      collections.push(entries);
      return React.createElement("div", {
        "data-native-media-collection": true,
      });
    },
  },
});
const { ReadonlyBlockPreview, resolveCatalogSampleMedia } = await import(
  "./ReadonlyBlockPreview.tsx"
);
const { BlockCatalogCard } = await import("./BlockCatalogCard.tsx");
const { resolveMedia } = await import("./primitives/resolvers.ts");
afterEach(() => {
  collections.length = 0;
});

const source = "https://example.com/slide-1.svg";
const mediaNode = { type: "media", url_path: "/files", alt: "{{title}}" };
const renderPreview = (props) =>
  renderToStaticMarkup(
    React.createElement(ReadonlyBlockPreview, {
      origin: "core",
      trust: "core",
      node: mediaNode,
      data: { title: "Publisher description", files: source },
      ...props,
    }),
  );

test("only exact validated core sample sources are substituted, never metadata or signed data", async () => {
  const original = {
    item: Object.freeze({
      url: source,
      alt: "Original",
      filename: "original.png",
      mime: "image/png",
      size: 999,
      width: 2,
      height: 3,
      poster: "https://example.com/poster.png",
      expectedSha256: "a".repeat(64),
      actualSha256: "a".repeat(64),
    }),
  };
  const unknown = {
    item: { url: "https://publisher.test/report.pdf", filename: source },
  };
  const unavailable = { reason: "Media integrity check failed." };
  const entries = Object.freeze([original, unknown, unavailable]);
  const before = JSON.stringify(entries);
  const mapped = resolveCatalogSampleMedia(entries, "core", "core");
  assert.equal(mapped[1], unknown);
  assert.equal(mapped[2], unavailable);
  assert.equal(JSON.stringify(entries), before);
  assert.deepEqual(mapped[0].item, {
    url: "/rich-previews/launch-01.svg",
    filename: "launch-01.svg",
    kind: "image",
    mime: "image/svg+xml",
    width: 1080,
    height: 1080,
    alt: "Sample artwork: A little space for big ideas.",
  });
  const bytes = await readFile(
    new URL("../../../../public/rich-previews/launch-01.svg", import.meta.url),
    "utf8",
  );
  assert.match(bytes, /width="1080" height="1080"/);
  for (const url of [
    `${source}?revision=2`,
    `${source}#preview`,
    "https://example.com.evil.test/slide-1.svg",
    "https://example.com/unlisted.svg",
  ]) {
    assert.equal(
      resolveCatalogSampleMedia([{ item: { url } }], "core", "core"),
      null,
    );
  }
});

test("core origin and core trust are both required; installed and custom media keep original downloads", () => {
  for (const [origin, trust] of [
    ["core", "untrusted"],
    ["core", "installed"],
    ["installed", "core"],
    ["installed", "installed"],
    ["workspace-custom", "core"],
    ["workspace-custom", "workspace-custom"],
  ]) {
    const html = renderPreview({ origin, trust });
    assert.doesNotMatch(html, /Sample files shown/);
    const actual = collections.at(-1)[0].item;
    assert.equal(actual.originalUrl, source);
    assert.equal(actual.downloadUrl, source);
    assert.equal(actual.src, source);
  }
});

test("nested native media maps samples while ordinary content and unknown files retain scope and order", () => {
  const data = Object.freeze({
    title: "Root heading",
    rows: [
      {
        title: "First row",
        files: [
          source,
          { url: "https://publisher.test/photo.png", alt: "Authored image" },
        ],
      },
      {
        title: "Second row",
        files: [{ url: "https://example.com/slide-2.svg" }, "javascript:bad"],
      },
    ],
  });
  const before = JSON.stringify(data);
  const html = renderPreview({
    data,
    node: {
      type: "card-list",
      items_path: "/rows",
      mode: "list",
      card: {
        type: "card",
        title: "{{title}}",
        children: [
          {
            type: "section",
            text: "Original link: https://example.com/slide-1.svg",
          },
          mediaNode,
        ],
      },
    },
  });
  assert.match(html, /First row/);
  assert.match(html, /Second row/);
  assert.equal(html.match(/Sample files shown/g)?.length, 2);
  assert.match(html, /Original link: https:\/\/example.com\/slide-1.svg/);
  assert.equal(
    collections[0][0].item.downloadUrl,
    "/rich-previews/launch-01.svg",
  );
  assert.equal(collections[0][0].item.src, collections[0][0].item.downloadUrl);
  assert.equal(
    collections[0][1].item.originalUrl,
    "https://publisher.test/photo.png",
  );
  assert.equal(collections[0][1].item.alt, "Authored image");
  assert.equal(collections[1][0].item.filename, "launch-02.svg");
  assert.match(collections[1][1].reason, /unsafe/);
  assert.equal(JSON.stringify(data), before);
});

test("unsafe and integrity-failed samples stay unavailable without a substitution label", () => {
  const data = {
    files: [
      {
        url: source,
        expectedSha256: "a".repeat(64),
        actualSha256: "b".repeat(64),
      },
    ],
  };
  assert.match(resolveMedia(mediaNode, data)[0].reason, /integrity/);
  assert.doesNotMatch(renderPreview({ data }), /Sample files shown/);
  assert.match(collections[0][0].reason, /integrity/);
});

test("catalog card forwards its verified manifest trust instead of trusting preview data", () => {
  const item = {
    handle: "any-media-composite",
    name: "Preview",
    origin: "core",
    status: "active",
    summary: "Native media",
    permissions: [],
    workshop: null,
    preview: { files: source, trust: "core" },
    manifestRecord: { trust: "untrusted", manifest: { tree: mediaNode } },
  };
  const html = renderToStaticMarkup(
    React.createElement(BlockCatalogCard, { item, onSelect() {} }),
  );
  assert.match(html, /Untrusted publisher/);
  assert.doesNotMatch(html, /Sample files shown/);
  assert.equal(collections[0][0].item.downloadUrl, source);
});

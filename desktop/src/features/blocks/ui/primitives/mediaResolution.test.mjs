import assert from "node:assert/strict";
import test from "node:test";

import { inferMediaKind, resolveMedia } from "./resolvers.ts";

const node = { type: "media", url_path: "/items", alt: "Campaign" };

test("media descriptors preserve order, original file metadata and video posters", () => {
  const result = resolveMedia(node, {
    items: [
      "https://example.test/one.png",
      {
        url: "https://example.test/two.svg",
        alt: "Second slide",
        width: 1080,
        height: 1350,
      },
      {
        url: "https://example.test/clip",
        mime: "video/mp4",
        filename: "Launch.mp4",
        poster: "https://example.test/poster.jpg",
      },
      {
        url: "https://example.test/brief",
        mime: "application/pdf",
        filename: "Brief.pdf",
      },
    ],
  });
  assert.deepEqual(
    result.map(({ item }) => item?.kind),
    ["image", "image", "video", "file"],
  );
  assert.equal(result[1].item.alt, "Second slide");
  assert.equal(result[1].item.height, 1350);
  assert.equal(result[2].item.poster, "https://example.test/poster.jpg");
  assert.equal(result[3].item.filename, "Brief.pdf");
});

test("SVG and audio are inferred from MIME, filenames or extension", () => {
  assert.equal(
    inferMediaKind({ url: "https://example.test/logo.svg", alt: "Logo" }),
    "image",
  );
  assert.equal(
    inferMediaKind({ url: "https://example.test/voice.mp3", alt: "Voice" }),
    "audio",
  );
  assert.equal(
    inferMediaKind({
      url: "https://example.test/hash",
      filename: "Recording.wav",
      alt: "Voice",
    }),
    "audio",
  );
  assert.equal(
    inferMediaKind({
      url: "https://example.test/hash",
      mime: "audio/ogg",
      alt: "Voice",
    }),
    "audio",
  );
});

test("descriptor safety is independent for source and poster", () => {
  const result = resolveMedia(node, {
    items: [
      {
        url: "https://example.test/clip.mp4",
        poster: "javascript:alert(1)",
        width: -10,
        height: Infinity,
      },
      { url: "javascript:alert(1)", poster: "https://example.test/poster.jpg" },
      { url: "file:///private/file.pdf", filename: "Local.pdf" },
    ],
  });
  assert.equal(result[0].item.url, "https://example.test/clip.mp4");
  assert.equal(result[0].item.poster, undefined);
  assert.equal(result[0].item.width, undefined);
  assert.equal(result[0].item.height, undefined);
  assert.match(result[1].reason, /unsafe/i);
  assert.match(result[2].reason, /unsafe/i);
});

test("root descriptors work without changing the media node contract", () => {
  const result = resolveMedia(
    { type: "media", url_path: "/", alt: "Recording" },
    {
      url: "https://example.test/hash",
      filename: "Recording.wav",
      mime: "audio/wav",
    },
  );
  assert.equal(result[0].item.kind, "audio");
  assert.equal(result[0].item.filename, "Recording.wav");
});

test("legacy URL arrays preserve the first 24 items and report every omitted file", () => {
  const urls = Array.from(
    { length: 40 },
    (_, i) => `https://example.test/${i}.png`,
  );
  for (const count of [24, 25, 40]) {
    const result = resolveMedia(node, { items: urls.slice(0, count) });
    assert.deepEqual(
      result.flatMap(({ item }) => (item ? [item.url] : [])),
      urls.slice(0, 24),
    );
    const unavailable = result.filter(({ item }) => !item);
    assert.deepEqual(
      unavailable,
      count === 24
        ? []
        : [
            {
              reason: `Showing the first 24 files. ${count - 24} additional files are not previewed.`,
              omittedCount: count - 24,
            },
          ],
    );
  }
  assert.equal(
    resolveMedia(
      { type: "media", url: "https://example.test/cover.png", alt: "Cover" },
      {},
    )[0].item.kind,
    "image",
  );
  assert.match(resolveMedia(node, { items: [] })[0].reason, /No media/);
});

test("bare PDF and spreadsheet URLs retain inferred filenames for inline document routing", () => {
  const result = resolveMedia(node, {
    items: [
      "https://relay.test/media/report%20final.pdf?download=1",
      { url: "https://relay.test/media/ledger.xlsx", alt: "Weekly accounts" },
      "https://relay.test/media/clients.csv",
    ],
  });
  assert.deepEqual(
    result.map(({ item }) => item.filename),
    ["report final.pdf", "ledger.xlsx", "clients.csv"],
  );
  const explicit = resolveMedia(node, {
    items: [
      { url: "https://relay.test/media/hash", filename: "Original.xlsx" },
    ],
  });
  assert.equal(explicit[0].item.filename, "Original.xlsx");
});

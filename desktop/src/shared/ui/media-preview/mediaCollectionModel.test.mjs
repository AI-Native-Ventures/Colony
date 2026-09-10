import assert from "node:assert/strict";
import test from "node:test";
import {
  keyMediaCollection,
  mediaCollectionLabel,
  mediaCollectionType,
} from "./mediaCollectionModel.ts";

const item = {
  src: "http://localhost:123/proxy/a",
  originalUrl: "https://relay.example/media/a.pdf",
  kind: "file",
  filename: "Report.pdf",
};

test("keeps source order and unavailable positions without deduplicating originals", () => {
  const entries = [
    { item },
    { reason: "Blocked unsafe media URL" },
    { item },
    { item: { ...item, originalUrl: "https://relay.example/media/b.pdf" } },
  ];
  const keyed = keyMediaCollection(entries);
  assert.deepEqual(
    keyed.map(({ item, reason }) => item?.originalUrl ?? reason),
    [
      item.originalUrl,
      "Blocked unsafe media URL",
      item.originalUrl,
      "https://relay.example/media/b.pdf",
    ],
  );
  assert.equal(new Set(keyed.map(({ key }) => key)).size, 4);
  assert.deepEqual(
    keyed.map(({ key }) => key),
    keyMediaCollection(entries).map(({ key }) => key),
  );
  assert.equal(
    keyed[0].key,
    keyMediaCollection([
      { item: { ...item, src: "http://localhost:456/proxy/a" } },
    ])[0].key,
  );
});

test("the shared selector does not silently discard entries beyond 24", () => {
  const keyed = keyMediaCollection(
    Array.from({ length: 27 }, () => ({ item })),
  );
  assert.equal(keyed.length, 27);
  assert.equal(new Set(keyed.map(({ key }) => key)).size, 27);
});

test("metadata labels are plain content and URL fallback ignores query credentials", () => {
  assert.equal(mediaCollectionLabel(item), "Report.pdf");
  assert.equal(mediaCollectionType(item), "PDF");
  assert.equal(
    mediaCollectionLabel({
      ...item,
      filename: undefined,
      originalUrl: "https://relay.example/media/original.xlsx?token=secret",
    }),
    "original.xlsx",
  );
  assert.equal(
    mediaCollectionLabel({ ...item, filename: "<script>hello</script>" }),
    "<script>hello</script>",
  );
});

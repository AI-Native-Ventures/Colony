// Hosted fixture lifecycle only. Never included in the packaged app.
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";

const ordered = (entries) =>
  [...entries].sort(([a], [b]) => a.localeCompare(b));

/** Model a legacy app exiting before the first independent upgrade reader. */
export async function persistLegacyFixture({
  writer,
  read,
  settle = () => setTimeout(2_000),
}) {
  let source;
  try {
    source = ordered(await writer.read());
    assert.ok(
      source.length > 0,
      "Legacy fixture must seed nonempty source data",
    );
    // WebKit batches SQLite writes. Keep the live writer alone through the
    // commit delay, then close it normally before opening any independent reader.
    // This fixture preparation wait is not persistence proof; the one post-exit
    // read below must still contain the exact source data.
    // https://github.com/WebKit/WebKit/blob/main/Source/WebKit/NetworkProcess/storage/SQLiteStorageArea.cpp
    await settle();
  } finally {
    await writer.close();
  }
  // The writer has exited normally. This single fresh process proves
  // persistence before Electron is allowed to start; it never seeds or retries.
  assert.deepEqual(
    ordered(await read()),
    source,
    "Legacy source did not survive writer exit",
  );
  return source;
}

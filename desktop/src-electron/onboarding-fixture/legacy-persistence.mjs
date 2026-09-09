// Hosted fixture lifecycle only. Never included in the packaged app.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { setTimeout } from "node:timers/promises";

const ordered = (entries) =>
  [...entries].sort(([a], [b]) => a.localeCompare(b));

/** Keep the fixture writer alive until another process observes its writes. */
export async function persistLegacyFixture({
  writer,
  read,
  settle = () => setTimeout(2_000),
  pause = () => setTimeout(500),
  attempts = 10,
}) {
  let source;
  try {
    source = ordered(await writer.read());
    assert.ok(
      source.length > 0,
      "Legacy fixture must seed nonempty source data",
    );
    // WebKit batches SQLite writes for 500ms. An independent reader opened
    // before that commit can cache an empty store and delete it on teardown.
    // Let the live writer settle before starting any observer. This is only
    // ordering: exact independent reads below still prove persistence.
    // https://github.com/WebKit/WebKit/blob/main/Source/WebKit/NetworkProcess/storage/SQLiteStorageArea.cpp
    await settle();
    let observed = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const entries = ordered(await read());
      if (isDeepStrictEqual(entries, source)) {
        observed = true;
        break;
      }
      // Only an as-yet-empty store is a flush race. Different data is a failure.
      assert.equal(entries.length, 0, "Legacy source changed before migration");
      if (attempt + 1 < attempts) await pause();
    }
    assert.ok(
      observed,
      "Legacy WebKit writes were not visible to an independent reader",
    );
  } finally {
    await writer.close();
  }
  // All writer and observer processes have exited. This fresh process proves
  // persistence before Electron is allowed to start; it never seeds or retries.
  assert.deepEqual(
    ordered(await read()),
    source,
    "Legacy source did not survive writer exit",
  );
  return source;
}

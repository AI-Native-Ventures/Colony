// Hosted fixture lifecycle only. Never included in the packaged app.
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";

const ordered = (entries) =>
  [...entries].sort(([a], [b]) => a.localeCompare(b));

/** Model a legacy app exiting before the first independent upgrade reader. */
export async function persistLegacyFixture({
  writer,
  read,
  settle = () => setTimeout(1000),
}) {
  let source;
  try {
    source = ordered(await writer.read());
    assert.ok(
      source.length > 0,
      "Legacy fixture must seed nonempty source data",
    );
    // Fixture preparation only: let WebKit's asynchronous writes settle without
    // opening competing storage processes. This wait is not persistence proof.
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

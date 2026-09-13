import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageModel } from "./stage-dictation-model.mjs";

const bytes = Buffer.from("verified test model");
const manifest = {
  filename: "model.bin",
  url: "https://example.invalid/model",
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
test("assembles multiple streamed chunks in order", async (t) => {
  const directory = await fixture(t);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 4));
      controller.enqueue(bytes.subarray(4, 9));
      controller.enqueue(bytes.subarray(9));
      controller.close();
    },
  });
  const file = await stageModel({
    directory,
    manifest,
    fetchModel: async () => new Response(body),
  });
  assert.deepEqual(await readFile(file), bytes);
});
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dictation-stage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
test("stages verified bytes and reuses cache without network", async (t) => {
  const directory = await fixture(t);
  const file = await stageModel({
    directory,
    manifest,
    fetchModel: async () => new Response(bytes),
  });
  assert.deepEqual(await readFile(file), bytes);
  assert.equal(
    await stageModel({
      directory,
      manifest,
      fetchModel: () => {
        throw new Error("must not fetch");
      },
    }),
    file,
  );
});
for (const [name, body] of [
  ["checksum", Buffer.alloc(bytes.length)],
  ["truncated", bytes.subarray(1)],
  ["oversized", Buffer.concat([bytes, bytes])],
]) {
  test(`rejects ${name} download without leaving partial model`, async (t) => {
    const directory = await fixture(t);
    await assert.rejects(
      stageModel({
        directory,
        manifest,
        fetchModel: async () => new Response(body),
      }),
      /mismatch|exceeds/,
    );
    assert.deepEqual(await readdir(directory), []);
  });
}
test("repairs a corrupt cached model", async (t) => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, manifest.filename), "bad");
  const file = await stageModel({
    directory,
    manifest,
    fetchModel: async () => new Response(bytes),
  });
  assert.deepEqual(await readFile(file), bytes);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHandoverSaver } from "./save.mjs";

test("native selection saves exact bytes and cancellation never writes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "website-save-test-"));
  const filePath = path.join(directory, "website.zip");
  try {
    const save = createHandoverSaver({}, { showSaveDialog: async () => ({ filePath }) });
    const bytes = Buffer.from("verified archive bytes");
    assert.deepEqual(await save(bytes, "website.zip", () => true), { saved: true });
    assert.deepEqual(await readFile(filePath), bytes);
    const cancel = createHandoverSaver({}, { showSaveDialog: async () => ({ canceled: true, filePath }) });
    assert.deepEqual(await cancel(Buffer.from("changed"), "website.zip", () => true), { saved: false });
    assert.deepEqual(await readFile(filePath), bytes);
    let active = true;
    const switched = createHandoverSaver({}, { showSaveDialog: async () => {
      active = false; return { filePath };
    } });
    await assert.rejects(switched(Buffer.from("changed"), "website.zip", () => active), /Community changed/);
    assert.deepEqual(await readFile(filePath), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

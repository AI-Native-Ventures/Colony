import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EvidenceBrowserHost } from "./host.mjs";

function host(writeCapture) {
  const value = Object.create(EvidenceBrowserHost.prototype);
  value.writeCapture = writeCapture;
  return value;
}

function entry(workspace) {
  return {
    binding: {
      jobId: "job/with-untrusted-input",
      workspaceRoot: workspace,
      ownerPubkey: "f".repeat(64),
      relayUrl: "wss://relay.example.com",
      workerPubkey: "a".repeat(64),
      pid: 1234,
      generation: "b".repeat(32),
    },
    viewport: "desktop",
  };
}

async function temporaryWorkspace() {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "colony-evidence-host-")));
}

test("capturePath delegates to the native writer and preserves its exact contract", async () => {
  const workspace = await temporaryWorkspace();
  const calls = [];
  try {
    const capture = await host(async ({
      ownerPubkey,
      relayUrl,
      workerPubkey,
      expectedPid,
      expectedStartNonce,
      fileName,
      bytesBase64,
    }) => {
      calls.push({
        ownerPubkey,
        relayUrl,
        workerPubkey,
        expectedPid,
        expectedStartNonce,
        fileName,
        bytesBase64,
      });
      const bytes = Buffer.from(bytesBase64, "base64");
      const directory = path.join(workspace, ".colony-evidence");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const filePath = path.join(directory, fileName);
      await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
      return { path: filePath, bytes: bytes.length };
    }).capturePath(entry(workspace), Buffer.from("png"));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].ownerPubkey, "f".repeat(64));
    assert.equal(calls[0].relayUrl, "wss://relay.example.com");
    assert.equal(calls[0].workerPubkey, "a".repeat(64));
    assert.equal(calls[0].expectedPid, 1234);
    assert.equal(calls[0].expectedStartNonce, "b".repeat(32));
    assert.match(calls[0].fileName, /^job_with_untrusted_input-desktop-[a-f0-9]+\.png$/);
    assert.equal(calls[0].bytesBase64, Buffer.from("png").toString("base64"));
    assert.deepEqual(await readFile(capture.path), Buffer.from("png"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("capturePath rejects a native writer result outside the authorized workspace", async () => {
  const workspace = await temporaryWorkspace();
  const outside = await temporaryWorkspace();
  try {
    await assert.rejects(
      () =>
        host(async ({ bytesBase64 }) => ({
          path: path.join(outside, "capture.png"),
          bytes: Buffer.from(bytesBase64, "base64").length,
        })).capturePath(entry(workspace), Buffer.from("png")),
      /invalid path/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("capturePath refuses a symlinked workspace before invoking the native writer", async () => {
  const workspace = await temporaryWorkspace();
  const target = await temporaryWorkspace();
  const link = `${workspace}-link`;
  try {
    await symlink(target, link);
    let invoked = false;
    await assert.rejects(
      () =>
        host(async () => {
          invoked = true;
          return { path: "", bytes: 0 };
        }).capturePath(entry(link), Buffer.from("png")),
      /must not be a symlink/,
    );
    assert.equal(invoked, false);
  } finally {
    await rm(link, { force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

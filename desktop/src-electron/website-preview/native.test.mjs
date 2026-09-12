import assert from "node:assert/strict";
import { test } from "node:test";

import {
  awaitNativeArtifact,
  decodeNativeArtifactBytes,
  nativeWebsiteArtifactArgs,
} from "./native.mjs";

test("uses Tauri's camelCase website artifact invoke contract", () => {
  assert.deepEqual(
    nativeWebsiteArtifactArgs({
      url: "https://relay.example.com/media/abc.html",
      ownerPubkey: "owner",
      relay: "wss://relay.example.com",
    }),
    {
      url: "https://relay.example.com/media/abc.html",
      expectedOwnerPubkey: "owner",
      expectedRelayUrl: "wss://relay.example.com",
    },
  );
});

test("decodes the raw Tauri binary response without changing bytes", () => {
  const source = Buffer.from("<html>verified</html>");
  const decoded = decodeNativeArtifactBytes({
    __colony_binary: source.toString("base64"),
  });
  assert.deepEqual(decoded, source);
  assert.notEqual(decoded, source);
});

test("accepts typed IPC buffers and fences a late native result", async () => {
  const source = new Uint8Array([1, 2, 3]);
  const decoded = decodeNativeArtifactBytes(source);
  assert.deepEqual(decoded, Buffer.from(source));
  assert.notEqual(decoded.buffer, source.buffer);

  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const controller = new AbortController();
  const result = awaitNativeArtifact(pending, controller.signal);
  controller.abort(new Error("business changed"));
  await assert.rejects(result, /business changed/);

  // The native response can arrive after the request was fenced. It is
  // consumed by the helper and can never resolve the aborted operation.
  resolve({ __colony_binary: Buffer.from("stale").toString("base64") });
  await new Promise((done) => setTimeout(done, 0));
});

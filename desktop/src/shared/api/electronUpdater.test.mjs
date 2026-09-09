import assert from "node:assert/strict";
import { test } from "node:test";
import { checkElectronUpdate } from "./electronUpdater.ts";

test("unavailable updater remains an error instead of claiming up to date", async () => {
  await assert.rejects(
    checkElectronUpdate(async () => {
      throw new Error("Updater not initialized");
    }),
    /not initialized/,
  );
  assert.equal(await checkElectronUpdate(async () => null), null);
});

test("install requires verified native bytes and releases the update handle", async () => {
  const calls = [];
  const update = await checkElectronUpdate(async (command, args) => {
    calls.push([command, args]);
    if (command === "electron_check_for_update")
      return { rid: 7, version: "0.17.0" };
    if (command === "plugin:updater|download") return 9;
  });
  await assert.rejects(update.install(), /Download and verify/);
  await update.download();
  await update.install();
  await update.close();
  assert.deepEqual(
    calls.filter(([name]) => name === "plugin:updater|install"),
    [["plugin:updater|install", { updateRid: 7, bytesRid: 9 }]],
  );
  assert.deepEqual(
    calls.filter(([name]) => name === "plugin:resources|close"),
    [["plugin:resources|close", { rid: 7 }]],
  );
  await assert.rejects(update.install(), /closed/);
});

test("closing during download disposes arriving bytes without permitting installation", async () => {
  let resolveDownload;
  const calls = [];
  const update = await checkElectronUpdate(async (command, args) => {
    calls.push([command, args]);
    if (command === "electron_check_for_update")
      return { rid: 1, version: "0.17.0" };
    if (command === "plugin:updater|download")
      return new Promise((resolve) => {
        resolveDownload = resolve;
      });
  });
  const downloading = update.download();
  const closing = update.close();
  resolveDownload(2);
  await Promise.all([downloading, closing]);
  assert.deepEqual(
    calls
      .filter(([name]) => name === "plugin:resources|close")
      .map(([, args]) => args.rid),
    [2, 1],
  );
  assert.equal(
    calls.some(([name]) => name === "plugin:updater|install"),
    false,
  );
});

test("a rejected signature cannot produce installable bytes and still closes the handle", async () => {
  const closed = [];
  const update = await checkElectronUpdate(async (command, args) => {
    if (command === "electron_check_for_update")
      return { rid: 3, version: "0.17.0" };
    if (command === "plugin:updater|download")
      throw new Error("Signature verification failed");
    if (command === "plugin:resources|close") closed.push(args.rid);
  });
  await assert.rejects(update.download(), /Signature verification/);
  await assert.rejects(update.install(), /Download and verify/);
  await update.close();
  assert.deepEqual(closed, [3]);
});

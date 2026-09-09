// Hosted-only legacy executable-layout fixture. This directory is excluded
// from packaged Electron source; production native hosts reject these modes.
import assert from "node:assert/strict";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { NativeHost } from "../native-host.mjs";
import { summarizeLegacyEntries } from "./legacy-diagnostics.mjs";

/** Open the hosted legacy-layout WebKit process without prematurely closing its writer. */
export async function openLegacyStorage({
  manifest,
  directory,
  env,
  mode,
  diagnostics,
}) {
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(process.platform, "darwin");
  assert.equal(manifest.onboardingFixture, true);
  assert.ok(["legacy-seed", "legacy-read"].includes(mode));
  const contents = path.join(directory, "Legacy Colony Fixture.app/Contents");
  await mkdir(path.join(contents, "MacOS"), { recursive: true });
  const executable = path.join(contents, "MacOS/buzz-desktop");
  await copyFile(
    path.join(manifest.app, "Contents/Resources/native/buzz-desktop"),
    executable,
    constants.COPYFILE_EXCL,
  ).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  // The fixed fixture identifier matches its immutable embedded Info.plist.
  // Never use the stable application's identifier for this persistent store.
  await writeFile(
    path.join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ventures.ainative.colony.onboarding-fixture</string>
<key>CFBundleName</key><string>Legacy Colony Fixture</string>
<key>CFBundleExecutable</key><string>buzz-desktop</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
    { flag: "wx" },
  ).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const executableIdentity = await diagnostics?.executable(executable);
  const host = new NativeHost(executable, {
    env: { ...env, COLONY_MIGRATION_PROOF: mode },
  });
  let exit;
  host.child.once("exit", (code, signal) => {
    exit = { code, signal };
  });
  const processFields = { mode, pid: host.child.pid };
  diagnostics?.record("host-open", { ...processFields, executableIdentity });
  return {
    read: async () => {
      const started = performance.now();
      try {
        const entries = await host.request("invoke", {
          command: "electron_read_frontend_migration",
          args: {},
        });
        diagnostics?.record("host-read", {
          ...processFields,
          durationMs: Math.round(performance.now() - started),
          ...summarizeLegacyEntries(entries),
        });
        diagnostics?.snapshot(`${mode}-read`);
        return entries;
      } catch (error) {
        diagnostics?.record("host-read-failed", {
          ...processFields,
          durationMs: Math.round(performance.now() - started),
        });
        throw error;
      }
    },
    close: async () => {
      const started = performance.now();
      let closed = false;
      try {
        await host.close();
        // A forced kill is not proof that WebKit had a chance to flush its store.
        assert.deepEqual(exit, { code: 0, signal: null });
        closed = true;
      } finally {
        diagnostics?.record("host-close", {
          ...processFields,
          durationMs: Math.round(performance.now() - started),
          closed,
          exit: exit ?? null,
        });
        diagnostics?.snapshot(`${mode}-close`);
      }
    },
  };
}

/** Independently read and gracefully close one legacy-layout process. */
export async function readLegacyStorage(options) {
  const host = await openLegacyStorage(options);
  try {
    return await host.read();
  } finally {
    await host.close();
  }
}

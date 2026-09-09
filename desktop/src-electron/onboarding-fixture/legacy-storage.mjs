// Hosted-only legacy executable-layout fixture. This directory is excluded
// from packaged Electron source; production native hosts reject these modes.
import assert from "node:assert/strict";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NativeHost } from "../native-host.mjs";

/** Read a real persistent WebKit store from the legacy Tauri executable layout. */
export async function readLegacyStorage({ manifest, directory, env, mode }) {
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
  );
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
  );
  const host = new NativeHost(executable, {
    env: { ...env, COLONY_MIGRATION_PROOF: mode },
  });
  let exit;
  host.child.once("exit", (code, signal) => {
    exit = { code, signal };
  });
  try {
    await host.ready;
    return await host.request("invoke", {
      command: "electron_read_frontend_migration",
      args: {},
    });
  } finally {
    await host.close();
    // A forced kill is not proof that WebKit had a chance to flush its store.
    assert.deepEqual(exit, { code: 0, signal: null });
  }
}

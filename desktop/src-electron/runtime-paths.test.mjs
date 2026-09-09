import assert from "node:assert/strict";
import test from "node:test";
import { runtimePaths } from "./runtime-paths.mjs";

test("only bundled stable metadata selects the installed profile", () => {
  const common = {
    packaged: true,
    appPath: "/Applications/Colony.app/Contents/Resources/app.asar",
    resourcesPath: "/Applications/Colony.app/Contents/Resources",
    env: {},
  };
  const stable = runtimePaths({ ...common, channel: "stable" });
  const candidate = runtimePaths({ ...common, channel: "candidate" });
  assert.equal(stable.stable, true);
  assert.equal(stable.profile, "colony-electron");
  assert.equal(candidate.stable, false);
  assert.notEqual(candidate.profile, stable.profile);
  assert.equal(
    runtimePaths({ ...common, packaged: false, channel: "stable" }).stable,
    false,
  );
});

test("installed app uses bundled services regardless of shell overrides", () => {
  const paths = runtimePaths({
    packaged: true,
    appPath:
      "/Applications/Colony Electron Beta.app/Contents/Resources/app.asar",
    resourcesPath: "/Applications/Colony Electron Beta.app/Contents/Resources",
    env: {
      COLONY_NATIVE_HOST: "/checkout/stale-host",
      COLONY_ELECTRON_DEV_URL: "http://127.0.0.1:1425",
    },
  });
  assert.equal(
    paths.nativeHost,
    "/Applications/Colony Electron Beta.app/Contents/Resources/native/buzz-desktop",
  );
  assert.equal(paths.devUrl, undefined);
  assert.equal(paths.config, `${paths.appPath}/runtime-config.json`);
  assert.equal(paths.name, "Colony Electron Beta");
});

test("development keeps explicit host and validated Vite origin", () => {
  const paths = runtimePaths({
    packaged: false,
    appPath: "/checkout/desktop",
    env: {
      COLONY_NATIVE_HOST: "/tmp/host",
      COLONY_ELECTRON_DEV_URL: "http://127.0.0.1:1425",
    },
  });
  assert.equal(paths.nativeHost, "/tmp/host");
  assert.equal(paths.config, "/checkout/desktop/src-tauri/tauri.conf.json");
  assert.throws(
    () =>
      runtimePaths({
        packaged: false,
        appPath: "/checkout",
        env: { COLONY_ELECTRON_DEV_URL: "https://external.example" },
      }),
    /development origin/,
  );
  assert.throws(
    () =>
      runtimePaths({
        packaged: false,
        appPath: "/checkout",
        env: { COLONY_NATIVE_HOST: "relative" },
      }),
    /absolute/,
  );
});

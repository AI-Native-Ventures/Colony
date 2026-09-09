# Desktop Browser Profile Discovery Implementation Plan

> **For agentic workers:** Execute inline using the repository proof workflow. The optional superpowers executing-plans skill is not installed. The founder already approved the migration and first-launch/repeat import; do not request that authorization again.

**Goal:** Add metadata-only browser profile discovery under the actual desktop application's Electron source tree.

**Architecture:** A conventional-location catalog feeds a privileged discovery function. An explicit summary projection keeps filesystem paths out of future renderer IPC. No cookie contents or native credentials are accessed in this phase.

**Tech Stack:** Node ESM, built-in filesystem/crypto APIs, Node test runner.

## Gate and tasks

- [x] Create the exact tests below in `desktop/src-electron/browser-import/discovery.test.mjs`. Run `node --test desktop/src-electron/browser-import/discovery.test.mjs`; expect failure before implementation.
- [x] Create the catalog and discovery modules shown below. This is production migration source, not another experiment.
- [x] Run the six tests. Verify scope separation, no content reads, denied access, symlink handling, bounded results and cancellation.
- [x] Format/lint the new source, inspect the scoped diff, and commit signed off on `codex/electron-desktop-migration`.
- [x] Record that UI integration, cookie source adapters, actual authenticated import and the Electron Rust host are not yet implemented. Those are later gates in the approved migration spec.

## Exact implementation

### `desktop/src-electron/browser-import/locations.mjs`

```javascript
import path from "node:path";

/** Conventional profile roots. Call only from the local privileged process. */
export function browserLocations({ platform, homeDir, env = {} }) {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (!p.isAbsolute(homeDir)) throw new Error("An absolute home directory is required");
  const root = (id, name, relative, family = "chromium") => ({
    id, name, family, directory: p.join(homeDir, ...relative),
  });
  if (platform === "darwin") {
    const support = ["Library", "Application Support"];
    return [
      root("chrome", "Google Chrome", [...support, "Google", "Chrome"]),
      root("edge", "Microsoft Edge", [...support, "Microsoft Edge"]),
      root("brave", "Brave", [...support, "BraveSoftware", "Brave-Browser"]),
      root("chromium", "Chromium", [...support, "Chromium"]),
      root("arc", "Arc", [...support, "Arc", "User Data"]),
      root("dia", "Dia", [...support, "Dia", "User Data"]),
      root("firefox", "Firefox", [...support, "Firefox", "Profiles"], "firefox"),
      root("safari", "Safari", ["Library", "Cookies"], "safari"),
      root("safari-container", "Safari", ["Library", "Containers", "com.apple.Safari", "Data", "Library", "Cookies"], "safari"),
    ];
  }
  if (platform === "win32") {
    const local = p.isAbsolute(env.LOCALAPPDATA || "") ? env.LOCALAPPDATA : p.join(homeDir, "AppData", "Local");
    const roaming = p.isAbsolute(env.APPDATA || "") ? env.APPDATA : p.join(homeDir, "AppData", "Roaming");
    const win = (id, name, parts, family = "chromium", parent = local) => ({
      id, name, family, directory: p.join(parent, ...parts),
    });
    return [
      win("chrome", "Google Chrome", ["Google", "Chrome", "User Data"]),
      win("edge", "Microsoft Edge", ["Microsoft", "Edge", "User Data"]),
      win("brave", "Brave", ["BraveSoftware", "Brave-Browser", "User Data"]),
      win("chromium", "Chromium", ["Chromium", "User Data"]),
      win("firefox", "Firefox", ["Mozilla", "Firefox", "Profiles"], "firefox", roaming),
    ];
  }
  if (platform === "linux") {
    const config = p.isAbsolute(env.XDG_CONFIG_HOME || "") ? env.XDG_CONFIG_HOME : p.join(homeDir, ".config");
    return [
      ...[["chrome", "Google Chrome", "google-chrome"], ["edge", "Microsoft Edge", "microsoft-edge"], ["brave", "Brave", "BraveSoftware/Brave-Browser"], ["chromium", "Chromium", "chromium"]]
        .map(([id, name, suffix]) => ({ id, name, family: "chromium", directory: p.join(config, suffix) })),
      root("firefox", "Firefox", [".mozilla", "firefox"], "firefox"),
    ];
  }
  return [];
}
```

### `desktop/src-electron/browser-import/discovery.mjs`

```javascript
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { browserLocations } from "./locations.mjs";

const MAX_ENTRIES = 512;
const MAX_PROFILES = 64;
const MISSING = new Set(["ENOENT", "ENOTDIR"]);
const DENIED = new Set(["EACCES", "EPERM"]);

async function inspect(file, io) {
  try {
    const stat = await io.lstat(file);
    return stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
  } catch (error) {
    if (MISSING.has(error.code)) return "missing";
    if (DENIED.has(error.code)) return "permission-required";
    throw new Error("Browser profile metadata could not be inspected");
  }
}

function candidate(source, profileName, profilePath, status) {
  return {
    id: createHash("sha256").update(source.id).update("\0").update(profilePath).digest("hex"),
    browserId: source.id,
    browserName: source.name,
    profileName,
    profilePath,
    family: source.family,
    status,
  };
}

/**
 * Discover conventional profiles with metadata access only.
 * Returns privileged paths: never expose the result directly over renderer IPC.
 * No database contents, cookie values, Keychain access or network operations.
 * Custom paths, symlinked profiles and portable installs need explicit selection.
 */
export async function discoverBrowserProfiles(options, { io = fs, signal } = {}) {
  const sources = browserLocations(options);
  const profiles = [];
  const issues = [];
  for (const source of sources) {
    signal?.throwIfAborted();
    const status = await inspect(source.directory, io);
    if (status === "missing") continue;
    if (status !== "directory") {
      issues.push({ browserId: source.id, status: status === "permission-required" ? status : "explicit-selection-required" });
      continue;
    }
    if (source.family === "safari") {
      const store = await inspect(path.join(source.directory, "Cookies.binarycookies"), io);
      if (store === "file") profiles.push(candidate(source, "Default", source.directory, "profile-found"));
      else if (store === "permission-required") issues.push({ browserId: source.id, status: store });
      continue;
    }
    let directory;
    try {
      directory = await io.opendir(source.directory);
    } catch (error) {
      if (MISSING.has(error.code)) continue;
      if (DENIED.has(error.code)) {
        issues.push({ browserId: source.id, status: "permission-required" });
        continue;
      }
      throw new Error("Browser profiles could not be listed");
    }
    let entries = 0;
    let found = 0;
    for await (const entry of directory) {
      signal?.throwIfAborted();
      if (++entries > MAX_ENTRIES || found >= MAX_PROFILES) {
        issues.push({ browserId: source.id, status: "more-profiles-available" });
        break;
      }
      if (!entry.isDirectory()) continue;
      if (source.family === "chromium" && !/^(Default|Profile [0-9]+)$/.test(entry.name)) continue;
      const profilePath = path.join(source.directory, entry.name);
      const stores = source.family === "firefox" ? ["cookies.sqlite"] : ["Network/Cookies", "Cookies"];
      let storeFound = false;
      let denied = false;
      for (const store of stores) {
        signal?.throwIfAborted();
        const metadata = await inspect(path.join(profilePath, store), io);
        storeFound ||= metadata === "file";
        denied ||= metadata === "permission-required";
      }
      // Chromium directories can be new profiles without a cookie store yet.
      if (source.family === "firefox" && !storeFound && !denied) continue;
      found++;
      profiles.push(candidate(source, entry.name, profilePath, denied && !storeFound ? "permission-required" : "profile-found"));
    }
  }
  profiles.sort((a, b) => a.browserId.localeCompare(b.browserId) || a.profileName.localeCompare(b.profileName));
  return { profiles, issues };
}

/** Safe owner-facing discovery result; finding a profile does not prove login. */
export function summarizeBrowserProfiles({ profiles, issues }) {
  return {
    profiles: profiles.map(({ id, browserId, browserName, profileName, status }) => ({
      id, browserId, browserName, profileName, status,
    })),
    issues: issues.map(({ browserId, status }) => ({ browserId, status })),
  };
}
```

### `desktop/src-electron/browser-import/discovery.test.mjs`

```javascript
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { browserLocations } from "./locations.mjs";
import { discoverBrowserProfiles, summarizeBrowserProfiles } from "./discovery.mjs";

async function fixture(t) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "colony-profile-discovery-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const options = { platform: "darwin", homeDir };
  const roots = Object.fromEntries(browserLocations(options).map(source => [source.id, source.directory]));
  async function file(browser, name, value = "private-cookie-fixture") {
    const target = path.join(roots[browser], name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, value);
    return target;
  }
  return { options, roots, file };
}

test("discovers separate browser profiles without reading file contents", async t => {
  const { options, file } = await fixture(t);
  const secret = await file("chrome", "Default/Network/Cookies");
  await file("chrome", "Profile 2/Cookies");
  await file("chrome", "Guest Profile/Cookies");
  await file("edge", "Default/Cookies");
  await file("firefox", "abc.default-release/cookies.sqlite");
  await file("firefox", "cache/unrelated");
  const io = new Proxy(fs, { get(target, key) {
    if (!["lstat", "opendir"].includes(key)) throw new Error("Content access is forbidden");
    return target[key];
  } });
  const result = await discoverBrowserProfiles(options, { io });
  assert.deepEqual(result.profiles.map(p => [p.browserId, p.profileName]), [
    ["chrome", "Default"], ["chrome", "Profile 2"], ["edge", "Default"], ["firefox", "abc.default-release"],
  ]);
  assert.equal(new Set(result.profiles.map(p => p.id)).size, 4);
  const repeat = await discoverBrowserProfiles(options, { io });
  assert.deepEqual(repeat, result);
  const publicResult = JSON.stringify(summarizeBrowserProfiles(result));
  assert.ok(!publicResult.includes(options.homeDir));
  assert.ok(!publicResult.includes("private-cookie-fixture"));
  assert.equal(await fs.readFile(secret, "utf8"), "private-cookie-fixture");
});

test("denied browser access is reported without exposing raw OS errors", async t => {
  const { options, roots, file } = await fixture(t);
  await file("edge", "Default/Cookies");
  const io = { ...fs, lstat: async filePath => {
    if (filePath === roots.chrome) throw Object.assign(new Error("secret path or value"), { code: "EACCES" });
    return fs.lstat(filePath);
  } };
  const result = await discoverBrowserProfiles(options, { io });
  assert.deepEqual(result.issues, [{ browserId: "chrome", status: "permission-required" }]);
  assert.equal(result.profiles[0].browserId, "edge");
  assert.ok(!JSON.stringify(result).includes("secret path or value"));
});

test("symlink profiles are not followed during automatic discovery", async t => {
  const { options, roots, file } = await fixture(t);
  await file("chrome", "Default/Cookies");
  await fs.symlink(path.join(roots.chrome, "Default"), path.join(roots.chrome, "Profile 9"));
  const result = await discoverBrowserProfiles(options);
  assert.deepEqual(result.profiles.map(p => p.profileName), ["Default"]);
});

test("profile enumeration is capped and reports incomplete discovery", async t => {
  const { options, roots } = await fixture(t);
  await Promise.all(Array.from({ length: 66 }, (_, i) => fs.mkdir(path.join(roots.chrome, "Profile " + i), { recursive: true })));
  const result = await discoverBrowserProfiles(options);
  assert.equal(result.profiles.length, 64);
  assert.deepEqual(result.issues, [{ browserId: "chrome", status: "more-profiles-available" }]);
});

test("cancellation propagates instead of becoming empty success", async t => {
  const { options } = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discoverBrowserProfiles(options, { signal: controller.signal }), { name: "AbortError" });
});

test("platform roots honor absolute OS config paths and reject relative home", () => {
  const windows = browserLocations({ platform: "win32", homeDir: "C:\\Users\\Owner", env: { LOCALAPPDATA: "D:\\Local", APPDATA: "D:\\Roaming" } });
  assert.equal(windows.find(s => s.id === "chrome").directory, "D:\\Local\\Google\\Chrome\\User Data");
  assert.equal(windows.find(s => s.id === "firefox").directory, "D:\\Roaming\\Mozilla\\Firefox\\Profiles");
  const linux = browserLocations({ platform: "linux", homeDir: "/home/owner", env: { XDG_CONFIG_HOME: "/config" } });
  assert.equal(linux[0].directory, "/config/google-chrome");
  assert.deepEqual(browserLocations({ platform: "unknown", homeDir: "/home/owner" }), []);
  assert.throws(() => browserLocations({ platform: "linux", homeDir: "relative" }), /absolute/);
});
```

## Self-review

The six tests cover the first discovery gate. The bounded scope intentionally excludes account import and native-host extraction; those remain named, unpassed gates rather than hidden stubs. Chromium profile directory conventions and Firefox store markers are discovery hints, not authentication or adapter compatibility proof.


## Completed local checkpoint

Six metadata-only discovery tests passed on macOS with synthetic profile directories; Biome passed from the desktop directory. The tests are included in the existing desktop test script. No live cookies were read or imported. The existing React runtime still uses Tauri; full Electron host integration and the first-launch/Settings import flow remain unimplemented.

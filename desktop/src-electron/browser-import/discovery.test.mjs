import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { browserLocations } from "./locations.mjs";
import {
  discoverBrowserProfiles,
  summarizeBrowserProfiles,
} from "./discovery.mjs";

async function fixture(t) {
  const homeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "colony-profile-discovery-"),
  );
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const options = { platform: "darwin", homeDir };
  const roots = Object.fromEntries(
    browserLocations(options).map((source) => [source.id, source.directory]),
  );
  async function file(browser, name, value = "private-cookie-fixture") {
    const target = path.join(roots[browser], name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, value);
    return target;
  }
  return { options, roots, file };
}

test("discovers separate browser profiles without reading file contents", async (t) => {
  const { options, file } = await fixture(t);
  const secret = await file("chrome", "Default/Network/Cookies");
  await file("chrome", "Profile 2/Cookies");
  await file("chrome", "Guest Profile/Cookies");
  await file("edge", "Default/Cookies");
  await file("firefox", "abc.default-release/cookies.sqlite");
  await file("firefox", "cache/unrelated");
  const io = new Proxy(fs, {
    get(target, key) {
      if (!["lstat", "opendir"].includes(key))
        throw new Error("Content access is forbidden");
      return target[key];
    },
  });
  const result = await discoverBrowserProfiles(options, { io });
  assert.deepEqual(
    result.profiles.map((p) => [p.browserId, p.profileName]),
    [
      ["chrome", "Default"],
      ["chrome", "Profile 2"],
      ["edge", "Default"],
      ["firefox", "abc.default-release"],
    ],
  );
  assert.equal(new Set(result.profiles.map((p) => p.id)).size, 4);
  const repeat = await discoverBrowserProfiles(options, { io });
  assert.deepEqual(repeat, result);
  const publicResult = JSON.stringify(summarizeBrowserProfiles(result));
  assert.ok(!publicResult.includes(options.homeDir));
  assert.ok(!publicResult.includes("private-cookie-fixture"));
  assert.equal(await fs.readFile(secret, "utf8"), "private-cookie-fixture");
});

test("denied browser access is reported without exposing raw OS errors", async (t) => {
  const { options, roots, file } = await fixture(t);
  await file("edge", "Default/Cookies");
  const io = {
    ...fs,
    lstat: async (filePath) => {
      if (filePath === roots.chrome)
        throw Object.assign(new Error("secret path or value"), {
          code: "EACCES",
        });
      return fs.lstat(filePath);
    },
  };
  const result = await discoverBrowserProfiles(options, { io });
  assert.deepEqual(result.issues, [
    { browserId: "chrome", status: "permission-required" },
  ]);
  assert.equal(result.profiles[0].browserId, "edge");
  assert.ok(!JSON.stringify(result).includes("secret path or value"));
});

test("symlink profiles are not followed during automatic discovery", async (t) => {
  const { options, roots, file } = await fixture(t);
  await file("chrome", "Default/Cookies");
  await fs.symlink(
    path.join(roots.chrome, "Default"),
    path.join(roots.chrome, "Profile 9"),
  );
  const result = await discoverBrowserProfiles(options);
  assert.deepEqual(
    result.profiles.map((p) => p.profileName),
    ["Default"],
  );
});

test("profile enumeration is capped and reports incomplete discovery", async (t) => {
  const { options, roots } = await fixture(t);
  await Promise.all(
    Array.from({ length: 66 }, (_, i) =>
      fs.mkdir(path.join(roots.chrome, `Profile ${i}`), { recursive: true }),
    ),
  );
  const result = await discoverBrowserProfiles(options);
  assert.equal(result.profiles.length, 64);
  assert.deepEqual(result.issues, [
    { browserId: "chrome", status: "more-profiles-available" },
  ]);
});

test("cancellation propagates instead of becoming empty success", async (t) => {
  const { options } = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    discoverBrowserProfiles(options, { signal: controller.signal }),
    { name: "AbortError" },
  );
});

test("platform roots honor absolute OS config paths and reject relative home", () => {
  const windows = browserLocations({
    platform: "win32",
    homeDir: "C:\\Users\\Owner",
    env: { LOCALAPPDATA: "D:\\Local", APPDATA: "D:\\Roaming" },
  });
  assert.equal(
    windows.find((s) => s.id === "chrome").directory,
    "D:\\Local\\Google\\Chrome\\User Data",
  );
  assert.equal(
    windows.find((s) => s.id === "firefox").directory,
    "D:\\Roaming\\Mozilla\\Firefox\\Profiles",
  );
  const linux = browserLocations({
    platform: "linux",
    homeDir: "/home/owner",
    env: { XDG_CONFIG_HOME: "/config" },
  });
  assert.equal(linux[0].directory, "/config/google-chrome");
  assert.deepEqual(
    browserLocations({ platform: "unknown", homeDir: "/home/owner" }),
    [],
  );
  assert.throws(
    () => browserLocations({ platform: "linux", homeDir: "relative" }),
    /absolute/,
  );
});

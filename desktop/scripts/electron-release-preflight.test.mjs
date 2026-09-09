import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(
  new URL("./electron-release-preflight.sh", import.meta.url),
);
const release = {
  PATH: process.env.PATH,
  RELEASE_MACOS: "true",
  COLONY_MACOS_SIGNING: "ad-hoc",
  BUZZ_UPDATER_PUBLIC_KEY: "synthetic-public-key",
  TAURI_SIGNING_PRIVATE_KEY: "synthetic-private-key-never-print",
  BUZZ_RELEASE_TAGGER_CLIENT_ID: "synthetic-client",
  BUZZ_RELEASE_TAGGER_PRIVATE_KEY: "synthetic-publisher-never-print",
};
const run = (env) => spawnSync("bash", [script], { env, encoding: "utf8" });

test("explicit ad-hoc release needs no Apple credentials but retains updater and publisher gates", () => {
  assert.equal(run(release).status, 0);
  for (const key of [
    "BUZZ_UPDATER_PUBLIC_KEY",
    "TAURI_SIGNING_PRIVATE_KEY",
    "BUZZ_RELEASE_TAGGER_CLIENT_ID",
    "BUZZ_RELEASE_TAGGER_PRIVATE_KEY",
  ]) {
    const result = run({ ...release, [key]: "" });
    assert.equal(result.status, 1);
    assert.match(result.stdout, new RegExp(key));
    assert.doesNotMatch(result.stdout + result.stderr, /never-print/);
  }
});

test("missing Apple inputs cannot downgrade a requested Developer ID release", () => {
  const result = run({ ...release, COLONY_MACOS_SIGNING: "developer-id" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /COLONY_APPLE_CERTIFICATE_P12/);
  assert.match(result.stdout, /COLONY_APPLE_API_KEY/);
  assert.equal(run({ ...release, COLONY_MACOS_SIGNING: "" }).status, 1);
  assert.equal(
    run({ ...release, COLONY_MACOS_SIGNING: "automatic" }).status,
    1,
  );
});

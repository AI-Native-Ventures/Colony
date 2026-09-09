// Hosted fixture diagnostics only. Never read WebKit database contents or native logs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const fixtureBundle = "ventures.ainative.colony.onboarding-fixture";
const storageRoots = [
  `Library/WebKit/${fixtureBundle}`,
  `Library/Containers/${fixtureBundle}/Data/Library/WebKit`,
];

/** Summarize synthetic exported state without retaining keys or values. */
export function summarizeLegacyEntries(entries) {
  return {
    count: entries.length,
    sha256: createHash("sha256")
      .update(
        JSON.stringify([...entries].sort(([a], [b]) => a.localeCompare(b))),
      )
      .digest("hex"),
  };
}

/** Inspect only the two declared fixture stores, without following symlinks. */
export async function collectSyntheticWebKitMetadata(home) {
  const stores = [];
  for (const relativeRoot of storageRoots) {
    const store = { root: relativeRoot, entries: [], truncated: false };
    stores.push(store);
    const root = path.join(home, relativeRoot);
    try {
      // Refuse symlinks in ancestors too; a fixture path must not redirect us.
      let cursor = home;
      for (const part of relativeRoot.split("/")) {
        cursor = path.join(cursor, part);
        if ((await lstat(cursor)).isSymbolicLink()) {
          store.status = "symlink-refused";
          break;
        }
      }
      if (store.status) continue;
      const visit = async (location, depth) => {
        if (store.entries.length >= 256 || depth > 10) {
          store.truncated = true;
          return;
        }
        const stat = await lstat(location);
        store.entries.push({
          path: path.relative(root, location) || ".",
          type: stat.isSymbolicLink()
            ? "symlink"
            : stat.isDirectory()
              ? "directory"
              : "file",
          size: stat.size,
          inode: stat.ino,
          device: stat.dev,
          modifiedMs: stat.mtimeMs,
          createdMs: stat.birthtimeMs,
        });
        if (!stat.isDirectory() || stat.isSymbolicLink()) return;
        for (const name of (await readdir(location)).sort()) {
          if (store.entries.length >= 256) {
            store.truncated = true;
            break;
          }
          await visit(path.join(location, name), depth + 1);
        }
      };
      await visit(root, 0);
      store.status = "observed";
    } catch (error) {
      store.status =
        error.code === "ENOENT"
          ? "absent-or-changed-during-read"
          : "metadata-unavailable";
    }
  }
  return stores;
}

/** Keep safe process observations separate from unverified configured store identity. */
export function createLegacyDiagnostics({ manifest, env }) {
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(process.platform, "darwin");
  assert.equal(manifest.onboardingFixture, true);
  const started = performance.now();
  const records = [];
  const pending = [];
  const record = (event, fields = {}) => {
    records.push({
      event,
      elapsedMs: Math.round(performance.now() - started),
      ...fields,
    });
  };
  record("configured-fixture", {
    sourceRevision: manifest.sourceRevision,
    version: manifest.version,
    arch: manifest.arch,
    channel: manifest.channel,
    manifestNativeSha256: manifest.binaries?.find(
      (binary) => binary.name === "colony-native-host",
    )?.sha256,
    macOSRelease: os.release(),
    expectedBundleIdentifier: fixtureBundle,
    configuredNamespace: env.COLONY_ELECTRON_INSTANCE_ID,
    configuredProfileId: env.COLONY_ELECTRON_PROFILE_ID,
    configuredOrigin: "tauri://localhost/electron-migration.html",
    storeIdentityVerified: false,
    note: "Configuration and candidate store metadata do not prove which store WebKit selected.",
  });
  return {
    record,
    async executable(executable) {
      try {
        const stat = await lstat(executable);
        return {
          path: executable,
          canonicalPath: await realpath(executable),
          size: stat.size,
          inode: stat.ino,
          device: stat.dev,
          modifiedMs: stat.mtimeMs,
        };
      } catch {
        return { status: "metadata-unavailable" };
      }
    },
    snapshot(reason) {
      const requestedAtMs = Math.round(performance.now() - started);
      // Observation runs alongside the original lifecycle, adding no retry/pause.
      pending.push(
        collectSyntheticWebKitMetadata(os.homedir()).then(
          (stores) =>
            record("store-metadata", { reason, requestedAtMs, stores }),
          () => record("store-metadata-unavailable", { reason, requestedAtMs }),
        ),
      );
    },
    async save(directory) {
      await Promise.all(pending);
      if (!directory) return;
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "legacy-diagnostics.json"),
        JSON.stringify(records, null, 2),
      );
    },
  };
}

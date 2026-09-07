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
    return stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "directory"
        : stat.isFile()
          ? "file"
          : "other";
  } catch (error) {
    if (MISSING.has(error.code)) return "missing";
    if (DENIED.has(error.code)) return "permission-required";
    throw new Error("Browser profile metadata could not be inspected");
  }
}

function candidate(source, profileName, profilePath, status) {
  return {
    id: createHash("sha256")
      .update(source.id)
      .update("\0")
      .update(profilePath)
      .digest("hex"),
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
export async function discoverBrowserProfiles(
  options,
  { io = fs, signal } = {},
) {
  const sources = browserLocations(options);
  const profiles = [];
  const issues = [];
  for (const source of sources) {
    signal?.throwIfAborted();
    const status = await inspect(source.directory, io);
    if (status === "missing") continue;
    if (status !== "directory") {
      issues.push({
        browserId: source.id,
        status:
          status === "permission-required"
            ? status
            : "explicit-selection-required",
      });
      continue;
    }
    if (source.family === "safari") {
      const store = await inspect(
        path.join(source.directory, "Cookies.binarycookies"),
        io,
      );
      if (store === "file")
        profiles.push(
          candidate(source, "Default", source.directory, "profile-found"),
        );
      else if (store === "permission-required")
        issues.push({ browserId: source.id, status: store });
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
        issues.push({
          browserId: source.id,
          status: "more-profiles-available",
        });
        break;
      }
      if (!entry.isDirectory()) continue;
      if (
        source.family === "chromium" &&
        !/^(Default|Profile [0-9]+)$/.test(entry.name)
      )
        continue;
      const profilePath = path.join(source.directory, entry.name);
      const stores =
        source.family === "firefox"
          ? ["cookies.sqlite"]
          : ["Network/Cookies", "Cookies"];
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
      profiles.push(
        candidate(
          source,
          entry.name,
          profilePath,
          denied && !storeFound ? "permission-required" : "profile-found",
        ),
      );
    }
  }
  profiles.sort(
    (a, b) =>
      a.browserId.localeCompare(b.browserId) ||
      a.profileName.localeCompare(b.profileName),
  );
  return { profiles, issues };
}

/** Safe owner-facing discovery result; finding a profile does not prove login. */
export function summarizeBrowserProfiles({ profiles, issues }) {
  return {
    profiles: profiles.map(
      ({ id, browserId, browserName, profileName, status }) => ({
        id,
        browserId,
        browserName,
        profileName,
        status,
      }),
    ),
    issues: issues.map(({ browserId, status }) => ({ browserId, status })),
  };
}

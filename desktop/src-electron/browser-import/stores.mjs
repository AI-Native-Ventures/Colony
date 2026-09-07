import { DatabaseSync } from "node:sqlite";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  timingSafeEqual,
} from "node:crypto";
import { execFile } from "node:child_process";

const services = {
  chrome: "Chrome Safe Storage",
  chromium: "Chromium Safe Storage",
};
/** Explicit support; detection never implies that encrypted sessions are transferable. */
export function support(profile, platform = process.platform) {
  return (
    profile.family === "firefox" ||
    (platform === "darwin" && !!services[profile.browserId])
  );
}
async function open(profile) {
  const root = await realpath(profile.profilePath);
  if (root !== path.resolve(profile.profilePath))
    throw new Error("Linked browser profiles require manual sign-in");
  for (const name of profile.family === "firefox"
    ? ["cookies.sqlite"]
    : ["Network/Cookies", "Cookies"]) {
    const file = path.join(root, name);
    try {
      const stat = await lstat(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (await realpath(file)) !== file
      )
        throw new Error("Linked cookie stores are not supported");
      const db = new DatabaseSync(file, {
        readOnly: true,
        enableDoubleQuotedStringLiterals: false,
      });
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;");
      return db;
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error(
          "Browser data is unavailable. Close the browser and try again, or sign in here.",
        );
    }
  }
  throw new Error("No saved sign-ins were found in this profile");
}
/** Only site names leave the privileged process during selection. */
export async function listSites(profile) {
  const db = await open(profile);
  try {
    const column = profile.family === "firefox" ? "host" : "host_key";
    const table = profile.family === "firefox" ? "moz_cookies" : "cookies";
    return db
      .prepare(
        `SELECT DISTINCT ${column} AS host FROM ${table} ORDER BY ${column} LIMIT 2001`,
      )
      .all()
      .map((row) => row.host);
  } finally {
    db.close();
  }
}
/** Called only after the owner selects a profile and sites and presses Import. */
export function readSafeStorageKey(profile) {
  const service = services[profile.browserId];
  if (process.platform !== "darwin" || !service)
    throw new Error("This browser needs manual sign-in");
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", service],
      { encoding: "buffer", timeout: 60000, maxBuffer: 8192 },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              "Keychain access was not available. Sign in here or try again.",
            ),
          );
          return;
        }
        // security adds one newline; preserve all other password bytes.
        const password = stdout.at(-1) === 10 ? stdout.subarray(0, -1) : stdout;
        const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
        stdout.fill(0);
        resolve(key);
      },
    );
  });
}
/** Chromium macOS v10 envelope, including v24 host binding. */
export function decryptCookie(encrypted, key, host, version) {
  const bytes = Buffer.from(encrypted);
  if (bytes.subarray(0, 3).toString() !== "v10")
    throw new Error("This sign-in uses unsupported browser protection");
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  const plain = Buffer.concat([
    decipher.update(bytes.subarray(3)),
    decipher.final(),
  ]);
  try {
    if (version >= 24) {
      const hash = createHash("sha256").update(host).digest();
      if (plain.length < 32 || !timingSafeEqual(plain.subarray(0, 32), hash))
        throw new Error("Cookie host binding did not match");
      return plain.subarray(32).toString("utf8");
    }
    return plain.toString("utf8");
  } finally {
    plain.fill(0);
  }
}
function convert(row, firefox, value, now) {
  const host = firefox ? row.host : row.host_key;
  if (!/^\.?[a-zA-Z0-9.-]+$/.test(host) || host.includes("..")) return null;
  if (
    firefox
      ? row.originAttributes
      : row.top_frame_site_key || row.is_partitioned
  )
    return null;
  const secure = !!(firefox ? row.isSecure : row.is_secure);
  const expirationDate = firefox
    ? row.expiry
    : row.expires_utc / 1e6 - 11644473600;
  const persistent = firefox
    ? row.expiry > 0
    : row.has_expires !== 0 && row.expires_utc > 0;
  if (persistent && expirationDate <= now) return null;
  const sameSite = firefox
    ? { 0: "no_restriction", 1: "lax", 2: "strict" }[row.sameSite]
    : { "-1": "unspecified", 0: "no_restriction", 1: "lax", 2: "strict" }[
        row.samesite
      ];
  if (!sameSite || (sameSite === "no_restriction" && !secure)) return null;
  const cookie = {
    url: `${secure ? "https" : "http"}://${host.replace(/^\./, "")}${row.path || "/"}`,
    name: row.name,
    value,
    path: row.path || "/",
    secure,
    httpOnly: !!(firefox ? row.isHttpOnly : row.is_httponly),
    sameSite,
  };
  if (host.startsWith(".")) cookie.domain = host;
  if (persistent) cookie.expirationDate = expirationDate;
  return cookie;
}
/** Selected values stay in main-process memory and go directly to Electron cookies. */
export async function readSelectedCookies(
  profile,
  hosts,
  { keyProvider = readSafeStorageKey, now = Date.now() / 1000 } = {},
) {
  const db = await open(profile);
  let key;
  try {
    const firefox = profile.family === "firefox";
    const table = firefox ? "moz_cookies" : "cookies";
    const column = firefox ? "host" : "host_key";
    const query = db.prepare(
      `SELECT * FROM ${table} WHERE ${column} IN (${hosts.map(() => "?").join(",")}) LIMIT 5001`,
    );
    // Chromium's Windows-epoch microseconds exceed Number.MAX_SAFE_INTEGER.
    // Read integers losslessly, then convert for Electron's seconds-based API.
    query.setReadBigInts(true);
    const rows = query
      .all(...hosts)
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([name, value]) => [
            name,
            typeof value === "bigint" ? Number(value) : value,
          ]),
        ),
      );
    if (rows.length > 5000)
      throw new Error("Select fewer sites for this import");
    const version = firefox
      ? 0
      : Number(
          db.prepare("SELECT value FROM meta WHERE key='version'").get()
            ?.value || 0,
        );
    if (!firefox && rows.some((row) => row.encrypted_value?.length))
      key = await keyProvider(profile);
    let skipped = 0;
    const cookies = [];
    for (const row of rows) {
      try {
        const value =
          !firefox && row.encrypted_value?.length
            ? decryptCookie(row.encrypted_value, key, row.host_key, version)
            : row.value;
        const cookie = convert(row, firefox, value, now);
        if (cookie) cookies.push(cookie);
        else skipped++;
      } catch {
        skipped++;
      }
    }
    return { cookies, skipped };
  } finally {
    key?.fill(0);
    db.close();
  }
}

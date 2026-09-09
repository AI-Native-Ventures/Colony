import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createHash } from "node:crypto";
import {
  decryptCookie,
  listSites,
  readSelectedCookies,
  support,
} from "./stores.mjs";

test("Chromium v24 cookies reject host substitution and unsupported encryption", () => {
  const key = Buffer.alloc(16, 7),
    host = ".example.com";
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  const plain = Buffer.concat([
    createHash("sha256").update(host).digest(),
    Buffer.from("fixture-session"),
  ]);
  const encrypted = Buffer.concat([
    Buffer.from("v10"),
    cipher.update(plain),
    cipher.final(),
  ]);
  assert.equal(decryptCookie(encrypted, key, host, 24), "fixture-session");
  assert.throws(
    () => decryptCookie(encrypted, key, ".other.com", 24),
    /host binding/,
  );
  assert.throws(
    () => decryptCookie(Buffer.from("v20unsupported"), key, host, 24),
    /unsupported/,
  );
});
test("Firefox selection excludes other sites, containers and expired cookies", async (t) => {
  const profilePath = await realpath(
    await mkdtemp(path.join(tmpdir(), "colony-cookie-fixture-")),
  );
  t.after(() => rm(profilePath, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(profilePath, "cookies.sqlite"));
  db.exec(
    "CREATE TABLE moz_cookies(host TEXT,name TEXT,value TEXT,path TEXT,expiry INTEGER,isSecure INTEGER,isHttpOnly INTEGER,sameSite INTEGER,originAttributes TEXT)",
  );
  const insert = db.prepare(
    "INSERT INTO moz_cookies VALUES(?,?,?,?,?,?,?,?,?)",
  );
  insert.run(
    ".example.com",
    "session",
    "test-only",
    "/",
    2000000000,
    1,
    1,
    1,
    "",
  );
  insert.run(
    "example.com",
    "container",
    "test-only",
    "/",
    2000000000,
    1,
    1,
    1,
    "^userContextId=2",
  );
  insert.run("example.com", "expired", "test-only", "/", 100, 1, 1, 1, "");
  insert.run(
    "other.com",
    "other",
    "never-selected",
    "/",
    2000000000,
    1,
    1,
    1,
    "",
  );
  db.close();
  const profile = { family: "firefox", profilePath };
  assert.deepEqual(await listSites(profile), [
    ".example.com",
    "example.com",
    "other.com",
  ]);
  const result = await readSelectedCookies(
    profile,
    [".example.com", "example.com"],
    { now: 1000 },
  );
  assert.equal(result.cookies.length, 1);
  assert.equal(result.skipped, 2);
  assert.equal(result.cookies[0].domain, ".example.com");
  assert.equal(result.cookies[0].httpOnly, true);
  assert.equal(result.cookies[0].sameSite, "lax");
  assert.equal(
    support({ family: "chromium", browserId: "chrome" }, "win32"),
    false,
  );
});

test("Chromium SQLite timestamps above JS safe integer survive import", async (t) => {
  const profilePath = await realpath(
    await mkdtemp(path.join(tmpdir(), "colony-chrome-fixture-")),
  );
  t.after(() => rm(profilePath, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(profilePath, "Cookies"));
  db.exec(
    "CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES('version','24'); CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,path TEXT,expires_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,has_expires INTEGER,top_frame_site_key TEXT)",
  );
  const key = Buffer.alloc(16, 7),
    host = "example.com";
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  const plain = Buffer.concat([
    createHash("sha256").update(host).digest(),
    Buffer.from("fixture-only"),
  ]);
  const encrypted = Buffer.concat([
    Buffer.from("v10"),
    cipher.update(plain),
    cipher.final(),
  ]);
  const expiry = (2000000000n + 11644473600n) * 1000000n;
  db.prepare("INSERT INTO cookies VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
    host,
    "session",
    "",
    encrypted,
    "/",
    expiry,
    1,
    1,
    1,
    1,
    "",
  );
  db.close();
  const result = await readSelectedCookies(
    { family: "chromium", browserId: "chrome", profilePath },
    [host],
    { keyProvider: async () => Buffer.from(key), now: 1000 },
  );
  assert.equal(result.cookies.length, 1);
  assert.equal(result.cookies[0].expirationDate, 2000000000);
  assert.equal(result.cookies[0].value, "fixture-only");
  assert.equal(result.cookies[0].domain, undefined);
});

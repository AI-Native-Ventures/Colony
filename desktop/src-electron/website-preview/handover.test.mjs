import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAuthorizedDependencies,
  MAX_FILE_BYTES,
  sha256Hex,
} from "./artifact.mjs";
import { HANDOVER_STAGING_PREFIX, downloadHandover } from "./handover.mjs";

const PUBLIC_ADDRESS = "93.184.216.34";

function reply(chunks) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/octet-stream" },
    destroy() {},
    body: (async function* () {
      for (const chunk of chunks) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }
    })(),
  };
}

function createTransport(routes) {
  const calls = [];
  return {
    calls,
    dependencies: {
      async lookup() {
        return [{ address: PUBLIC_ADDRESS, family: 4 }];
      },
      async open(request) {
        calls.push(request);
        const handler = routes.get(request.url);
        if (handler === undefined) {
          throw Object.assign(new Error(`no route for ${request.url}`), {
            code: "ENOTFOUND",
          });
        }
        return handler(request);
      },
    },
  };
}

function enoent() {
  return Object.assign(new Error("ENOENT"), { code: "ENOENT" });
}

function createFakeFileSystem(root) {
  const files = new Map();
  const directories = new Set([root]);
  const symlinks = new Map();
  const calls = { link: [], mkdir: [], readFile: [], rm: [], writeFile: [] };
  let stagingCounter = 0;
  const entry = (isDirectory, isFile, isSymbolicLink) => ({
    isDirectory: () => isDirectory,
    isFile: () => isFile,
    isSymbolicLink: () => isSymbolicLink,
  });
  return {
    files,
    directories,
    symlinks,
    calls,
    fs: {
      async stat(target) {
        if (directories.has(target)) return entry(true, false, false);
        if (files.has(target)) return entry(false, true, false);
        throw enoent();
      },
      async lstat(target) {
        if (symlinks.has(target)) return entry(false, false, true);
        if (directories.has(target)) return entry(true, false, false);
        if (files.has(target)) return entry(false, true, false);
        throw enoent();
      },
      async mkdtemp(prefix) {
        const value = `${prefix}${++stagingCounter}`;
        directories.add(value);
        return value;
      },
      async mkdir(target) {
        directories.add(target);
        calls.mkdir.push(target);
      },
      async writeFile(target, bytes) {
        files.set(target, Buffer.from(bytes));
        calls.writeFile.push(target);
      },
      async readFile(target) {
        const value = files.get(target);
        if (value === undefined) throw enoent();
        calls.readFile.push(target);
        return value;
      },
      async link(source, destination) {
        if (
          files.has(destination) ||
          directories.has(destination) ||
          symlinks.has(destination)
        ) {
          throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
        }
        files.set(destination, Buffer.from(files.get(source)));
        calls.link.push({ source, destination });
      },
      async unlink(target) {
        files.delete(target);
      },
      async rm(target) {
        calls.rm.push(target);
        for (const key of [...directories]) {
          if (key === target || key.startsWith(`${target}/`)) {
            directories.delete(key);
          }
        }
        for (const key of [...files.keys()]) {
          if (key.startsWith(`${target}/`)) files.delete(key);
        }
      },
    },
  };
}

function item(path, url, bytes, options = {}) {
  const value = { path, url, sha256: sha256Hex(bytes) };
  if (options.size !== undefined) value.size = options.size;
  return value;
}

test("downloadHandover stages then links verified bytes without overwrite", async () => {
  const first = Buffer.from("archive bytes");
  const second = Buffer.from("logo bytes");
  const routes = new Map([
    ["https://cdn.example.com/a.zip", () => reply([first])],
    ["https://cdn.example.com/logo.png", () => reply([second])],
  ]);
  const world = createTransport(routes);
  const root = "/chosen/root";
  const fake = createFakeFileSystem(root);

  const result = await downloadHandover({
    window: null,
    items: [
      item("source/site.zip", "https://cdn.example.com/a.zip", first),
      item("assets/logo.png", "https://cdn.example.com/logo.png", second),
    ],
    chooseDirectory: async () => root,
    dependencies: world.dependencies,
    fileSystem: fake.fs,
  });

  assert.equal(result.complete, true);
  assert.deepEqual(
    result.files.map((file) => [file.path, file.size]),
    [
      ["source/site.zip", first.byteLength],
      ["assets/logo.png", second.byteLength],
    ],
  );
  assert.equal(result.alreadyPresent.length, 0);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(fake.files.get(`${root}/source/site.zip`), first);
  // Staging is fully removed; destination files are the only survivors.
  assert.equal(
    [...fake.directories].some((value) =>
      value.includes(HANDOVER_STAGING_PREFIX),
    ),
    false,
  );
  assert.equal(fake.calls.link.length, 2);
  assert.equal(world.calls.length, 2);
});

test("downloads a private Blossom source archive through the authorized reader", async () => {
  const body = Buffer.from("verified source archive");
  const url =
    "https://relay.example.com/media/abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789.zip";
  const calls = [];
  const dependencies = createAuthorizedDependencies({
    relayOrigin: "https://relay.example.com",
    dependencies: {
      async lookup() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
      async open() {
        throw new Error("private source archive must not use public transport");
      },
    },
    fetchMediaBytes: async (artifactUrl) => {
      calls.push(artifactUrl);
      return { bytes: body, contentType: "application/zip" };
    },
  });
  const root = "/chosen/root";
  const fake = createFakeFileSystem(root);

  const result = await downloadHandover({
    window: null,
    items: [item("source/site.zip", url, body)],
    chooseDirectory: async () => root,
    dependencies,
    fileSystem: fake.fs,
  });

  assert.equal(result.complete, true);
  assert.deepEqual(calls, [url]);
  assert.deepEqual(fake.files.get(`${root}/source/site.zip`), body);
});

test("a declared size that is not exact fails before finalizing", async () => {
  const body = Buffer.from("short");
  const world = createTransport(
    new Map([["https://cdn.example.com/a.zip", () => reply([body])]]),
  );
  const root = "/chosen/root";
  const fake = createFakeFileSystem(root);

  await assert.rejects(
    downloadHandover({
      window: null,
      items: [
        item("a.zip", "https://cdn.example.com/a.zip", body, {
          size: body.byteLength + 1,
        }),
      ],
      chooseDirectory: async () => root,
      dependencies: world.dependencies,
      fileSystem: fake.fs,
    }),
    (error) => error?.code === "handover_size_mismatch",
  );
  assert.equal(fake.calls.link.length, 0);
  assert.equal(
    [...fake.directories].some((value) =>
      value.includes(HANDOVER_STAGING_PREFIX),
    ),
    false,
  );
});

test("digest mismatch and abort remove staging with nothing finalized", async () => {
  const body = Buffer.from("tampered");
  const world = createTransport(
    new Map([["https://cdn.example.com/a.zip", () => reply([body])]]),
  );
  const root = "/chosen/root";
  const fake = createFakeFileSystem(root);

  await assert.rejects(
    downloadHandover({
      window: null,
      items: [
        {
          path: "a.zip",
          url: "https://cdn.example.com/a.zip",
          sha256: sha256Hex("approved"),
        },
      ],
      chooseDirectory: async () => root,
      dependencies: world.dependencies,
      fileSystem: fake.fs,
    }),
    (error) => error?.code === "artifact_digest_mismatch",
  );
  assert.equal(fake.calls.link.length, 0);
  assert.equal(
    [...fake.directories].some((value) =>
      value.includes(HANDOVER_STAGING_PREFIX),
    ),
    false,
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    downloadHandover({
      window: null,
      items: [
        item("a.zip", "https://cdn.example.com/a.zip", body, {
          size: body.byteLength,
        }),
      ],
      chooseDirectory: async () => root,
      dependencies: world.dependencies,
      fileSystem: fake.fs,
      signal: controller.signal,
    }),
    (error) => error?.code === "aborted",
  );
  assert.equal(fake.calls.link.length, 0);
});

test("cancellation creates nothing and needs no retry cleanup", async () => {
  const root = "/chosen/root";
  const fake = createFakeFileSystem(root);
  await assert.rejects(
    downloadHandover({
      window: null,
      items: [item("a.zip", "https://cdn.example.com/a.zip", Buffer.from("x"))],
      chooseDirectory: async () => null,
      fileSystem: fake.fs,
    }),
    (error) => error?.code === "handover_cancelled",
  );
  assert.equal(fake.calls.writeFile.length, 0);
  assert.equal(fake.calls.link.length, 0);
});

test("duplicate paths are refused before any download", async () => {
  let chose = false;
  const root = "/chosen/root";
  const fake = createFakeFileSystem(root);
  for (const paths of [
    ["a.zip", "a.zip"],
    ["assets/Logo.png", "assets/logo.png"],
  ]) {
    await assert.rejects(
      downloadHandover({
        window: null,
        items: paths.map((value) =>
          item(value, "https://cdn.example.com/a.zip", Buffer.from("x")),
        ),
        chooseDirectory: async () => {
          chose = true;
          return root;
        },
        fileSystem: fake.fs,
      }),
      (error) => error?.code === "handover_duplicate_path",
    );
  }
  assert.equal(chose, false);
});

test("a matching destination is alreadyPresent and a different one is preserved", async () => {
  const approved = Buffer.from("approved bytes");
  const user = Buffer.from("the user's own file");
  const root = "/chosen/root";
  const fake = createFakeFileSystem(root);
  fake.files.set(`${root}/keep.zip`, approved);
  fake.files.set(`${root}/clash.zip`, user);
  const world = createTransport(
    new Map([
      ["https://cdn.example.com/keep.zip", () => reply([approved])],
      ["https://cdn.example.com/clash.zip", () => reply([approved])],
    ]),
  );

  const result = await downloadHandover({
    window: null,
    items: [
      item("keep.zip", "https://cdn.example.com/keep.zip", approved),
      item("clash.zip", "https://cdn.example.com/clash.zip", approved),
    ],
    chooseDirectory: async () => root,
    dependencies: world.dependencies,
    fileSystem: fake.fs,
  });

  assert.equal(result.complete, false);
  assert.deepEqual(
    result.alreadyPresent.map((file) => file.path),
    ["keep.zip"],
  );
  assert.deepEqual(
    result.failed.map((file) => [file.path, file.code]),
    [["clash.zip", "handover_conflict"]],
  );
  assert.deepEqual(fake.files.get(`${root}/clash.zip`), user);
  assert.equal(fake.calls.link.length, 0);
});

test("a planted symlink in the destination chain cannot redirect a write", async () => {
  const body = Buffer.from("escape attempt");
  const root = "/chosen/root";
  const fake = createFakeFileSystem(root);
  fake.symlinks.set(`${root}/source`, "/etc");
  const world = createTransport(
    new Map([["https://cdn.example.com/a.zip", () => reply([body])]]),
  );

  const result = await downloadHandover({
    window: null,
    items: [item("source/a.zip", "https://cdn.example.com/a.zip", body)],
    chooseDirectory: async () => root,
    dependencies: world.dependencies,
    fileSystem: fake.fs,
  });

  assert.equal(result.complete, false);
  assert.deepEqual(
    result.failed.map((file) => [file.path, file.code]),
    [["source/a.zip", "handover_conflict"]],
  );
  assert.equal(fake.calls.link.length, 0);
  assert.equal(fake.symlinks.get(`${root}/source`), "/etc");
  assert.equal(fake.files.has("/etc/a.zip"), false);
});

test("a retry after partial finalization skips already-present files", async () => {
  const first = Buffer.from("one");
  const second = Buffer.from("two");
  const root = "/chosen/root";
  const fake = createFakeFileSystem(root);
  const routes = new Map([
    ["https://cdn.example.com/one.zip", () => reply([first])],
    ["https://cdn.example.com/two.zip", () => reply([second])],
  ]);
  const world = createTransport(routes);

  const firstRun = await downloadHandover({
    window: null,
    items: [
      item("one.zip", "https://cdn.example.com/one.zip", first),
      item("two.zip", "https://cdn.example.com/two.zip", second),
    ],
    chooseDirectory: async () => root,
    dependencies: world.dependencies,
    fileSystem: fake.fs,
  });
  assert.equal(firstRun.complete, true);

  const retry = await downloadHandover({
    window: null,
    items: [
      item("one.zip", "https://cdn.example.com/one.zip", first),
      item("two.zip", "https://cdn.example.com/two.zip", second),
    ],
    chooseDirectory: async () => root,
    dependencies: world.dependencies,
    fileSystem: fake.fs,
  });
  assert.equal(retry.complete, true);
  assert.equal(retry.files.length, 0);
  assert.deepEqual(retry.alreadyPresent.map((file) => file.path).sort(), [
    "one.zip",
    "two.zip",
  ]);
});

test("a context change before finalize removes staging and writes nothing", async () => {
  const body = Buffer.from("bytes");
  const world = createTransport(
    new Map([["https://cdn.example.com/a.zip", () => reply([body])]]),
  );
  const root = "/chosen/root";
  const fake = createFakeFileSystem(root);
  let calls = 0;
  await assert.rejects(
    downloadHandover({
      window: null,
      items: [item("a.zip", "https://cdn.example.com/a.zip", body)],
      chooseDirectory: async () => root,
      dependencies: world.dependencies,
      fileSystem: fake.fs,
      assertCurrent: () => {
        calls += 1;
        if (calls >= 2) throw new Error("the business changed");
      },
    }),
    /the business changed/,
  );
  assert.equal(fake.calls.link.length, 0);
  assert.equal(
    [...fake.directories].some((value) =>
      value.includes(HANDOVER_STAGING_PREFIX),
    ),
    false,
  );
  assert.equal(fake.files.size, 0);
});

test("the declared total budget is enforced before any fetch", async () => {
  let chose = false;
  const root = "/chosen/root";
  const fake = createFakeFileSystem(root);
  const budget = Array.from({ length: 5 }, (_, index) =>
    item(
      `part-${index}.zip`,
      `https://cdn.example.com/part-${index}.zip`,
      Buffer.from("x"),
      { size: MAX_FILE_BYTES },
    ),
  );
  await assert.rejects(
    downloadHandover({
      window: null,
      items: budget,
      chooseDirectory: async () => {
        chose = true;
        return root;
      },
      fileSystem: fake.fs,
    }),
    (error) => error?.code === "handover_too_large",
  );
  assert.equal(chose, false);
});

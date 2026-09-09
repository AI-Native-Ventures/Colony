import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { stageNodePty } from "./electron-stage-node-pty.mjs";

function fakeMachOFile() {
  const buf = Buffer.alloc(8192);
  buf.writeUInt32LE(0xfedface, 0); // cffaedfe little-endian as uint32LE -> actually we want bytes `cf fa ed fe`
  // Let's set bytes directly
  buf[0] = 0xcf;
  buf[1] = 0xfa;
  buf[2] = 0xed;
  buf[3] = 0xfe;
  return buf;
}

test("stageNodePty copies allowed files and skips others", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "node-pty-fake-"));
  const source = path.join(temp, "node-pty");
  await mkdir(source, { recursive: true });
  await mkdir(path.join(source, "lib"), { recursive: true });
  await mkdir(path.join(source, "prebuilds", "darwin-arm64"), {
    recursive: true,
  });
  await mkdir(path.join(source, "prebuilds", "win32-x64"), { recursive: true });
  await mkdir(path.join(source, "src"), { recursive: true });
  await mkdir(path.join(source, "deps"), { recursive: true });
  await writeFile(path.join(source, "package.json"), '{"name":"node-pty"}');
  await writeFile(path.join(source, "LICENSE"), "MIT");
  await writeFile(
    path.join(source, "lib", "index.js"),
    "exports.spawn = () => {};\n",
  );
  await writeFile(
    path.join(source, "lib", "terminal.test.js"),
    "test('x') {}\n",
  );
  await writeFile(
    path.join(source, "prebuilds", "darwin-arm64", "pty.node"),
    fakeMachOFile(),
  );
  await writeFile(
    path.join(source, "prebuilds", "darwin-arm64", "spawn-helper"),
    fakeMachOFile(),
  );
  await writeFile(
    path.join(source, "prebuilds", "win32-x64", "junk"),
    "not mach-o",
  );
  await writeFile(path.join(source, "src", "junk.ts"), "// junk");
  await chmod(
    path.join(source, "prebuilds", "darwin-arm64", "spawn-helper"),
    0o644,
  );

  const appDir = path.join(temp, "appDir");
  await mkdir(appDir, { recursive: true });

  const result = await stageNodePty({
    source,
    appDir,
    platform: "darwin",
    arch: "arm64",
  });

  // Assert allowed files present
  assert.deepStrictEqual(
    result.files.map((f) => f.path).sort(),
    [
      "LICENSE",
      "lib/index.js",
      "package.json",
      "prebuilds/darwin-arm64/pty.node",
      "prebuilds/darwin-arm64/spawn-helper",
    ].sort(),
  );

  // Assert skipped
  assert.strictEqual(
    result.files.find((f) => f.path === "lib/terminal.test.js"),
    undefined,
  );
  assert.strictEqual(
    result.files.find((f) => f.path === "prebuilds/win32-x64/junk"),
    undefined,
  );
  assert.strictEqual(
    result.files.find((f) => f.path === "src/junk.ts"),
    undefined,
  );

  // Assert spawn-helper mode 0755
  const spawnStat = statSync(
    path.join(
      appDir,
      "node_modules",
      "node-pty",
      "prebuilds",
      "darwin-arm64",
      "spawn-helper",
    ),
  );
  assert.strictEqual(
    (spawnStat.mode & 0o777).toString(8),
    "755",
    "spawn-helper should be 0755",
  );

  // Assert manifest
  assert.strictEqual(result.prebuild, "darwin-arm64");
  assert.ok(
    result.files.every((f) => typeof f.bytes === "number" && f.bytes > 0),
  );
  assert.ok(
    result.files.every(
      (f) => typeof f.sha256 === "string" && f.sha256.length === 64,
    ),
  );

  await rm(temp, { recursive: true, force: true });
});

test("a non-Mach-O pty.node throws", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "node-pty-bad-"));
  const source = path.join(temp, "node-pty");
  await mkdir(source, { recursive: true });
  await mkdir(path.join(source, "lib"), { recursive: true });
  await mkdir(path.join(source, "prebuilds", "darwin-arm64"), {
    recursive: true,
  });
  await writeFile(path.join(source, "package.json"), '{"name":"node-pty"}');
  await writeFile(path.join(source, "LICENSE"), "MIT");
  await writeFile(path.join(source, "lib", "index.js"), "");
  await writeFile(
    path.join(source, "prebuilds", "darwin-arm64", "pty.node"),
    "not a binary",
  );
  await writeFile(
    path.join(source, "prebuilds", "darwin-arm64", "spawn-helper"),
    fakeMachOFile(),
  );
  await chmod(
    path.join(source, "prebuilds", "darwin-arm64", "spawn-helper"),
    0o755,
  );

  const appDir = path.join(temp, "appDir");
  await mkdir(appDir, { recursive: true });

  await assert.rejects(
    async () =>
      await stageNodePty({ source, appDir, platform: "darwin", arch: "arm64" }),
    /Staged pty\.node is not a valid Mach-O binary/,
  );

  await rm(temp, { recursive: true, force: true });
});

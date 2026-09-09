import { chmod, cp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("..", import.meta.url));

function isMachO(bytes) {
  if (bytes.length < 4096) return false;
  const hex = bytes.subarray(0, 4).toString("hex");
  return ["cffaedfe", "cefaedfe", "cafebabe", "bebafeca"].includes(hex);
}

export async function stageNodePty({
  source = path.join(desktop, "node_modules", "node-pty"),
  appDir,
  platform = process.platform,
  arch = process.arch,
}) {
  const prebuildDir = `prebuilds/${platform}-${arch}`;
  const dest = path.join(appDir, "node_modules", "node-pty");
  await mkdir(dest, { recursive: true });

  const stagedFiles = [];

  async function stageFile(srcFile, relPath) {
    const destFile = path.join(dest, relPath);
    await mkdir(path.dirname(destFile), { recursive: true });
    await cp(srcFile, destFile, { recursive: false, force: true });
    const bytes = await readFile(destFile);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    stagedFiles.push({ path: relPath, bytes: bytes.length, sha256 });
  }

  // Copy package.json
  await stageFile(path.join(source, "package.json"), "package.json");

  // Copy LICENSE
  await stageFile(path.join(source, "LICENSE"), "LICENSE");

  // Copy lib/ skipping *.test.js
  const libSourceDir = path.join(source, "lib");
  const libEntries = await readdir(libSourceDir, { withFileTypes: true });
  for (const entry of libEntries) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".test.js")) continue;
    const rel = path.join("lib", entry.name);
    await stageFile(path.join(libSourceDir, entry.name), rel);
  }

  // Copy prebuilds/<platform>-<arch>/ only
  const prebuildSourceDir = path.join(source, prebuildDir);
  try {
    const prebuildEntries = await readdir(prebuildSourceDir, {
      withFileTypes: true,
    });
    for (const entry of prebuildEntries) {
      if (!entry.isFile()) continue;
      const rel = path.join(prebuildDir, entry.name);
      await stageFile(path.join(prebuildSourceDir, entry.name), rel);
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    throw new Error(
      `node-pty prebuild directory missing: ${prebuildDir} at ${prebuildSourceDir}`,
    );
  }

  // chmod 0755 spawn-helper
  const spawnHelperPath = path.join(dest, prebuildDir, "spawn-helper");
  try {
    await chmod(spawnHelperPath, 0o755);
  } catch (e) {
    throw new Error(`Failed to chmod spawn-helper: ${e.message}`);
  }

  // Verify staged pty.node and spawn-helper are Mach-O
  const ptyNodePath = path.join(dest, prebuildDir, "pty.node");
  const ptyBytes = await readFile(ptyNodePath);
  if (!isMachO(ptyBytes)) {
    throw new Error(
      `Staged pty.node is not a valid Mach-O binary (${prebuildDir}/pty.node)`,
    );
  }

  const spawnHelperBytes = await readFile(spawnHelperPath);
  if (!isMachO(spawnHelperBytes)) {
    throw new Error(
      `Staged spawn-helper is not a valid Mach-O binary (${prebuildDir}/spawn-helper)`,
    );
  }

  // Verify spawn-helper has executable bit
  const spawnStat = await stat(spawnHelperPath);
  if (!(spawnStat.mode & 0o111)) {
    throw new Error(
      `Staged spawn-helper does not have executable bit: ${spawnHelperPath}`,
    );
  }

  return {
    files: stagedFiles,
    prebuild: `${platform}-${arch}`,
  };
}

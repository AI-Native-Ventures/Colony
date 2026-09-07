import { packager } from "@electron/packager";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const exec = promisify(execFile);
const desktop = fileURLToPath(new URL("..", import.meta.url));
const repo = path.dirname(desktop);
const profile = process.argv.includes("--debug") ? "debug" : "release";
const cargoProfile = profile === "debug" ? "dev" : "release";
const helpers = [
  "buzz-acp",
  "buzz-agent",
  "buzz-dev-mcp",
  "git-credential-nostr",
  "buzz",
  "buzz-backend-kubernetes",
];
const packages = [
  "buzz-acp",
  "buzz-agent",
  "buzz-dev-mcp",
  "git-credential-nostr",
  "buzz-cli",
  "buzz-backend-kubernetes",
];
const metadata = JSON.parse(
  await readFile(path.join(desktop, "package.json"), "utf8"),
);
if (process.platform !== "darwin")
  throw new Error("This beta package gate currently supports macOS only");
const run = async (command, args, cwd = repo) => {
  console.log(`[electron-package] ${command} ${args.join(" ")}`);
  const { stdout, stderr } = await exec(command, args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.log(stderr.trim());
};
const targetDir = async (manifest) =>
  JSON.parse(
    (
      await exec(
        "cargo",
        [
          "metadata",
          "--format-version",
          "1",
          "--no-deps",
          ...(manifest ? ["--manifest-path", manifest] : []),
        ],
        { cwd: repo, maxBuffer: 8 * 1024 * 1024 },
      )
    ).stdout,
  ).target_directory;

// Always build from the current source. Never silently package an old helper or
// a Tauri compile-only placeholder supplied by another build.
await run("pnpm", ["build"], desktop);
await run("cargo", [
  "build",
  "--profile",
  cargoProfile,
  "--jobs",
  "4",
  ...packages.flatMap((name) => ["-p", name]),
]);
await run("just", ["_ensure-sidecar-stubs"]);
await run("cargo", [
  "build",
  "--manifest-path",
  "desktop/src-tauri/Cargo.toml",
  "--profile",
  cargoProfile,
  "--jobs",
  "4",
  "--features",
  "electron-host",
  "--bin",
  "colony-native-host",
]);
const rootTarget = await targetDir();
const hostTarget = await targetDir("desktop/src-tauri/Cargo.toml");
const output = path.join(
  desktop,
  "electron-dist",
  `${metadata.version}-${profile}-${process.arch}`,
);
await mkdir(output, { recursive: true });
const stage = await mkdtemp(path.join(os.tmpdir(), "colony-electron-package-"));
try {
  const appDir = path.join(stage, "app");
  const nativeDir = path.join(stage, "native");
  await mkdir(appDir);
  await mkdir(nativeDir);
  await cp(path.join(desktop, "dist"), path.join(appDir, "dist"), {
    recursive: true,
  });
  await cp(
    path.join(desktop, "src-electron"),
    path.join(appDir, "src-electron"),
    {
      recursive: true,
      filter: (source) => !/\.(test\.mjs|md)$|smoke\.mjs$/.test(source),
    },
  );
  const config = JSON.parse(
    await readFile(path.join(desktop, "src-tauri/tauri.conf.json"), "utf8"),
  );
  await writeFile(
    path.join(appDir, "runtime-config.json"),
    JSON.stringify({ app: { security: { csp: config.app.security.csp } } }),
  );
  await writeFile(
    path.join(appDir, "package.json"),
    JSON.stringify({
      name: "colony-electron-beta",
      productName: "Colony Electron Beta",
      version: metadata.version,
      type: "module",
      main: "src-electron/main.mjs",
    }),
  );
  const binaries = [];
  for (const name of ["colony-native-host", ...helpers]) {
    const source = path.join(
      name === "colony-native-host" ? hostTarget : rootTarget,
      profile,
      name,
    );
    const bytes = await readFile(source);
    const mode = (await stat(source)).mode;
    // Mach-O executable, not a zero-byte stub or a shell script stand-in.
    if (
      !(mode & 0o111) ||
      bytes.length < 4096 ||
      !["cffaedfe", "cefaedfe", "cafebabe", "bebafeca"].includes(
        bytes.subarray(0, 4).toString("hex"),
      )
    )
      throw new Error(`Invalid native executable: ${name}`);
    const linked = (await exec("otool", ["-L", source])).stdout
      .split("\n")
      .filter((line) => line.includes(" (compatibility version "))
      .map((line) => line.trim().split(" (compatibility version ")[0]);
    if (
      linked.some(
        (library) =>
          !library.startsWith("/System/Library/") &&
          !library.startsWith("/usr/lib/"),
      )
    )
      throw new Error(
        `Native executable has an unbundled library dependency: ${name}`,
      );
    // Retain the legacy liveness basename so an already-installed Tauri app
    // recognizes this compatibility host and preserves its live workers.
    const destination = name === "colony-native-host" ? "buzz-desktop" : name;
    await cp(source, path.join(nativeDir, destination));
    binaries.push({
      name,
      destination,
      linked,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const [bundle] = await packager({
    dir: appDir,
    name: "Colony Electron Beta",
    executableName: "Colony Electron Beta",
    appBundleId: "ventures.ainative.colony.electron-beta",
    appVersion: metadata.version,
    electronVersion: metadata.devDependencies.electron,
    platform: "darwin",
    arch: process.arch,
    asar: true,
    prune: false,
    icon: path.join(desktop, "src-tauri/icons/icon.icns"),
    extraResource: [nativeDir],
    out: output,
    overwrite: true,
  });
  const app = path.join(bundle, "Colony Electron Beta.app");
  // Local ad-hoc signature enables the relocated beta to run. This is not
  // Developer ID signing or notarization and is recorded explicitly below.
  await run("codesign", ["--force", "--deep", "--sign", "-", app]);
  await run("codesign", ["--verify", "--deep", "--strict", app]);
  const zip = path.join(
    output,
    `Colony-Electron-Beta-${metadata.version}-${profile}-${process.arch}.zip`,
  );
  await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
  await writeFile(
    path.join(output, "manifest.json"),
    JSON.stringify(
      {
        version: metadata.version,
        profile,
        arch: process.arch,
        signing: "ad-hoc; not notarized",
        app,
        zip,
        binaries,
      },
      null,
      2,
    ),
  );
  console.log(`[electron-package] Ready: ${app}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}

import { packager } from "@electron/packager";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
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
import {
  CANARY_KEYRING_SERVICE,
  PORT_KEYRING_SERVICE,
  electronBetaBuildEnv,
  ELECTRON_BETA_RELAY,
  electronPackageVariant,
} from "./electron-package-config.mjs";
import {
  channelUpdaterConfig,
  productionSigning,
} from "./electron-release-contract.mjs";
import { stageNodePty } from "./electron-stage-node-pty.mjs";

const exec = promisify(execFile);
const desktop = fileURLToPath(new URL("..", import.meta.url));
const repo = path.dirname(desktop);
const profile = process.argv.includes("--debug") ? "debug" : "release";
const cargoProfile = profile === "debug" ? "dev" : "release";
const variant = electronPackageVariant(process.argv);
const buildEnv = electronBetaBuildEnv(process.env);
const signing = variant.developerId ? productionSigning(process.env) : {};
if (variant.release) {
  const updaterConfig = channelUpdaterConfig(variant.channel, process.env);
  buildEnv.TAURI_CONFIG = JSON.stringify(updaterConfig);
  buildEnv.BUZZ_UPDATER_ENDPOINT = updaterConfig.plugins.updater.endpoints[0];
}
if (variant.canary) {
  // Owned by the variant, not by the workflow: a canary that inherits the
  // stable keyring service takes over the stable install's identity.
  buildEnv.BUZZ_DESKTOP_KEYRING_SERVICE = CANARY_KEYRING_SERVICE;
}
if (variant.port) {
  buildEnv.BUZZ_DESKTOP_KEYRING_SERVICE = PORT_KEYRING_SERVICE;
}
// Build tools need public release metadata, never the signing credentials.
for (const key of Object.keys(buildEnv)) {
  if (key.startsWith("COLONY_APPLE_") || key.startsWith("TAURI_SIGNING_"))
    delete buildEnv[key];
}
const helpers = [
  "buzz-acp",
  "buzz-agent",
  "buzz-browserd",
  "buzz-dev-mcp",
  "git-credential-nostr",
  "buzz",
  "buzz-backend-kubernetes",
];
const packages = [
  "buzz-acp",
  "buzz-agent",
  "buzz-browser",
  "buzz-dev-mcp",
  "git-credential-nostr",
  "buzz-cli",
  "buzz-backend-kubernetes",
];
const metadata = JSON.parse(
  await readFile(path.join(desktop, "package.json"), "utf8"),
);
if (process.platform !== "darwin")
  throw new Error("The Electron package gate currently supports macOS only");
const run = async (command, args, cwd = repo) => {
  console.log(`[electron-package] ${command} ${args.join(" ")}`);
  const { stdout, stderr } = await exec(command, args, {
    cwd,
    env: buildEnv,
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
  ...variant.helperFeatures,
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
  variant.hostFeatures,
  "--bin",
  "colony-native-host",
]);
const rootTarget = await targetDir();
const hostTarget = await targetDir("desktop/src-tauri/Cargo.toml");
const output = path.join(
  desktop,
  "electron-dist",
  `${metadata.version}-${profile}-${process.arch}${variant.outputSuffix}`,
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
      filter: (source) =>
        !/\.(test\.mjs|md)$|smoke\.mjs$/.test(source) &&
        path.basename(source) !== "onboarding-fixture",
    },
  );
  const nodePtyResult = await stageNodePty({
    source: await realpath(path.join(desktop, "node_modules", "node-pty")),
    appDir,
  });
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
      name: variant.stable
        ? "colony"
        : variant.canary
          ? "colony-canary"
          : variant.port
            ? "colony-port"
            : "colony-electron-beta",
      productName: variant.name,
      version: metadata.version,
      type: "module",
      main: "src-electron/main.mjs",
      colonyReleaseChannel: variant.channel,
      colonyMigrationFixture: variant.fixture && profile === "release",
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
    name: variant.name,
    executableName: variant.executableName,
    appBundleId: variant.bundleId,
    appVersion: metadata.version,
    protocols:
      variant.production || variant.canary || variant.port
        ? [{ name: variant.name, schemes: ["buzz"] }]
        : [],
    electronVersion: metadata.devDependencies.electron,
    platform: "darwin",
    arch: process.arch,
    asar: { unpack: "**/node_modules/node-pty/**" },
    prune: false,
    icon: path.join(desktop, "src-tauri/icons/icon.icns"),
    extraResource: [nativeDir],
    out: output,
    overwrite: true,
    ...signing,
  });
  const app = path.join(bundle, `${variant.name}.app`);
  // Verify node-pty unpacked from asar with executable helper.
  const prebuildDirName = `darwin-${process.arch}`;
  const unpackedBase = path.join(
    app,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "prebuilds",
    prebuildDirName,
  );
  const unpackedSpawnHelper = path.join(unpackedBase, "spawn-helper");
  const unpackedPtyNode = path.join(unpackedBase, "pty.node");
  try {
    const helperStat = await stat(unpackedSpawnHelper);
    if (!(helperStat.mode & 0o111)) {
      throw new Error(
        `Unpacked spawn-helper missing executable bit: ${unpackedSpawnHelper} (mode=${(helperStat.mode & 0o777).toString(8)})`,
      );
    }
  } catch (e) {
    if (e.code === "ENOENT")
      throw new Error(
        `Unpacked node-pty spawn-helper missing at ${unpackedSpawnHelper}; asar unpack failed or prebuild not staged`,
      );
    throw e;
  }
  try {
    await stat(unpackedPtyNode);
  } catch (e) {
    if (e.code === "ENOENT")
      throw new Error(
        `Unpacked node-pty pty.node missing at ${unpackedPtyNode}; asar unpack failed or prebuild not staged`,
      );
    throw e;
  }
  if (!variant.developerId) {
    // Ad-hoc is explicit for stable distribution; missing Apple credentials
    // never silently change a requested Developer ID release.
    await run("codesign", ["--force", "--deep", "--sign", "-", app]);
  }
  await run("codesign", ["--verify", "--deep", "--strict", app]);
  if (variant.developerId) {
    await run("xcrun", ["stapler", "validate", app]);
    await run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
    const signature = (
      await exec("codesign", ["--display", "--verbose=4", app])
    ).stderr;
    if (
      !signature.includes(
        `TeamIdentifier=${process.env.COLONY_APPLE_TEAM_ID}`,
      ) ||
      !signature.includes("Authority=Developer ID Application:")
    ) {
      throw new Error(
        "Packaged app does not carry the expected Developer ID signature",
      );
    }
  } else {
    const signature = (
      await exec("codesign", ["--display", "--verbose=4", app])
    ).stderr;
    if (!signature.includes("Signature=adhoc"))
      throw new Error(
        "Packaged app does not carry the expected ad-hoc signature",
      );
  }
  // Codesigning changes executable bytes. Record the binaries actually shipped.
  for (const binary of binaries) {
    const bytes = await readFile(
      path.join(app, "Contents/Resources/native", binary.destination),
    );
    binary.bytes = bytes.length;
    binary.sha256 = createHash("sha256").update(bytes).digest("hex");
  }
  const zip = path.join(
    output,
    `${variant.name.replaceAll(" ", "-")}-${metadata.version}-${profile}-${process.arch}.zip`,
  );
  await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
  await writeFile(
    path.join(output, "manifest.json"),
    JSON.stringify(
      {
        version: metadata.version,
        profile,
        arch: process.arch,
        relay: ELECTRON_BETA_RELAY,
        signing: variant.developerId
          ? "Developer ID; notarized and stapled"
          : "ad-hoc; not notarized",
        channel: variant.channel,
        executableName: variant.executableName,
        bundleId: variant.bundleId,
        sourceRevision: process.env.GITHUB_SHA ?? null,
        onboardingFixture: variant.fixture,
        app,
        zip,
        binaries,
        nodePty: nodePtyResult,
      },
      null,
      2,
    ),
  );
  console.log(`[electron-package] Ready: ${app}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}

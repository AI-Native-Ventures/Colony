import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Write a tauri.release.conf.json with release-only overrides.
//
// Tauri's --config flag merges the provided JSON on top of the base
// tauri.conf.json, so this file must contain ONLY the delta fields -
// not a copy of the base config.
//
// For OSS release builds this script emits:
// 1. bundle.macOS.minimumSystemVersion = "10.15" for broad compatibility.
// 2. bundle.createUpdaterArtifacts = true so Tauri produces the .tar.gz
//    archive and .sig signature during the build.
// 3. plugins.updater with the public key and endpoint from env vars.
//    Both BUZZ_UPDATER_PUBLIC_KEY and BUZZ_UPDATER_ENDPOINT are required -
//    the script fails if either is missing (OSS builds always ship with updater).
//
// Apple code signing and notarization happen post-build via
// block/apple-codesign-action in release.yml, so no signingIdentity is
// emitted here and the Tauri build is invoked with --no-sign.
//
// ---------------------------------------------------------------------------
// Release channels
// ---------------------------------------------------------------------------
//
// BUZZ_RELEASE_CHANNEL selects which product this overlay describes:
//
//   stable (default) - Colony, xyz.block.buzz.app, version from tauri.conf.json
//   canary           - Colony Canary, ventures.ainative.colony.canary,
//                      version from BUZZ_CANARY_VERSION
//
// The canary identity lives here rather than in a sibling script because the
// overlay is a single contract: exactly one file is merged over
// tauri.conf.json, and everything a release build changes about the base
// config has to be inside it. A second script would have to re-emit the
// updater block, createUpdaterArtifacts, minimumSystemVersion and the
// externalBin guard below, and the two copies would drift the first time one
// of them was edited. Channel is a parameter of the overlay, not a different
// kind of overlay.
//
// A different identifier AND a different productName is what makes a canary
// install sit beside stable: macOS keys application support, preferences and
// keychain items off the bundle identifier, while Finder, the Dock and the
// menu bar key off the bundle name. Changing only one of them produces two
// apps that fight over one data directory or one Dock slot.
//
// Known overlap, deliberately left alone: both channels register the `buzz://`
// deep-link scheme, so macOS picks one of them to open a buzz:// URL. Giving
// canary its own scheme would break every deep link the relay hands it, which
// is worse than an ambiguous handler.

const CHANNELS = {
  stable: {},
  canary: {
    productName: "Colony Canary",
    identifier: "ventures.ainative.colony.canary",
    infoPlist: "Info.canary.plist",
  },
};

const CANARY_VERSION_PATTERN = /^\d+\.\d+\.\d+-canary\.\d+$/;

const srcTauriDir = resolve(process.cwd(), "src-tauri");
const outputConfigPath = resolve(srcTauriDir, "tauri.release.conf.json");

const channel = (process.env.BUZZ_RELEASE_CHANNEL ?? "stable")
  .trim()
  .toLowerCase();

if (!Object.hasOwn(CHANNELS, channel)) {
  console.error(
    `Error: BUZZ_RELEASE_CHANNEL="${channel}" is not a known channel (expected one of: ${Object.keys(
      CHANNELS,
    ).join(", ")})`,
  );
  process.exit(1);
}

const updaterPubkey = process.env.BUZZ_UPDATER_PUBLIC_KEY;
const updaterEndpoint = process.env.BUZZ_UPDATER_ENDPOINT;

const missing = [];
if (!updaterPubkey) missing.push("BUZZ_UPDATER_PUBLIC_KEY");
if (!updaterEndpoint) missing.push("BUZZ_UPDATER_ENDPOINT");
if (channel === "canary" && !process.env.BUZZ_CANARY_VERSION) {
  missing.push("BUZZ_CANARY_VERSION");
}
if (missing.length > 0) {
  console.error(
    `Error: required environment variable(s) missing: ${missing.join(", ")}`,
  );
  process.exit(1);
}

const releaseConfig = {
  bundle: {
    macOS: {
      minimumSystemVersion: "10.15",
    },
    createUpdaterArtifacts: true,
  },
  plugins: {
    updater: {
      pubkey: updaterPubkey,
      endpoints: [updaterEndpoint],
    },
  },
};

if (channel === "canary") {
  const canaryVersion = process.env.BUZZ_CANARY_VERSION.trim();
  // The updater orders builds with semver, so the prerelease segment has to be
  // `canary.<n>` with a numeric n: semver compares numeric prerelease
  // identifiers numerically and everything else as a string, and a string
  // comparison makes canary.9 look newer than canary.10.
  if (!CANARY_VERSION_PATTERN.test(canaryVersion)) {
    console.error(
      `Error: BUZZ_CANARY_VERSION="${canaryVersion}" must look like 0.11.7-canary.42`,
    );
    process.exit(1);
  }

  const { productName, identifier, infoPlist } = CHANNELS.canary;

  // tauri.conf.json points bundle.macOS.infoPlist at a checked-in Info.plist
  // whose CFBundleName/CFBundleDisplayName are the literal string "Colony".
  // Those keys win over productName in the built app, so without this overlay
  // the canary ships as a bundle directory called "Colony Canary.app" that
  // still calls itself "Colony" in Finder, the Dock and the menu bar - exactly
  // the confusion a separate channel exists to avoid.
  const basePlistPath = resolve(srcTauriDir, "Info.plist");
  const basePlist = readFileSync(basePlistPath, "utf8");
  const namePattern =
    /(<key>CFBundle(?:DisplayName|Name)<\/key>\s*<string>)Colony(<\/string>)/g;
  const matches = basePlist.match(namePattern) ?? [];
  if (matches.length !== 2) {
    throw new Error(
      `Expected CFBundleDisplayName and CFBundleName to both read "Colony" in ${basePlistPath}, found ${matches.length}. Update this script rather than shipping a canary that names itself Colony.`,
    );
  }
  const canaryPlistPath = resolve(srcTauriDir, infoPlist);
  writeFileSync(
    canaryPlistPath,
    basePlist.replace(namePattern, `$1${productName}$2`),
  );
  console.log(`Wrote ${canaryPlistPath}`);

  releaseConfig.productName = productName;
  releaseConfig.identifier = identifier;
  releaseConfig.version = canaryVersion;
  releaseConfig.bundle.macOS.infoPlist = infoPlist;
}

// Tauri applies --config after platform-specific config using RFC 7396.
// Any externalBin value here would therefore replace the platform sidecar list,
// while null would silently delete it. This delta must never own that key.
if (Object.hasOwn(releaseConfig.bundle, "externalBin")) {
  throw new Error(
    "Release config must not define bundle.externalBin; sidecars are platform-specific",
  );
}

console.log(`Release channel -> ${channel}`);
if (channel === "canary") {
  console.log(
    `Canary identity -> ${releaseConfig.productName} (${releaseConfig.identifier}) v${releaseConfig.version}`,
  );
}
console.log(`Updater enabled -> ${updaterEndpoint}`);

writeFileSync(outputConfigPath, `${JSON.stringify(releaseConfig, null, 2)}\n`);
console.log(`Wrote ${outputConfigPath}`);

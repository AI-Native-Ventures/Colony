import assert from "node:assert/strict";
import { test } from "node:test";
import {
  productionSigning,
  stableUpdaterConfig,
  STABLE_UPDATER_ENDPOINT,
} from "./electron-release-contract.mjs";
import { electronPackageVariant } from "./electron-package-config.mjs";

test("production preserves installed identity and rejects fixture/debug builds", () => {
  const production = electronPackageVariant(["--production"]);
  assert.equal(production.name, "Colony");
  assert.equal(production.executableName, "buzz-desktop");
  assert.equal(production.bundleId, "xyz.block.buzz.app");
  assert.equal(production.hostFeatures, "electron-stable");
  assert.equal(production.channel, "stable");
  const candidate = electronPackageVariant(["--production-candidate"]);
  assert.equal(candidate.channel, "candidate");
  assert.equal(candidate.production, false);
  for (const flag of [
    "--debug",
    "--onboarding-fixture",
    "--production-candidate",
  ]) {
    assert.throws(() => electronPackageVariant(["--production", flag]));
  }
});

test("ad-hoc distribution is explicit and retains the stable runtime identity", () => {
  const production = electronPackageVariant(["--production", "--ad-hoc"]);
  assert.equal(production.developerId, false);
  assert.equal(production.production, true);
  assert.equal(production.channel, "stable");
  assert.equal(production.hostFeatures, "electron-stable");
  assert.equal(production.bundleId, "xyz.block.buzz.app");
  assert.equal(production.executableName, "buzz-desktop");
  assert.equal(production.outputSuffix, "-stable");
  assert.equal(electronPackageVariant(["--production"]).developerId, true);
  for (const args of [
    ["--ad-hoc"],
    ["--production-candidate", "--ad-hoc"],
    ["--production", "--ad-hoc", "--debug"],
    ["--production", "--ad-hoc", "--onboarding-fixture"],
  ])
    assert.throws(() => electronPackageVariant(args));
});

test("Developer ID mode refuses missing credentials and mismatched Apple team", () => {
  assert.throws(
    () => productionSigning({}),
    /Production signing is unavailable/,
  );
  const env = {
    COLONY_APPLE_SIGNING_IDENTITY:
      "Developer ID Application: Example (ABC1234567)",
    COLONY_APPLE_TEAM_ID: "ABC1234567",
    COLONY_APPLE_API_KEY: "/fixture/AuthKey.p8",
    COLONY_APPLE_API_KEY_ID: "KEY1234567",
    COLONY_APPLE_API_ISSUER: "fixture-issuer",
  };
  assert.equal(
    productionSigning(env).osxSign.optionsForFile().hardenedRuntime,
    true,
  );
  assert.throws(
    () => productionSigning({ ...env, COLONY_APPLE_SIGNING_IDENTITY: "-" }),
    /Developer ID/,
  );
  assert.throws(
    () => productionSigning({ ...env, COLONY_APPLE_TEAM_ID: "DEF1234567" }),
    /matching/,
  );
});

test("existing updater endpoint cannot drift or silently omit the trust key", () => {
  assert.throws(() => stableUpdaterConfig({}), /PUBLIC_KEY/);
  assert.throws(
    () =>
      stableUpdaterConfig({
        BUZZ_UPDATER_PUBLIC_KEY: "fixture",
        BUZZ_UPDATER_ENDPOINT: "https://other.invalid",
      }),
    /cannot change/,
  );
  assert.deepEqual(
    stableUpdaterConfig({ BUZZ_UPDATER_PUBLIC_KEY: "fixture" }).plugins.updater,
    { pubkey: "fixture", endpoints: [STABLE_UPDATER_ENDPOINT] },
  );
});

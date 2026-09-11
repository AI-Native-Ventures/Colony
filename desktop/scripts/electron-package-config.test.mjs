import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  CANARY_KEYRING_SERVICE,
  electronBetaBuildEnv,
  ELECTRON_BETA_RELAY,
  electronPackageVariant,
} from "./electron-package-config.mjs";

test("installable beta uses the same hosted account service as stable and canary", async () => {
  const env = electronBetaBuildEnv({ PATH: "/fixture/bin" });
  assert.equal(env.BUZZ_RELAY_URL, "wss://relay.colony.ainative.ventures");
  assert.equal(env.BUZZ_RELAY_HTTP, "https://relay.colony.ainative.ventures");
  assert.equal(env.PATH, "/fixture/bin");
  for (const workflow of [
    "colony-desktop-release.yml",
    "colony-desktop-canary.yml",
  ]) {
    const source = await readFile(
      new URL(`../../.github/workflows/${workflow}`, import.meta.url),
      "utf8",
    );
    assert.ok(source.includes(ELECTRON_BETA_RELAY.websocket));
    assert.ok(source.includes(ELECTRON_BETA_RELAY.http));
  }
});

test("fixture transport must be explicitly selected and cannot overwrite the beta", () => {
  const beta = electronPackageVariant(["--debug"]);
  const fixture = electronPackageVariant(["--debug", "--onboarding-fixture"]);
  assert.equal(beta.fixture, false);
  assert.deepEqual(beta.helperFeatures, []);
  assert.equal(beta.hostFeatures, "electron-host");
  assert.equal(fixture.fixture, true);
  assert.notEqual(fixture.name, beta.name);
  assert.notEqual(fixture.bundleId, beta.bundleId);
  assert.notEqual(fixture.outputSuffix, beta.outputSuffix);
  assert.match(fixture.hostFeatures, /onboarding-fixture/);
  assert.match(fixture.helperFeatures[1], /buzz-acp\/onboarding-fixture/);
  assert.match(fixture.helperFeatures[1], /buzz-cli\/onboarding-fixture/);
  assert.equal(
    Object.hasOwn(
      electronBetaBuildEnv({ BUZZ_ONBOARDING_FIXTURE_TRANSPORT: "fixture" }),
      "BUZZ_ONBOARDING_FIXTURE_TRANSPORT",
    ),
    false,
  );
});

test("a developer shell cannot silently redirect the installable beta to a local relay", () => {
  const original = {
    BUZZ_RELAY_URL: "ws://localhost:3000",
    BUZZ_RELAY_HTTP: "http://localhost:3000",
    BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY: "1",
  };
  const env = electronBetaBuildEnv(original);
  assert.equal(env.BUZZ_RELAY_URL, ELECTRON_BETA_RELAY.websocket);
  assert.equal(env.BUZZ_RELAY_HTTP, ELECTRON_BETA_RELAY.http);
  assert.equal(
    Object.hasOwn(env, "BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY"),
    false,
  );
  assert.equal(original.BUZZ_RELAY_URL, "ws://localhost:3000");
  assert.equal(original.BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY, "1");
});

test("the canary is a separate app from stable, never a renamed one", () => {
  const canary = electronPackageVariant(["--production", "--canary"]);
  const stable = electronPackageVariant(["--production"]);
  assert.equal(canary.name, "Colony Canary");
  assert.equal(canary.channel, "canary");
  assert.equal(canary.bundleId, "ventures.ainative.colony.canary");
  assert.equal(canary.outputSuffix, "-canary");
  assert.equal(canary.stable, false);
  assert.equal(canary.release, true);
  assert.equal(canary.canary, true);
  assert.equal(canary.fixture, false);
  // The owner quits one channel by process name, so the two can never match.
  assert.notEqual(canary.executableName, stable.executableName);
  assert.equal(canary.executableName, "colony-canary");
  assert.notEqual(canary.bundleId, stable.bundleId);
  assert.notEqual(canary.outputSuffix, stable.outputSuffix);
  // Packaged release host, exactly like stable.
  assert.equal(canary.hostFeatures, stable.hostFeatures);
  // Signing follows production, so a canary is signed the way stable is.
  assert.equal(canary.developerId, stable.developerId);
  assert.equal(
    electronPackageVariant(["--production", "--canary", "--ad-hoc"])
      .developerId,
    false,
  );
});

test("a canary cannot be built as a fixture, a debug build or a candidate", () => {
  assert.throws(
    () => electronPackageVariant(["--canary", "--onboarding-fixture"]),
    /fixture, debug or conflicting/,
  );
  assert.throws(
    () => electronPackageVariant(["--canary", "--debug"]),
    /fixture, debug or conflicting/,
  );
  assert.throws(
    () => electronPackageVariant(["--canary", "--production-candidate"]),
    /production candidate/,
  );
  // Ad-hoc stays explicit, and a local canary is allowed to ask for it.
  assert.throws(() => electronPackageVariant(["--ad-hoc"]), /requires/);
  assert.equal(electronPackageVariant(["--canary", "--ad-hoc"]).canary, true);
});

test("the canary keyring service is owned here, not by a workflow", async () => {
  assert.equal(CANARY_KEYRING_SERVICE, "colony-canary-desktop");
  const source = await readFile(
    new URL("./electron-package.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /BUZZ_DESKTOP_KEYRING_SERVICE = CANARY_KEYRING_SERVICE/);
});

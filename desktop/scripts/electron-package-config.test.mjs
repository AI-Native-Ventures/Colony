import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  electronBetaBuildEnv,
  ELECTRON_BETA_RELAY,
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

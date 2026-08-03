import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./DiscoverySettingsCard.tsx", import.meta.url),
  "utf8",
);

test("Discovery settings explain the BYOK privacy and billing boundary", () => {
  assert.match(source, /stays in this device/);
  assert.match(source, /does not upload or synchronize/);
  assert.match(source, /billed\s+directly/);
  assert.match(source, /saving a key does not start a\s+run/);
});

test("Discovery settings never request a stored secret value", () => {
  assert.match(source, /getDiscoveryCredentialStatus\(provider\)/);
  assert.doesNotMatch(source, /getDiscoveryCredential\s*\(/);
  assert.match(source, /setValue\(""\)/);
  assert.match(source, /type=\{showValue \? "text" : "password"\}/);
});

test("Discovery settings render Outscraper, Brave, and Exa consistently", () => {
  assert.match(source, /provider: "outscraper"/);
  assert.match(source, /provider: "brave_search"/);
  assert.match(source, /provider: "exa_search"/);
  assert.match(source, /PROVIDERS\.map/);
  assert.match(source, /saveDiscoveryCredential\(provider, value\)/);
  assert.match(source, /deleteDiscoveryCredential\(provider\)/);
});

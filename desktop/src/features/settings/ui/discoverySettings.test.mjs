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
  assert.match(source, /getDiscoveryOutscraperCredentialStatus/);
  assert.doesNotMatch(source, /getDiscoveryOutscraperCredential\s*\(/);
  assert.match(source, /setValue\(""\)/);
  assert.match(source, /type=\{showValue \? "text" : "password"\}/);
});

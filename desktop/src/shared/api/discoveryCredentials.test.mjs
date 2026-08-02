import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("./discoveryCredentials.ts", import.meta.url);

test("Discovery credential API exposes only status-returning commands", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /save_discovery_outscraper_credential/);
  assert.match(source, /get_discovery_outscraper_credential_status/);
  assert.match(source, /delete_discovery_outscraper_credential/);
  assert.match(source, /Promise<DiscoveryCredentialStatus>/g);
  assert.doesNotMatch(source, /Promise<string>/);
  assert.doesNotMatch(source, /getDiscoveryOutscraperCredential\s*\(/);
});

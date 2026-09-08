import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { createOnboardingFixtureProxy } from "./proxy.mjs";

test("proxy refuses non-fixture domains and non-loopback upstreams before starting", async () => {
  for (const [domain, upstreamHttpUrl] of [
    ["example.com", "http://127.0.0.1:1234"],
    ["onboarding-safe.invalid", "http://example.com:1234"],
    ["onboarding-safe.invalid", "http://127.0.0.1:1234/path"],
  ]) {
    await assert.rejects(
      createOnboardingFixtureProxy({
        domain,
        upstreamHttpUrl,
        directory: os.tmpdir(),
      }),
    );
  }
});

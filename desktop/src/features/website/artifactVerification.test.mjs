import assert from "node:assert/strict";
import test from "node:test";

import {
  isLocalArtifactUrl,
  verifiedArtifactRequestKey,
} from "./artifactVerification.ts";

const REF = {
  url: "https://cdn.example.com/capture.png",
  sha256: "A".repeat(64),
};

test("the request key is null when no load may start", () => {
  assert.equal(
    verifiedArtifactRequestKey({ artifact: null, enabled: true, hasLoader: true }),
    null,
  );
  assert.equal(
    verifiedArtifactRequestKey({ artifact: REF, enabled: false, hasLoader: true }),
    null,
  );
  assert.equal(
    verifiedArtifactRequestKey({ artifact: REF, enabled: true, hasLoader: false }),
    null,
  );
  assert.equal(
    verifiedArtifactRequestKey({
      artifact: { url: "", sha256: REF.sha256 },
      enabled: true,
      hasLoader: true,
    }),
    null,
  );
});

test("the request key changes with URL and normalized hash", () => {
  const base = verifiedArtifactRequestKey({
    artifact: REF,
    enabled: true,
    hasLoader: true,
  });
  assert.ok(base);
  assert.equal(
    base,
    verifiedArtifactRequestKey({
      artifact: { url: REF.url, sha256: REF.sha256.toLowerCase() },
      enabled: true,
      hasLoader: true,
    }),
    "hash case is normalized so the key does not churn",
  );
  assert.notEqual(
    base,
    verifiedArtifactRequestKey({
      artifact: { ...REF, url: "https://cdn.example.com/other.png" },
      enabled: true,
      hasLoader: true,
    }),
  );
  assert.notEqual(
    base,
    verifiedArtifactRequestKey({
      artifact: { ...REF, sha256: "B".repeat(64) },
      enabled: true,
      hasLoader: true,
    }),
  );
});

test("only local verified object URLs are accepted", () => {
  assert.equal(isLocalArtifactUrl("blob:https://app/byte-range"), true);
  assert.equal(isLocalArtifactUrl("data:image/png;base64,AAAA"), true);
  assert.equal(isLocalArtifactUrl("asset://localhost/capture.png"), true);
  assert.equal(isLocalArtifactUrl("file:///tmp/capture.png"), true);
  assert.equal(
    isLocalArtifactUrl("http://asset.localhost/capture.png"),
    true,
  );
  assert.equal(isLocalArtifactUrl("http://127.0.0.1:1420/capture.png"), true);
});

test("remote URLs, including the artifact's own URL, are refused", () => {
  assert.equal(isLocalArtifactUrl(REF.url), false);
  assert.equal(isLocalArtifactUrl(REF.url, REF.url), false);
  assert.equal(
    isLocalArtifactUrl("https://cdn.example.com/capture.png", REF.url),
    false,
  );
  assert.equal(isLocalArtifactUrl("javascript:alert(1)"), false);
  assert.equal(isLocalArtifactUrl(""), false);
  assert.equal(isLocalArtifactUrl("not a url"), false);
});

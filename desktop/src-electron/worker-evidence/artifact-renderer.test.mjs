import assert from "node:assert/strict";
import test from "node:test";

import {
  createVerifiedArtifactRenderer,
  requireWebsiteManifest,
  requireWebsiteRevision,
} from "./artifact-renderer.mjs";

test("artifact rendering uses the signed positive Website content revision", () => {
  assert.equal(requireWebsiteRevision({ websiteRevision: 4 }), 4);
  assert.throws(
    () => requireWebsiteRevision({ websiteRevision: 0 }),
    /signed Website content revision/,
  );
  assert.throws(
    () => requireWebsiteRevision({ websiteRevision: undefined }),
    /signed Website content revision/,
  );
  assert.deepEqual(
    requireWebsiteManifest(
      {
        websiteManifestUrl: "https://artifact.example.com/site.json",
        websiteManifestSha256: "a".repeat(64),
      },
      {
        url: "https://artifact.example.com/site.json",
        sha256: "a".repeat(64),
      },
    ),
    {
      url: "https://artifact.example.com/site.json",
      sha256: "a".repeat(64),
    },
  );
  assert.throws(
    () =>
      requireWebsiteManifest(
        {
          websiteManifestUrl: "https://artifact.example.com/site.json",
          websiteManifestSha256: "a".repeat(64),
        },
        {
          url: "https://artifact.example.com/other.json",
          sha256: "a".repeat(64),
        },
      ),
    /does not match the signed Website revision/,
  );
});

test("artifact rendering does not fall back to a synthetic revision", async () => {
  const render = createVerifiedArtifactRenderer({
    BrowserWindow: function BrowserWindow() {},
    WebContentsView: function WebContentsView() {},
    View: function View() {},
    session: { fromPartition() {} },
    loadPreview: async () => {},
  });
  await assert.rejects(
    () =>
      render({
        binding: { websiteRevision: 0 },
        source: { kind: "verified-artifact" },
        viewport: "desktop",
      }),
    /signed Website content revision/,
  );
});

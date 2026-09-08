import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
test("optional browser import mounts outside QueryClientProvider without crashing", async (t) => {
  t.mock.module("@/features/communities/useCommunities", {
    namedExports: { useCommunities: () => ({ activeCommunity: null }) },
  });
  t.mock.module("@/features/onboarding/communityOnboarding", {
    namedExports: { useCommunityOnboarding: () => ({ transaction: null }) },
  });
  t.mock.module("@/shared/api/electronNativeBridge", {
    namedExports: { electronDesktop: () => undefined },
  });
  const { BrowserImportWelcome } = await import("./BrowserImport.tsx");
  assert.equal(renderToString(React.createElement(BrowserImportWelcome)), "");
});

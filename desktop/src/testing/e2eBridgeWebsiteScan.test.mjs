import assert from "node:assert/strict";
import test from "node:test";
import { websiteScanResponse } from "./e2eBridgeWebsiteScan.ts";

const COMMAND = "scan_onboarding_company_website";

test("without a fixture the website read stays an unsupported command", () => {
  for (const mock of [undefined, {}]) {
    assert.throws(
      () => websiteScanResponse(mock, COMMAND),
      /Unsupported mocked Tauri command: scan_onboarding_company_website/,
    );
  }
});

test("a configured read comes back as the native command returns it", () => {
  const scan = {
    status: "success",
    result: {
      requestedUrl: "https://brightplumbing.co.za",
      canonicalUrl: "https://brightplumbing.co.za/",
      pages: [
        {
          url: "https://brightplumbing.co.za/",
          description: { value: "Bright Plumbing fixes leaks." },
          text: "",
        },
      ],
      warnings: [],
    },
  };
  assert.deepEqual(
    websiteScanResponse({ companyWebsiteScan: scan }, COMMAND),
    scan,
  );
});

test("a configured failure is returned as it is", () => {
  const failed = { status: "timeout", message: "The site took too long." };
  assert.deepEqual(
    websiteScanResponse({ companyWebsiteScan: failed }, COMMAND),
    failed,
  );
});

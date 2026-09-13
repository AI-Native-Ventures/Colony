import assert from "node:assert/strict";
import test from "node:test";

import {
  EVIDENCE_CONTENT_SECURITY_POLICY,
  EVIDENCE_VIEWPORTS,
  evidenceResponseHeaders,
  evidenceViewportSize,
  isAllowedEvidenceRequest,
  requireEvidenceReadMethod,
  resolveEvidenceViewport,
  validateEvidenceUrl,
} from "./policy.mjs";

const PUBLIC_URL = "https://www.example.com/index.html";

test("evidence navigation accepts only public HTTPS GET requests", () => {
  assert.equal(
    isAllowedEvidenceRequest({ url: PUBLIC_URL, method: "GET" }),
    true,
  );
  for (const request of [
    { url: "http://www.example.com/", method: "GET" },
    { url: "file:///tmp/index.html", method: "GET" },
    { url: "javascript:alert(1)", method: "GET" },
    { url: PUBLIC_URL, method: "POST" },
    { url: PUBLIC_URL, method: "GET", resourceType: "websocket" },
    { url: PUBLIC_URL, method: "GET", resourceType: "serviceworker" },
    { url: "https://localhost/index.html", method: "GET" },
    { url: "https://127.0.0.1/index.html", method: "GET" },
  ]) {
    assert.equal(
      isAllowedEvidenceRequest(request),
      false,
      `request should be refused: ${JSON.stringify(request)}`,
    );
  }

  // Chromium-owned inline resources do not traverse the HTTPS protocol
  // handler. Keep the explicit data/blob allowance while network URLs remain
  // restricted to public HTTPS.
  assert.equal(
    isAllowedEvidenceRequest({ url: "data:text/plain,ok", method: "GET" }),
    true,
  );
  assert.equal(
    isAllowedEvidenceRequest({ url: "blob:https://www.example.com/id", method: "GET" }),
    true,
  );
});

test("the URL validator blocks credentials, fragments, private hosts, and oversize URLs", () => {
  assert.equal(validateEvidenceUrl(PUBLIC_URL).href, PUBLIC_URL);
  for (const value of [
    "http://www.example.com/",
    "https://user:password@www.example.com/",
    "https://www.example.com/#fragment",
    "https://localhost/",
    "https://10.0.0.1/",
    "https://example",
    `https://www.example.com/${"a".repeat(2_050)}`,
  ]) {
    assert.throws(
      () => validateEvidenceUrl(value),
      undefined,
      `URL should be refused: ${value.slice(0, 80)}`,
    );
  }
});

test("read method policy and fixed viewport policy are exact", () => {
  assert.equal(requireEvidenceReadMethod("get"), "GET");
  for (const method of ["POST", "PUT", "PATCH", "DELETE", undefined, null]) {
    assert.throws(() => requireEvidenceReadMethod(method), /only permits GET/);
  }

  assert.deepEqual(EVIDENCE_VIEWPORTS, {
    desktop: { width: 1440, height: 900 },
    mobile: { width: 390, height: 844 },
  });
  assert.deepEqual(evidenceViewportSize("desktop"), {
    width: 1440,
    height: 900,
  });
  assert.deepEqual(evidenceViewportSize("mobile"), {
    width: 390,
    height: 844,
  });
  assert.equal(resolveEvidenceViewport("desktop"), "desktop");
  assert.throws(() => resolveEvidenceViewport("tablet"), /desktop or mobile/);
});

test("resource response headers expose no request credentials and keep the policy locked", () => {
  const headers = evidenceResponseHeaders("text/html; charset=utf-8");
  assert.equal(headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(headers.get("access-control-allow-methods"), "GET");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  for (const name of ["authorization", "cookie", "set-cookie"]) {
    assert.equal(headers.get(name), null, `${name} must not be emitted`);
  }
  assert.match(EVIDENCE_CONTENT_SECURITY_POLICY, /form-action 'none'/);
  assert.match(EVIDENCE_CONTENT_SECURITY_POLICY, /connect-src https:/);
  assert.match(EVIDENCE_CONTENT_SECURITY_POLICY, /frame-src 'none'/);
});

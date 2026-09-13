import assert from "node:assert/strict";
import test from "node:test";
import { installDictationPermissions } from "./dictation-permissions.mjs";
function fixture() {
  let request, check;
  const owner = {
    getURL: () => "colony://app/index.html",
    session: {
      setPermissionRequestHandler: (fn) => (request = fn),
      setPermissionCheckHandler: (fn) => (check = fn),
    },
  };
  installDictationPermissions(
    owner,
    (url) => typeof url === "string" && url.startsWith("colony://app/"),
  );
  const details = {
    isMainFrame: true,
    requestingUrl: "colony://app/index.html",
    mediaTypes: ["audio"],
    mediaType: "audio",
  };
  return {
    owner,
    details,
    request: (wc, p, d) => {
      let allowed;
      request(wc, p, (value) => (allowed = value), d);
      return allowed;
    },
    check: (wc, p, d) => check(wc, p, "colony://app", d),
  };
}
test("trusted main renderer may request microphone access", () => {
  const f = fixture();
  assert.equal(f.request(f.owner, "media", f.details), true);
  assert.equal(f.check(f.owner, "media", f.details), true);
});
test("remote tabs, subframes, camera, display and unspecified media stay denied", () => {
  const f = fixture();
  for (const details of [
    { ...f.details, isMainFrame: false },
    { ...f.details, requestingUrl: "https://example.com" },
    { ...f.details, mediaTypes: ["video"], mediaType: "video" },
    { ...f.details, mediaTypes: ["audio", "video"], mediaType: "unknown" },
    { isMainFrame: true, requestingUrl: "colony://app/index.html" },
    {},
  ]) {
    assert.equal(f.request(f.owner, "media", details), false);
    assert.equal(f.check(f.owner, "media", details), false);
  }
  assert.equal(f.request({}, "media", f.details), false);
  assert.equal(f.check(null, "media", f.details), false);
  for (const permission of [
    "display-capture",
    "notifications",
    "geolocation",
  ]) {
    assert.equal(f.request(f.owner, permission, f.details), false);
    assert.equal(f.check(f.owner, permission, f.details), false);
  }
});

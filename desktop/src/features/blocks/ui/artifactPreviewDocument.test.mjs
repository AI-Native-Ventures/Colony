import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { artifactPreviewDocument, readArtifactHtml } from "./artifactPreviewDocument.ts";

test("static previews retain layout but remove executable and navigating content", () => {
  const dom = new JSDOM("");
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const html = artifactPreviewDocument(`<style>h1{color:blue}</style><h1 onclick="steal()">Version 1</h1><script>steal()</script><iframe src="https://example.com"></iframe><meta http-equiv="refresh" content="0;url=https://example.com"><base href="https://example.com"><a href="https://example.com">Link</a><form action="https://example.com"><input></form><img src="https://example.com/pixel">`);
    const parsed = new dom.window.DOMParser().parseFromString(html, "text/html");
    assert.equal(parsed.querySelector("h1").textContent, "Version 1");
    assert.equal(parsed.querySelector("style").textContent, "h1{color:blue}");
    assert.equal(parsed.querySelectorAll("script, iframe, base, form, input, [onclick], [src], [href]").length, 0);
    assert.equal(parsed.head.firstElementChild.httpEquiv, "Content-Security-Policy");
    assert.match(parsed.head.firstElementChild.content, /default-src 'none'/);
    assert.equal(parsed.querySelector('meta[http-equiv="refresh"]'), null);
    assert.throws(() => artifactPreviewDocument(" "), /empty/);
    assert.throws(() => artifactPreviewDocument("x".repeat(20_001)), /exceeds/);
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
});

test("older artifact payloads do not opt into HTML previews", () => {
  assert.equal(readArtifactHtml({ url: "https://example.com/file.html" }), null);
  assert.equal(readArtifactHtml(null), null);
  assert.equal(readArtifactHtml({ preview_html: 12 }), null);
  assert.equal(readArtifactHtml({ preview_html: "<h1>Revision 2</h1>" }), "<h1>Revision 2</h1>");
});

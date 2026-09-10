import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { collectInlineAuthorizations } from "./inline-script.mjs";
import { previewCsp } from "./scheme.mjs";

function tokenFor(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return `'sha256-${createHash("sha256").update(bytes).digest("base64")}'`;
}

test("hashes exact inline script bytes and skips external scripts", () => {
  const html =
    '<script>alpha</script><script src="/bundle.js"></script><script>beta</script>';
  const result = collectInlineAuthorizations(Buffer.from(html, "utf8"));
  assert.deepEqual(result.scriptHashes, [tokenFor("alpha"), tokenFor("beta")]);
  assert.deepEqual(result.handlerHashes, []);
  assert.equal(result.truncated, false);
});

test("hashes inline event handler values after entity decoding", () => {
  const html =
    "<button onclick=\"go(&quot;a&quot;)\">x</button><a onmouseover='tick()'>y</a>";
  const result = collectInlineAuthorizations(Buffer.from(html, "utf8"));
  assert.deepEqual(result.handlerHashes, [
    tokenFor('go("a")'),
    tokenFor("tick()"),
  ]);
});

test("hashes byte-exact content even when it is not valid UTF-8", () => {
  const body = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
  const bytes = Buffer.concat([
    Buffer.from("<script>", "utf8"),
    body,
    Buffer.from("</SCRIPT>", "utf8"),
  ]);
  const result = collectInlineAuthorizations(bytes);
  assert.deepEqual(result.scriptHashes, [tokenFor(body)]);
});

test("hashes CRLF and UTF-8 handler text as the served bytes", () => {
  const html =
    "<script>line1\r\nline2</script>" +
    '<button onclick="caf\u00e9()">x</button>';
  const result = collectInlineAuthorizations(Buffer.from(html, "utf8"));
  assert.deepEqual(result.scriptHashes, [tokenFor("line1\r\nline2")]);
  assert.deepEqual(result.handlerHashes, [tokenFor("caf\u00e9()")]);
});

test("decodes character entities and clamps invalid numerics", () => {
  const html =
    '<button onclick="a(&#233;)">x</button>' +
    '<button onclick="b(&#x110000;)">y</button>' +
    '<button onclick="c(&#xD800;)">z</button>' +
    '<button onclick="d(&amp;)">w</button>';
  const result = collectInlineAuthorizations(Buffer.from(html, "utf8"));
  assert.deepEqual(result.handlerHashes, [
    tokenFor("a(\u00e9)"),
    tokenFor("b(\uFFFD)"),
    tokenFor("c(\uFFFD)"),
    tokenFor("d(&)"),
  ]);
  assert.equal(result.truncated, false);
});

test("an undecodable handler stays unauthorized and counts as truncation", () => {
  const html = '<button onclick="x(&#65;)">x</button>';
  const original = String.fromCodePoint;
  String.fromCodePoint = () => {
    throw new RangeError("decode failed");
  };
  try {
    const result = collectInlineAuthorizations(Buffer.from(html, "utf8"));
    assert.deepEqual(result.handlerHashes, []);
    assert.equal(result.truncated, true);
  } finally {
    String.fromCodePoint = original;
  }
});

test("caps authorizations and reports truncation", () => {
  const html = "<script>a</script><script>b</script><script>c</script>";
  const result = collectInlineAuthorizations(Buffer.from(html, "utf8"), 2);
  assert.equal(result.scriptHashes.length, 2);
  assert.equal(result.truncated, true);
});

test("previewCsp appends only hash tokens and unsafe-hashes", () => {
  const csp = previewCsp({
    scriptHashes: [tokenFor("a")],
    handlerHashes: [tokenFor("b")],
  });
  const scriptDirective = csp
    .split("; ")
    .find((directive) => directive.startsWith("script-src"));
  assert.ok(scriptDirective.includes(tokenFor("a")));
  assert.ok(scriptDirective.includes("'unsafe-hashes'"));
  assert.ok(scriptDirective.includes(tokenFor("b")));
  assert.ok(!scriptDirective.includes("'unsafe-inline'"));
  assert.equal(scriptDirective.includes("default-src"), false);
});

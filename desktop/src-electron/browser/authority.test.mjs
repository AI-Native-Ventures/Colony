import test from "node:test";
import assert from "node:assert/strict";
import { Authority, normalizeUrl } from "./authority.mjs";

function setup() {
  const authority = new Authority();
  authority.add({
    id: "one",
    workspace: "colony",
    url: "https://example.com/a",
  });
  authority.add({
    id: "two",
    workspace: "horizon",
    url: "https://example.com/a",
  });
  return authority;
}

test("a grant can access only its explicit tab and business", () => {
  const a = setup();
  const g = a.grant("one", "writer", "interact");
  assert.equal(a.check(g.token, "one").workspace, "colony");
  assert.throws(() => a.check(g.token, "two"), /scope/);
  assert.throws(() => a.check("invented", "one"), /revoked/);
});

test("only one controller holds a tab; independent tabs are concurrent", () => {
  const a = setup();
  a.grant("one", "writer", "interact");
  assert.throws(() => a.grant("one", "designer", "interact"), /already/);
  assert.equal(a.grant("two", "designer", "read").tabId, "two");
});

test("human takeover invalidates retained grant objects and allows a new owner", () => {
  const a = setup();
  const old = a.grant("one", "writer", "interact");
  a.revoke("one");
  assert.throws(() => a.check(old.token, "one"), /revoked/);
  const fresh = a.grant("one", "writer", "read");
  assert.notEqual(fresh.token, old.token);
  assert.throws(
    () => a.check(fresh.token, "one", { write: true }),
    /read-only/,
  );
});

test("navigation expires observations and origin changes revoke authority", () => {
  const a = setup();
  const grant = a.grant("one", "writer", "interact");
  const revision = a.check(grant.token, "one").revision;
  a.navigate("one", "https://example.com/b");
  assert.throws(() => a.check(grant.token, "one", { revision }), /stale/);
  assert.doesNotThrow(() => a.check(grant.token, "one"));
  a.navigate("one", "https://other.example/");
  assert.throws(() => a.check(grant.token, "one"), /revoked/);
});

test("closed tabs and malformed capabilities fail closed", () => {
  const a = setup();
  const grant = a.grant("one", "writer", "read");
  a.remove("one");
  assert.throws(() => a.check(grant.token, "one"), /revoked/);
  assert.throws(() => a.grant("two", "", "read"), /worker/);
  assert.throws(() => a.grant("two", "writer", "admin"), /mode/);
});

test("only HTTP(S) URLs without embedded credentials are accepted", () => {
  assert.equal(normalizeUrl("https://example.com"), "https://example.com/");
  for (const bad of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hi",
    "https://user:secret@example.com",
    "bad",
  ]) {
    assert.throws(() => normalizeUrl(bad));
  }
});

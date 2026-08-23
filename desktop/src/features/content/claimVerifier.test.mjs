import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { KIND_STREAM_MESSAGE } from "@/shared/constants/kinds";

import {
  evaluateClaimGate,
  hashSourceText,
  isolateSourceText,
  verifyClaim,
} from "./claimVerifier.ts";

const PAGE_HTML = `<html><body>
  <h1>Colony</h1>
  <p id="proof">Fully insured since 2019</p>
</body></html>`;

const PROOF_TEXT = "Fully insured since 2019";

const OWNER_PUBKEY = "f".repeat(64);
const IMPOSTOR_PUBKEY = "b".repeat(64);

function relayEvent(id) {
  return {
    content: "the owner said so",
    created_at: 1_700_000_000,
    id,
    kind: KIND_STREAM_MESSAGE,
    pubkey: OWNER_PUBKEY,
    sig: "0".repeat(128),
    tags: [],
  };
}

function claim(overrides = {}) {
  return {
    asserts: "Fully insured",
    id: "c1",
    kind: "verbatim",
    source: {
      type: "page",
      url: "https://example.com/insurance",
      selector: "#proof",
    },
    sourceHash: hashSourceText(PROOF_TEXT),
    verifiedAt: null,
    verifiedBy: null,
    ...overrides,
  };
}

// jsdom's DOMParser comes from another realm; adapt it to the one-method
// shape the verifier expects rather than passing the class across.
function makeParser() {
  const dom = new JSDOM();
  return {
    parseFromString: (html, type) =>
      new dom.window.DOMParser().parseFromString(html, type),
  };
}

function deps(overrides = {}) {
  return {
    fetchEventById: async (eventId) => relayEvent(eventId),
    fetchPageHtml: async () => PAGE_HTML,
    isOwnerPubkey: (pubkey) => pubkey === OWNER_PUBKEY,
    now: () => 1_755_000_000_000,
    parser: makeParser(),
    ...overrides,
  };
}

function isolate(html, selector) {
  return isolateSourceText(html, selector, makeParser());
}

test("a page source whose text still hashes to source_hash is verified", async () => {
  const verdict = await verifyClaim(claim(), deps());
  assert.equal(verdict.state, "verified");
  if (verdict.state === "verified") {
    assert.equal(verdict.checkedAt, 1_755_000_000_000);
    assert.equal(verdict.sourceHash, hashSourceText(PROOF_TEXT));
  }
});

test("a page source that changed after verification is stale, not failed", async () => {
  const verdict = await verifyClaim(
    claim(),
    deps({ fetchPageHtml: async () => PAGE_HTML.replace("2019", "2020") }),
  );
  assert.equal(verdict.state, "stale");
  if (verdict.state === "stale") {
    assert.match(verdict.reason, /changed after this claim was verified/);
  }
});

test("an unreachable page leaves the claim unverified with the reason", async () => {
  const verdict = await verifyClaim(
    claim(),
    deps({
      fetchPageHtml: async () => {
        throw new Error("DNS failure");
      },
    }),
  );
  assert.equal(verdict.state, "unverified");
  if (verdict.state === "unverified") {
    assert.match(verdict.reason, /DNS failure/);
  }
});

test("a page reachable for the first time is unverified, not verified", async () => {
  const verdict = await verifyClaim(claim({ sourceHash: null }), deps());
  assert.equal(verdict.state, "unverified");
});

test("a selector that no longer matches reads as stale", () => {
  assert.throws(() => isolate(PAGE_HTML, "#gone"), /matched nothing/);
});

test("a selector isolates its element's text and whitespace normalizes", () => {
  const html = `<div>  Fully\n insured \t since  2019 </div>`;
  assert.equal(
    hashSourceText(isolate(html, "div")),
    hashSourceText(PROOF_TEXT),
  );
});

test("no selector falls back to the page body text", () => {
  const sourceHash = hashSourceText(`${PROOF_TEXT} Colony`);
  const verdict = hashSourceText(isolate(PAGE_HTML, null));
  assert.notEqual(verdict, sourceHash);
  assert.match(isolate(PAGE_HTML, null), /Fully insured since 2019/);
});

test("an owner source verifies by signature against the named event", async () => {
  const verdict = await verifyClaim(
    claim({ source: { event: "a".repeat(64), saidAt: null, type: "owner" } }),
    deps(),
  );
  assert.equal(verdict.state, "owner-signed");
  if (verdict.state === "owner-signed") {
    assert.equal(verdict.event, "a".repeat(64));
  }
});

test("an owner claim citing an event signed by a NON-owner is not owner-signed", async () => {
  const verdict = await verifyClaim(
    claim({ source: { event: "a".repeat(64), saidAt: null, type: "owner" } }),
    deps({
      fetchEventById: async (eventId) => ({
        ...relayEvent(eventId),
        pubkey: IMPOSTOR_PUBKEY,
      }),
    }),
  );
  assert.notEqual(verdict.state, "owner-signed");
});

test("a forged attribution reads differently from a missing source", async () => {
  const forged = await verifyClaim(
    claim({ source: { event: "a".repeat(64), saidAt: null, type: "owner" } }),
    deps({
      fetchEventById: async (eventId) => ({
        ...relayEvent(eventId),
        pubkey: IMPOSTOR_PUBKEY,
      }),
    }),
  );
  const missing = await verifyClaim(
    claim({ source: { event: "c".repeat(64), saidAt: null, type: "owner" } }),
    deps({ fetchEventById: async () => null }),
  );
  assert.equal(forged.state, "unverified");
  assert.equal(missing.state, "unverified");
  if (forged.state === "unverified" && missing.state === "unverified") {
    assert.notEqual(forged.reason, missing.reason);
    assert.match(forged.reason, /not a workspace owner/);
  }
});

test("no known owner pubkeys trusts nothing: the owner claim stays unverified", async () => {
  const verdict = await verifyClaim(
    claim({ source: { event: "a".repeat(64), saidAt: null, type: "owner" } }),
    deps({ isOwnerPubkey: () => false }),
  );
  assert.equal(verdict.state, "unverified");
});

test("an owner source whose event cannot be read is unverified", async () => {
  const verdict = await verifyClaim(
    claim({ source: { event: "a".repeat(64), saidAt: null, type: "owner" } }),
    deps({ fetchEventById: async () => null }),
  );
  assert.equal(verdict.state, "unverified");
});

test("a repo source is manual at launch, recorded but never fetched", async () => {
  let fetched = false;
  const verdict = await verifyClaim(
    claim({
      source: {
        line: 1,
        path: "LICENSE",
        repo: "github.com/x/y",
        rev: null,
        type: "repo",
      },
    }),
    deps({
      fetchPageHtml: async () => {
        fetched = true;
        return PAGE_HTML;
      },
    }),
  );
  assert.equal(verdict.state, "manual");
  assert.equal(fetched, false);
});

test("a derived claim never auto-passes, whatever the source shows", async () => {
  let fetched = false;
  const verdict = await verifyClaim(
    claim({ kind: "derived" }),
    deps({
      fetchPageHtml: async () => {
        fetched = true;
        return PAGE_HTML;
      },
    }),
  );
  assert.equal(verdict.state, "manual");
  assert.equal(fetched, false);
});

test("a claim with no source is unverified", async () => {
  const verdict = await verifyClaim(claim({ source: null }), deps());
  assert.equal(verdict.state, "unverified");
});

test("strict mode blocks the render when a claim is unverified", () => {
  const outcome = evaluateClaimGate(
    [claim()],
    { c1: { reason: "x", state: "unverified" } },
    "strict",
  );
  assert.equal(outcome.status, "fail");
  assert.deepEqual(outcome.blocked, ["c1"]);
});

test("strict mode blocks a stale claim too", () => {
  const outcome = evaluateClaimGate(
    [claim()],
    { c1: { reason: "x", state: "stale" } },
    "strict",
  );
  assert.equal(outcome.status, "fail");
});

test("verified, owner-signed and manual claims pass the strict gate", () => {
  const verdicts = {
    a: { checkedAt: 1, sourceHash: "h", state: "verified" },
    b: { event: "e", state: "owner-signed" },
    c: { reason: "r", state: "manual" },
  };
  const claims = ["a", "b", "c"].map((id) => claim({ id }));
  const outcome = evaluateClaimGate(claims, verdicts, "strict");
  assert.equal(outcome.status, "pass");
  assert.equal(outcome.blocked.length, 0);
});

test("advisory mode renders past a failing claim but carries the warning", () => {
  const outcome = evaluateClaimGate(
    [claim()],
    { c1: { reason: "x", state: "unverified" } },
    "advisory",
  );
  assert.equal(outcome.status, "pass");
  assert.equal(outcome.warnings.length, 1);
  assert.match(outcome.warnings[0], /Fully insured/);
});

test("a claim missing from the verdict map is treated as unchecked", () => {
  const outcome = evaluateClaimGate([claim()], {}, "strict");
  assert.equal(outcome.status, "fail");
  assert.match(outcome.warnings[0], /not been checked/);
});

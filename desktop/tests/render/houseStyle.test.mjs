// The pre-render text gates.
//
// These decide whether a card is allowed to cost a render at all, so the tests
// care most about two things: that a rule cannot be dodged by moving the text
// into another field, and that a gate fails closed rather than passing on a
// technicality.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(
  new URL("../../src/features/content/render/houseStyle.ts", import.meta.url),
);
const {
  allText,
  bannedWordsGate,
  canvasGate,
  emDashGate,
  mayRender,
  preRenderTextGates,
} = await import(
  `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(readFileSync(SRC, "utf8")))}`
);

const KIT = {
  bannedWords: ["synergy", "leverage", "AI-powered"],
  canvases: [
    { h: 1350, name: "post", w: 1080 },
    { h: 1920, name: "story", w: 1080 },
  ],
};

const card = (over = {}) => ({
  alt: "A violet card reading: run your company with AI agents.",
  caption: "Colony is a workspace where agents and people build a company.",
  extra: ["Launching soon"],
  headline: "Run your company with AI agents.",
  ...over,
});

test("allText covers every field a card publishes", () => {
  const t = allText(card());
  assert.equal(t.length, 4, "headline, extra, caption and alt all count");
});

// --- em-dash ----------------------------------------------------------------

test("a clean card passes the em-dash gate", () => {
  assert.equal(emDashGate(card()).status, "pass");
});

test("an em-dash in the headline fails", () => {
  const g = emDashGate(
    card({ headline: "Run your company — with AI agents." }),
  );
  assert.equal(g.status, "fail");
  assert.equal(g.measured, 1);
  assert.match(g.detail, /plain dash/);
});

test("an em-dash cannot hide in the caption", () => {
  // The rule is about everything the product emits, and a caption is read by
  // the same person as the card. Checking only the headline would let the most
  // commonly written field through.
  const g = emDashGate(card({ caption: "One price — everything included." }));
  assert.equal(g.status, "fail");
});

test("an em-dash cannot hide in alt text either", () => {
  const g = emDashGate(card({ alt: "A card — violet." }));
  assert.equal(g.status, "fail");
});

test("a plain hyphen is not an em-dash", () => {
  const g = emDashGate(card({ headline: "Agent-first, human-approved." }));
  assert.equal(g.status, "pass");
});

// --- canvas -----------------------------------------------------------------

test("a canvas the kit lists passes and is named", () => {
  const g = canvasGate(1080, 1350, KIT);
  assert.equal(g.status, "pass");
  assert.match(g.detail, /"post"/);
});

test("a canvas the kit does not list fails, and the allowed set is reported", () => {
  const g = canvasGate(1200, 1200, KIT);
  assert.equal(g.status, "fail");
  assert.match(g.detail, /post 1080x1350/);
  assert.match(g.detail, /story 1080x1920/);
});

test("a transposed canvas is not the same canvas", () => {
  // 1350x1080 is landscape and would be cropped by every target the kit lists.
  assert.equal(canvasGate(1350, 1080, KIT).status, "fail");
});

test("a kit with no canvases refuses everything rather than allowing everything", () => {
  const g = canvasGate(1080, 1350, { canvases: [] });
  assert.equal(g.status, "fail", "an unconfigured kit must fail closed");
  assert.match(g.detail, /none configured/);
});

// --- banned words -----------------------------------------------------------

test("a banned word is caught whatever its case", () => {
  const g = bannedWordsGate(
    card({ headline: "Real Synergy, delivered." }),
    KIT,
  );
  assert.equal(g.status, "fail");
  assert.deepEqual(g.measured, ["synergy"]);
});

test("banned words match whole words, not substrings", () => {
  // "leverage" is banned; "leveraged" and "cleverage" must not fire, or the
  // gate becomes a nuisance the author learns to work around.
  const g = bannedWordsGate(card({ headline: "We leveraged nothing." }), KIT);
  assert.equal(g.status, "pass");
});

test("a hyphenated banned phrase is caught by its parts", () => {
  const g = bannedWordsGate(
    card({ headline: "An AI-powered workspace." }),
    KIT,
  );
  assert.equal(g.status, "fail");
});

test("a banned word cannot hide in the caption", () => {
  const g = bannedWordsGate(
    card({ caption: "Pure synergy for your team." }),
    KIT,
  );
  assert.equal(g.status, "fail");
});

test("a kit with no banned words passes and says so", () => {
  const g = bannedWordsGate(card(), { canvases: KIT.canvases });
  assert.equal(g.status, "pass");
  assert.match(g.detail, /no banned words/);
});

test("kit words are matched literally, never compiled as a pattern", () => {
  // Kit content is customer data. Compiling it as a regex would hand a brand
  // file control over this process, so a word full of metacharacters must
  // simply not match rather than throw or match everything.
  const g = bannedWordsGate(card(), {
    bannedWords: [".*", "(", "[a-z]+"],
    canvases: KIT.canvases,
  });
  assert.equal(g.status, "pass");
});

// --- the gate set -----------------------------------------------------------

test("a clean card clears every pre-render gate", () => {
  const entries = preRenderTextGates(card(), 1080, 1350, KIT);
  assert.equal(entries.length, 3);
  assert.equal(mayRender(entries).ok, true);
});

test("any single failure stops the render", () => {
  const entries = preRenderTextGates(
    card({ headline: "Synergy — at last." }),
    1200,
    1200,
    KIT,
  );
  const verdict = mayRender(entries);
  assert.equal(verdict.ok, false);
  assert.equal(
    verdict.blocking.length,
    3,
    "all three should fail on this card",
  );
});

test("the expensive step never happens on a failing card", () => {
  // This is the whole point of the pre-render split: the gate answers before
  // any pixels exist, so a bad card costs nothing.
  const entries = preRenderTextGates(
    card({ headline: "A — B" }),
    1080,
    1350,
    KIT,
  );
  assert.equal(mayRender(entries).ok, false);
  assert.equal(
    mayRender(entries).blocking[0].id,
    "em-dash",
    "and the report names which rule stopped it",
  );
});

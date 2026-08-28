// The post an agent is told to write, read by the app that has to draw it.
//
// `company_roster.rs` tells the Content & Campaign Specialist what a post
// looks like: the words, the claims, and a style block naming a family, hues
// and a template. buzz-core has the matching test proving the relay accepts
// that shape. This is the other end — the shape has to survive the desktop
// parse and come out as a card the renderer can actually build.
//
// The two failures this catches are both silent. A style block the parse drops
// leaves a post that renders a default card rather than the one that was
// authored, and a template the kit advertises but LAYOUTS does not implement
// throws only at render time, after every text gate has passed.

import assert from "node:assert/strict";
import test from "node:test";

import { parsePost } from "./contracts.ts";
import { cardSpecs, cardText, houseRules } from "./renderPost.ts";
import { LAYOUTS } from "./render/compositions.ts";
import { COLONY_KIT } from "./render/colonyKit.ts";

const BODY = {
  alt: "A violet card reading: Run a company without the headcount.",
  caption: "Most tools give you a faster way to do your own work.",
  channel: "linkedin",
  claim_fields: { headline: ["clm_hero"] },
  claims: [
    {
      asserts: "Run a company without the headcount",
      id: "clm_hero",
      kind: "verbatim",
      source: {
        selector: "h1",
        type: "page",
        url: "https://colony.ainative.ventures/",
      },
    },
  ],
  hashtags: ["agents"],
  headline: "Run a company without the headcount",
  job: "who",
  schema: "colony/content-post/v1",
  scheduled_for: "2026-09-07",
  status: "draft",
  style: { family: "night", hues: ["violet", "pink"], layout: "statement" },
  week: 1,
};

const event = (body) => ({
  content: JSON.stringify(body),
  created_at: 1_800_000_000,
  id: "e1",
  kind: 30196,
  pubkey: "a".repeat(64),
  sig: "",
  tags: [["d", "colony-launch:w1-mon"]],
});

test("the style block the agent writes survives the parse", () => {
  const post = parsePost(event(BODY));
  assert.deepEqual(post.style, {
    family: "night",
    hues: ["violet", "pink"],
    layout: "statement",
    raw: BODY.style,
    variant: null,
  });
});

test("that post yields exactly one card the renderer can build", () => {
  const post = parsePost(event(BODY));
  const specs = cardSpecs(post, post.style);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].headline, "Run a company without the headcount");
  assert.ok(LAYOUTS[specs[0].layout], `no layout named ${specs[0].layout}`);
});

test("every template the Colony kit advertises is one the renderer implements", () => {
  // The kit is what the agent is told to read before choosing a template, so
  // a name in here that LAYOUTS does not have is a card the agent cannot know
  // is impossible until it has already been authored.
  for (const template of COLONY_KIT.templates) {
    assert.ok(
      LAYOUTS[template],
      `the kit advertises ${template}, which the renderer cannot build`,
    );
  }
});

test("a carousel is the same post with slides, one card each", () => {
  const post = parsePost(
    event({
      ...BODY,
      style: {
        ...BODY.style,
        slides: [{ headline: "One" }, { headline: "Two", layout: "poster" }],
      },
    }),
  );
  const specs = cardSpecs(post, post.style);
  assert.deepEqual(
    specs.map((spec) => [spec.slug, spec.layout, spec.headline]),
    [
      ["w1-mon-1", "statement", "One"],
      ["w1-mon-2", "poster", "Two"],
    ],
  );
});

test("the caption and alt reach the text gates, not just the drawn headline", () => {
  // A banned word in the caption is still published, so a gate that only read
  // the headline would let it through.
  const post = parsePost(event(BODY));
  const text = cardText(post, cardSpecs(post, post.style));
  assert.equal(text.caption, BODY.caption);
  assert.equal(text.alt, BODY.alt);
});

test("an undrawn post carries neither images nor reports", () => {
  const post = parsePost(event(BODY));
  assert.deepEqual(post.images, []);
  assert.deepEqual(post.gateReports, []);
  assert.equal(post.status, "draft");
});

test("the canvas gate measures against the kit's own canvas", () => {
  const rules = houseRules(COLONY_KIT, null);
  assert.deepEqual(rules.canvases, [
    { h: 1350, name: "instagram-portrait-4-5", w: 1080 },
  ]);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  KIND_CONTENT_DECISION,
  KIND_CONTENT_POST,
} from "@/shared/constants/kinds";

import { buildDecisionEvent, postVerdict } from "./contentDecisions.ts";
import {
  parseCampaign,
  parseDecision,
  parsePost,
  parseStyle,
} from "./contracts.ts";

const IMAGE_HASH = "a".repeat(64);
const AUTHOR = "c".repeat(64);

function event(kind, tags, content) {
  return {
    content: JSON.stringify(content),
    created_at: 1_755_000_000,
    id: "e".repeat(64),
    kind,
    pubkey: AUTHOR,
    sig: "0".repeat(128),
    tags,
  };
}

function postBody(overrides = {}) {
  return {
    alt: "A violet card.",
    caption: "Most AI tools give you a faster way to do your own work.",
    claim_fields: { headline: ["clm_hero_h1"] },
    claims: [
      {
        asserts: "Run your company with AI agents.",
        id: "clm_hero_h1",
        kind: "verbatim",
        source: {
          line: 42,
          path: "site/src/sections/Hero.tsx",
          repo: "github.com/AI-Native-Ventures/Colony",
          type: "repo",
        },
      },
    ],
    gate_report: {
      gates: [
        {
          bar: { op: "gte", unit: "ratio", value: 4.5 },
          id: "contrast",
          measured: 8.18,
          status: "pass",
        },
        { id: "grain", measured: 1.89, status: "pass" },
        { id: "fonts", measured: 0, status: "pass" },
        { id: "canvas", measured: [1080, 1350], status: "pass" },
        { id: "housestyle", measured: 0, status: "pass" },
        {
          detail: { reason: "no claim index in this render" },
          id: "claims",
          status: "skip",
        },
      ],
      image_hash: `sha256:${IMAGE_HASH}`,
      rendered_at: "2026-08-16T15:40:12Z",
      renderer: { engine: "chromium", version: "129" },
      style_version: "colony-launch/3",
    },
    hashtags: ["#AI", "agents"],
    headline: "Run your company with AI agents.",
    image: {
      height: 1350,
      sha256: IMAGE_HASH,
      url: "https://x/y.png",
      width: 1080,
    },
    job: "who",
    schema: "colony/content-post/v1",
    scheduled_for: "2026-08-17",
    status: "ready",
    style: { family: "dawn", hues: ["violet", "pink"] },
    style_version: "colony-launch/3",
    week: 1,
    ...overrides,
  };
}

function parsedPost(overrides) {
  return parsePost(
    event(
      KIND_CONTENT_POST,
      [["d", "colony-launch:w1-mon-colony"]],
      postBody(overrides),
    ),
  );
}

test("parsePost_readsTheRealReportShape", () => {
  const post = parsedPost();
  assert.equal(post.campaign, "colony-launch");
  assert.equal(post.slug, "w1-mon-colony");
  assert.equal(post.job, "who");
  assert.deepEqual(post.hashtags, ["AI", "agents"]);
  assert.equal(post.gateReport.gates.length, 6);
  assert.equal(post.gateReport.gates[0].measured, 8.18);
});

test("parsePost_normalisesThePrefixedImageHash", () => {
  // The kit writes `sha256:…`; a Blossom descriptor writes it bare. If these
  // two spellings did not converge, the report-to-image comparison that voids
  // a stale report would fail on every card.
  const post = parsedPost();
  assert.equal(post.gateReport.imageHash, IMAGE_HASH);
  assert.equal(post.image.sha256, IMAGE_HASH);
});

test("parsePost_derivesIncompleteFromASkippedGate", () => {
  assert.equal(parsedPost().gateReport.verdict, "incomplete");
});

test("parsePost_ignoresAVerdictTheGatesContradict", () => {
  // A relay-side check already refuses this, so a record carrying it is either
  // from an older relay or from somewhere unexpected. Either way the summary
  // is not what the UI shows.
  const post = parsedPost({
    gate_report: { ...postBody().gate_report, verdict: "pass" },
  });
  assert.equal(post.gateReport.verdict, "incomplete");
});

test("parsePost_returnsNullOnAnAddressWithNoCampaign", () => {
  const orphan = event(KIND_CONTENT_POST, [["d", "w1-mon-colony"]], postBody());
  assert.equal(parsePost(orphan), null);
});

test("parsePost_returnsNullOnUnparseableContent", () => {
  const broken = {
    content: "not json",
    created_at: 1,
    id: "e".repeat(64),
    kind: KIND_CONTENT_POST,
    pubkey: AUTHOR,
    sig: "0".repeat(128),
    tags: [["d", "a:b"]],
  };
  assert.equal(parsePost(broken), null);
});

test("parsePost_dropsAClaimWithAnUnknownSourceType", () => {
  const post = parsedPost({
    claim_fields: {},
    claims: [
      {
        asserts: "x",
        id: "clm_x",
        kind: "verbatim",
        source: { type: "vibes" },
      },
    ],
  });
  assert.equal(post.claims[0].source, null);
});

test("parsePost_readsAllThreeClaimSourceArms", () => {
  const post = parsedPost({
    claim_fields: {},
    claims: [
      {
        asserts: "a",
        id: "clm_page",
        kind: "trim",
        source: { selector: "h1", type: "page", url: "https://x" },
      },
      {
        asserts: "b",
        id: "clm_repo",
        kind: "derived",
        source: { path: "LICENSE", type: "repo" },
      },
      {
        asserts: "c",
        id: "clm_owner",
        kind: "derived",
        source: { event: "d".repeat(64), said_at: 1, type: "owner" },
      },
    ],
  });
  assert.deepEqual(
    post.claims.map((claim) => claim.source.type),
    ["page", "repo", "owner"],
  );
});

test("parseCampaign_ordersWeeksByIndex", () => {
  const campaign = parseCampaign(
    event(30195, [["d", "colony-launch"]], {
      name: "Colony launch",
      schema: "colony/content-campaign/v1",
      weeks: [
        { index: 2, label: "Launch", starts_on: "2026-08-24" },
        { index: 1, label: "Countdown", starts_on: "2026-08-17" },
      ],
    }),
  );
  assert.deepEqual(
    campaign.weeks.map((week) => week.index),
    [1, 2],
  );
});

test("parseStyle_dropsARuleWithNoOrigin", () => {
  // A rule nobody can trace back is a rule nobody dares delete, so it is not
  // shown at all rather than shown without its reason.
  const style = parseStyle(
    event(30197, [["d", "house"]], {
      rules: [
        { active: true, id: "orphan", text: "From nowhere." },
        {
          id: "real",
          origin: { at: 1, quote: "no em dashes" },
          text: "No em dashes.",
        },
      ],
      schema: "colony/content-style/v1",
    }),
  );
  assert.deepEqual(
    style.rules.map((rule) => rule.id),
    ["real"],
  );
  assert.equal(style.rules[0].active, true);
});

test("parseDecision_readsAnApproval", () => {
  const decision = parseDecision(
    event(
      KIND_CONTENT_DECISION,
      [["a", `${KIND_CONTENT_POST}:${AUTHOR}:colony-launch:w1-mon-colony`]],
      {
        decision: "approve",
        schema: "colony/content-decision/v1",
        target: { image_sha256: `sha256:${IMAGE_HASH}`, verdict: "incomplete" },
      },
    ),
  );
  assert.equal(decision.decision, "approve");
  assert.equal(decision.verdict, "incomplete");
  assert.equal(decision.imageSha256, IMAGE_HASH);
});

test("postVerdict_withNoReport_isIncompleteNotPass", () => {
  // A post nothing has measured must never read as measured and clean.
  assert.equal(postVerdict(parsedPost({ gate_report: null })), "incomplete");
});

test("buildDecisionEvent_approvalNamesTheBytesAndTheVerdict", () => {
  const draft = buildDecisionEvent({ decision: "approve", post: parsedPost() });
  assert.equal(draft.ok, true);
  const content = JSON.parse(draft.event.content);
  assert.equal(content.target.image_sha256, IMAGE_HASH);
  assert.equal(content.target.verdict, "incomplete");
  assert.equal(draft.event.tags[0][0], "a");
  assert.match(draft.event.tags[0][1], /^30196:/);
});

test("buildDecisionEvent_refusesToApproveAFailingCard", () => {
  const failing = parsedPost({
    gate_report: {
      ...postBody().gate_report,
      gates: [{ id: "contrast", measured: 2.7, status: "fail" }],
    },
  });
  const draft = buildDecisionEvent({ decision: "approve", post: failing });
  assert.equal(draft.ok, false);
  assert.match(draft.reason, /failed a check/i);
});

test("buildDecisionEvent_refusesToApproveAnUnrenderedCard", () => {
  const draft = buildDecisionEvent({
    decision: "approve",
    post: parsedPost({ gate_report: null, image: null, status: "draft" }),
  });
  assert.equal(draft.ok, false);
  assert.match(draft.reason, /not been rendered/i);
});

test("buildDecisionEvent_refusesAChangeWithNothingToAct_on", () => {
  const draft = buildDecisionEvent({ decision: "change", post: parsedPost() });
  assert.equal(draft.ok, false);
});

test("buildDecisionEvent_carriesTheCorrectionBin", () => {
  const draft = buildDecisionEvent({
    correction: { bin: "rule", text: "Never write 'opens Monday'." },
    decision: "change",
    note: "Nobody says opens Monday.",
    post: parsedPost(),
  });
  assert.equal(draft.ok, true);
  const content = JSON.parse(draft.event.content);
  assert.equal(content.correction.bin, "rule");
  assert.equal(content.note, "Nobody says opens Monday.");
});

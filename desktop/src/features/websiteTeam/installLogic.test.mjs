import assert from "node:assert/strict";
import test from "node:test";

import {
  assessInstall,
  describePublication,
  isInstallCommunityActive,
  looksLikeConfigurationError,
  normalizeRelay,
  personaInitials,
  starterPromptFor,
  summarizeAgentStarts,
} from "./installLogic.ts";

const SKILL_NAMES = [
  "website-team-workflow",
  "website-owner-review",
  "website-handover",
  "website-research",
  "website-direction-build",
  "website-independent-review",
];

function persona(index, overrides = {}) {
  const names = ["Avery", "Ren", "Jules", "Vera"];
  const roles = [
    "Website Manager",
    "Website Researcher",
    "Website Designer-builder",
    "Website Reviewer",
  ];
  return {
    personaId: `website-manager-${names[index].toLowerCase()}`,
    slug: names[index].toLowerCase(),
    displayName: names[index],
    roleId: `role-${index}`,
    roleTitle: roles[index],
    tier: index === 0 ? "leader" : "worker",
    colorIndex: index,
    agentPubkey: String(index + 1).repeat(64),
    agentName: names[index],
    managerPubkey: index === 0 ? null : "1".repeat(64),
    created: true,
    assignedSkills: [],
    ...overrides,
  };
}

function installResult(overrides = {}) {
  const personas = [0, 1, 2, 3].map((index) => persona(index));
  return {
    recipeId: "website-manager",
    recipeVersion: "0.1.0",
    relayUrl: "wss://one.example",
    communityKey: "wss://one.example",
    ownerPubkey: "a".repeat(64),
    teamId: "website-team:aaaaaaaa:website-manager",
    teamName: "Website Manager",
    teamExisted: false,
    channelId: "channel-1",
    seedUrl: null,
    starterPrompt: null,
    personas,
    skills: SKILL_NAMES.map((name) => ({
      name,
      path: `/tmp/${name}/SKILL.md`,
      status: "installed",
      detail: null,
    })),
    publication: {
      team: "published",
      personas: personas.map((entry) => ({
        id: entry.personaId,
        status: "published",
      })),
      agents: personas.map((entry) => ({
        id: entry.agentPubkey,
        status: "published",
      })),
      detail: null,
    },
    createdAgents: 4,
    reconciled: false,
    notes: [],
    ...overrides,
  };
}

test("normalizeRelay treats equivalent spellings as one community", () => {
  assert.equal(normalizeRelay(" WSS://One.Example/ "), "wss://one.example");
  assert.equal(normalizeRelay("wss://one.example"), "wss://one.example");
  assert.notEqual(normalizeRelay("wss://one.example"), "wss://two.example");
});

test("isInstallCommunityActive guards a community switch", () => {
  const result = installResult();
  assert.equal(isInstallCommunityActive("wss://one.example/", result), true);
  assert.equal(isInstallCommunityActive("wss://two.example", result), false);
});

test("a fully published install assesses as complete", () => {
  const assessment = assessInstall(installResult());
  assert.equal(assessment.state, "complete");
  assert.equal(assessment.personas.length, 4);
  assert.equal(assessment.personas[0].status, "installed");
  assert.equal(assessment.pendingPublications, 0);
  assert.match(assessment.headline, /installed/);
});

test("queued publication is pending, never success", () => {
  const result = installResult();
  result.publication.agents[0].status = "queued";
  const assessment = assessInstall(result);
  assert.equal(assessment.state, "pending_publish");
  assert.equal(assessment.pendingPublications, 1);
  assert.match(assessment.headline, /catching up/);
});

test("a missing agent record is incomplete", () => {
  const result = installResult();
  result.personas[2] = persona(2, { agentPubkey: "", created: false });
  result.publication.agents[2].id = "";
  const assessment = assessInstall(result);
  assert.equal(assessment.state, "incomplete");
  assert.equal(assessment.personas[2].status, "missing");
  assert.match(assessment.detail ?? "", /missing/);
});

test("a failed skill write is incomplete even when everything is published", () => {
  const result = installResult();
  result.skills[3] = {
    name: "website-research",
    path: "",
    status: "failed",
    detail: "workspace unavailable",
  };
  const assessment = assessInstall(result);
  assert.equal(assessment.state, "incomplete");
  assert.equal(assessment.failedSkills.length, 1);
  assert.match(assessment.detail ?? "", /skill/);
});

test("a preserved user-edited skill is not a failure", () => {
  const result = installResult();
  result.skills[0] = {
    name: "website-team-workflow",
    path: "/tmp/website-team-workflow/SKILL.md",
    status: "preserved",
    detail: "Kept your edited copy.",
  };
  const assessment = assessInstall(result);
  assert.equal(assessment.state, "complete");
  assert.equal(assessment.preservedSkills.length, 1);
  assert.equal(assessment.failedSkills.length, 0);
});

test("a re-run reports the existing install instead of a new one", () => {
  const assessment = assessInstall(installResult({ reconciled: true }));
  assert.equal(assessment.state, "complete");
  assert.match(assessment.headline, /already installed/);
});

test("describePublication names every real state", () => {
  assert.match(describePublication("published"), /Published/);
  assert.match(describePublication("queued"), /Queued/);
  assert.match(describePublication("missing"), /Not queued/);
});

test("configuration-shaped start errors are recognized", () => {
  assert.equal(
    looksLikeConfigurationError("Agent readiness: no provider configured"),
    true,
  );
  assert.equal(
    looksLikeConfigurationError("Colony Credits model is not selected"),
    true,
  );
  assert.equal(looksLikeConfigurationError("relay refused the request"), false);
});

test("summarizeAgentStarts separates running from needs-configuration", () => {
  const summary = summarizeAgentStarts([
    {
      personaId: "a",
      displayName: "Avery",
      pubkey: "1",
      started: true,
      error: null,
      needsConfiguration: false,
    },
    {
      personaId: "b",
      displayName: "Ren",
      pubkey: "2",
      started: false,
      error: "not ready: choose how to power your agents",
      needsConfiguration: true,
    },
  ]);
  assert.equal(summary.started, 1);
  assert.equal(summary.needsConfiguration, 1);
  assert.equal(summary.failed.length, 1);
});

test("starterPromptFor falls back to the recipe example", () => {
  assert.equal(
    starterPromptFor(
      { starterPrompt: "  Redo the pricing page  " },
      { examplePrompt: "Improve my website" },
    ),
    "Redo the pricing page",
  );
  assert.equal(
    starterPromptFor(
      { starterPrompt: null },
      { examplePrompt: "Improve my website" },
    ),
    "Improve my website",
  );
});

test("personaInitials is bounded to two characters", () => {
  assert.equal(personaInitials("Avery"), "A");
  assert.equal(personaInitials("Website Manager"), "WM");
});

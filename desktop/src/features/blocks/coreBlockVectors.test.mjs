import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BLOCK_STARTER_COMPOSITE_HANDLES } from "./contracts.ts";
import { validateBlockManifest } from "./blockValidation.ts";
import { StarterBlockGallery } from "./ui/StarterBlockGallery.tsx";
import { supportsBlockPrimitiveType } from "./ui/primitives/BlockPrimitive.tsx";

const CORE_COMPOSITES = new URL(
  "../../../../crates/buzz-relay/src/core_blocks/composites/",
  import.meta.url,
);

async function readStarterManifest(handle) {
  const raw = JSON.parse(
    await readFile(new URL(`${handle}.json`, CORE_COMPOSITES), "utf8"),
  );
  const result = validateBlockManifest(raw);
  assert.equal(result.ok, true, `${handle} must be a valid bundled manifest`);
  assert.ok(result.ok);
  return result.value;
}

function walk(node, visit) {
  visit(node);
  if (node.type === "stack" || node.type === "grid" || node.type === "card") {
    for (const child of node.children ?? []) walk(child, visit);
  } else if (node.type === "card-list") {
    walk(node.card, visit);
  }
}

function nodeTypes(manifest) {
  const types = new Set();
  walk(manifest.tree, (node) => {
    assert.equal(
      supportsBlockPrimitiveType(node.type),
      true,
      `${manifest.handle} uses unsupported primitive ${node.type}`,
    );
    types.add(node.type);
  });
  return types;
}

function actionIds(manifest) {
  return new Set(manifest.actions.map((action) => action.id));
}

function assertContains(set, expected, label) {
  for (const value of expected) {
    assert.equal(set.has(value), true, `${label} is missing ${value}`);
  }
}

test("starter block vectors pin the seven bundled composite contracts", async () => {
  const manifests = new Map();
  for (const handle of BLOCK_STARTER_COMPOSITE_HANDLES) {
    manifests.set(handle, await readStarterManifest(handle));
  }
  assert.equal(manifests.size, 7);

  const lead = manifests.get("lead-card");
  assertContains(
    nodeTypes(lead),
    ["card", "details", "status", "actions"],
    "Lead Card",
  );
  assertContains(actionIds(lead), ["lead.view-evidence"], "Lead Card");

  const approval = manifests.get("approval");
  assertContains(
    nodeTypes(approval),
    ["card", "details", "status", "actions"],
    "Approval",
  );
  assertContains(
    actionIds(approval),
    ["approval.approve", "approval.deny"],
    "Approval",
  );
  assertContains(
    new Set(approval.input_schema.required),
    ["action", "destination", "content", "expires_at"],
    "Approval schema",
  );

  const proposal = manifests.get("agent-proposal");
  assert.deepEqual([...nodeTypes(proposal)].sort(), [
    "actions",
    "card",
    "details",
    "status",
  ]);
  assertContains(
    actionIds(proposal),
    ["agent.review", "agent.create", "agent.update", "agent.decline"],
    "Agent Proposal",
  );
  assert.equal(
    proposal.actions.some(
      (action) =>
        action.interaction.type === "presentation" &&
        action.interaction.surface === "agent-review",
    ),
    true,
  );
  assert.equal(
    /private.?key|env.?vars|credential|backend.?config|api.?key/i.test(
      JSON.stringify(proposal.input_schema),
    ),
    false,
  );

  const report = manifests.get("report");
  assertContains(
    nodeTypes(report),
    ["metric", "chart", "table", "details"],
    "Report",
  );

  const artifact = manifests.get("artifact");
  assertContains(
    nodeTypes(artifact),
    ["card", "media", "status", "actions"],
    "Artifact",
  );

  const receipt = manifests.get("receipt");
  assertContains(nodeTypes(receipt), ["card", "status", "details"], "Receipt");
  assert.equal(receipt.actions.length, 0);

  const brainstorm = manifests.get("brainstorm");
  assert.deepEqual([...nodeTypes(brainstorm)].sort(), [
    "question",
    "section",
    "stack",
  ]);
  const question = brainstorm.tree.children.find(
    (node) => node.type === "question",
  );
  assert.equal(question?.mode, "multi-select");
  assert.equal(question?.options_path, "/choices");
  assert.equal(question?.allow_custom, true);
  assert.equal(question?.options, undefined);
});

test("starter block gallery renders every exact bundled example natively", async () => {
  const entries = [];
  for (const handle of BLOCK_STARTER_COMPOSITE_HANDLES) {
    const manifest = await readStarterManifest(handle);
    entries.push({
      manifest,
      data: manifest.examples[0]?.data ?? {},
    });
  }

  const html = renderToStaticMarkup(
    React.createElement(StarterBlockGallery, { entries }),
  );
  for (const handle of BLOCK_STARTER_COMPOSITE_HANDLES) {
    assert.match(html, new RegExp(`data-starter-block="${handle}"`));
  }
  assert.doesNotMatch(html, /unsupported|unknown primitive/i);
  assert.match(html, /Premium editorial/);
  assert.match(
    html,
    /Confident typography, restraint, and strong art direction/,
  );
  assert.doesNotMatch(html, /\{\{prompt\}\}/);
});

test("the handover vector renders natively and pins the link it must carry", async () => {
  const handover = await readStarterManifest("handover");

  assertContains(
    nodeTypes(handover),
    ["card", "details", "card-list", "status", "actions"],
    "Handover",
  );
  assertContains(
    actionIds(handover),
    ["handover.pick-up", "handover.decline"],
    "Handover",
  );
  assert.equal(handover.validation.requires_attention, true);
  assertContains(
    new Set(handover.input_schema.required),
    ["source_channel", "source_event_id", "target_channel", "assignee"],
    "Handover schema",
  );

  const html = renderToStaticMarkup(
    React.createElement(StarterBlockGallery, {
      entries: [{ manifest: handover, data: handover.examples[0].data }],
    }),
  );
  assert.match(html, /data-starter-block="handover"/);
  assert.doesNotMatch(html, /unsupported|unknown primitive/i);
  assert.match(html, /Tennant Group/);
  assert.match(html, /Live rebuild/);
  assert.doesNotMatch(html, /\{\{/);
});

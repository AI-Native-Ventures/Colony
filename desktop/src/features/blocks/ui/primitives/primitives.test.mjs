import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BlockActions } from "./BlockActions.tsx";
import { BlockCard } from "./BlockCard.tsx";
import { BlockCardList } from "./BlockCardList.tsx";
import { BlockChart, buildBlockChartGeometry } from "./BlockChart.tsx";
import { BlockDetails } from "./BlockDetails.tsx";
import { BlockLayout } from "./BlockLayout.tsx";
import { BlockMedia } from "./BlockMedia.tsx";
import { BlockMetric } from "./BlockMetric.tsx";
import { BlockQuestion } from "./BlockQuestion.tsx";
import {
  BlockPrimitive,
  supportsBlockPrimitiveType,
} from "./BlockPrimitive.tsx";
import { BlockSection } from "./BlockSection.tsx";
import { BlockStatus } from "./BlockStatus.tsx";
import { BlockTable } from "./BlockTable.tsx";
import { resolveAttentionResolution } from "../BlockRenderer.tsx";
import {
  filterRows,
  formatBlockCell,
  inferMediaKind,
  resolveActionAvailability,
  resolveBlockPath,
  resolveBlockTemplate,
  resolveCard,
  resolveCardListItems,
  resolveChartData,
  resolveDetails,
  resolveLayout,
  resolveMedia,
  resolveMetric,
  resolveSection,
  resolveStatus,
  resolveTableRows,
  stableSortRows,
} from "./resolvers.ts";

const render = (component, props) =>
  renderToStaticMarkup(React.createElement(component, props));

test("block layout resolver clamps columns and renders responsive grid", () => {
  const node = { type: "grid", columns: 99, gap: "medium", children: [] };
  assert.deepEqual(resolveLayout(node), {
    kind: "grid",
    columns: 4,
    gap: "medium",
  });
  const html = render(
    BlockLayout,
    { node },
    React.createElement("span", null, "Child"),
  );
  assert.match(html, /grid-cols-1/);
  assert.match(html, /sm:grid-cols-2/);
});

test("block section resolver uses local then root data and semantic heading", () => {
  const node = {
    type: "section",
    title: "{{title}}",
    text: "{{company.name}}",
  };
  assert.deepEqual(
    resolveSection(node, { title: "Summary" }, { company: { name: "Acme" } }),
    { title: "Summary", text: "Acme" },
  );
  const html = render(BlockSection, {
    data: { title: "Summary" },
    headingLevel: 3,
    node,
    rootData: { company: { name: "Acme" } },
  });
  assert.match(html, /<section/);
  assert.match(html, /<h3/);
  assert.match(html, /Summary/);
});

test("block metric resolver and component preserve value and unit", () => {
  const node = {
    type: "metric",
    label: "{{label}}",
    value: "{{value}}",
    unit: "{{unit}}",
  };
  assert.deepEqual(
    resolveMetric(node, { label: "Revenue", value: 12500, unit: "USD" }),
    { label: "Revenue", value: "12500", unit: "USD" },
  );
  const html = render(BlockMetric, {
    data: { label: "Revenue", value: 12500, unit: "USD" },
    node,
  });
  assert.match(html, /Revenue/);
  assert.match(html, /12500/);
  assert.match(html, /USD/);
});

test("block details resolver renders semantic definition list", () => {
  const node = {
    type: "details",
    items: [{ label: "{{label}}", value: "{{value}}" }],
  };
  assert.deepEqual(resolveDetails(node, { label: "Owner", value: "Scott" }), [
    { label: "Owner", value: "Scott" },
  ]);
  const html = render(BlockDetails, {
    data: { label: "Owner", value: "Scott" },
    node,
  });
  assert.match(html, /<dl/);
  assert.match(html, /<dt/);
  assert.match(html, /<dd/);
});

test("block status resolver covers warning error and completed progress states", () => {
  const node = { type: "status", label: "Build", state_path: "/status" };
  assert.equal(resolveStatus(node, { status: "blocked" }).tone, "warning");
  assert.equal(resolveStatus(node, { status: "failed" }).tone, "error");
  assert.deepEqual(
    resolveStatus(node, {
      status: { state: "completed", progress: 140 },
    }),
    {
      label: "Build",
      state: "completed",
      tone: "success",
      progress: 100,
    },
  );
  const html = render(BlockStatus, {
    data: { status: { state: "completed", progress: 100 } },
    node,
  });
  assert.match(html, /role="status"/);
  assert.match(html, /role="progressbar"/);
  assert.equal(
    resolveStatus({ type: "status", label: "Pending review" }, {}).tone,
    "info",
  );
});

test("terminal attention replaces a pending data-backed status without overwriting independent state", () => {
  const node = { type: "status", label: "Decision", state_path: "/status" };
  const completed = render(BlockStatus, {
    attentionResolution: "succeeded",
    data: { status: "pending" },
    node,
  });
  assert.match(completed, /Completed/);
  assert.doesNotMatch(completed, /pending/i);

  const independent = render(BlockStatus, {
    attentionResolution: "succeeded",
    data: { status: "qualified" },
    node,
  });
  assert.match(independent, /qualified/);
  assert.doesNotMatch(independent, /Completed/);
});

test("block actions resolver disables undeclared and non-Core presentation controls", () => {
  const signed = {
    label: "Approve",
    interaction: { type: "signed", action_id: "approval.approve" },
  };
  const presentation = {
    label: "Review",
    interaction: { type: "presentation", surface: "agent-review" },
  };
  const environment = {
    origin: "workspace-custom",
    trusted: true,
    declaredActionIds: new Set(["approval.approve"]),
    submitSigned() {},
    openPresentation() {},
  };
  assert.equal(resolveActionAvailability(signed, environment).enabled, true);
  assert.equal(
    resolveActionAvailability(
      { ...signed, interaction: { type: "signed", action_id: "undeclared" } },
      environment,
    ).enabled,
    false,
  );
  assert.equal(
    resolveActionAvailability(presentation, environment).enabled,
    false,
  );
  const html = render(BlockActions, {
    environment,
    node: { type: "actions", controls: [signed, presentation] },
  });
  assert.match(html, /<fieldset/);
  assert.match(html, /<legend class="sr-only">Block actions<\/legend>/);
  assert.match(html, /disabled/);
  assert.match(html, /local review surface is unavailable/i);
});

const attentionTree = {
  type: "stack",
  gap: "small",
  children: [
    { type: "status", label: "Pending review" },
    {
      type: "actions",
      controls: [
        {
          label: "Review",
          interaction: { type: "presentation", surface: "agent-review" },
        },
      ],
    },
  ],
};

test("succeeded attention replaces static status and suppresses action controls", () => {
  const resolution = resolveAttentionResolution(true, "succeeded");
  const html = render(BlockPrimitive, {
    context: {
      attentionResolution: resolution,
      data: {},
      actionEnvironment: {
        origin: "core",
        trusted: true,
        declaredActionIds: new Set(),
        openPresentation() {},
      },
    },
    node: attentionTree,
  });

  assert.equal(resolution, "succeeded");
  assert.match(html, /Completed/);
  assert.doesNotMatch(html, /Pending review/);
  assert.doesNotMatch(html, /Review/);
  assert.doesNotMatch(html, /data-block-primitive="actions"/);
});

test("denied attention replaces static status with Declined and suppresses actions", () => {
  const resolution = resolveAttentionResolution(true, "denied");
  const html = render(BlockPrimitive, {
    context: { attentionResolution: resolution, data: {} },
    node: attentionTree,
  });

  assert.equal(resolution, "denied");
  assert.match(html, /Declined/);
  assert.doesNotMatch(html, /Pending review/);
  assert.doesNotMatch(html, /Review/);
});

test("failed attention stays reviewable and preserves the manifest status", () => {
  const resolution = resolveAttentionResolution(true, "failed");
  const html = render(BlockPrimitive, {
    context: {
      attentionResolution: resolution,
      data: {},
      actionEnvironment: {
        origin: "core",
        trusted: true,
        declaredActionIds: new Set(),
        openPresentation() {},
      },
    },
    node: attentionTree,
  });

  assert.equal(resolution, undefined);
  assert.equal(resolveAttentionResolution(false, "succeeded"), undefined);
  assert.match(html, /Pending review/);
  assert.match(html, /Review/);
  assert.match(html, /data-block-primitive="actions"/);
});

test("block question renders data-backed choices once as selectable described cards", () => {
  const html = render(BlockQuestion, {
    data: {
      prompt: "Which qualities should the first concept combine?",
      choices: [
        {
          id: "premium",
          label: "Premium editorial",
          description: "Restrained typography and art direction.",
        },
        {
          id: "motion",
          label: "Cinematic motion",
          description: "Purposeful transitions and pacing.",
        },
      ],
    },
    environment: {
      origin: "core",
      trusted: true,
      declaredActionIds: new Set(["brainstorm.submit"]),
      submitSigned() {},
    },
    node: {
      type: "question",
      prompt: "{{prompt}}",
      mode: "multi-select",
      options_path: "/choices",
      min_selections: 1,
      max_selections: 12,
      allow_custom: true,
      require_custom_input: false,
      submit_action: "brainstorm.submit",
    },
  });

  assert.equal(html.match(/Premium editorial/g)?.length, 1);
  assert.equal(html.match(/Cinematic motion/g)?.length, 1);
  assert.match(html, /Restrained typography and art direction\./);
  assert.match(html, /Purposeful transitions and pacing\./);
  assert.match(html, /Which qualities should the first concept combine\?/);
  assert.doesNotMatch(html, /\{\{prompt\}\}/);
  assert.equal(html.match(/aria-pressed="false"/g)?.length, 2);
});

test("block question shows a durable answer while its processor is still working", () => {
  const html = render(BlockQuestion, {
    data: {
      prompt: "How should agents spend credits?",
      choices: [
        {
          id: "campaign-budget",
          label: "Approve campaign budget",
          description: "Approve a maximum once.",
        },
      ],
    },
    environment: {
      origin: "core",
      trusted: true,
      declaredActionIds: new Set(["brainstorm.submit"]),
      pendingActionId: "brainstorm.submit",
      submitSigned() {},
    },
    node: {
      type: "question",
      prompt: "{{prompt}}",
      mode: "single-select",
      options_path: "/choices",
      min_selections: 1,
      max_selections: 1,
      allow_custom: false,
      require_custom_input: false,
      submit_action: "brainstorm.submit",
    },
  });

  assert.match(html, />Answered</);
  assert.doesNotMatch(html, />Submit</);
  assert.match(html, /disabled/);
});

test("block question keeps its answered label after processing completes", () => {
  const html = render(BlockQuestion, {
    data: {
      prompt: "How should agents spend credits?",
      choices: [
        {
          id: "campaign-budget",
          label: "Approve campaign budget",
          description: "Approve a maximum once.",
        },
      ],
    },
    environment: {
      origin: "core",
      trusted: true,
      declaredActionIds: new Set(["brainstorm.submit"]),
      completedActionIds: new Set(["brainstorm.submit"]),
      submitSigned() {},
    },
    node: {
      type: "question",
      prompt: "{{prompt}}",
      mode: "single-select",
      options_path: "/choices",
      min_selections: 1,
      max_selections: 1,
      allow_custom: false,
      require_custom_input: false,
      submit_action: "brainstorm.submit",
    },
  });

  assert.match(html, />Answered</);
  assert.doesNotMatch(html, />Submit/);
  assert.match(html, /disabled/);
});

test("block table resolver formats filters and stable-sorts typed cells", () => {
  const node = {
    type: "table",
    caption: "Leads",
    columns: [
      { key: "name", label: "Name" },
      { key: "score", label: "Score", format: "number" },
    ],
    rows_path: "/rows",
  };
  const rows = resolveTableRows(node, {
    rows: [
      { id: "a", name: "Beta", score: 10 },
      { id: "b", name: "Alpha", score: 10 },
      { id: "c", name: "Gamma", score: 2 },
    ],
  });
  assert.equal(formatBlockCell(true, "boolean"), "Yes");
  assert.deepEqual(
    stableSortRows(rows, "score", "descending").map((row) => row.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    filterRows(rows, "alp").map((row) => row.id),
    ["b"],
  );
  const html = render(BlockTable, {
    data: { rows },
    node,
    selectionMode: "multiple",
  });
  assert.match(html, /<table/);
  assert.match(html, /<caption[^>]*>Leads/);
  assert.match(html, /aria-sort="none"/);
  assert.match(html, /type="checkbox"/);
});

test("block card resolver uses the Attachment family", () => {
  const node = {
    type: "card",
    title: "{{name}}",
    description: "{{summary}}",
    children: [],
  };
  assert.deepEqual(resolveCard(node, { name: "Acme", summary: "Qualified" }), {
    title: "Acme",
    description: "Qualified",
  });
  const html = render(BlockCard, {
    data: { name: "Acme", summary: "Qualified" },
    node,
  });
  assert.match(html, /data-slot="attachment"/);
  assert.match(html, /Acme/);
});

test("block card-list resolver bounds items and renders list grid carousel modes", () => {
  const items = resolveCardListItems(
    { items: Array.from({ length: 250 }, (_, id) => ({ id })) },
    "/items",
  );
  assert.equal(items.length, 200);
  for (const mode of ["list", "grid", "carousel"]) {
    const html = render(BlockCardList, {
      items: items.slice(0, 2),
      mode,
      renderItem: (item) => React.createElement("span", null, String(item.id)),
    });
    assert.match(html, /data-block-primitive="card-list"/);
    if (mode === "carousel")
      assert.match(html, /aria-roledescription="carousel"/);
  }
});

test("block chart resolver and native SVG cover bar line area donut and negative data", () => {
  const data = {
    series: [
      { label: "Positive", value: 12 },
      { label: "Zero", value: 0 },
      { label: "Negative", value: -4 },
    ],
  };
  const base = {
    type: "chart",
    data_path: "/series",
    label_key: "label",
    value_key: "value",
  };
  const resolved = resolveChartData({ ...base, kind: "bar" }, data);
  assert.equal(resolved.length, 3);
  const geometry = buildBlockChartGeometry(resolved);
  assert.equal(geometry.bars.length, 3);
  assert.ok(geometry.bars.every((bar) => bar.height >= 1));
  assert.match(geometry.linePath, /^M /);
  assert.match(geometry.areaPath, / Z$/);
  assert.equal(geometry.donutPaths.length, 1);

  for (const kind of ["bar", "line", "area", "donut"]) {
    const html = render(BlockChart, {
      data,
      node: { ...base, kind },
      title: `${kind} chart`,
    });
    assert.match(html, /<svg/);
    assert.match(html, /role="img"/);
    assert.match(html, /View chart data/);
    assert.match(html, /<table/);
  }
});

test("block media resolver accepts HTTP media and rejects executable or hash-invalid sources", () => {
  const node = { type: "media", url_path: "/url", alt: "{{alt}}" };
  assert.equal(
    inferMediaKind({
      url: "https://example.com/video.mp4",
      alt: "Demo",
    }),
    "video",
  );
  assert.equal(
    resolveMedia(node, {
      url: "https://example.com/photo.jpg",
      alt: "Photo",
    })[0].item?.kind,
    "image",
  );
  for (const url of ["javascript:alert(1)", "data:text/html,<script>"]) {
    assert.match(
      resolveMedia(node, { url, alt: "Unsafe" })[0].reason,
      /unsafe/i,
    );
  }
  const badHash = resolveMedia(node, {}, [
    {
      url: "https://example.com/file.pdf",
      alt: "File",
      expectedSha256: "a".repeat(64),
      actualSha256: "b".repeat(64),
    },
  ]);
  assert.match(badHash[0].reason, /integrity/i);
  const html = render(BlockMedia, {
    data: { url: "javascript:alert(1)" },
    node,
  });
  assert.match(html, /Blocked unsafe media URL/);
  assert.doesNotMatch(html, /<iframe|dangerouslySetInnerHTML/);
});

test("block primitive root helper dispatches every native primitive type", () => {
  for (const type of [
    "stack",
    "grid",
    "section",
    "metric",
    "details",
    "status",
    "actions",
    "table",
    "card",
    "card-list",
    "chart",
    "media",
    "question",
  ]) {
    assert.equal(supportsBlockPrimitiveType(type), true, type);
  }
  assert.equal(supportsBlockPrimitiveType("executable-html"), false);
  assert.equal(resolveBlockPath({ a: { b: 2 } }, "/a/b"), 2);
  assert.equal(
    resolveBlockTemplate(
      "{{name}} / {{company}}",
      { name: "Lead" },
      {
        company: "Acme",
      },
    ),
    "Lead / Acme",
  );
  const html = render(BlockPrimitive, {
    context: { data: { label: "Revenue", value: 42 } },
    node: {
      type: "metric",
      label: "{{label}}",
      value: "{{value}}",
    },
  });
  assert.match(html, /data-block-primitive="metric"/);
});

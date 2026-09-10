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
import { BlockMetric } from "./BlockMetric.tsx";
import { BlockSection } from "./BlockSection.tsx";
import { BlockStatus } from "./BlockStatus.tsx";
import {
  BlockTable,
  isBlockNumericColumn,
  showBlockTableTools,
} from "./BlockTable.tsx";

const render = (component, props) =>
  renderToStaticMarkup(React.createElement(component, props));

test("details omit missing values, retain false and zero, and disclose real references", () => {
  const node = {
    type: "details",
    presentation: "disclosure",
    summary: "Source details",
    items: [
      { label: "Missing", value: "{{missing}}" },
      { label: "Whitespace", value: "  " },
      { label: "Included", value: "{{enabled}}", format: "boolean" },
      { label: "Count", value: "{{count}}" },
      { label: "Source", value: "{{source}}" },
    ],
  };
  const html = render(BlockDetails, {
    node,
    data: { enabled: false, count: 0, source: "<script>alert(1)</script>" },
  });
  assert.match(html, /<details/);
  assert.match(html, /Source details/);
  assert.doesNotMatch(html, />Missing<|>Whitespace</);
  assert.match(html, />No</);
  assert.match(html, />0</);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal(
    render(BlockDetails, {
      node: {
        type: "details",
        items: [{ label: "Missing", value: "{{missing}}" }],
      },
      data: {},
    }),
    "",
  );
});

test("optional section context disappears while intentional heading-only sections remain", () => {
  const node = {
    type: "section",
    title: "Already on your site",
    text: "{{known}}",
    omit_empty_text: true,
    presentation: "callout",
  };
  assert.equal(render(BlockSection, { node, data: { known: "  " } }), "");
  assert.match(
    render(BlockSection, { node, data: { known: "Twenty clients" } }),
    /data-presentation="callout"/,
  );
  assert.match(
    render(BlockSection, {
      node: { type: "section", title: "Your team" },
      data: {},
    }),
    /Your team/,
  );
});

test("card rows and metrics keep complete long content and authored comparison copy", () => {
  const long = "A complete explanation ".repeat(30);
  const html = render(BlockCard, {
    node: {
      type: "card",
      presentation: "row",
      eyebrow: "Proposed",
      title: "{{name}}",
      subtitle: "{{role}}",
      description: "{{why}}",
    },
    data: { name: "Amina", role: "Operations", why: long },
  });
  assert.match(html, /data-presentation="row"/);
  assert.ok(html.includes(long));
  assert.match(html, /Proposed/);
  assert.match(html, /Operations/);
  assert.doesNotMatch(html, /truncate|line-clamp/);
  const metric = render(BlockMetric, {
    node: {
      type: "metric",
      label: "Revenue",
      value: "{{value}}",
      comparison: "{{comparison}}",
    },
    data: { value: "1,234,567,890", comparison: "Down 2% from last month" },
  });
  assert.match(metric, /1,234,567,890/);
  assert.match(metric, /Down 2% from last month/);
  assert.doesNotMatch(metric, /truncate|line-clamp/);
});

test("small tables show complete values without search or sort clutter", () => {
  const description = "Long explanation ".repeat(40);
  const node = {
    type: "table",
    rows_path: "/rows",
    columns: [
      { key: "name", label: "Work" },
      { key: "value", label: "Value" },
      { key: "included", label: "Included" },
    ],
  };
  const html = render(BlockTable, {
    node,
    data: {
      rows: [
        { name: description, value: 24000, included: false },
        { name: "Maintenance", value: 3500, included: true },
      ],
    },
  });
  assert.doesNotMatch(html, /type="search"|aria-sort|line-clamp|truncate/);
  assert.match(html, /data-numeric="true"/);
  assert.match(html, />Yes</);
  assert.match(html, />No</);
  assert.match(html, /Read-only/);
  assert.ok(html.includes(description));
  assert.equal(showBlockTableTools(12), false);
  assert.equal(showBlockTableTools(13), true);
  assert.equal(
    isBlockNumericColumn(node.columns[1], [{ value: 0 }, { value: null }]),
    true,
  );
  assert.equal(
    isBlockNumericColumn(node.columns[0], [{ name: 1 }, { name: "Unknown" }]),
    false,
  );
});

test("long table search and sorting remain discoverable and empty tables are truthful", () => {
  const node = {
    type: "table",
    rows_path: "/rows",
    columns: [{ key: "name", label: "Name" }],
  };
  const html = render(BlockTable, {
    node,
    data: {
      rows: Array.from({ length: 32 }, (_, index) => ({
        name: `Item ${index}`,
      })),
    },
  });
  assert.match(html, /type="search"/);
  assert.match(html, /aria-sort="none"/);
  assert.match(html, /32 rows/);
  assert.match(
    render(BlockTable, { node, data: { rows: [] } }),
    /No rows to show/,
  );
});

test("grids and collections own their width container and numbered lists are semantic", () => {
  const grid = render(BlockLayout, {
    node: { type: "grid", columns: 4, gap: "medium" },
    children: "Values",
  });
  assert.match(grid, /block-native-layout/);
  assert.match(grid, /@sm\/block-layout:grid-cols-2/);
  const cards = render(BlockCardList, {
    items: ["First", "Second"],
    mode: "grid",
    presentation: "numbered",
    renderItem: (item) => React.createElement("span", null, item),
  });
  assert.match(cards, /block-native-collection/);
  assert.match(cards, /<ol/);
  assert.match(cards, /data-presentation="numbered"/);
  assert.match(cards, /@2xl\/block-collection:grid-cols-2/);
  const single = render(BlockCardList, {
    items: ["Only"],
    mode: "carousel",
    renderItem: (item) => React.createElement("span", null, item),
  });
  assert.doesNotMatch(single, /Next slide|Previous slide/);
});

test("a single-value donut closes its ring and extreme finite chart values stay finite", () => {
  const single = buildBlockChartGeometry([{ label: "Only", value: 10 }]);
  assert.equal(single.donutPaths.length, 1);
  assert.equal(single.donutPaths[0].match(/A /g)?.length, 4);
  const extreme = buildBlockChartGeometry([
    { label: "Min", value: -Number.MAX_VALUE },
    { label: "Max", value: Number.MAX_VALUE },
  ]);
  assert.doesNotMatch(JSON.stringify(extreme), /NaN|Infinity|null/);
  assert.ok(
    extreme.bars.every(
      (bar) => Number.isFinite(bar.y) && Number.isFinite(bar.height),
    ),
  );
});

test("a donut does not silently omit negatives and keeps original values available", () => {
  const html = render(BlockChart, {
    node: {
      type: "chart",
      kind: "donut",
      data_path: "/series",
      label_key: "label",
      value_key: "value",
    },
    data: {
      series: [
        { label: "Gain", value: 10 },
        { label: "Loss", value: -5 },
      ],
    },
  });
  assert.match(html, /needs non-negative values/);
  assert.doesNotMatch(html, /<svg/);
  assert.match(html, /<details[^>]*open/);
  assert.match(html, /Loss/);
  assert.match(html, />-5</);
});

test("duplicate status copy is omitted and actual step position remains accessible", () => {
  const complete = render(BlockStatus, {
    node: { type: "status", label: "Completed", state_path: "/status" },
    data: { status: "completed" },
  });
  assert.equal(complete.match(/completed/gi)?.length, 1);
  const step = render(BlockStatus, {
    node: {
      type: "status",
      label: "Question {{position}} of {{total}}",
      position_path: "/position",
      total_path: "/total",
    },
    data: { position: 2, total: 5 },
  });
  assert.match(step, /Question 2 of 5/);
  assert.match(step, /aria-valuenow="2"/);
  assert.match(step, /aria-valuemax="5"/);
});

test("hidden indirect actions leave no empty action bar", () => {
  const html = render(BlockActions, {
    node: {
      type: "actions",
      controls: [
        {
          label: "Submit revision",
          interaction: { type: "signed", action_id: "revise" },
        },
      ],
    },
    environment: {
      origin: "core",
      trusted: true,
      declaredActionIds: new Set(["revise"]),
      directActionIds: new Set(),
      hideIndirectSignedActions: true,
    },
  });
  assert.equal(html, "");
});

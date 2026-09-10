import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  blockCatalogCategory,
  filterBlockCatalog,
} from "./blockCatalogPresentation.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
Object.assign(globalThis, {
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  window: dom.window,
});
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { BlocksCatalogList } = await import("./BlocksCatalogList.tsx");
const { BlockCatalogCard } = await import("./BlockCatalogCard.tsx");
afterEach(cleanup);
after(() => dom.window.close());

function item(
  handle,
  {
    origin = "core",
    title = `${handle} actual preview`,
    type = "card",
    trust = origin,
  } = {},
) {
  return {
    blockAddress: `${origin}:${handle}`,
    catalogEventId: "a".repeat(64),
    handle,
    manifestId: "b".repeat(64),
    name: `Native ${handle}`,
    origin,
    permissions: [],
    preview: { title },
    publisherPubkey: "c".repeat(64),
    recentUsage: { complete: true, count: 0, lastUsedAt: null },
    status: "active",
    summary: `${handle} description`,
    workshop: null,
    manifestRecord: {
      trust,
      manifest: { tree: { type, title: "{{title}}" } },
    },
  };
}

const fixtures = [
  item("card"),
  item("brief"),
  item("invoice", { origin: "installed", trust: "untrusted" }),
];

test("categories use origin and primitive identity; searching retains publisher entries", () => {
  assert.equal(blockCatalogCategory(fixtures[0]), "primitives");
  assert.equal(blockCatalogCategory(fixtures[1]), "composites");
  assert.equal(blockCatalogCategory(fixtures[2]), "custom");
  assert.deepEqual(filterBlockCatalog(fixtures, "  NATIVE   brief ", "all"), [
    fixtures[1],
  ]);
  assert.deepEqual(filterBlockCatalog(fixtures, "description", "custom"), [
    fixtures[2],
  ]);
  assert.deepEqual(filterBlockCatalog(fixtures, "missing", "all"), []);
  assert.equal(
    blockCatalogCategory(item("card", { origin: "workspace-custom" })),
    "custom",
  );
});

test("selecting and filtering mounts one actual preview and preserves the handoff", () => {
  const handoffs = [];
  const view = render(
    React.createElement(BlocksCatalogList, {
      items: fixtures,
      error: null,
      isLoading: false,
      onSelect: (selected) => handoffs.push(selected),
    }),
  );
  const previewCount = () =>
    view.container.querySelectorAll("[data-block-catalog-handle]").length;
  assert.equal(previewCount(), 1);
  assert.ok(view.getByText("card actual preview"));
  assert.equal(view.queryByText("brief actual preview"), null);
  fireEvent.click(view.getByTestId("select-block-preview-brief"));
  assert.equal(previewCount(), 1);
  assert.ok(view.getByText("brief actual preview"));
  assert.equal(view.queryByText("card actual preview"), null);
  fireEvent.click(view.getByRole("button", { name: "Work in chat" }));
  assert.deepEqual(handoffs, [fixtures[1]]);
  fireEvent.change(view.getByRole("searchbox", { name: "Search Blocks" }), {
    target: { value: "invoice" },
  });
  assert.equal(view.queryByTestId("select-block-preview-brief"), null);
  assert.ok(view.getByText("invoice actual preview"));
  assert.ok(view.getByText("Untrusted publisher"));
  assert.equal(previewCount(), 1);
  fireEvent.change(view.getByRole("searchbox"), {
    target: { value: "nonexistent" },
  });
  assert.equal(previewCount(), 0);
  fireEvent.click(view.getByRole("button", { name: "Clear filters" }));
  assert.equal(previewCount(), 1);
  assert.ok(view.getByText("brief actual preview"));
  fireEvent.click(view.getByRole("button", { name: "Foundation 1" }));
  assert.ok(view.getByText("card actual preview"));
  assert.equal(view.queryByTestId("select-block-preview-brief"), null);
});

test("catalog refresh cannot retain a removed or different-community preview", () => {
  const props = { error: null, isLoading: false, onSelect() {} };
  const view = render(
    React.createElement(BlocksCatalogList, { ...props, items: fixtures }),
  );
  fireEvent.click(view.getByTestId("select-block-preview-brief"));
  view.rerender(
    React.createElement(BlocksCatalogList, { ...props, items: [fixtures[2]] }),
  );
  assert.equal(view.queryByText("brief actual preview"), null);
  assert.ok(view.getByText("invoice actual preview"));
  view.rerender(
    React.createElement(BlocksCatalogList, {
      ...props,
      items: [],
      isLoading: true,
    }),
  );
  assert.equal(view.queryByText("invoice actual preview"), null);
  assert.ok(view.getByRole("status", { name: "Loading Blocks" }));
});

test("media and artifact handles render publisher data without replacement fixtures", () => {
  for (const handle of ["media", "artifact"]) {
    const html = renderToStaticMarkup(
      React.createElement(BlockCatalogCard, {
        item: item(handle),
        onSelect() {},
      }),
    );
    assert.match(html, new RegExp(`${handle} actual preview`));
    assert.doesNotMatch(html, /launch-01|service-report|rich-previews/);
  }
});

test("deprecated entries and required capabilities remain visible in the selected preview", () => {
  const deprecated = {
    ...fixtures[2],
    status: "deprecated",
    permissions: [{ capability: "invoice.read" }],
  };
  const html = renderToStaticMarkup(
    React.createElement(BlockCatalogCard, { item: deprecated, onSelect() {} }),
  );
  assert.match(html, /Deprecated/);
  assert.match(html, /Untrusted publisher/);
  assert.match(html, /Requires invoice.read/);
});

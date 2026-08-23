import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { JSDOM } from "jsdom";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { AuxiliaryPanel } from "./AuxiliaryPanel/index.ts";
import { AuxiliaryPanelBody } from "./AuxiliaryPanel/index.ts";
import {
  AuxiliaryPanelHeader,
  AuxiliaryPanelHeaderGroup,
} from "./AuxiliaryPanel/index.ts";
import {
  AuxiliaryPanelContext,
  useAuxiliaryPanel,
} from "./AuxiliaryPanel/index.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
});

after(() => dom.window.close());

function render(element) {
  return renderToStaticMarkup(element);
}

test("AuxiliaryPanel provides layout mode through context", () => {
  function ContextProbe() {
    const context = useAuxiliaryPanel();
    return React.createElement(
      "span",
      null,
      `${context.mode}:${context.layout}:${context.isSplitLayout}`,
    );
  }

  const html = render(
    React.createElement(
      AuxiliaryPanel,
      {
        layout: "split",
        onClose: () => {},
        testId: "message-thread-panel",
        widthPx: 420,
      },
      React.createElement(ContextProbe),
    ),
  );

  assert.match(html, /docked:split:true/);
  assert.doesNotMatch(html, /data-testid="message-thread-panel"/);
});

test("AuxiliaryPanel preserves descendants when its layout changes", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const child = React.createElement(
    "div",
    { "data-testid": "persistent-child" },
    React.createElement("input", {
      "data-testid": "persistent-input",
      defaultValue: "draft",
    }),
  );
  const renderLayout = async (layout) => {
    await act(async () => {
      root.render(
        React.createElement(
          AuxiliaryPanel,
          { layout, onClose: () => {}, widthPx: 420 },
          child,
        ),
      );
    });
  };

  await renderLayout("standalone");
  const childBefore = container.querySelector(
    '[data-testid="persistent-child"]',
  );
  const inputBefore = container.querySelector(
    '[data-testid="persistent-input"]',
  );
  assert.ok(childBefore);
  assert.ok(inputBefore);
  childBefore.scrollTop = 37;

  await renderLayout("split");
  assert.equal(
    container.querySelector('[data-testid="persistent-child"]'),
    childBefore,
  );
  assert.equal(
    container.querySelector('[data-testid="persistent-input"]'),
    inputBefore,
  );
  assert.equal(childBefore.scrollTop, 37);

  await act(async () => root.unmount());
});

test("AuxiliaryPanelBody accepts a mode override and applies panel padding", () => {
  const html = render(
    React.createElement(
      AuxiliaryPanelBody,
      {
        className: "overflow-y-auto",
        mode: "panel",
        panelPadding: true,
      },
      "Panel body",
    ),
  );

  assert.match(html, /min-h-0/);
  assert.match(html, /flex-1/);
  assert.match(html, /pt-4/);
  assert.match(html, /overflow-y-auto/);
  assert.match(html, />Panel body</);
});

test("AuxiliaryPanelBody resolves mode from context", () => {
  const html = render(
    React.createElement(
      AuxiliaryPanelContext.Provider,
      {
        value: {
          isFloatingOverlay: false,
          isOverlay: false,
          isSinglePanelView: false,
          isSplitLayout: false,
          layout: "standalone",
          mode: "single-panel",
          onClose: () => {},
          transparentChrome: false,
          widthPx: 360,
        },
      },
      React.createElement(AuxiliaryPanelBody, null, "Body"),
    ),
  );

  assert.match(html, /pt-13/);
});

test("AuxiliaryPanelBody throws without a mode or provider", () => {
  assert.throws(
    () => render(React.createElement(AuxiliaryPanelBody, null, "Body")),
    /AuxiliaryPanelBody requires `mode` or an AuxiliaryPanel ancestor/,
  );
});

test("useAuxiliaryPanel throws outside AuxiliaryPanel", () => {
  function HookProbe() {
    useAuxiliaryPanel();
    return React.createElement("span", null, "unreachable");
  }

  assert.throws(
    () => render(React.createElement(HookProbe)),
    /useAuxiliaryPanel must be used within AuxiliaryPanel/,
  );
});

test("AuxiliaryPanelHeaderGroup derives overlay button styling from context", () => {
  const html = render(
    React.createElement(
      AuxiliaryPanelContext.Provider,
      {
        value: {
          isFloatingOverlay: true,
          isOverlay: true,
          isSinglePanelView: false,
          isSplitLayout: false,
          layout: "standalone",
          mode: "panel",
          onClose: () => {},
          transparentChrome: false,
          widthPx: 360,
        },
      },
      React.createElement(
        AuxiliaryPanelHeader,
        null,
        React.createElement(
          AuxiliaryPanelHeaderGroup,
          { onBack: () => {} },
          "Title",
        ),
      ),
    ),
  );

  assert.match(html, /ml-0/);
  assert.doesNotMatch(html, /-ml-2/);
});

test("AuxiliaryPanel applies className in standalone layout", () => {
  const html = render(
    React.createElement(
      AuxiliaryPanel,
      {
        className: "custom-panel-class",
        onClose: () => {},
        testId: "message-thread-panel",
        widthPx: 420,
      },
      "Panel",
    ),
  );

  assert.match(html, /custom-panel-class/);
  assert.match(html, /data-testid="message-thread-panel"/);
  assert.match(html, /role="complementary"/);
});

test("AuxiliaryPanelHeader renders a generic close action from context", () => {
  const html = render(
    React.createElement(
      AuxiliaryPanel,
      {
        header: React.createElement(
          AuxiliaryPanelHeader,
          null,
          React.createElement(AuxiliaryPanelHeaderGroup, null, "Title"),
        ),
        onClose: () => {},
        widthPx: 420,
      },
      "Panel",
    ),
  );

  assert.match(html, /aria-label="Close panel"/);
  assert.match(html, /data-testid="auxiliary-panel-close"/);
});

test("AuxiliaryPanelHeader keeps resize border in single-panel mode when requested", () => {
  const html = render(
    React.createElement(
      AuxiliaryPanel,
      {
        header: React.createElement(
          AuxiliaryPanelHeader,
          { resizeBorder: true },
          React.createElement(AuxiliaryPanelHeaderGroup, null, "Title"),
        ),
        onClose: () => {},
        onResizeStart: () => {},
        widthPx: 420,
      },
      "Panel",
    ),
  );

  assert.match(html, /after:-left-px/);
  assert.match(html, /peer-hover\/auxiliary-panel-resize:after:bg-border\/80/);
});

test("AuxiliaryPanelHeader omits resize border in single-panel mode by default", () => {
  const html = render(
    React.createElement(
      AuxiliaryPanel,
      {
        header: React.createElement(
          AuxiliaryPanelHeader,
          null,
          React.createElement(AuxiliaryPanelHeaderGroup, null, "Title"),
        ),
        onClose: () => {},
        onResizeStart: () => {},
        widthPx: 420,
      },
      "Panel",
    ),
  );

  assert.doesNotMatch(html, /after:-left-px/);
  assert.doesNotMatch(
    html,
    /peer-hover\/auxiliary-panel-resize:after:bg-border\/80/,
  );
});

test("AuxiliaryPanel resize handle uses a generic namespace", () => {
  const html = render(
    React.createElement(
      AuxiliaryPanel,
      {
        onClose: () => {},
        onResizeStart: () => {},
        widthPx: 420,
      },
      "Panel",
    ),
  );

  assert.match(html, /peer\/auxiliary-panel-resize/);
  assert.match(html, /group\/auxiliary-panel-resize/);
  assert.doesNotMatch(html, /profile-resize/);
});

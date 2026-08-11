/**
 * Product-layer proof that the status filter is live: selecting a status in
 * the LeadFilters control ends in a data-source fetch carrying that status.
 * An adapter-level test alone would pass while the component still
 * short-circuited on `initialLeads` and never fetched at all.
 */
import assert from "node:assert/strict";
import test from "node:test";

// ── Minimal DOM shim ─────────────────────────────────────────────────────────
// react-dom/client needs a small subset of the DOM API to render the filter
// control. Same shape as OpenRouterConnectField.test.mjs.

class MinimalEventTarget {
  constructor() {
    this._listeners = {};
  }
  addEventListener(type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  }
  removeEventListener(type, fn) {
    if (this._listeners[type]) {
      this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
    }
  }
  dispatchEvent(e) {
    let current = this;
    while (current) {
      for (const fn of current._listeners[e.type] ?? []) fn(e);
      if (e.__stopPropagation) break;
      current = current.parentNode;
    }
    return true;
  }
}

class MinimalNode extends MinimalEventTarget {
  constructor(tagName) {
    super();
    this.tagName = tagName;
    this.children = [];
    this.childNodes = [];
    this.style = {};
    this.attributes = new Map();
    this.nodeType = 1;
    this.nodeValue = null;
    this.parentNode = null;
  }
  get ownerDocument() {
    return globalThis.document;
  }
  get options() {
    return this.children.filter((child) => child.tagName === "option");
  }
  get textContent() {
    if (this.nodeType === 3) return this.nodeValue ?? "";
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(value) {
    this.children = [];
    this.childNodes = [];
    if (value !== "" && value != null) {
      const text = new MinimalNode("#text");
      text.nodeValue = String(value);
      text.nodeType = 3;
      this.appendChild(text);
    }
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  setAttributeNS(_ns, name, value) {
    this.setAttribute(name, value);
  }
  appendChild(child) {
    this.children.push(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    this.childNodes = this.childNodes.filter((c) => c !== child);
    return child;
  }
  insertBefore(newNode, refNode) {
    if (!refNode) return this.appendChild(newNode);
    const i = this.children.indexOf(refNode);
    if (i < 0) return this.appendChild(newNode);
    this.children.splice(i, 0, newNode);
    this.childNodes.splice(i, 0, newNode);
    newNode.parentNode = this;
    return newNode;
  }
  contains(node) {
    if (!node) return false;
    return this === node || this.children.some((c) => c?.contains?.(node));
  }
}

class MinimalDocument extends MinimalEventTarget {
  constructor() {
    super();
    this.nodeType = 9;
  }
  createElement(tagName) {
    return new MinimalNode(tagName);
  }
  createElementNS(_ns, tagName) {
    return new MinimalNode(tagName);
  }
  createTextNode(value) {
    const n = new MinimalNode("#text");
    n.nodeValue = value;
    n.nodeType = 3;
    return n;
  }
  createComment(value) {
    const n = new MinimalNode("#comment");
    n.nodeValue = value;
    n.nodeType = 8;
    return n;
  }
  get body() {
    if (!this._body) this._body = this.createElement("body");
    return this._body;
  }
  get activeElement() {
    return null;
  }
  contains(node) {
    return node != null;
  }
}

globalThis.document = new MinimalDocument();
globalThis.HTMLIFrameElement = MinimalNode;
globalThis.HTMLElement = MinimalNode;
globalThis.HTMLSelectElement = MinimalNode;
globalThis.Node = MinimalNode;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
process.env.IS_REACT_ACT_ENVIRONMENT = "true";

if (typeof globalThis.window === "undefined") {
  Object.defineProperty(globalThis, "window", {
    value: globalThis,
    configurable: true,
  });
}
if (!Object.getOwnPropertyDescriptor(globalThis, "navigator")?.value) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "node" },
    configurable: true,
  });
}
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
};

import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import {
  EMPTY_LEAD_FILTERS,
  LeadFilters,
  selectedLeadStatus,
} from "./LeadFilters.tsx";
import { useLeadsStatusFetch } from "./useLeadsStatusFetch.ts";

function findByAriaLabel(node, label) {
  if (node.getAttribute?.("aria-label") === label) return node;
  for (const child of node.children ?? []) {
    const found = findByAriaLabel(child, label);
    if (found) return found;
  }
  return null;
}

function recordingDataSource() {
  const scopes = [];
  return {
    scopes,
    getLeads: async (scope) => {
      scopes.push(scope);
      return {
        leads: [],
        total: 0,
        page: 1,
        pageSize: scope.pageSize ?? 25,
        hasNextPage: false,
      };
    },
  };
}

test("LeadFilters offers the six funnel statuses and emits them on change", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const changes = [];
  await act(async () => {
    root.render(
      React.createElement(LeadFilters, {
        leads: [],
        onChange: (next) => changes.push(next),
        value: EMPTY_LEAD_FILTERS,
      }),
    );
  });

  const select = findByAriaLabel(container, "Filter lead status");
  assert.ok(select, "the status filter control must render");
  const options = [...select.children].map((option) => ({
    label: option.textContent,
    value: option.getAttribute("value"),
  }));
  assert.deepEqual(options, [
    { label: "All statuses", value: "all" },
    { label: "Candidate", value: "candidate" },
    { label: "Accepted", value: "accepted" },
    { label: "Qualified", value: "qualified" },
    { label: "Dormant", value: "dormant" },
    { label: "Disqualified", value: "disqualified" },
    { label: "Converted", value: "client_active" },
  ]);

  // The DOM shim cannot drive React's change-event plugin (it relies on
  // browser value-tracking machinery), so the test invokes the exact handler
  // React bound to the select element, with the select as the event target -
  // the same call a browser change event produces.
  select.value = "dormant";
  const propsKey = Object.keys(select).find((key) =>
    key.startsWith("__reactProps"),
  );
  await act(async () => {
    select[propsKey].onChange({ target: select });
  });
  assert.deepEqual(changes.at(-1), { status: "dormant" });

  await act(async () => root.unmount());
});

test("selectedLeadStatus maps the filter control's value onto the fetch scope", () => {
  assert.equal(
    selectedLeadStatus({ ...EMPTY_LEAD_FILTERS, status: "dormant" }),
    "dormant",
  );
  assert.equal(selectedLeadStatus(EMPTY_LEAD_FILTERS), undefined);
});

test("a status selected in the filter produces a relay-bound fetch carrying it", async () => {
  const dataSource = recordingDataSource();
  const container = document.createElement("div");
  const root = createRoot(container);
  const initialLeads = {
    leads: [],
    total: 0,
    page: 1,
    pageSize: 100,
    hasNextPage: false,
  };

  function Harness(props) {
    useLeadsStatusFetch(props);
    return null;
  }

  const base = {
    campaignId: "auto-repair-johannesburg",
    dataSource,
    initialLeads,
    scope: "campaign",
  };
  try {
    await act(async () => {
      root.render(React.createElement(Harness, base));
    });
    assert.equal(
      dataSource.scopes.length,
      0,
      "unfiltered workspace must short-circuit on initialLeads",
    );

    await act(async () => {
      root.render(
        React.createElement(Harness, {
          ...base,
          status: "dormant",
        }),
      );
    });
    assert.equal(dataSource.scopes.length, 1);
    assert.equal(dataSource.scopes[0].status, "dormant");
    assert.equal(dataSource.scopes[0].campaignId, "auto-repair-johannesburg");
    assert.equal(dataSource.scopes[0].pageSize, 100);

    await act(async () => {
      root.render(
        React.createElement(Harness, {
          ...base,
          status: "qualified",
        }),
      );
    });
    assert.equal(dataSource.scopes.length, 2);
    assert.equal(dataSource.scopes[1].status, "qualified");
  } finally {
    await act(async () => root.unmount());
  }
});

test("a global workspace fetch carries the status with the global page size", async () => {
  const dataSource = recordingDataSource();
  const container = document.createElement("div");
  const root = createRoot(container);

  function Harness(props) {
    useLeadsStatusFetch(props);
    return null;
  }

  try {
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          dataSource,
          initialLeads: null,
          scope: "global",
          status: "disqualified",
        }),
      );
    });
    assert.equal(dataSource.scopes.length, 1);
    assert.equal(dataSource.scopes[0].status, "disqualified");
    assert.equal(dataSource.scopes[0].scope, "global");
    assert.equal(dataSource.scopes[0].campaignId, undefined);
    assert.equal(dataSource.scopes[0].pageSize, 500);
  } finally {
    await act(async () => root.unmount());
  }
});

test("a status selected on an individual-target campaign carries targetType into the fetch", async () => {
  const dataSource = recordingDataSource();
  const container = document.createElement("div");
  const root = createRoot(container);
  const initialLeads = {
    leads: [],
    total: 0,
    page: 1,
    pageSize: 100,
    hasNextPage: false,
  };

  function Harness(props) {
    useLeadsStatusFetch(props);
    return null;
  }

  const base = {
    campaignId: "marketing-directors-united-states",
    dataSource,
    initialLeads,
    scope: "campaign",
    targetType: "individual",
  };
  try {
    await act(async () => {
      root.render(React.createElement(Harness, base));
    });
    assert.equal(
      dataSource.scopes.length,
      0,
      "unfiltered individual campaign must short-circuit on initialLeads",
    );

    await act(async () => {
      root.render(
        React.createElement(Harness, {
          ...base,
          status: "candidate",
        }),
      );
    });
    assert.equal(dataSource.scopes.length, 1);
    assert.equal(dataSource.scopes[0].status, "candidate");
    assert.equal(
      dataSource.scopes[0].targetType,
      "individual",
      "the fetch must keep the campaign's target type so a people campaign does not swap to company rows",
    );
  } finally {
    await act(async () => root.unmount());
  }
});

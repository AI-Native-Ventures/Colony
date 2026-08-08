/**
 * Pipeline presentation proof: six columns rendered from the data source's
 * status-filtered response, counts taken from the response totals, and a
 * relay refusal rendering its reason inline against the card.
 */
import assert from "node:assert/strict";
import test from "node:test";

// ── Minimal DOM shim ─────────────────────────────────────────────────────────
// Same shape as useLeadsStatusFetch.test.mjs and OpenRouterConnectField.test.mjs.

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

import { PipelineWorkspace } from "./PipelineWorkspace.tsx";

function lead(id, companyName, status, overrides = {}) {
  return {
    id,
    companyName,
    location: "Sandton, South Africa",
    source: "google_maps",
    sourceLabel: "Outscraper (Google Maps)",
    score: 80,
    contacts: 1,
    industryId: "automotive",
    verticalId: "auto-repair",
    campaignIds: ["auto-repair-johannesburg"],
    status,
    addedAt: "2026-08-01T08:30:00.000Z",
    ...overrides,
  };
}

const RELAY_REFUSAL =
  "invalid: Lead status transition Disqualified -> Accepted is not allowed";

function stubDataSource(overrides = {}) {
  return {
    getPipelineColumns: async () => [
      {
        status: "candidate",
        total: 42,
        leads: [lead("lead-001", "Rosebank Auto Care", "candidate")],
      },
      {
        status: "accepted",
        total: 17,
        leads: [lead("lead-002", "Soweto Motor Works", "accepted")],
      },
      { status: "qualified", total: 9, leads: [] },
      { status: "dormant", total: 4, leads: [] },
      { status: "disqualified", total: 2, leads: [] },
      { status: "client_active", total: 0, leads: [] },
    ],
    updateLead: async () => {
      throw new Error(RELAY_REFUSAL);
    },
    ...overrides,
  };
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function byTestId(root, testId) {
  let found = null;
  walk(root, (node) => {
    if (!found && node.getAttribute?.("data-testid") === testId) found = node;
  });
  return found;
}

async function renderPipeline(dataSource) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const opened = [];
  await act(async () => {
    root.render(
      React.createElement(PipelineWorkspace, {
        dataSource,
        onOpenLead: (leadId) => opened.push(leadId),
      }),
    );
  });
  await act(async () => {});
  return { container, opened, root };
}

test("the pipeline renders six columns populated from the response", async () => {
  const { container, root } = await renderPipeline(stubDataSource());
  try {
    const workspace = byTestId(container, "pipeline-workspace");
    assert.ok(workspace, "pipeline workspace must render");
    for (const [status, label] of [
      ["candidate", "Candidate"],
      ["accepted", "Accepted"],
      ["qualified", "Qualified"],
      ["dormant", "Dormant"],
      ["disqualified", "Disqualified"],
      ["client_active", "Converted"],
    ]) {
      const column = byTestId(container, `pipeline-column-${status}`);
      assert.ok(column, `${label} column must render`);
      assert.ok(
        column.textContent.includes(label),
        `${label} column must be headed by its label`,
      );
    }
    for (const [status, total] of [
      ["candidate", "42"],
      ["accepted", "17"],
      ["qualified", "9"],
      ["dormant", "4"],
      ["disqualified", "2"],
      ["client_active", "0"],
    ]) {
      const badge = byTestId(container, `pipeline-column-${status}-total`);
      assert.ok(badge, `${status} total badge must render`);
      assert.equal(
        badge.textContent,
        total,
        `${status} count must come from the response total, not a literal`,
      );
    }
    assert.ok(
      container.textContent.includes("Rosebank Auto Care"),
      "candidate card must render",
    );
    assert.ok(
      container.textContent.includes("Soweto Motor Works"),
      "accepted card must render",
    );
  } finally {
    await act(async () => root.unmount());
  }
});

test("the move control never offers Converted and greys out illegal moves", async () => {
  const { container, root } = await renderPipeline(stubDataSource());
  try {
    const select = byTestId(container, "pipeline-move-lead-001");
    assert.ok(select, "candidate card must have a move control");
    const options = select.options.filter(
      (option) => option.getAttribute("value") !== "",
    );
    const labels = options.map((option) => option.textContent);
    assert.ok(
      !labels.some((label) => label.includes("Converted")),
      "a Lead must never be offered a move into Converted",
    );
    const accepted = options.find(
      (option) => option.getAttribute("value") === "accepted",
    );
    assert.equal(
      accepted.hasAttribute("disabled"),
      false,
      "candidate -> accepted is legal",
    );
    const qualified = options.find(
      (option) => option.getAttribute("value") === "qualified",
    );
    assert.equal(
      qualified.hasAttribute("disabled"),
      true,
      "candidate -> qualified must be greyed out",
    );
  } finally {
    await act(async () => root.unmount());
  }
});

test("a relay refusal renders its reason inline against the card", async () => {
  const { container, root } = await renderPipeline(stubDataSource());
  try {
    const select = byTestId(container, "pipeline-move-lead-002");
    assert.ok(select, "accepted card must have a move control");
    select.value = "qualified";
    const propsKey = Object.keys(select).find((key) =>
      key.startsWith("__reactProps"),
    );
    assert.ok(propsKey, "React must have bound props to the select");
    await act(async () => {
      select[propsKey].onChange({ target: select });
    });
    await act(async () => {});
    const rejection = byTestId(container, "pipeline-rejection-lead-002");
    assert.ok(rejection, "the refusal must render against the card");
    assert.ok(
      rejection.textContent.includes(
        "Lead status transition Disqualified -> Accepted is not allowed",
      ),
      "the relay's reason must render inline, not a generic failure",
    );
  } finally {
    await act(async () => root.unmount());
  }
});

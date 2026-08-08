/**
 * Tests for the OpenRouter connect helpers: the key merge/removal must only
 * ever touch `env_vars.OPENROUTER_API_KEY` and must preserve every other
 * config field and env var — prior credentials and unrelated settings stay
 * intact through connect, disconnect, and reconnect.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENROUTER_API_KEY,
  withOpenRouterKey,
  withoutOpenRouterKey,
} from "./OpenRouterConnectField.tsx";

// ── Minimal DOM shim ─────────────────────────────────────────────────────────
// react-dom/client needs a small subset of the DOM API to render the field.
// Same shape as MessageComposerDraftImagePersist.test.mjs, extended with the
// attribute and SVG hooks the component's buttons and lucide icons need.

class MinimalEventTarget {
  constructor() {
    this._listeners = {};
  }
  addEventListener(type, fn) {
    if (!this._listeners[type]) {
      this._listeners[type] = [];
    }
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
      for (const fn of current._listeners[e.type] ?? []) {
        fn(e);
      }
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
  get firstChild() {
    return this.children[0] ?? null;
  }
  get lastChild() {
    return this.children[this.children.length - 1] ?? null;
  }
  get nextSibling() {
    return null;
  }
  get textContent() {
    if (this.nodeType === 3) return this.nodeValue ?? "";
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(value) {
    // React clears a root container by assigning `textContent = ""` before
    // re-inserting the fresh tree; mirror that by dropping the children.
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
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

// ── Tauri IPC interceptor ────────────────────────────────────────────────────
// @tauri-apps/api/core calls window.__TAURI_INTERNALS__.invoke(cmd, args), so
// the real connectOpenRouter wrapper (and its toTauriError normalization) is
// exercised without patching module internals.

/** @type {Map<string, (args: unknown) => Promise<unknown>>} */
const ipcHandlers = new Map();

globalThis.__TAURI_INTERNALS__ = {
  invoke: (cmd, args) => {
    const handler = ipcHandlers.get(cmd);
    if (handler) return handler(args);
    return Promise.reject(new Error(`unmocked Tauri command: ${cmd}`));
  },
  transformCallback: (_cb) => Math.random(),
};

import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { OpenRouterConnectField } from "./OpenRouterConnectField.tsx";

function findByTestId(node, testId) {
  if (node.getAttribute?.("data-testid") === testId) return node;
  for (const child of node.children ?? []) {
    const found = findByTestId(child, testId);
    if (found) return found;
  }
  return null;
}

function makeConfig() {
  return {
    env_vars: {},
    provider: null,
    model: null,
    preferred_runtime: null,
  };
}

async function mountField() {
  const container = document.createElement("div");
  const root = createRoot(container);
  const changes = [];
  await act(async () => {
    root.render(
      React.createElement(OpenRouterConnectField, {
        config: makeConfig(),
        connected: false,
        onConfigChange: (next) => changes.push(next),
      }),
    );
  });
  return { container, root, changes };
}

const baseConfig = {
  env_vars: {
    ANTHROPIC_API_KEY: "sk-ant-kept",
    OPENROUTER_API_KEY: "sk-or-old",
    OTHER_VAR: "kept",
  },
  provider: "openrouter",
  model: "some/model",
  preferred_runtime: "buzz-agent",
};

test("withOpenRouterKey stores the key and preserves everything else", () => {
  const next = withOpenRouterKey(baseConfig, "sk-or-new");
  assert.equal(next.env_vars[OPENROUTER_API_KEY], "sk-or-new");
  assert.equal(next.env_vars.ANTHROPIC_API_KEY, "sk-ant-kept");
  assert.equal(next.env_vars.OTHER_VAR, "kept");
  assert.equal(next.provider, "openrouter");
  assert.equal(next.model, "some/model");
  assert.equal(next.preferred_runtime, "buzz-agent");
  // The input config is not mutated.
  assert.equal(baseConfig.env_vars[OPENROUTER_API_KEY], "sk-or-old");
});

test("withOpenRouterKey on a config with no key adds only the key", () => {
  const bare = {
    env_vars: { OTHER_VAR: "kept" },
    provider: null,
    model: null,
    preferred_runtime: null,
  };
  const next = withOpenRouterKey(bare, "sk-or-new");
  assert.deepEqual(next.env_vars, {
    OTHER_VAR: "kept",
    OPENROUTER_API_KEY: "sk-or-new",
  });
});

test("withoutOpenRouterKey removes only the OpenRouter key", () => {
  const next = withoutOpenRouterKey(baseConfig);
  assert.equal(OPENROUTER_API_KEY in next.env_vars, false);
  assert.deepEqual(next.env_vars, {
    ANTHROPIC_API_KEY: "sk-ant-kept",
    OTHER_VAR: "kept",
  });
  assert.equal(next.provider, "openrouter");
});

test("withoutOpenRouterKey is a no-op when no key is present", () => {
  const bare = {
    env_vars: { OTHER_VAR: "kept" },
    provider: null,
    model: null,
    preferred_runtime: null,
  };
  assert.deepEqual(withoutOpenRouterKey(bare), bare);
});

// ── Failure visibility: a rejected invoke must surface the backend message ──
//
// invokeTauri normalizes every rejection to an Error (toTauriError), so a
// catch that only reads `typeof err === "string"` silently discards every
// Rust failure message — the 10-minute timeout, state mismatch, missing
// state, and listener/browser failures would all collapse into the generic
// "Couldn't start the connection. Try again." This test renders the real
// component, drives the real connectOpenRouter wrapper, and rejects the
// underlying invoke with the backend's timeout message. It fails if the
// catch ever stops reading `err.message` again.

test("a rejected connect invoke surfaces the backend message, not the generic fallback", async () => {
  let rejectInvoke;
  ipcHandlers.set(
    "connect_openrouter",
    () =>
      new Promise((_resolve, reject) => {
        rejectInvoke = reject;
      }),
  );

  const { container, root } = await mountField();
  try {
    const button = findByTestId(container, "openrouter-connect-button");
    assert.ok(button, "connect button must render");

    // Click through React's delegated listener, attached to the root container.
    await act(async () => {
      container.dispatchEvent({ type: "click", target: button });
    });

    // The Rust command rejects with this message when the 10-minute window
    // expires; the UI must show it verbatim.
    await act(async () => {
      rejectInvoke(
        new Error(
          "Timed out waiting for you to authorize OpenRouter. " +
            "Your existing credentials were left unchanged; try again.",
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const error = findByTestId(container, "openrouter-connect-error");
    assert.ok(error, "error notice must render after a rejected invoke");
    assert.match(
      error.textContent,
      /Timed out waiting for you to authorize OpenRouter/,
      "the backend's message must be visible",
    );
    assert.doesNotMatch(
      error.textContent,
      /Couldn't start the connection/,
      "the generic fallback must not swallow the backend message",
    );
  } finally {
    ipcHandlers.clear();
    await act(async () => root.unmount());
  }
});

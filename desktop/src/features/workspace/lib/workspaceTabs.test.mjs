import assert from "node:assert/strict";
import test from "node:test";

let importSequence = 0;

async function freshStore(run) {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const map = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => void map.set(key, String(value)),
      removeItem: (key) => void map.delete(key),
    },
  });
  try {
    const module = await import(`./workspaceTabs.ts?test=${importSequence++}`);
    await run(module);
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
}

const scratch = (title) => ({
  kind: "scratchpad",
  title,
  createdBy: "local",
  payload: { text: "" },
});

test("a channel with no tabs is empty and has no active tab", async () => {
  await freshStore((mod) => {
    const state = mod.getWorkspace("chan-a");
    assert.deepEqual(state.tabs, []);
    assert.equal(state.activeTabId, null);
  });
});

test("opening a tab makes it active and gives it a unique id", async () => {
  await freshStore((mod) => {
    const first = mod.openTab("chan-a", scratch("One"));
    const second = mod.openTab("chan-a", scratch("Two"));
    assert.notEqual(first, second);
    const state = mod.getWorkspace("chan-a");
    assert.deepEqual(
      state.tabs.map((tab) => tab.title),
      ["One", "Two"],
    );
    assert.equal(state.activeTabId, second);
  });
});

test("tabs are never shared across channels", async () => {
  await freshStore((mod) => {
    mod.openTab("chan-a", scratch("One"));
    assert.deepEqual(mod.getWorkspace("chan-b").tabs, []);
  });
});

test("the store round-trips an opaque payload without reading it", async () => {
  await freshStore((mod) => {
    const payload = { deeply: { nested: [1, 2, 3] }, handle: "pty-7" };
    const id = mod.openTab("chan-a", {
      kind: "some-future-kind",
      title: "Stub",
      createdBy: "local",
      payload,
    });
    const tab = mod.getWorkspace("chan-a").tabs.find((t) => t.id === id);
    assert.deepEqual(
      tab.payload,
      payload,
      "the workspace layer must not reshape a kind's payload",
    );
    mod.updateTabPayload("chan-a", id, { replaced: true });
    const updated = mod.getWorkspace("chan-a").tabs.find((t) => t.id === id);
    assert.deepEqual(updated.payload, { replaced: true });
  });
});

test("an unregistered kind is accepted, because the store is kind-agnostic", async () => {
  await freshStore((mod) => {
    const id = mod.openTab("chan-a", {
      kind: "terminal",
      title: "zsh",
      createdBy: "local",
      payload: {},
    });
    assert.equal(mod.getWorkspace("chan-a").tabs[0].id, id);
  });
});

test("closing the active tab activates its neighbour", async () => {
  await freshStore((mod) => {
    const a = mod.openTab("chan-a", scratch("A"));
    const b = mod.openTab("chan-a", scratch("B"));
    const c = mod.openTab("chan-a", scratch("C"));
    mod.setActiveTab("chan-a", b);
    mod.closeTab("chan-a", b);
    const state = mod.getWorkspace("chan-a");
    assert.deepEqual(
      state.tabs.map((tab) => tab.id),
      [a, c],
    );
    assert.equal(state.activeTabId, c, "closing B should activate C");
  });
});

test("clearing the active tab keeps every tab open", async () => {
  await freshStore((mod) => {
    const first = mod.openTab("chan-a", scratch("A"));
    const second = mod.openTab("chan-a", scratch("B"));
    mod.clearActiveTab("chan-a");
    const state = mod.getWorkspace("chan-a");
    assert.equal(state.activeTabId, null);
    assert.deepEqual(
      state.tabs.map((tab) => tab.id),
      [first, second],
      "clearing the active tab must not close any tabs",
    );
  });
});

test("closing the last tab leaves no active tab", async () => {
  await freshStore((mod) => {
    const a = mod.openTab("chan-a", scratch("A"));
    mod.closeTab("chan-a", a);
    assert.equal(mod.getWorkspace("chan-a").activeTabId, null);
  });
});

test("closing an inactive tab leaves the active tab alone", async () => {
  await freshStore((mod) => {
    const a = mod.openTab("chan-a", scratch("A"));
    const b = mod.openTab("chan-a", scratch("B"));
    mod.closeTab("chan-a", a);
    assert.equal(mod.getWorkspace("chan-a").activeTabId, b);
  });
});

test("reopen restores the last closed tab with its payload and position", async () => {
  await freshStore((mod) => {
    const a = mod.openTab("chan-a", scratch("A"));
    const b = mod.openTab("chan-a", {
      kind: "scratchpad",
      title: "B",
      createdBy: "local",
      payload: { text: "kept" },
    });
    mod.openTab("chan-a", scratch("C"));
    mod.closeTab("chan-a", b);
    const reopened = mod.reopenLastClosedTab("chan-a");
    const state = mod.getWorkspace("chan-a");
    assert.equal(state.tabs[1].id, reopened, "reopens at its old index");
    assert.deepEqual(state.tabs[1].payload, { text: "kept" });
    assert.equal(state.tabs[0].id, a);
    assert.equal(state.activeTabId, reopened);
  });
});

test("reopen with nothing closed returns null", async () => {
  await freshStore((mod) => {
    assert.equal(mod.reopenLastClosedTab("chan-a"), null);
  });
});

test("moveTab reorders and clamps out-of-range targets", async () => {
  await freshStore((mod) => {
    const a = mod.openTab("chan-a", scratch("A"));
    const b = mod.openTab("chan-a", scratch("B"));
    const c = mod.openTab("chan-a", scratch("C"));
    mod.moveTab("chan-a", c, 0);
    assert.deepEqual(
      mod.getWorkspace("chan-a").tabs.map((tab) => tab.id),
      [c, a, b],
    );
    mod.moveTab("chan-a", c, 99);
    assert.deepEqual(
      mod.getWorkspace("chan-a").tabs.map((tab) => tab.id),
      [a, b, c],
    );
  });
});

test("renameTab rejects an empty title", async () => {
  await freshStore((mod) => {
    const a = mod.openTab("chan-a", scratch("A"));
    mod.renameTab("chan-a", a, "   ");
    assert.equal(mod.getWorkspace("chan-a").tabs[0].title, "A");
    mod.renameTab("chan-a", a, "Renamed");
    assert.equal(mod.getWorkspace("chan-a").tabs[0].title, "Renamed");
  });
});

test("tabs survive a reload, active tab included", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const map = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => void map.set(key, String(value)),
      removeItem: (key) => void map.delete(key),
    },
  });
  try {
    const first = await import(`./workspaceTabs.ts?test=${importSequence++}`);
    const id = first.openTab("chan-a", scratch("Kept"));
    const second = await import(`./workspaceTabs.ts?test=${importSequence++}`);
    const state = second.getWorkspace("chan-a");
    assert.equal(state.tabs.length, 1);
    assert.equal(state.tabs[0].id, id);
    assert.equal(state.activeTabId, id);
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
});

test("reset clears every channel", async () => {
  await freshStore((mod) => {
    mod.openTab("chan-a", scratch("A"));
    mod.openTab("chan-b", scratch("B"));
    mod.resetWorkspaceTabs();
    assert.deepEqual(mod.getWorkspace("chan-a").tabs, []);
    assert.deepEqual(mod.getWorkspace("chan-b").tabs, []);
  });
});

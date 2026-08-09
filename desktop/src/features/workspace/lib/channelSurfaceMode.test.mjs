import assert from "node:assert/strict";
import test from "node:test";

const KEY = "buzz.channels.surfaceMode";
let importSequence = 0;

async function withStorage(storage, run) {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  try {
    const module = await import(
      `./channelSurfaceMode.ts?test=${importSequence++}`
    );
    await run(module);
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

test("an unknown channel starts on the timeline", async () => {
  await withStorage(memoryStorage(), (mod) => {
    assert.equal(mod.getChannelSurfaceMode("chan-a"), "timeline");
  });
});

test("mode is remembered per channel, not globally", async () => {
  await withStorage(memoryStorage(), (mod) => {
    mod.setChannelSurfaceMode("chan-a", "workspace");
    assert.equal(mod.getChannelSurfaceMode("chan-a"), "workspace");
    assert.equal(
      mod.getChannelSurfaceMode("chan-b"),
      "timeline",
      "channel b must not inherit channel a's mode",
    );
  });
});

test("mode survives a reload through localStorage", async () => {
  const storage = memoryStorage();
  await withStorage(storage, (mod) => {
    mod.setChannelSurfaceMode("chan-a", "workspace");
  });
  await withStorage(storage, (mod) => {
    assert.equal(mod.getChannelSurfaceMode("chan-a"), "workspace");
  });
});

test("malformed and unreadable storage falls back to timeline", async () => {
  for (const stored of ["{bad-json", "null", '{"chan-a":"nonsense"}']) {
    await withStorage(memoryStorage({ [KEY]: stored }), (mod) => {
      assert.equal(mod.getChannelSurfaceMode("chan-a"), "timeline");
    });
  }
  await withStorage(
    {
      getItem() {
        throw new Error("storage blocked");
      },
      setItem() {
        throw new Error("storage blocked");
      },
    },
    (mod) => {
      assert.equal(mod.getChannelSurfaceMode("chan-a"), "timeline");
      mod.setChannelSurfaceMode("chan-a", "workspace");
      assert.equal(
        mod.getChannelSurfaceMode("chan-a"),
        "workspace",
        "an unwritable store must still apply in memory",
      );
    },
  );
});

test("expanded state is tracked per channel and defaults false", async () => {
  await withStorage(memoryStorage(), (mod) => {
    assert.equal(mod.getWorkspaceExpanded("chan-a"), false);
    mod.setWorkspaceExpanded("chan-a", true);
    assert.equal(mod.getWorkspaceExpanded("chan-a"), true);
    assert.equal(mod.getWorkspaceExpanded("chan-b"), false);
  });
});

test("reset clears every channel back to the timeline", async () => {
  await withStorage(memoryStorage(), (mod) => {
    mod.setChannelSurfaceMode("chan-a", "workspace");
    mod.setWorkspaceExpanded("chan-a", true);
    mod.resetChannelSurfaceModes();
    assert.equal(mod.getChannelSurfaceMode("chan-a"), "timeline");
    assert.equal(mod.getWorkspaceExpanded("chan-a"), false);
  });
});

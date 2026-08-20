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

test("workspace mode is channel-scoped and resettable", async () => {
  await withStorage(memoryStorage(), (mod) => {
    mod.setChannelSurfaceMode("alpha", "workspace");
    assert.equal(mod.getChannelSurfaceMode("alpha"), "workspace");
    assert.equal(mod.getChannelSurfaceMode("beta"), "timeline");

    mod.resetChannelSurfaceModes();
    assert.equal(mod.getChannelSurfaceMode("alpha"), "timeline");
  });
});

test("surface mode is the only exported workspace focus state", async () => {
  await withStorage(memoryStorage(), (mod) => {
    assert.equal(["get", "Workspace", "Expanded"].join("") in mod, false);
    assert.equal(["set", "Workspace", "Expanded"].join("") in mod, false);
    assert.equal(["use", "Workspace", "Expanded"].join("") in mod, false);
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

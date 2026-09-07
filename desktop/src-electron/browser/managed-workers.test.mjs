import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Authority } from "./authority.mjs";
import { ManagedBrowser, runtimeId } from "./managed-workers.mjs";
const pubkey = "a".repeat(64);
const relay = "wss://relay.example";
const worker = () => ({
  pubkey,
  owner_identified: true,
  name: "Sarah",
  relay_url: relay,
  backend: { type: "local" },
  status: "running",
  pid: 12,
  last_started_at: "now",
  respond_to: "owner-only",
  needs_restart: false,
  persona_orphaned: false,
});
function setup(root) {
  const authority = new Authority();
  authority.add({ id: "tab", workspace: "biz", url: "https://example.com" });
  let rows = [worker()];
  let context = { id: "biz", relay };
  const views = {
    authority,
    business: "biz",
    get(id) {
      const t = authority.tabs.get(id);
      if (!t || t.workspace !== this.business) throw Error("closed");
      return t;
    },
    notify() {},
    request(req) {
      authority.check(req.token, req.args.tabId || "tab");
      return { ok: true };
    },
  };
  const manager = new ManagedBrowser({
    root,
    socketPath: "/tmp/test.sock",
    views,
    roster: async () => rows,
    context: () => context,
  });
  return {
    manager,
    authority,
    views,
    setRows: (r) => (rows = r),
    setContext: (c) => (context = c),
  };
}
test("runtime filenames use the native canonical relay identity", () => {
  assert.equal(
    runtimeId(pubkey, " WSS://LOCALHOST:443/ "),
    runtimeId(pubkey, "wss://127.0.0.1"),
  );
  assert.equal(
    runtimeId(pubkey, "ws://[::1]/"),
    runtimeId(pubkey, "ws://127.3.4.5/"),
  );
  assert.notEqual(
    runtimeId(pubkey, relay),
    runtimeId(pubkey, relay + "/other"),
  );
  assert.throws(() => runtimeId("../bad", relay));
  assert.throws(() => runtimeId(pubkey, "https://relay.example"));
});
test("only eligible owner-scoped workers are projected and an assigned token stays local", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "managed-browser-test-"));
  try {
    const s = setup(root);
    s.setRows([
      { ...worker(), env_vars: { secret: "hidden" } },
      { ...worker(), pubkey: "b".repeat(64), respond_to: "anyone" },
    ]);
    assert.deepEqual(await s.manager.list(), [{ pubkey, name: "Sarah" }]);
    const result = await s.manager.share({
      id: "tab",
      pubkey,
      mode: "interact",
    });
    assert.deepEqual(result, { name: "Sarah", mode: "interact" });
    const grant = JSON.parse(
      await readFile(
        path.join(root, runtimeId(pubkey, relay) + ".json"),
        "utf8",
      ),
    );
    assert.deepEqual(
      await s.manager.request({
        token: grant.token,
        method: "browser_tabs_list",
        args: {},
      }),
      { ok: true },
    );
    s.setRows([{ ...worker(), pid: 99 }]);
    await assert.rejects(
      s.manager.request({
        token: grant.token,
        method: "browser_tabs_list",
        args: {},
      }),
      /running|changed/,
    );
    assert.equal(s.authority.grants.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("wrong relay, stopped, shared or pending-restart workers cannot be assigned", async () => {
  const s = setup("/unused");
  for (const patch of [
    { relay_url: "wss://other.example" },
    { status: "stopped" },
    { respond_to: "anyone" },
    { needs_restart: true },
    { owner_identified: false },
    { backend: { type: "provider" } },
    { persona_orphaned: true },
  ]) {
    s.setRows([{ ...worker(), ...patch }]);
    assert.deepEqual(await s.manager.list(), []);
    await assert.rejects(s.manager.share({ id: "tab", pubkey, mode: "read" }));
  }
});
test("takeover and changed business cannot be resurrected by an awaited roster lookup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "managed-browser-test-"));
  try {
    const s = setup(root);
    await s.manager.share({ id: "tab", pubkey, mode: "read" });
    const [token] = s.authority.grants.keys();
    s.authority.revoke("tab");
    await assert.rejects(
      s.manager.request({ token, method: "browser_tabs_list", args: {} }),
    );
    s.setContext({ id: "different", relay });
    await assert.rejects(s.manager.share({ id: "tab", pubkey, mode: "read" }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("takeover cancels a share waiting on the native roster", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "managed-browser-test-"));
  try {
    const s = setup(root);
    let resolve;
    const pending = new Promise((r) => (resolve = r));
    s.manager.roster = () => pending;
    const sharing = s.manager.share({ id: "tab", pubkey, mode: "read" });
    s.authority.revoke("tab");
    resolve([worker()]);
    await assert.rejects(sharing, /changed|cancelled/);
    assert.equal(s.authority.grants.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an old validation cannot revoke a newer grant after takeover", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "managed-browser-test-"));
  try {
    const s = setup(root);
    await s.manager.share({ id: "tab", pubkey, mode: "read" });
    const [old] = s.authority.grants.keys();
    let resolve;
    const pending = new Promise((r) => (resolve = r));
    s.manager.roster = () => pending;
    const validation = s.manager.validate(old);
    s.authority.revoke("tab");
    s.manager.roster = async () => [worker()];
    await s.manager.share({ id: "tab", pubkey, mode: "read" });
    const [current] = s.authority.grants.keys();
    resolve([worker()]);
    await assert.rejects(validation);
    assert.equal(s.authority.grants.has(current), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two tabs sharing one worker cannot reorder grant-file replacements", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "managed-browser-test-"));
  try {
    const s = setup(root);
    s.authority.add({
      id: "second",
      workspace: "biz",
      url: "https://example.com",
    });
    let entered, release;
    const atRename = new Promise((resolve) => (entered = resolve));
    const held = new Promise((resolve) => (release = resolve));
    let replacements = 0;
    s.manager.replaceFile = async (from, to) => {
      replacements++;
      if (replacements === 1) {
        entered();
        await held;
      }
      await rename(from, to);
    };
    const first = s.manager.share({ id: "tab", pubkey, mode: "read" });
    await atRename;
    const second = s.manager.share({ id: "second", pubkey, mode: "read" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(replacements, 1);
    release();
    await Promise.all([first, second]);
    const saved = JSON.parse(
      await readFile(
        path.join(root, `${runtimeId(pubkey, relay)}.json`),
        "utf8",
      ),
    );
    assert.equal(s.authority.grants.get(saved.token).tabId, "second");
    assert.equal(s.authority.grants.size, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

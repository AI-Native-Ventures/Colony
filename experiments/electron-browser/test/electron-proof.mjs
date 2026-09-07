import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { connectMcp } from "./mcp-client.mjs";

function ref(snap, role, name) {
  const line = snap.outline
    .split("\n")
    .find((line) => line.includes(` ${role} ${name}`));
  assert.ok(line, `Missing ${role} ${name} in ${snap.outline}`);
  return line.split(" ")[0];
}

export async function runProof({ phase, app, window, manager, createGrant }) {
  const start = performance.now();
  const base = process.env.COLONY_PROOF_URL;
  const checks = [];
  const clients = [];
  async function worker(tab, mode = "interact", name = "fixture-worker") {
    const { file, grant } = await createGrant(tab.id, name, mode);
    const client = connectMcp(file);
    clients.push(client);
    await client.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "proof", version: "1" },
    });
    const list = await client.call("tools/list");
    assert.equal(list.tools.length, 5);
    return { client, grant };
  }
  try {
    if (phase === "restart") {
      assert.equal(await manager.restore(), true);
      assert.equal(manager.tabs.size, 3);
      const tabs = [...manager.tabs.values()];
      const colony = tabs.find((tab) => tab.workspace === "colony");
      const horizon = tabs.find((tab) => tab.workspace === "horizon");
      assert.equal(
        await colony.view.webContents.executeJavaScript(
          'localStorage.getItem("brand")',
        ),
        "Colony fixture",
      );
      assert.equal(
        await horizon.view.webContents.executeJavaScript(
          'localStorage.getItem("brand")',
        ),
        null,
      );
      const cookies = await colony.view.webContents.session.cookies.get({
        url: base,
        name: "fixture_brand",
      });
      assert.equal(decodeURIComponent(cookies[0].value), "Colony fixture");
      assert.equal(
        (
          await horizon.view.webContents.session.cookies.get({
            url: base,
            name: "fixture_brand",
          })
        ).length,
        0,
      );
      assert.equal(manager.authority.grants.size, 0);
      checks.push(
        "three tabs restored across process restart",
        "Colony cookie and storage persist",
        "Horizon remains isolated after restart",
        "grants do not survive restart",
      );
    } else {
      const colony = await manager.create("colony", `${base}/colony`);
      const horizon = await manager.create("horizon", `${base}/horizon`, {
        activate: false,
      });
      const second = await manager.create("colony", `${base}/second`, {
        activate: false,
      });
      assert.equal(manager.tabs.size, 3);
      for (const tab of [colony, horizon, second])
        assert.ok(window.contentView.children.includes(tab.view));
      checks.push("three real WebContentsView tabs attached to shell");
      const { client: c, grant } = await worker(colony);
      const { client: h } = await worker(horizon, "read", "other-worker");
      assert.deepEqual(
        (await c.tool("browser_tabs_list")).map((tab) => tab.id),
        [colony.id],
      );
      await assert.rejects(
        c.tool("browser_snapshot", { tabId: horizon.id }),
        /scope/,
      );
      assert.throws(
        () =>
          manager.authority.grant(colony.id, "competing-worker", "interact"),
        /already/,
      );
      checks.push(
        "MCP discovery is scoped",
        "cross-business access denied",
        "competing controller denied",
      );
      const [cs, hs] = await Promise.all([
        c.tool("browser_snapshot", { tabId: colony.id }),
        h.tool("browser_snapshot", { tabId: horizon.id }),
      ]);
      assert.ok(!cs.outline.includes("fixture-secret"));
      await assert.rejects(
        h.tool("browser_type", {
          tabId: horizon.id,
          ref: ref(hs, "textbox", "Caption"),
          text: "not permitted",
        }),
        /read-only/,
      );
      await assert.rejects(
        c.tool("browser_type", {
          tabId: colony.id,
          ref: ref(cs, "textbox", "Secret"),
          text: "not permitted",
        }),
        /could not/,
      );
      await c.tool("browser_type", {
        tabId: colony.id,
        ref: ref(cs, "textbox", "Caption"),
        text: "Colony fixture",
      });
      let snap = await c.tool("browser_snapshot", { tabId: colony.id });
      await c.tool("browser_click", {
        tabId: colony.id,
        ref: ref(snap, "button", "Preview draft"),
      });
      assert.equal(
        await colony.view.webContents.executeJavaScript(
          'document.getElementById("preview").textContent',
        ),
        "Draft ready: Colony fixture",
      );
      snap = await c.tool("browser_snapshot", { tabId: colony.id });
      assert.match(snap.outline, /Draft ready: Colony fixture/);
      const draftPng = await c.tool("browser_screenshot", { tabId: colony.id });
      await writeFile(
        path.join(process.env.COLONY_PROOF_EVIDENCE, "draft-preview.png"),
        Buffer.from(draftPng, "base64"),
      );
      await c.tool("browser_click", {
        tabId: colony.id,
        ref: ref(snap, "button", "Remember fixture session"),
      });
      await manager.flush();
      checks.push(
        "two workers read independent tabs concurrently",
        "read-only and password guards enforced",
        "stdio MCP worker changed actual visible page",
      );
      // loadURL gives a deterministic completion boundary; reload returns void.
      await second.view.webContents.loadURL(`${base}/second`);
      assert.equal(
        await second.view.webContents.executeJavaScript(
          'localStorage.getItem("brand")',
        ),
        "Colony fixture",
      );
      assert.equal(
        await horizon.view.webContents.executeJavaScript(
          'localStorage.getItem("brand")',
        ),
        null,
      );
      checks.push(
        "same-business tabs share storage",
        "other business storage isolated",
      );
      const remoteBridge = await colony.view.webContents.executeJavaScript(
        "({ node: typeof require, bridge: typeof window.colonyBrowser, process: typeof process })",
      );
      assert.deepEqual(remoteBridge, {
        node: "undefined",
        bridge: "undefined",
        process: "undefined",
      });
      checks.push("remote page has no Node or shell bridge");
      snap = await c.tool("browser_snapshot", { tabId: colony.id });
      const oldRef = ref(snap, "button", "Preview draft");
      await colony.view.webContents.loadURL(`${base}/after-navigation`);
      await assert.rejects(
        c.tool("browser_click", { tabId: colony.id, ref: oldRef }),
        /stale/,
      );
      checks.push("navigation rejects stale references");
      let release;
      colony.queue = new Promise((resolve) => {
        release = resolve;
      });
      const pending = manager.request({
        token: grant.token,
        method: "browser_snapshot",
        args: { tabId: colony.id },
      });
      manager.takeover(colony.id);
      release();
      await assert.rejects(pending, /revoked/);
      await assert.rejects(
        c.tool("browser_snapshot", { tabId: colony.id }),
        /revoked/,
      );
      checks.push(
        "human takeover blocks queued and subsequent worker commands",
      );
      const { client: replacement } = await worker(
        colony,
        "read",
        "replacement-worker",
      );
      const png = await replacement.tool("browser_screenshot", {
        tabId: colony.id,
      });
      assert.ok(Buffer.from(png, "base64").length > 1000);
      await writeFile(
        path.join(process.env.COLONY_PROOF_EVIDENCE, "worker-page.png"),
        Buffer.from(png, "base64"),
      );
      checks.push("MCP screenshot returns real page pixels");
      const shell = await window.webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: false,
      });
      await writeFile(
        path.join(process.env.COLONY_PROOF_EVIDENCE, "shell.png"),
        shell.toPNG(),
      );
    }
    return {
      phase,
      checks,
      elapsedMs: Math.round(performance.now() - start),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      viewport: window.getContentSize(),
      hiddenWindow: true,
      metrics: app.getAppMetrics().map((metric) => ({
        type: metric.type,
        cpu: metric.cpu,
        memory: metric.memory,
      })),
      limitations:
        "Deterministic fixture and scripted MCP client. Not a model-driven or authenticated Instagram proof.",
    };
  } finally {
    for (const client of clients) client.close();
  }
}

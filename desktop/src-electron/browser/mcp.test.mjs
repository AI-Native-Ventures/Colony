import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { startBroker } from "./broker.mjs";

test("persistent MCP process starts without access and reads late grants on every call", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "colony-mcp-test-"));
  const file = path.join(root, "grant.json");
  const socketPath = path.join(root, "broker.sock");
  let expected = "first";
  const stop = await startBroker(socketPath, (req) => {
    if (req.token !== expected) throw Error("revoked");
    return [{ id: "tab", title: "Fixture" }];
  });
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./mcp.mjs", import.meta.url)), file],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const responses = new Map();
  let sequence = 0;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    responses.get(message.id)?.(message);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => reject(Error("MCP timeout")), 5000);
      responses.set(id, (m) => {
        clearTimeout(timer);
        responses.delete(id);
        resolve(m);
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  try {
    assert.equal(
      (await call("initialize")).result.serverInfo.name,
      "colony-electron-browser",
    );
    const listed = (await call("tools/list")).result.tools;
    assert.equal(listed.length, 6);
    assert.deepEqual(
      listed.find((tool) => tool.name === "mail_send")?.inputSchema.required,
      ["tabId", "to", "subject", "body"],
    );
    const args = { name: "browser_tabs_list", arguments: {} };
    assert.equal((await call("tools/call", args)).result.isError, true);
    await writeFile(file, JSON.stringify({ socketPath, token: "first" }), {
      mode: 0o600,
    });
    assert.match(
      (await call("tools/call", args)).result.content[0].text,
      /Fixture/,
    );
    expected = "second";
    assert.equal((await call("tools/call", args)).result.isError, true);
    await writeFile(file, JSON.stringify({ socketPath, token: "second" }), {
      mode: 0o600,
    });
    assert.match(
      (await call("tools/call", args)).result.content[0].text,
      /Fixture/,
    );
    const evidenceToken = "e".repeat(64);
    expected = evidenceToken;
    await writeFile(
      file,
      JSON.stringify({ socketPath, evidence: { token: evidenceToken } }),
      { mode: 0o600 },
    );
    const evidenceTools = (await call("tools/list")).result.tools;
    assert.equal(evidenceTools.length, 16);
    assert.equal(
      evidenceTools.some((tool) => tool.name === "evidence_capture_png"),
      true,
    );
    assert.match(
      (
        await call("tools/call", {
          name: "evidence_tabs_list",
          arguments: {},
        })
      ).result.content[0].text,
      /Fixture/,
    );
    assert.match(
      (await call("tools/call", args)).result.content[0].text,
      /No browser tab is shared/,
    );
    await rm(file);
    assert.equal((await call("tools/call", args)).result.isError, true);
  } finally {
    lines.close();
    child.kill();
    await stop();
    await rm(root, { recursive: true, force: true });
  }
});

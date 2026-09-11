// Real Electron + real WebContentsView + real CDP + the real MCP server process
// proving the mail_send journey. Nothing here is mocked: the tool call travels
// from a spawned `mcp.mjs` over the unix-socket broker into a live page. The
// page is the same Gmail compose fixture the Rust journey is proven against,
// served over local HTTP because tab authority accepts only HTTP(S) URLs.
import { BrowserWindow, app } from "electron";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { startBroker } from "./broker.mjs";
import { BrowserViews } from "./views.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const message = {
  to: "lead@example.com",
  subject: "Winter boiler special",
  body: "Hi team, our winter special is live.",
};

/** One MCP client over a spawned `mcp.mjs`, speaking newline JSON-RPC. */
function mcpClient(grantPath) {
  const child = spawn(
    process.execPath,
    [path.join(here, "mcp.mjs"), grantPath],
    {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  const pending = new Map();
  let sequence = 0;
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const reply = JSON.parse(line);
    pending.get(reply.id)?.(reply);
    pending.delete(reply.id);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => reject(new Error("MCP timeout")), 120000);
      pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  return { call, stop: () => child.kill() };
}

async function prove() {
  const fixture = await readFile(
    path.join(
      here,
      "../../../crates/buzz-browser/test-fixtures/gmail-compose.html",
    ),
    "utf8",
  );
  const data = await mkdtemp(path.join(os.tmpdir(), "colony-mail-proof-"));
  const socketPath = path.join(data, "browser.sock");
  const grantPath = path.join(data, "grant.json");
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(fixture);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const pageUrl = `http://127.0.0.1:${server.address().port}/gmail-compose.html`;

  // Never shown: a focused window would let a stray keystroke or click on the
  // human's machine trigger the tab-takeover handler mid-journey.
  const window = new BrowserWindow({ width: 1280, height: 900, show: false });
  const views = new BrowserViews(window, () => {});
  let client;
  let stopBroker;
  try {
    views.setBusiness("mail-proof");
    await views.open({ id: "mail-tab", business: "mail-proof", url: pageUrl });
    const tab = views.get("mail-tab");
    if (tab.view.webContents.isLoading())
      await new Promise((resolve) =>
        tab.view.webContents.once("did-finish-load", resolve),
      );
    tab.view.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
    tab.view.setVisible(true);
    stopBroker = await startBroker(socketPath, (request) =>
      views.request(request),
    );

    // The compose form does not exist until the journey clicks Compose itself.
    assert.equal(
      await tab.view.webContents.executeJavaScript(
        "document.getElementById('compose-box').hidden",
      ),
      true,
      "the fixture must start with the compose form closed",
    );

    const share = async (mode) => {
      views.authority.revoke("mail-tab");
      const grant = views.authority.grant("mail-tab", "Sales", mode);
      await writeFile(
        grantPath,
        JSON.stringify({ socketPath, token: grant.token }),
        {
          mode: 0o600,
        },
      );
    };
    await share("interact");
    client = mcpClient(grantPath);
    assert.equal(
      (await client.call("initialize")).result.serverInfo.name,
      "colony-electron-browser",
    );
    const listed = (await client.call("tools/list")).result.tools;
    assert.ok(
      listed.some((tool) => tool.name === "mail_send"),
      "the Electron MCP server must expose mail_send",
    );

    const reply = await client.call("tools/call", {
      name: "mail_send",
      arguments: { tabId: "mail-tab", ...message },
    });
    assert.ok(!reply.result.isError, reply.result.content?.[0]?.text);
    const result = JSON.parse(reply.result.content[0].text);
    assert.equal(
      result.status,
      "sent",
      `failure_reason: ${result.failure_reason}`,
    );
    assert.equal(result.failure_reason, null);
    assert.equal(result.to, message.to);
    assert.equal(result.subject, message.subject);
    const png = Buffer.from(result.screenshot_png_base64 ?? "", "base64");
    assert.ok(
      png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      "the result must carry a real PNG screenshot",
    );

    const recorded = JSON.parse(
      await tab.view.webContents.executeJavaScript(
        "document.getElementById('sent').textContent",
      ),
    );
    assert.deepEqual(
      recorded,
      message,
      "the page itself must have recorded all three fields",
    );

    // A read-only grant cannot run the journey at all.
    await share("read");
    const denied = await client.call("tools/call", {
      name: "mail_send",
      arguments: { tabId: "mail-tab", ...message },
    });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /read-only/);

    console.log("Page recorded:", JSON.stringify(recorded));
    console.log("Screenshot bytes:", png.length);
    console.log("sent_at:", result.sent_at);
    console.log(
      "Read-only grant refused mail_send:",
      denied.result.content[0].text,
    );
    console.log(
      "Electron mail_send from the shared tab's Compose button: PASS",
    );
  } finally {
    client?.stop();
    await stopBroker?.();
    await views.closeAll();
    await new Promise((resolve) => server.close(resolve));
    await rm(data, { recursive: true, force: true });
  }
}

app.whenReady().then(async () => {
  try {
    await prove();
    app.exit(0);
  } catch (error) {
    console.error("Electron mail_send proof FAILED:", error.message);
    app.exit(1);
  }
});

// Real Electron + real WebContentsView + real CDP + the real MCP server process
// proving the mail_send journey. Nothing here is mocked: the tool call travels
// from a spawned `mcp.mjs` over the unix-socket broker into a live page. The
// page is the same Gmail compose fixture the Rust journey is proven against,
// served over local HTTP because tab authority accepts only HTTP(S) URLs.
//
// The runner launches this file twice, because the agent-facing tool is gated
// on the main process environment. With BUZZ_BROWSER_MAIL_SEND=enabled it
// proves the worker path; without the variable it proves that a worker holding
// a valid write grant still cannot send by talking to the broker directly, and
// that the owner-side path works anyway, since the owner never goes through
// that gate.
import { BrowserWindow, app } from "electron";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { requestBroker, startBroker } from "./broker.mjs";
import { mailSendEnabledFromEnv } from "./mail-journey.mjs";
import { executeOutreachSend } from "./outreach-send.mjs";
import { BrowserViews } from "./views.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const message = {
  to: "lead@example.com",
  subject: "Winter boiler special",
  body: "Hi team, our winter special is live.",
};

// What the owner approves on the card, sent from the tab the owner is looking
// at. Deliberately different from the agent-tool message above, so the page's
// own record proves which path filled the form.
const approved = {
  to: "owner-lead@example.com",
  subject: "Your winter service slot",
  body: "Hi, we have a slot free on Thursday.",
};
const APPROVAL_ID = "d".repeat(64);

/**
 * One MCP client over a spawned `mcp.mjs`, speaking newline JSON-RPC.
 *
 * `mail_send` is gated on `BUZZ_BROWSER_MAIL_SEND=enabled` the way the Rust
 * daemon gates it, so the worker environment is explicit here rather than
 * inherited from whoever ran the proof.
 */
function mcpClient(grantPath, mailSend = "enabled") {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  if (mailSend) env.BUZZ_BROWSER_MAIL_SEND = mailSend;
  else delete env.BUZZ_BROWSER_MAIL_SEND;
  const child = spawn(
    process.execPath,
    [path.join(here, "mcp.mjs"), grantPath],
    {
      stdio: ["pipe", "pipe", "inherit"],
      env,
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

/**
 * The second launch: no gate value in the environment.
 *
 * It proves the gate is the main process's, not the adapter's, and that the
 * owner-side send does not depend on the gate at all.
 */
async function proveOwnerSide({ views, tab, share, socketPath, pageUrl }) {
  // A worker with a real write grant, skipping `mcp.mjs` and speaking to the
  // broker socket itself, which is all a worker with a shell needs.
  await share("interact");
  const token = [...views.authority.grants.keys()][0];
  const refusal = await requestBroker(socketPath, {
    token,
    method: "mail_send",
    args: { tabId: "mail-tab", ...message },
  }).then(
    (result) => {
      throw new Error(
        `the broker ran mail_send for an ungated worker: ${JSON.stringify(result)}`,
      );
    },
    (error) => error.message,
  );
  assert.match(
    refusal,
    /^mail_send is disabled: /,
    "the main process must refuse mail_send, not only the adapter",
  );
  assert.equal(
    await tab.view.webContents.executeJavaScript(
      "document.getElementById('compose-box').hidden",
    ),
    true,
    "a refused journey must not have opened the compose form",
  );

  // The same grant still reads the page, so only mail_send is gated.
  const observed = await requestBroker(socketPath, {
    token,
    method: "browser_snapshot",
    args: { tabId: "mail-tab" },
  });
  assert.match(observed.outline, /button Compose/);

  // The owner-side path: no grant, no MCP, the same function main.mjs calls
  // when the renderer invokes `execute_outreach_send` on an approved card.
  const deps = {
    attempted: new Set(),
    allowedHosts: [new URL(pageUrl).host],
    tabs: () => views.ownerTabs(),
    send: ({ tabId, ...fields }) => views.ownerMailSend(tabId, fields),
  };
  const approval = {
    instanceEventId: "e".repeat(64),
    actionEventId: APPROVAL_ID,
    data: {
      destination: approved.to,
      content: { subject: approved.subject, body: approved.body },
    },
  };

  // The write grant above still stands, so the tab is a teammate's.
  const held = await executeOutreachSend(approval, deps);
  assert.equal(held.status, "failed");
  assert.match(held.failure_reason, /^A teammate is using your Gmail tab\./);

  // The owner takes the tab back, exactly as a click in the tab would.
  views.takeover("mail-tab");
  const owned = await executeOutreachSend(approval, deps);
  assert.equal(
    owned.status,
    "sent",
    `owner-side failure_reason: ${owned.failure_reason}`,
  );
  assert.equal(owned.to, approved.to);
  assert.equal(owned.subject, approved.subject);
  assert.equal(
    owned.screenshot_png_base64,
    undefined,
    "the owner-side shape is the Tauri command's, which carries no screenshot",
  );
  const ownerRecorded = JSON.parse(
    await tab.view.webContents.executeJavaScript(
      "document.getElementById('sent').textContent",
    ),
  );
  assert.deepEqual(
    ownerRecorded,
    approved,
    "the page must have recorded exactly what the owner approved",
  );

  // A replayed approval never fills the form again.
  const replay = await executeOutreachSend(approval, deps);
  assert.equal(replay.status, "failed");
  assert.match(replay.failure_reason, /already sent from this desktop/);

  console.log("Worker through the broker refused:", refusal);
  console.log("Owner-side page recorded:", JSON.stringify(ownerRecorded));
  console.log("Owner-side replay refused:", replay.failure_reason);
  console.log("Electron owner-side execute_outreach_send: PASS");
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
    if (!mailSendEnabledFromEnv()) {
      await proveOwnerSide({ views, tab, share, socketPath, pageUrl });
      return;
    }

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

    // An agent worker with no gate set cannot call the tool at all.
    const ungated = mcpClient(grantPath, null);
    const gated = await ungated.call("tools/call", {
      name: "mail_send",
      arguments: { tabId: "mail-tab", ...message },
    });
    ungated.stop();
    assert.equal(gated.result.isError, true);
    assert.match(gated.result.content[0].text, /^mail_send is disabled: /);

    console.log("Page recorded:", JSON.stringify(recorded));
    console.log("Screenshot bytes:", png.length);
    console.log("sent_at:", result.sent_at);
    console.log(
      "Read-only grant refused mail_send:",
      denied.result.content[0].text,
    );
    console.log("Ungated adapter refused:", gated.result.content[0].text);
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

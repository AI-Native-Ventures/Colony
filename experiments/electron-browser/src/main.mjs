import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, writeFile, rm, mkdtemp } from "node:fs/promises";
import os from "node:os";
import { BrowserManager } from "./browser.mjs";
import { startBroker } from "./broker.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateDir = path.resolve(
  process.env.COLONY_BROWSER_STATE_DIR || path.join(root, ".state"),
);
await mkdir(stateDir, { recursive: true, mode: 0o700 });
app.setPath("userData", path.join(stateDir, "user-data"));
app.setName("Colony Browser Prototype");
const proof = process.argv
  .find((arg) => arg.startsWith("--proof="))
  ?.split("=")[1];
if (proof && process.platform === "darwin") app.dock.hide();
// Let Electron finish loading this ESM entry before awaiting its ready event.
// Awaiting ready at module top level deadlocks startup on Electron 44.
async function boot() {
  await app.whenReady();
  if (proof) console.log(`Electron proof ${proof}: app ready`);
  Menu.setApplicationMenu(null);

  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: "Colony · Shared Browser Prototype",
    show: false,
    backgroundColor: "#f4f0fa",
    webPreferences: {
      preload: path.join(root, "src/preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "colony-eb-"));
  const socketPath = path.join(runtimeDir, "browser.sock");
  const grants = new Map();
  let lastGrantFile = null;
  let manager;
  const state = () => ({ ...manager.state(), lastGrantFile });
  manager = new BrowserManager(window, stateDir, () => {
    if (!window.isDestroyed())
      window.webContents.send("browser:state", state());
    for (const [token, file] of grants)
      if (!manager.authority.grants.has(token)) {
        grants.delete(token);
        void rm(file, { force: true }).catch(() => {});
        if (lastGrantFile === file) lastGrantFile = null;
      }
  });
  const stopBroker = await startBroker(socketPath, (request) =>
    manager.request(request),
  );

  async function createGrant(tabId, worker, mode) {
    const grant = manager.authority.grant(tabId, worker, mode);
    const file = path.join(runtimeDir, `${tabId}.json`);
    await writeFile(file, JSON.stringify({ socketPath, token: grant.token }), {
      mode: 0o600,
    });
    grants.set(grant.token, file);
    lastGrantFile = file;
    manager.changed();
    return { grant, file };
  }

  ipcMain.handle("browser:command", async (event, command) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("Untrusted IPC sender");
    if (!command || typeof command !== "object")
      throw new Error("Invalid command");
    const { action, tabId } = command;
    switch (action) {
      case "state":
        return state();
      case "create":
        await manager.create(command.workspace, command.url);
        break;
      case "select":
        manager.select(tabId);
        break;
      case "close":
        manager.close(tabId);
        break;
      case "navigate":
        await manager.navigate(tabId, command.url);
        break;
      case "takeover":
        manager.takeover(tabId);
        break;
      case "grant":
        await createGrant(tabId, command.worker, command.mode);
        break;
      case "back": {
        const tab = manager.tabs.get(tabId);
        if (!tab) throw new Error("Tab closed");
        manager.takeover(tabId);
        if (tab.view.webContents.navigationHistory.canGoBack())
          tab.view.webContents.navigationHistory.goBack();
        break;
      }
      case "reload": {
        const tab = manager.tabs.get(tabId);
        if (!tab) throw new Error("Tab closed");
        manager.takeover(tabId);
        tab.view.webContents.reload();
        break;
      }
      default:
        throw new Error("Unknown shell action");
    }
    return state();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler(
    (_wc, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on("resize", () => manager.layout());
  let closing = false;
  window.on("close", (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    void (async () => {
      await manager.flush();
      manager.destroy();
      await stopBroker();
      await rm(runtimeDir, { recursive: true, force: true });
    })().finally(() => {
      window.destroy();
      app.quit();
    });
  });
  await window.loadFile(path.join(root, "ui/index.html"));

  if (proof) {
    const { runProof } = await import("../test/electron-proof.mjs");
    try {
      const result = await runProof({
        phase: proof,
        app,
        window,
        manager,
        createGrant,
        socketPath,
      });
      await manager.flush();
      await writeFile(
        process.env.COLONY_PROOF_OUTPUT,
        JSON.stringify(result, null, 2),
      );
      console.log(`Electron proof ${proof}: PASS`);
    } catch (error) {
      console.error(`Electron proof ${proof}: FAIL`, error.stack);
      process.exitCode = 1;
    }
    manager.destroy();
    await stopBroker();
    await rm(runtimeDir, { recursive: true, force: true });
    closing = true;
    window.destroy();
    app.exit(process.exitCode || 0);
  } else {
    // Show the controls before loading external sites, which may be slow or offline.
    window.showInactive();
    if (!(await manager.restore()))
      await manager.create("colony", "https://www.instagram.com/");
    console.log(
      "Colony browser prototype ready. Browser data remains in its isolated profile.",
    );
  }
}
void boot().catch((error) => {
  console.error("Prototype startup failed:", error.message);
  app.exit(1);
});

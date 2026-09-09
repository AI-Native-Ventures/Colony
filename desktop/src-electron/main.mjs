import { Cleanup } from "./cleanup.mjs";
import { createHash } from "node:crypto";
import { SignInImport } from "./browser-import/manager.mjs";
import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  protocol,
  net,
} from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import { NativeHost } from "./native-host.mjs";
import { RendererHost } from "./renderer-host.mjs";
import { BrowserViews } from "./browser/views.mjs";
import { startBroker } from "./browser/broker.mjs";
import { shellCommand } from "./shell-commands.mjs";
import { ManagedBrowser, normalizeRelay } from "./browser/managed-workers.mjs";
import { runtimePaths } from "./runtime-paths.mjs";
import { DesktopDeepLinks } from "./deep-links.mjs";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const packageMetadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const paths = runtimePaths({
  packaged: app.isPackaged,
  appPath: desktop,
  resourcesPath: process.resourcesPath,
  env: process.env,
  channel: packageMetadata.colonyReleaseChannel,
});
const { devUrl } = paths;
app.setName(paths.name);
app.setPath(
  "userData",
  process.env.COLONY_ELECTRON_USER_DATA ||
    path.join(app.getPath("appData"), paths.profile),
);
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
const deepLinks = new DesktopDeepLinks();
app.on("open-url", (event, url) => {
  event.preventDefault();
  deepLinks.enqueue(url);
});
app.on("second-instance", (_event, argv) => {
  for (const value of argv) deepLinks.enqueue(value);
});
for (const value of process.argv) deepLinks.enqueue(value);
protocol.registerSchemesAsPrivileged([
  {
    scheme: "colony",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

const resources = new Cleanup();
const cleanup = () => resources.run();

async function boot() {
  await app.whenReady();
  const config = JSON.parse(await readFile(paths.config, "utf8"));
  // Both Vite's refresh preamble and the built app's theme bootstrap are
  // inline. Authorize only scripts in our own entry document by content hash.
  const html = devUrl
    ? await (await fetch(devUrl)).text()
    : await readFile(path.join(desktop, "dist/index.html"), "utf8");
  const hashes = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter((match) => !/\bsrc=/.test(match[1]) && match[2].trim())
    .map(
      (match) =>
        ` 'sha256-${createHash("sha256").update(match[2]).digest("base64")}'`,
    )
    .join("");
  const csp = config.app.security.csp.replace(
    "script-src 'self'",
    `script-src 'self'${hashes}`,
  );
  protocol.handle("colony", async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "app")
      return new Response("Not found", { status: 404 });
    const assetRoot = path.join(desktop, "dist");
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.resolve(
      assetRoot,
      !relative || !path.extname(relative) ? "index.html" : relative,
    );
    if (!file.startsWith(assetRoot + path.sep))
      return new Response("Not found", { status: 404 });
    const response = await net.fetch(pathToFileURL(file).href);
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", csp);
    return new Response(response.body, { status: response.status, headers });
  });
  const runtime = await mkdtemp(path.join(os.tmpdir(), "colony-browser-"));
  resources.add(() => rm(runtime, { recursive: true, force: true }));
  const profileId =
    paths.stable && !process.env.COLONY_ELECTRON_USER_DATA
      ? "stable"
      : createHash("sha256")
          .update(app.getPath("userData"))
          .digest("hex")
          .slice(0, 16);
  const host = new NativeHost(paths.nativeHost, {
    env: {
      ...process.env,
      COLONY_ELECTRON_BROWSER_ROOT: runtime,
      COLONY_ELECTRON_BROWSER_COMMAND: process.execPath,
      COLONY_ELECTRON_BROWSER_ADAPTER: path.join(
        desktop,
        "src-electron/browser/mcp.mjs",
      ),
      COLONY_ELECTRON_PACKAGED: app.isPackaged ? "1" : "0",
      COLONY_ELECTRON_PROFILE_ID: profileId,
      // Old installed Tauri versions look for a known host basename and its
      // full instance ID in the environment before reaping foreign workers.
      COLONY_ELECTRON_INSTANCE_ID:
        profileId === "stable"
          ? "xyz.block.buzz.app"
          : `xyz.block.buzz.app.dev-electron.${profileId}`,
    },
  });
  const rendererHost = new RendererHost(host);
  resources.add(() => host.close());
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    show: false,
    title: "Colony",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#17151b",
    webPreferences: {
      preload: path.join(desktop, "src-electron/preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const send = (message) => {
    if (!window.isDestroyed()) window.webContents.send("colony:event", message);
  };
  const views = new BrowserViews(window, (payload) =>
    send({ type: "browser", payload }),
  );
  resources.add(() => views.closeAll());
  const createImports = () => {
    const generation = rendererHost.generation;
    return new SignInImport({
      sessionFor(business) {
        // A prompt/read from a discarded renderer cannot resume merely because
        // the replacement renderer selects the same business again.
        rendererHost.check(generation);
        return views.sessionFor(business);
      },
    });
  };
  let imports = createImports();
  const socketPath = path.join(runtime, "browser.sock");
  let businessContext = null;
  const managedBrowser = new ManagedBrowser({
    root: runtime,
    socketPath,
    views,
    context: () => businessContext,
    roster: () =>
      rendererHost.request("invoke", {
        command: "list_managed_agents",
        args: {},
      }),
  });
  const stopBroker = await startBroker(socketPath, (request) =>
    managedBrowser.bindings.has(request.token)
      ? managedBrowser.request(request)
      : views.request(request),
  );
  resources.add(stopBroker);
  if (devUrl)
    window.webContents.session.webRequest.onHeadersReceived(
      { urls: ["http://127.0.0.1:1425/*"] },
      (details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            "Content-Security-Policy": [csp],
          },
        });
      },
    );
  rendererHost.on("event", send);
  rendererHost.on("channel", send);
  host.on("disconnected", (message) =>
    send({ type: "shell", name: "disconnected", payload: message }),
  );
  window.on("resize", () => send({ type: "shell", name: "resize" }));
  nativeTheme.on("updated", () =>
    send({
      type: "shell",
      name: "theme",
      payload: nativeTheme.shouldUseDarkColors ? "dark" : "light",
    }),
  );
  const origin = devUrl ? new URL(devUrl).origin : "colony://app";
  const trusted = (url) =>
    devUrl ? new URL(url).origin === origin : url.startsWith("colony://app/");
  window.webContents.on("will-navigate", (event, url) => {
    if (!trusted(url)) event.preventDefault();
  });
  let initialNavigation = true;
  window.webContents.on(
    "did-start-navigation",
    (_event, _url, inPlace, mainFrame) => {
      if (!mainFrame || inPlace) return;
      if (initialNavigation) {
        initialNavigation = false;
        return;
      }
      // Revocation is synchronous; cleanup fences new native calls until all
      // resources from the previous renderer have been retired.
      businessContext = null;
      views.setBusiness(null);
      const resetting = rendererHost.reset();
      imports = createImports();
      void resetting.catch(() => {
        send({
          type: "shell",
          name: "disconnected",
          payload: "Native renderer cleanup failed; restart the desktop",
        });
      });
    },
  );
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.session.setPermissionRequestHandler(
    (_wc, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);

  const dispatch = async (event, type, payload = {}) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !trusted(event.senderFrame.url)
    )
      throw new Error("Untrusted desktop caller");
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("Invalid request");
    if (
      type === "invoke" &&
      ["import_identity", "sign_out"].includes(payload.command)
    ) {
      businessContext = null;
      views.setBusiness(null);
    }
    if (["invoke", "listen", "unlisten", "emit"].includes(type))
      return rendererHost.request(type, payload);
    if (type === "shell") return shellCommand(window, payload);
    if (type === "business") {
      const relay = payload.relay ? normalizeRelay(payload.relay) : null;
      if (
        businessContext?.id !== payload.id ||
        businessContext?.relay !== relay
      ) {
        views.setBusiness(null);
        businessContext = payload.id ? { id: payload.id, relay } : null;
      }
      views.setBusiness(payload.id);
      return;
    }
    if (type === "import:discover") return imports.discoverProfiles();
    if (type === "import:sites") return imports.list(payload);
    if (type === "import:run") return imports.import(payload);
    if (type === "browser:open") return views.open(payload);
    if (type === "browser:bounds") return views.bounds(payload);
    if (type === "browser:action") return views.action(payload);
    if (type === "browser:close") return views.close(payload.id);
    if (type === "browser:workers") return managedBrowser.list();
    if (type === "browser:share") return managedBrowser.share(payload);
    if (type === "browser:grant") {
      const tab = views.get(payload.id);
      const grant = views.authority.grant(tab.id, payload.worker, payload.mode);
      const grantPath = path.join(runtime, `${grant.token}.json`);
      await writeFile(
        grantPath,
        JSON.stringify({ socketPath, token: grant.token }),
        { mode: 0o600 },
      );
      views.notify(tab);
      return {
        grantPath,
        command: process.execPath,
        env: { ELECTRON_RUN_AS_NODE: "1" },
        adapter: path.join(desktop, "src-electron/browser/mcp.mjs"),
      };
    }
    throw new Error("Unsupported desktop request");
  };
  ipcMain.handle("colony:request", async (...args) => {
    try {
      return { ok: true, result: await dispatch(...args) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : error,
      };
    }
  });
  let closing = false;
  window.on("close", (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    void cleanup().finally(() => {
      window.destroy();
      app.quit();
    });
  });
  await window.loadURL(devUrl || "colony://app/");
  await window.webContents.insertCSS(
    "[data-tauri-drag-region]{-webkit-app-region:drag} [data-tauri-drag-region] button,[data-tauri-drag-region] input{-webkit-app-region:no-drag}",
  );
  window.showInactive();
  await host.ready;
  deepLinks.ready((url) => {
    void host
      .request("invoke", { command: "electron_open_deep_link", args: { url } })
      .catch(() => {
        console.error("Colony could not open the requested app link");
      });
  });
}
if (primaryInstance)
  void boot().catch(async (error) => {
    console.error("Colony Electron startup failed:", error.message);
    await cleanup();
    app.exit(1);
  });

// Test-only shell: real preload/controller/preview; account and relay are fixtures.
import { app, BrowserWindow, WebContentsView, View, session, protocol, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { createHandoverSaver } from "./save.mjs";
import { createWebsitePreviewHost } from "./host.mjs";
import { PreviewController } from "./controller.mjs";
import { PREVIEW_SCHEME_DESCRIPTOR } from "./scheme.mjs";
import { site } from "./proof-fixture.mjs";
if (process.env.GITHUB_ACTIONS !== "true") throw new Error("Hosted CI proof only");
protocol.registerSchemesAsPrivileged([PREVIEW_SCHEME_DESCRIPTOR]);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1440, height: 1000, show: true,
    webPreferences: { preload: fileURLToPath(new URL("../preload.cjs", import.meta.url)), contextIsolation: true, nodeIntegration: false },
  });
  const host = createWebsitePreviewHost({ WebContentsView, View, session, clipStrategy: "clip", loadPreview: async () => site });
  const community = { id: "e2e-default-community" };
  const controller = new PreviewController({ host, window, context: () => community,
    // Only the native save dialog is substituted; the UI, IPC and archive are real.
    saveHandover: createHandoverSaver(window, {
      async showSaveDialog(_window, options) {
        const filePath = process.env.COLONY_PROOF_HANDOVER_PATH;
        globalThis.previewProof.savedFilename = options.defaultPath;
        return { canceled: !filePath, filePath };
      },
    }),
  });
  globalThis.previewProof = { host, controller };
  ipcMain.handle("colony:request", async (event, type, payload) => {
    try {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !type.startsWith("preview:")) throw new Error("Untrusted proof request");
      return { ok: true, result: await controller.request(type.slice(8), payload) };
    } catch (error) { return { ok: false, error: { message: error.message } }; }
  });
  window.on("closed", () => { void host.closeAll(); });
  await window.loadURL("about:blank");
});

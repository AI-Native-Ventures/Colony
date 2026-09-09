import { app, shell } from "electron";
import os from "node:os";
import { readFile } from "node:fs/promises";

/** Closed allowlist of shell operations; never dispatch arbitrary Electron APIs. */
export async function shellCommand(window, args) {
  switch (args.operation) {
    case "version":
      // Direct development entry points otherwise report Electron's version.
      return JSON.parse(
        await readFile(new URL("../package.json", import.meta.url), "utf8"),
      ).version;
    case "homeDir":
      return os.homedir();
    case "openUrl": {
      const url = new URL(args.url);
      if (
        !["https:", "http:", "mailto:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("Unsupported external URL");
      return shell.openExternal(url.href);
    }
    case "relaunch":
      app.relaunch();
      app.quit();
      return;
    case "notificationPermission":
      return false; // Permission has not been established for the opt-in shell.
    case "requestNotificationPermission":
      return "default";
    case "isFullscreen":
      return window.isFullScreen();
    case "badgeCount":
      app.setBadgeCount(
        Number.isInteger(args.count) && args.count >= 0 ? args.count : 0,
      );
      return;
    case "badgeLabel":
      if (app.dock)
        app.dock.setBadge(
          typeof args.label === "string" ? args.label.slice(0, 32) : "",
        );
      return;
    case "attention":
      if (app.dock)
        app.dock.bounce(
          args.kind === "Critical" ? "critical" : "informational",
        );
      return;
    case "unminimize":
      if (window.isMinimized()) window.restore();
      return;
    case "show":
      window.showInactive();
      return;
    case "focus":
      return; // Initial/recovery app callbacks must not steal focus.
    case "close":
      window.close();
      return;
    case "startDragging":
      return; // Electron uses CSS app-region drag on existing drag regions.
    case "zoom": {
      if (!Number.isFinite(args.value) || args.value < 0.5 || args.value > 3)
        throw new Error("Invalid zoom");
      window.webContents.setZoomFactor(args.value);
      return;
    }
    default:
      throw new Error("Unsupported shell operation");
  }
}

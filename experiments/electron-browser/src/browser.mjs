import { WebContentsView, session } from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Authority, normalizeUrl } from "./authority.mjs";
import { snapshot, screenshot, actOnRef } from "./page-tools.mjs";

export const WORKSPACES = ["colony", "horizon"];
const METHODS = new Set([
  "browser_tabs_list",
  "browser_snapshot",
  "browser_screenshot",
  "browser_click",
  "browser_type",
]);

export class BrowserManager {
  authority = new Authority();
  tabs = new Map();
  activeId = null;
  configuredSessions = new Set();

  constructor(window, stateDir, onChange = () => {}) {
    this.window = window;
    this.stateDir = stateDir;
    this.onChange = onChange;
  }

  state() {
    return {
      activeId: this.activeId,
      tabs: [...this.tabs.values()].map((tab) => {
        const grant = [...this.authority.grants.values()].find(
          (g) => g.tabId === tab.id,
        );
        return {
          id: tab.id,
          workspace: tab.workspace,
          title: tab.view.webContents.getTitle() || "New tab",
          url: tab.view.webContents.getURL() || tab.url,
          loading: tab.view.webContents.isLoading(),
          controller: grant ? `${grant.worker} · ${grant.mode}` : "You",
          error: tab.error || null,
        };
      }),
    };
  }

  changed() {
    this.onChange(this.state());
  }

  async create(workspace, url, { activate = true, id = randomUUID() } = {}) {
    if (!WORKSPACES.includes(workspace)) throw new Error("Unknown business");
    if (this.tabs.size >= 12) throw new Error("Prototype limit: 12 tabs");
    url = normalizeUrl(url);
    const partition = `persist:colony-prototype-${workspace}`;
    const browserSession = session.fromPartition(partition);
    if (!this.configuredSessions.has(partition)) {
      browserSession.setPermissionRequestHandler((_wc, _permission, callback) =>
        callback(false),
      );
      browserSession.setPermissionCheckHandler(() => false);
      browserSession.on("will-download", (event) => event.preventDefault());
      this.configuredSessions.add(partition);
    }
    const view = new WebContentsView({
      webPreferences: {
        session: browserSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    const tab = {
      id,
      workspace,
      url,
      view,
      observation: null,
      queue: Promise.resolve(),
    };
    this.tabs.set(id, tab);
    this.authority.add(tab);
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    const wc = view.webContents;
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    const validateNavigation = (event, destination) => {
      try {
        normalizeUrl(destination);
      } catch {
        event.preventDefault();
      }
    };
    wc.on("will-navigate", validateNavigation);
    wc.on("will-redirect", validateNavigation);
    wc.on("will-frame-navigate", (event) => {
      try {
        normalizeUrl(event.url);
      } catch {
        event.preventDefault();
      }
    });
    wc.on(
      "did-start-navigation",
      (_event, destination, _inPlace, isMainFrame) => {
        if (!isMainFrame) return;
        tab.observation = null;
        try {
          this.authority.navigate(id, destination);
        } catch {
          this.authority.revoke(id);
        }
        this.changed();
      },
    );
    wc.on("did-navigate", () => {
      tab.error = null;
      this.save();
      this.changed();
    });
    wc.on("did-navigate-in-page", () => {
      this.save();
      this.changed();
    });
    wc.on("page-title-updated", () => this.changed());
    wc.on("did-stop-loading", () => this.changed());
    wc.on("did-fail-load", (_e, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) {
        tab.error = description;
        this.changed();
      }
    });
    wc.on("render-process-gone", () => {
      this.takeover(id);
      tab.error = "Page process stopped. Reload to recover.";
      this.changed();
    });
    wc.on("before-input-event", (_event, input) => {
      if (input.type === "keyDown") this.takeover(id);
    });
    wc.on("before-mouse-event", (_event, mouse) => {
      if (mouse.type === "mouseDown") this.takeover(id);
    });
    if (activate) this.select(id);
    this.changed();
    try {
      await wc.loadURL(url);
    } catch (error) {
      tab.error = error.message;
    }
    this.save();
    this.changed();
    return tab;
  }

  select(id) {
    if (!this.tabs.has(id)) throw new Error("Tab is closed");
    this.activeId = id;
    for (const tab of this.tabs.values()) tab.view.setVisible(tab.id === id);
    this.layout();
    this.save();
    this.changed();
  }

  layout() {
    const [width, height] = this.window.getContentSize();
    for (const tab of this.tabs.values())
      tab.view.setBounds({
        x: 252,
        y: 146,
        width: Math.max(1, width - 252),
        height: Math.max(1, height - 146),
      });
  }

  takeover(id) {
    this.authority.revoke(id);
    const tab = this.tabs.get(id);
    if (tab) tab.observation = null;
    this.changed();
  }

  async navigate(id, url) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error("Tab is closed");
    this.takeover(id);
    await tab.view.webContents.loadURL(normalizeUrl(url));
  }

  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.authority.remove(id);
    this.tabs.delete(id);
    this.window.contentView.removeChildView(tab.view);
    tab.view.webContents.close({ waitForBeforeUnload: false });
    if (this.activeId === id) {
      this.activeId = this.tabs.keys().next().value || null;
      if (this.activeId) this.select(this.activeId);
    }
    this.save();
    this.changed();
  }

  save() {
    if (!this.stateDir) return;
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const tabs = [...this.tabs.values()].map((tab) => {
      const url = new URL(tab.view.webContents.getURL() || tab.url);
      // Do not persist OAuth codes or URL fragments in the tab manifest.
      url.search = "";
      url.hash = "";
      return { id: tab.id, workspace: tab.workspace, url: url.href };
    });
    const file = path.join(this.stateDir, "tabs.json");
    writeFileSync(
      `${file}.tmp`,
      JSON.stringify({ activeId: this.activeId, tabs }),
      { mode: 0o600 },
    );
    renameSync(`${file}.tmp`, file);
  }

  async restore() {
    let saved;
    try {
      saved = JSON.parse(
        readFileSync(path.join(this.stateDir, "tabs.json"), "utf8"),
      );
    } catch {
      return false;
    }
    if (!Array.isArray(saved.tabs)) return false;
    for (const item of saved.tabs.slice(0, 12)) {
      if (
        !WORKSPACES.includes(item.workspace) ||
        typeof item.id !== "string" ||
        this.tabs.has(item.id)
      )
        continue;
      try {
        await this.create(item.workspace, item.url, {
          activate: false,
          id: item.id,
        });
      } catch {
        /* Skip invalid restored tabs. */
      }
    }
    const selected = this.tabs.has(saved.activeId)
      ? saved.activeId
      : this.tabs.keys().next().value;
    if (selected) this.select(selected);
    return this.tabs.size > 0;
  }

  async request({ token, method, args = {} }) {
    if (
      typeof token !== "string" ||
      !METHODS.has(method) ||
      !args ||
      typeof args !== "object" ||
      Array.isArray(args)
    )
      throw new Error("Malformed browser command");
    const grant = this.authority.grants.get(token);
    if (!grant) throw new Error("Access revoked");
    if (method === "browser_tabs_list") {
      this.authority.check(token, grant.tabId);
      return this.state().tabs.filter((tab) => tab.id === grant.tabId);
    }
    const { tabId } = args;
    this.authority.check(token, tabId);
    const tab = this.tabs.get(tabId);
    const run = async () => {
      const check = (options) => this.authority.check(token, tabId, options);
      check();
      if (method === "browser_snapshot") return snapshot(tab, check);
      if (method === "browser_screenshot") return screenshot(tab, check);
      return actOnRef(tab, args, method, check);
    };
    const pending = tab.queue.then(run);
    tab.queue = pending.catch(() => {});
    return pending;
  }

  async flush() {
    for (const partition of this.configuredSessions)
      await session.fromPartition(partition).cookies.flushStore();
  }

  destroy() {
    this.save();
    for (const tab of this.tabs.values()) {
      this.authority.remove(tab.id);
      this.window.contentView.removeChildView(tab.view);
      tab.view.webContents.close({ waitForBeforeUnload: false });
    }
    this.tabs.clear();
  }
}

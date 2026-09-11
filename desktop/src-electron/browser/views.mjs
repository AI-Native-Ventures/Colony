import { createHash } from "node:crypto";
import { WebContentsView, session } from "electron";
import { Authority, normalizeUrl } from "./authority.mjs";
import { snapshot, screenshot, actOnRef } from "./page-tools.mjs";
import { mailSend } from "./mail-journey.mjs";

/** Real embedded tabs owned by one active Colony business at a time. */
export class BrowserViews {
  tabs = new Map();
  authority = new Authority();
  business = null;
  sessions = new Set();

  constructor(window, changed) {
    this.window = window;
    this.changed = changed;
  }

  setBusiness(id) {
    if (
      id !== null &&
      (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))
    )
      throw new Error("Invalid business");
    if (id === this.business) return;
    for (const tab of this.tabs.values()) this.close(tab.id);
    this.business = id;
  }

  sessionFor(business) {
    if (!business || business !== this.business)
      throw new Error("Business changed; reopen this action");
    const key = createHash("sha256").update(business).digest("hex");
    const partition = `persist:colony-business-${key}`;
    const value = session.fromPartition(partition);
    if (!this.sessions.has(partition)) {
      value.setPermissionRequestHandler((_wc, _permission, callback) =>
        callback(false),
      );
      value.setPermissionCheckHandler(() => false);
      value.on("will-download", (event) => event.preventDefault());
      this.sessions.add(partition);
    }
    return value;
  }

  state(tab) {
    const controller = [...this.authority.grants.values()].find(
      (grant) => grant.tabId === tab.id,
    );
    return {
      id: tab.id,
      business: tab.workspace,
      url: tab.view.webContents.getURL() || tab.url,
      title: tab.view.webContents.getTitle(),
      loading: tab.view.webContents.isLoading(),
      error: tab.error || null,
      controller: controller?.worker || "You",
      mode: controller?.mode || null,
    };
  }

  notify(tab) {
    this.changed(this.state(tab));
  }

  async open({ id, business, url }) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))
      throw new Error("Invalid tab");
    const partition = this.sessionFor(business);
    if (this.tabs.has(id)) return this.state(this.tabs.get(id));
    if (this.tabs.size >= 24)
      throw new Error("Close a browser tab before opening another");
    url = normalizeUrl(url);
    const view = new WebContentsView({
      webPreferences: {
        session: partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const tab = {
      id,
      workspace: business,
      url,
      view,
      queue: Promise.resolve(),
      observation: null,
    };
    this.tabs.set(id, tab);
    this.authority.add(tab);
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    const wc = view.webContents;
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    const validate = (event, url) => {
      try {
        normalizeUrl(url);
      } catch {
        event.preventDefault();
      }
    };
    wc.on("will-navigate", validate);
    wc.on("will-redirect", validate);
    wc.on("will-frame-navigate", (event) => validate(event, event.url));
    wc.on("did-start-navigation", (_event, url, _inPlace, main) => {
      if (!main) return;
      tab.observation = null;
      try {
        this.authority.navigate(id, url);
      } catch {
        this.authority.revoke(id);
      }
      this.notify(tab);
    });
    for (const event of [
      "did-stop-loading",
      "page-title-updated",
      "did-navigate-in-page",
    ])
      wc.on(event, () => this.notify(tab));
    wc.on("did-navigate", () => {
      tab.error = null;
      this.notify(tab);
    });
    wc.on("did-fail-load", (_e, code, description, _url, main) => {
      if (main && code !== -3) {
        tab.error = description;
        this.notify(tab);
      }
    });
    wc.on("render-process-gone", () => {
      this.takeover(id);
      tab.error = "This page stopped. Reload to recover.";
      this.notify(tab);
    });
    wc.on("before-input-event", (_e, input) => {
      if (input.type === "keyDown") this.takeover(id);
    });
    wc.on("before-mouse-event", (_e, input) => {
      if (input.type === "mouseDown") this.takeover(id);
    });
    void wc.loadURL(url).catch(() => {});
    return this.state(tab);
  }

  get(id) {
    const tab = this.tabs.get(id);
    if (!tab || tab.workspace !== this.business)
      throw new Error("Browser tab is no longer active");
    return tab;
  }

  bounds({ id, business, bounds, visible }) {
    if (business !== this.business) return;
    const tab = this.get(id);
    if (
      !bounds ||
      ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    )
      throw new Error("Invalid browser bounds");
    const zoom = this.window.webContents.getZoomFactor();
    const [width, height] = this.window.getContentSize();
    const x = Math.max(0, Math.round(bounds.x * zoom));
    const y = Math.max(0, Math.round(bounds.y * zoom));
    const w = Math.min(width - x, Math.round(bounds.width * zoom));
    const h = Math.min(height - y, Math.round(bounds.height * zoom));
    for (const other of this.tabs.values())
      if (other.id !== id) other.view.setVisible(false);
    if (w <= 0 || h <= 0 || !visible) {
      tab.view.setVisible(false);
      return;
    }
    tab.view.setBounds({ x, y, width: w, height: h });
    tab.view.setVisible(true);
  }

  action({ id, action, url }) {
    const tab = this.get(id),
      wc = tab.view.webContents;
    if (action === "hide") {
      tab.view.setVisible(false);
      return;
    }
    this.takeover(id);
    if (action === "navigate")
      void wc.loadURL(normalizeUrl(url)).catch(() => {});
    else if (action === "reload") wc.reload();
    else if (action === "back" && wc.navigationHistory.canGoBack())
      wc.navigationHistory.goBack();
    else if (action === "forward" && wc.navigationHistory.canGoForward())
      wc.navigationHistory.goForward();
    else if (!["back", "forward", "takeover"].includes(action))
      throw new Error("Unknown browser action");
  }

  takeover(id) {
    this.authority.revoke(id);
    const tab = this.tabs.get(id);
    if (tab) {
      tab.observation = null;
      this.notify(tab);
    }
  }
  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.authority.remove(id);
    this.tabs.delete(id);
    this.window.contentView.removeChildView(tab.view);
    tab.view.webContents.close({ waitForBeforeUnload: false });
  }

  async request({ token, method, args = {} }, validate = async () => {}) {
    const grant = this.authority.grants.get(token);
    if (!grant) throw new Error("Browser access revoked");
    const tab = this.get(grant.tabId);
    if (method === "browser_tabs_list") {
      this.authority.check(token, tab.id);
      return [this.state(tab)];
    }
    this.authority.check(token, args.tabId);
    const run = async () => {
      await validate();
      const check = (options) =>
        this.authority.check(token, args.tabId, options);
      check();
      if (method === "browser_snapshot") return snapshot(tab, check);
      if (method === "browser_screenshot") return screenshot(tab, check);
      if (["browser_type", "browser_click"].includes(method))
        return actOnRef(tab, args, method, check);
      if (method === "mail_send") return mailSend(tab, args, check);
      throw new Error("Unknown browser tool");
    };
    const result = tab.queue.then(run);
    tab.queue = result.catch(() => {});
    return result;
  }

  async closeAll() {
    this.setBusiness(null);
    for (const partition of this.sessions)
      await session.fromPartition(partition).cookies.flushStore();
  }
}

/**
 * Source-test doubles for the website preview host.
 *
 * No Electron: every dependency the host takes is a minimal fake that records
 * what the host asked of it, so lifecycle and security assertions can run
 * under plain `node --test`.
 */

import { createWebsitePreviewHost } from "./host.mjs";

export const SHA = "a".repeat(64);
export const MANIFEST_URL = "https://cdn.example.com/site/manifest.json";

class FakeWebContents {
  constructor(options = {}, previewSession = null) {
    this.listeners = new Map();
    this.loaded = [];
    this.url = "";
    this.previewSession = previewSession;
    this.mainFrame = { frames: [] };
    this.zoomFactor = 1;
    this.zoomFactorCalls = [];
    this.windowOpenHandler = null;
    this.destroyed = false;
    this.closed = false;
    this.closeOptions = null;
    // Tests set this to simulate a failed first main-frame load.
    this.loadFailure = options.loadFailure ?? null;
  }
  on(event, handler) {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
  }
  removeListener(event, handler) {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      list.filter((entry) => entry !== handler),
    );
  }
  emit(event, ...args) {
    for (const handler of [...(this.listeners.get(event) ?? [])]) {
      handler(...args);
    }
  }
  setZoomFactor(value) {
    this.zoomFactor = value;
    this.zoomFactorCalls.push(value);
  }
  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }
  loadURL(url) {
    this.url = url;
    this.loaded.push(url);
    // Deliver the load result on a microtask so listeners registered around
    // loadURL observe it, matching real Electron ordering.
    queueMicrotask(async () => {
      if (this.loadFailure !== null) {
        this.emit(
          "did-fail-load",
          {},
          this.loadFailure.code,
          this.loadFailure.description,
          url,
          true,
        );
      } else {
        this.emit("did-finish-load");
        if (url.endsWith("/__colony_preview_wrapper.html")) {
          const handler = this.previewSession?.protocol?.handlers?.get(
            "colony-preview",
          );
          if (handler !== undefined) {
            const response = await handler({ url, method: "GET" });
            const html = await response.text();
            const childUrl = html.match(/\ssrc=\"([^\"]+)\"/)?.[1];
            if (childUrl !== undefined) {
              this.mainFrame.frames = [
                { url: childUrl, processId: 7, routingId: 11 },
              ];
              this.emit(
                "did-frame-finish-load",
                { isMainFrame: false },
                false,
                7,
                11,
              );
            }
          }
        }
      }
    });
    return Promise.resolve();
  }
  close(options) {
    this.closed = true;
    this.closeOptions = options;
    this.destroyed = true;
  }
  isDestroyed() {
    return this.destroyed;
  }
}

class FakeSession {
  constructor(partition) {
    this.partition = partition;
    this.protocol = {
      handlers: new Map(),
      handle: (scheme, handler) => {
        this.protocol.handlers.set(scheme, handler);
      },
      unhandle: (scheme) => {
        this.protocol.handlers.delete(scheme);
      },
    };
    this.permissionRequestHandler = null;
    this.permissionCheckHandler = null;
    this.listeners = new Map();
    this.storageCleared = 0;
    this.cacheCleared = 0;
    this.webRequest = {
      filter: null,
      handler: null,
      onBeforeRequest(filter, handler) {
        if (filter === null || handler === null) {
          this.filter = null;
          this.handler = null;
          return;
        }
        this.filter = filter;
        this.handler = handler;
      },
    };
  }
  on(event, handler) {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
  }
  removeListener(event, handler) {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      list.filter((entry) => entry !== handler),
    );
  }
  emit(event, ...args) {
    for (const handler of [...(this.listeners.get(event) ?? [])]) {
      handler(...args);
    }
  }
  setPermissionRequestHandler(handler) {
    this.permissionRequestHandler = handler;
  }
  setPermissionCheckHandler(handler) {
    this.permissionCheckHandler = handler;
  }
  clearStorageData() {
    this.storageCleared += 1;
    return Promise.resolve();
  }
  clearCache() {
    this.cacheCleared += 1;
    return Promise.resolve();
  }
}

class FakeView {
  constructor() {
    this.children = [];
    this.bounds = null;
    this.visible = null;
    this.borderRadius = null;
  }
  addChildView(child) {
    this.children.push(child);
  }
  removeChildView(child) {
    this.children = this.children.filter((entry) => entry !== child);
  }
  setBounds(bounds) {
    this.bounds = { ...bounds };
  }
  setVisible(visible) {
    this.visible = visible;
  }
  setBorderRadius(radius) {
    this.borderRadius = radius;
  }
}

export function createElectron(options = {}) {
  const partitions = [];
  const sessions = new Map();
  const views = [];
  const session = {
    fromPartition(partition) {
      partitions.push(partition);
      let value = sessions.get(partition);
      if (value === undefined) {
        value = new FakeSession(partition);
        sessions.set(partition, value);
      }
      return value;
    },
  };
  class WebContentsView extends FakeView {
    constructor(viewOptions) {
      super();
      this.options = viewOptions;
      this.webContents = new FakeWebContents(options, viewOptions.session);
      views.push(this);
    }
  }
  class View extends FakeView {}
  return {
    partitions,
    sessions,
    views,
    electron: { WebContentsView, View, session },
  };
}

export function createWindow(id = 1) {
  const listeners = new Map();
  return {
    id,
    contentView: {
      children: [],
      addChildView(view) {
        this.children.push(view);
      },
      removeChildView(view) {
        this.children = this.children.filter((entry) => entry !== view);
      },
    },
    webContents: { getZoomFactor: () => 1 },
    once(event, handler) {
      listeners.set(event, handler);
    },
    removeListener(event, handler) {
      if (listeners.get(event) === handler) listeners.delete(event);
    },
    emit(event, ...args) {
      const handler = listeners.get(event);
      if (handler !== undefined) {
        listeners.delete(event);
        handler(...args);
      }
    },
    listenerCount(event) {
      return listeners.get(event) === undefined ? 0 : 1;
    },
    isDestroyed() {
      return false;
    },
  };
}

export function fakeSite(options = {}) {
  const entrypoint = options.entrypoint ?? "index.html";
  const entries = options.fileList ?? [
    ["index.html", "<!doctype html><title>preview</title>", "text/html"],
    ["assets/app.js", "console.log('ok')", "text/javascript"],
    ["assets/app.css", "body{color:#111}", "text/css"],
    [
      "images/logo.svg",
      "<svg xmlns='http://www.w3.org/2000/svg'/>",
      "image/svg+xml",
    ],
  ];
  const bodies = new Map(
    entries.map(([path, text]) => [path, Buffer.from(text, "utf8")]),
  );
  const metadata = new Map();
  entries.forEach(([path, , mime], index) => {
    metadata.set(
      path,
      Object.freeze({
        path,
        url: `https://cdn.example.com/${path}`,
        sha256: SHA,
        mime,
        size: options.sizes?.[index] ?? bodies.get(path).length,
        contentType: mime,
      }),
    );
  });
  const files = Object.freeze([...metadata.values()]);
  return Object.freeze({
    schema: "colony.website-preview/1",
    entrypoint,
    manifestSha256: options.manifestSha256 ?? SHA,
    files,
    entrypointFile: metadata.get(entrypoint) ?? null,
    getFile(path) {
      const file = metadata.get(path);
      if (file === undefined) return null;
      return Object.freeze({ ...file, bytes: Buffer.from(bodies.get(path)) });
    },
  });
}

export function createHost(options = {}) {
  const world = createElectron({ loadFailure: options.loadFailure });
  const loadCalls = [];
  const loadPreview =
    options.loadPreview ??
    (async ({ manifestRef }) => {
      loadCalls.push({ manifestRef });
      return options.site ?? fakeSite({ manifestSha256: manifestRef.sha256 });
    });
  const host = createWebsitePreviewHost({
    ...world.electron,
    loadPreview,
    clipStrategy: options.clipStrategy,
    maxViews: options.maxViews,
    maxTotalBytes: options.maxTotalBytes,
  });
  return { host, world, loadCalls };
}

export function requestFor(window, overrides = {}) {
  return {
    window,
    communityId: "community-1",
    jobId: "job-1",
    threadRoot: "b".repeat(64),
    revision: 1,
    manifest: { url: MANIFEST_URL, sha256: SHA },
    viewport: "desktop",
    pixelWidth: 1440,
    pixelHeight: 900,
    ...overrides,
  };
}

export function tokenFor(partition) {
  return partition.slice("preview-".length);
}

export function event() {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
}

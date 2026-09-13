/**
 * Generic host-mediated browser for isolated worker evidence.
 *
 * The worker receives an opaque capability through the existing Electron MCP
 * grant file. It never supplies a tab, cookie, preload, browser profile, or
 * filesystem path. This host owns the hidden BrowserWindow, the ephemeral
 * session, the HTTPS transport, and the capture destination; page-tools still
 * owns the bounded accessibility and reference-based interaction protocol.
 */

import { createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { actOnRef, cdp, screenshot, snapshot } from "../browser/page-tools.mjs";
import {
  evidenceViewportSize,
  MAX_EVIDENCE_CAPTURE_BYTES,
  MAX_EVIDENCE_SESSION_MS,
  requireEvidenceId,
  resolveEvidenceViewport,
  validateEvidenceAction,
  validateEvidenceUrl,
} from "./policy.mjs";
import { EvidenceTransport } from "./transport.mjs";

const LOAD_TIMEOUT_MS = 30_000;
const TITLE_LIMIT = 512;
const EVIDENCE_DIRECTORY = ".colony-evidence";
// NativeHost transports invoke arguments as one JSON frame. Base64 keeps the
// PNG a compact scalar while this raw cap leaves headroom below its 16 MiB
// frame limit for the command envelope and scoped identity fields.
const MAX_NATIVE_CAPTURE_BYTES = 8 * 1024 * 1024;

function safeTitle(value) {
  return typeof value === "string" ? value.slice(0, TITLE_LIMIT) : "";
}

function errorMessage(error, fallback) {
  return error instanceof Error && error.message !== ""
    ? error.message
    : fallback;
}

function waitForMainLoad(entry) {
  const webContents = entry.webContents;
  return new Promise((resolve, reject) => {
    let settled = false;
    const listeners = [];
    const timer = setTimeout(
      () => settle(new Error("Evidence page did not finish loading")),
      LOAD_TIMEOUT_MS,
    );
    const remove = () => {
      clearTimeout(timer);
      for (const [event, listener] of listeners)
        webContents.removeListener?.(event, listener);
      entry.abortSignal?.removeEventListener?.("abort", onAbort);
    };
    const settle = (error) => {
      if (settled) return;
      settled = true;
      remove();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => settle(new Error("Evidence page load was revoked"));
    const on = (event, listener) => {
      webContents.on(event, listener);
      listeners.push([event, listener]);
    };
    on("did-finish-load", () => settle(null));
    on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (code === -3 || isMainFrame === false) return;
      settle(new Error(description || "Evidence page failed to load"));
    });
    on("render-process-gone", () =>
      settle(new Error("Evidence page renderer stopped")),
    );
    if (entry.abortSignal?.aborted) onAbort();
    else
      entry.abortSignal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function isMainNavigation(details, fallback = true) {
  if (typeof details?.isMainFrame === "boolean") return details.isMainFrame;
  if (typeof details?.isMainFrame === "number")
    return details.isMainFrame === 1;
  return fallback;
}

/** Generic hidden browser host bound to an EvidenceAuthority. */
export class EvidenceBrowserHost {
  constructor({
    BrowserWindow,
    WebContentsView,
    session,
    authority,
    dependencies,
    writeCapture,
    artifactRenderer = null,
    maxSessions = 4,
    sessionMs = MAX_EVIDENCE_SESSION_MS,
  } = {}) {
    if (
      typeof BrowserWindow !== "function" ||
      typeof WebContentsView !== "function"
    ) {
      throw new Error(
        "EvidenceBrowserHost requires Electron window constructors",
      );
    }
    if (session === null || typeof session?.fromPartition !== "function") {
      throw new Error("EvidenceBrowserHost requires Electron sessions");
    }
    if (
      authority === null ||
      typeof authority?.validate !== "function" ||
      typeof authority?.assertLive !== "function"
    ) {
      throw new Error("EvidenceBrowserHost requires a live EvidenceAuthority");
    }
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) {
      throw new Error("maxSessions must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(sessionMs) ||
      sessionMs <= 0 ||
      sessionMs > MAX_EVIDENCE_SESSION_MS
    ) {
      throw new Error(
        `sessionMs must be between 1 and ${MAX_EVIDENCE_SESSION_MS}`,
      );
    }
    if (artifactRenderer !== null && typeof artifactRenderer !== "function") {
      throw new Error("artifactRenderer must be a function");
    }
    if (typeof writeCapture !== "function") {
      throw new Error("EvidenceBrowserHost requires a native capture writer");
    }
    this.BrowserWindow = BrowserWindow;
    this.WebContentsView = WebContentsView;
    this.session = session;
    this.authority = authority;
    this.dependencies = dependencies;
    this.writeCapture = writeCapture;
    this.artifactRenderer = artifactRenderer;
    this.maxSessions = maxSessions;
    this.sessionMs = sessionMs;
    this.entries = new Map();
    this.pending = new Map();
    this.disposed = false;
  }

  assertLive() {
    if (this.disposed) throw new Error("Evidence browser host is closed");
  }

  /** Return whether the authority still owns a capability with this token. */
  has(token) {
    return this.authority.bindings.has(token);
  }

  /** Queue calls for one grant so snapshots and reference actions cannot race. */
  queued(token, work) {
    const previous = this.pending.get(token) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.pending.set(token, next);
    return next.finally(() => {
      if (this.pending.get(token) === next) this.pending.delete(token);
    });
  }

  async createEntry(token, binding, viewport) {
    this.assertLive();
    if (this.entries.size >= this.maxSessions) {
      throw new Error("Evidence browser session limit reached");
    }
    const size = evidenceViewportSize(viewport);
    const partition = `colony-evidence-${createHash("sha256")
      .update(token)
      .digest("hex")}`;
    const evidenceSession = this.session.fromPartition(partition);
    const transport = new EvidenceTransport({
      previewSession: evidenceSession,
      dependencies: this.dependencies,
    });
    let window;
    let view;
    try {
      await transport.start();
      window = new this.BrowserWindow({
        width: size.width,
        height: size.height,
        useContentSize: true,
        show: false,
        skipTaskbar: true,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          devTools: false,
        },
      });
      view = new this.WebContentsView({
        webPreferences: {
          session: evidenceSession,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          devTools: false,
          disableDialogs: true,
        },
      });
      if (!view.webContents)
        throw new Error("Evidence web contents are unavailable");
      window.contentView.addChildView(view);
      view.setBounds({ x: 0, y: 0, width: size.width, height: size.height });
      view.setVisible(true);
      const entry = {
        token,
        binding,
        viewport,
        size,
        partition,
        session: evidenceSession,
        transport,
        window,
        view,
        webContents: view.webContents,
        tab: { id: `evidence-${token.slice(0, 12)}`, view, observation: null },
        state: "opening",
        url: null,
        revision: 0,
        closed: false,
        abortController: new AbortController(),
        timer: null,
        listeners: [],
      };
      entry.abortSignal = entry.abortController.signal;
      this.installWebContentsGuards(entry);
      entry.timer = setTimeout(() => {
        void this.closeEntry(entry, false);
      }, this.sessionMs);
      this.entries.set(token, entry);
      return entry;
    } catch (error) {
      try {
        view?.webContents?.close?.({ waitForBeforeUnload: false });
      } catch {}
      try {
        window?.close?.();
      } catch {}
      await transport.close();
      throw error;
    }
  }

  installWebContentsGuards(entry) {
    const wc = entry.webContents;
    const on = (event, listener) => {
      wc.on(event, listener);
      entry.listeners.push([event, listener]);
    };
    wc.setWindowOpenHandler?.(() => ({ action: "deny" }));
    on("will-navigate", (event, url) => {
      if (!this.publicNavigationAllowed(url)) event.preventDefault();
    });
    on("will-redirect", (event, url) => {
      if (!this.publicNavigationAllowed(url)) event.preventDefault();
    });
    on("will-frame-navigate", (event, details) => {
      const navigation = details ?? event;
      if (
        !isMainNavigation(navigation, false) ||
        !this.publicNavigationAllowed(navigation?.url ?? event?.url)
      )
        event.preventDefault();
    });
    on("will-attach-webview", (event) => event.preventDefault());
    on("did-start-navigation", (_event, url, _inPlace, isMainFrame) => {
      if (isMainFrame !== true) return;
      entry.revision += 1;
      entry.tab.observation = null;
      entry.url = url;
      entry.state = "loading";
    });
    on("did-navigate", (_event, url) => {
      entry.url = url;
    });
    on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (code === -3 || isMainFrame === false) return;
      entry.state = "failed";
      entry.error = description || "Evidence page failed to load";
    });
    on("render-process-gone", () => {
      entry.state = "failed";
      entry.error = "Evidence page renderer stopped";
    });
  }

  publicNavigationAllowed(rawUrl) {
    try {
      validateEvidenceUrl(rawUrl);
      return true;
    } catch {
      return false;
    }
  }

  async setViewport(entry) {
    entry.view.setBounds({
      x: 0,
      y: 0,
      width: entry.size.width,
      height: entry.size.height,
    });
    entry.webContents.setZoomFactor?.(1);
    await cdp(entry.tab, "Emulation.setDeviceMetricsOverride", {
      width: entry.size.width,
      height: entry.size.height,
      deviceScaleFactor: 1,
      mobile: entry.viewport === "mobile",
      screenWidth: entry.size.width,
      screenHeight: entry.size.height,
    });
  }

  async assertViewport(entry) {
    const result = await cdp(entry.tab, "Runtime.evaluate", {
      expression:
        "JSON.stringify({width:window.innerWidth,height:window.innerHeight,dpr:window.devicePixelRatio})",
      returnByValue: true,
    });
    let metrics;
    try {
      metrics = JSON.parse(result?.result?.value ?? "{}");
    } catch {
      metrics = {};
    }
    if (
      metrics.width !== entry.size.width ||
      metrics.height !== entry.size.height ||
      metrics.dpr !== 1
    ) {
      throw new Error(
        `Evidence CSS viewport is ${metrics.width}x${metrics.height} at dpr ${metrics.dpr}; expected ${entry.size.width}x${entry.size.height} at dpr 1`,
      );
    }
    return metrics;
  }

  async loadEntry(entry, url) {
    entry.abortController = new AbortController();
    entry.abortSignal = entry.abortController.signal;
    try {
      await this.setViewport(entry);
      const load = waitForMainLoad(entry);
      await entry.webContents.loadURL(url);
      await load;
      entry.state = "ready";
      entry.url = entry.webContents.getURL?.() || url;
      entry.cssViewport = await this.assertViewport(entry);
      await this.authority.validate(entry.token, {
        communityId: entry.binding.communityId,
        jobId: entry.binding.jobId,
        workerPubkey: entry.binding.workerPubkey,
        threadRoot: entry.binding.threadRoot,
      });
      return entry;
    } catch (error) {
      entry.state = "failed";
      entry.error = errorMessage(error, "Evidence page could not be opened");
      throw new Error(errorMessage(error, "Evidence page could not be opened"));
    }
  }

  async openPublic(token, binding, url, viewport) {
    const canonicalUrl = validateEvidenceUrl(url).href;
    let entry = this.entries.get(token);
    if (
      entry !== undefined &&
      (entry.closed || entry.viewport !== viewport || entry.state === "failed")
    ) {
      await this.closeEntry(entry, false);
      entry = undefined;
    }
    if (entry === undefined)
      entry = await this.createEntry(token, binding, viewport);
    await this.authority.validate(token, { jobId: binding.jobId });
    if (entry.url !== canonicalUrl || entry.state !== "ready") {
      await this.loadEntry(entry, canonicalUrl);
    }
    return this.state(entry);
  }

  /** Open a host-verified artifact/local build through an injected renderer. */
  async openArtifact(token, binding, source, viewport) {
    if (this.artifactRenderer === null) {
      throw new Error("Verified artifact rendering is not configured");
    }
    if (
      source === null ||
      typeof source !== "object" ||
      Array.isArray(source)
    ) {
      throw new Error("Evidence artifact source is invalid");
    }
    if (source.kind !== "verified-artifact" && source.kind !== "local-build") {
      throw new Error("Evidence artifact source kind is unsupported");
    }
    if (source.kind === "verified-artifact") {
      if (source.manifest === null || typeof source.manifest !== "object") {
        throw new Error("Evidence artifact manifest is invalid");
      }
      validateEvidenceUrl(source.manifest.url);
      if (
        typeof source.manifest.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(source.manifest.sha256)
      ) {
        throw new Error("Evidence artifact manifest hash is invalid");
      }
    } else {
      requireEvidenceId(source.buildId, "buildId");
    }
    const previous = this.entries.get(token);
    if (previous !== undefined) await this.closeEntry(previous, false);
    await this.authority.validate(token, { jobId: binding.jobId });
    let rendered;
    try {
      rendered = await this.artifactRenderer({
        binding,
        source,
        viewport,
        windowFactory: this.BrowserWindow,
        viewFactory: this.WebContentsView,
        session: this.session,
      });
      if (
        rendered === null ||
        typeof rendered !== "object" ||
        typeof rendered.close !== "function" ||
        !rendered.tab?.view?.webContents
      ) {
        throw new Error("The artifact renderer returned no isolated page");
      }
      rendered.view = rendered.view ?? rendered.tab.view;
      rendered.webContents = rendered.webContents ?? rendered.view.webContents;
      rendered.token = token;
      rendered.binding = binding;
      rendered.viewport = viewport;
      rendered.size = evidenceViewportSize(viewport);
      rendered.state = "opening";
      rendered.closed = false;
      rendered.revision = 1;
      rendered.url = rendered.tab.view.webContents.getURL?.() ?? null;
      rendered.abortController = new AbortController();
      rendered.abortSignal = rendered.abortController.signal;
      rendered.cssViewport = await this.assertViewport(rendered);
      await this.authority.validate(token, { jobId: binding.jobId });
      rendered.state = "ready";
      rendered.timer = setTimeout(() => {
        void this.closeEntry(rendered, false);
      }, this.sessionMs);
      this.entries.set(token, rendered);
      return this.state(rendered);
    } catch (error) {
      try {
        await rendered?.close?.();
      } catch {}
      try {
        rendered?.webContents?.close?.({ waitForBeforeUnload: false });
      } catch {}
      try {
        rendered?.window?.close?.();
      } catch {}
      throw new Error(
        errorMessage(error, "Evidence artifact could not be opened"),
      );
    }
  }

  state(entry) {
    return Object.freeze({
      tabId: entry.tab?.id ?? `evidence-${entry.token.slice(0, 12)}`,
      status: entry.state,
      viewport: entry.viewport,
      cssViewport: Object.freeze({ ...(entry.cssViewport ?? entry.size) }),
      url: entry.url ?? entry.tab?.view?.webContents?.getURL?.() ?? "",
      title: safeTitle(entry.tab?.view?.webContents?.getTitle?.()),
      error: entry.error ?? null,
      transport: entry.transport?.stats?.() ?? null,
    });
  }

  liveCheck(entry, options = {}) {
    this.authority.assertLive(entry.token);
    if (entry.closed || entry.state !== "ready") {
      throw new Error("Evidence page is not ready");
    }
    if (options.revision !== undefined && options.revision !== entry.revision) {
      throw new Error("Evidence page changed; take a new snapshot");
    }
    return { revision: entry.revision };
  }

  async requireEntry(token) {
    const binding = await this.authority.validate(token);
    const entry = this.entries.get(token);
    if (!entry || entry.closed) throw new Error("Evidence page is not open");
    return { binding, entry };
  }

  async capturePng(entry) {
    const before = this.liveCheck(entry);
    if (typeof entry.webContents.capturePage !== "function") {
      throw new Error("Evidence capture is unavailable in this Electron host");
    }
    const image = await entry.webContents.capturePage(
      {
        x: 0,
        y: 0,
        width: entry.size.width,
        height: entry.size.height,
      },
      true,
    );
    this.liveCheck(entry, before);
    const dimensions = image?.getSize?.() ?? {};
    if (
      dimensions.width !== entry.size.width ||
      dimensions.height !== entry.size.height
    ) {
      throw new Error(
        `Evidence PNG is ${dimensions.width}x${dimensions.height}; expected ${entry.size.width}x${entry.size.height}`,
      );
    }
    const bitmap = image?.getBitmap?.();
    if (!Buffer.isBuffer(bitmap) || bitmap.length === 0) {
      throw new Error("Evidence capture contains no bitmap");
    }
    let nonBlank = false;
    for (let offset = 0; offset + 3 < bitmap.length; offset += 4) {
      const first = bitmap[offset];
      const second = bitmap[offset + 1];
      const third = bitmap[offset + 2];
      const fourth = bitmap[offset + 3];
      // Electron documents getBitmap() as premultiplied BGRA. Require an
      // alpha-bearing pixel whose color is not opaque white; an ARGB guess
      // would classify white/transparent backgrounds as visible content.
      if (fourth !== 0 && (first !== 255 || second !== 255 || third !== 255)) {
        nonBlank = true;
        break;
      }
    }
    if (!nonBlank)
      throw new Error("Evidence capture contains no visible content");
    const bytes = image?.toPNG?.();
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length === 0 ||
      bytes.length > MAX_EVIDENCE_CAPTURE_BYTES
    ) {
      throw new Error("Evidence capture exceeds its PNG budget");
    }
    return {
      bytes,
      proof: Object.freeze({
        width: dimensions.width,
        height: dimensions.height,
        nonBlank: true,
      }),
    };
  }

  async capturePath(entry, bytes) {
    const workspace = entry.binding.workspaceRoot;
    if (typeof workspace !== "string" || !path.isAbsolute(workspace)) {
      throw new Error("Evidence capture has no authorized workspace");
    }
    const root = await realpath(workspace);
    if (root !== workspace) {
      throw new Error("Evidence capture workspace must not be a symlink");
    }
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_NATIVE_CAPTURE_BYTES) {
      throw new Error("Evidence capture exceeds the native transport budget");
    }
    const expectedPid = entry.binding.pid;
    // The native roster exposes the process start nonce as
    // `browser_generation`; EvidenceAuthority copies that exact value into
    // `binding.generation` before issuing the capability.
    const expectedStartNonce = entry.binding.generation;
    if (
      !Number.isSafeInteger(expectedPid) ||
      expectedPid <= 0 ||
      typeof expectedStartNonce !== "string" ||
      expectedStartNonce === ""
    ) {
      throw new Error("Evidence capture has no authorized worker generation");
    }
    const fileName = `${entry.binding.jobId.replace(/[^A-Za-z0-9._-]/g, "_")}-${entry.viewport}-${randomBytes(8).toString("hex")}.png`;
    const expectedPath = path.join(root, EVIDENCE_DIRECTORY, fileName);
    const result = await this.writeCapture({
      ownerPubkey: entry.binding.ownerPubkey,
      relayUrl: entry.binding.relayUrl,
      workerPubkey: entry.binding.workerPubkey,
      expectedPid,
      expectedStartNonce,
      fileName,
      // Native decodes this bounded scalar into `Vec<u8>`. Sending a Buffer
      // directly would serialize as `{type:"Buffer",data:[...]}` and would
      // not match the Rust command's byte payload.
      bytesBase64: bytes.toString("base64"),
    });
    if (
      result === null ||
      typeof result !== "object" ||
      result.path !== expectedPath ||
      result.bytes !== bytes.length
    ) {
      throw new Error("Native evidence capture returned an invalid path");
    }
    return result;
  }

  async request({ token, method, args = {} } = {}) {
    if (typeof token !== "string")
      throw new Error("Evidence access is invalid or revoked");
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("Evidence arguments must be an object");
    }
    return this.queued(token, async () => {
      const binding = await this.authority.validate(token);
      if (method === "evidence_open") {
        const viewport = resolveEvidenceViewport(args.viewport ?? "desktop");
        return this.openPublic(token, binding, args.url, viewport);
      }
      if (method === "evidence_artifact_open") {
        const viewport = resolveEvidenceViewport(args.viewport ?? "desktop");
        return this.openArtifact(token, binding, args.source, viewport);
      }
      if (method === "evidence_tabs_list") {
        const entry = this.entries.get(token);
        return entry ? [this.state(entry)] : [];
      }
      const { entry } = await this.requireEntry(token);
      if (method === "evidence_snapshot") {
        const value = await snapshot(entry.tab, (options) =>
          this.liveCheck(entry, options),
        );
        await this.authority.validate(token, { jobId: binding.jobId });
        return value;
      }
      if (method === "evidence_click" || method === "evidence_type") {
        const action = validateEvidenceAction({
          ...args,
          type: method === "evidence_click" ? "click" : "type",
        });
        const value = await actOnRef(
          entry.tab,
          action,
          method === "evidence_click" ? "browser_click" : "browser_type",
          (options) => this.liveCheck(entry, options),
        );
        entry.revision += 1;
        await this.authority.validate(token, { jobId: binding.jobId });
        return value;
      }
      if (method === "evidence_screenshot") {
        const value = await screenshot(entry.tab, (options) =>
          this.liveCheck(entry, options),
        );
        await this.authority.validate(token, { jobId: binding.jobId });
        return value;
      }
      if (method === "evidence_capture_png") {
        const { bytes, proof } = await this.capturePng(entry);
        await this.authority.validate(token, { jobId: binding.jobId });
        const capture = await this.capturePath(entry, bytes);
        await this.authority.validate(token, { jobId: binding.jobId });
        return {
          path: capture.path,
          bytes: bytes.length,
          viewport: entry.viewport,
          cssViewport: proof,
          nonBlank: proof.nonBlank,
        };
      }
      if (method === "evidence_stats") return this.state(entry);
      if (method === "evidence_close") {
        await this.closeEntry(entry, false);
        return { closed: true };
      }
      throw new Error("Unknown evidence browser tool");
    });
  }

  async closeEntry(entry, revoke) {
    if (!entry || entry.closed) return;
    entry.closed = true;
    entry.state = "closed";
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.abortController?.abort(new Error("Evidence session closed"));
    for (const [event, listener] of entry.listeners ?? [])
      entry.webContents?.removeListener?.(event, listener);
    this.entries.delete(entry.token);
    try {
      entry.view?.setVisible(false);
    } catch {}
    try {
      entry.window?.contentView?.removeChildView?.(entry.view);
    } catch {}
    try {
      await entry.transport?.close?.();
    } catch {}
    try {
      await entry.close?.();
    } catch {}
    try {
      entry.webContents?.close?.({ waitForBeforeUnload: false });
    } catch {}
    try {
      entry.window?.close?.();
    } catch {}
    if (revoke) this.authority.revoke(entry.token);
  }

  async invalidateAll() {
    const entries = [...this.entries.values()];
    await Promise.allSettled(
      entries.map((entry) => this.closeEntry(entry, true)),
    );
  }

  async close() {
    if (this.disposed) return;
    this.disposed = true;
    await this.invalidateAll();
  }
}

export function createEvidenceBrowserHost(options) {
  return new EvidenceBrowserHost(options);
}

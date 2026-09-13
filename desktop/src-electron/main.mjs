import { Cleanup } from "./cleanup.mjs";
import { createHash } from "node:crypto";
import { SignInImport } from "./browser-import/manager.mjs";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  protocol,
  net,
  session,
  View,
  WebContentsView,
} from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import { NativeHost } from "./native-host.mjs";
import { TerminalService } from "./terminal.mjs";
import { registerTerminalIpc } from "./terminal-ipc.mjs";
import { RendererHost } from "./renderer-host.mjs";
import { BrowserViews } from "./browser/views.mjs";
import { startBroker } from "./browser/broker.mjs";
import { executeOutreachSend } from "./browser/outreach-send.mjs";
import { shellCommand } from "./shell-commands.mjs";
import { ManagedBrowser, normalizeRelay } from "./browser/managed-workers.mjs";
import { runtimePaths } from "./runtime-paths.mjs";
import { DesktopDeepLinks } from "./deep-links.mjs";
import {
  createWebsitePreviewHost,
  resolveProductionClipStrategy,
} from "./website-preview/host.mjs";
import { loadVerifiedArtifact } from "./website-preview/artifacts.mjs";
import {
  createAuthorizedDependencies,
  createDefaultDependencies,
  isCanonicalRelayMediaUrl,
  loadWebsitePreview,
} from "./website-preview/artifact.mjs";
import { downloadHandover } from "./website-preview/handover.mjs";
import {
  awaitNativeArtifact,
  decodeNativeArtifactBytes,
  nativeWebsiteArtifactArgs,
} from "./website-preview/native.mjs";
import { PREVIEW_SCHEME_DESCRIPTOR } from "./website-preview/scheme.mjs";
import { EvidenceAuthority } from "./worker-evidence/authority.mjs";
import { createRelayTaskAssignmentResolver } from "./worker-evidence/assignment.mjs";
import { createEvidenceBrowserHost } from "./worker-evidence/host.mjs";
import { createVerifiedArtifactRenderer } from "./worker-evidence/artifact-renderer.mjs";

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
  PREVIEW_SCHEME_DESCRIPTOR,
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
  let businessContext = null;
  let businessGeneration = 0;
  let evidenceAuthority = null;
  let evidenceHost = null;
  let evidenceArtifactRenderer = null;
  let managedBrowser = null;
  // Isolated website previews. The host owns its own ephemeral session per
  // preview and never touches the application session or its cookies.
  const previews = createWebsitePreviewHost({
    WebContentsView,
    View,
    session,
    loadPreview: async ({ manifestRef, signal }) => {
      const guard = {
        context: businessContext,
        generation: businessGeneration,
      };
      const dependencies = await websiteDependenciesFor(guard);
      return loadWebsitePreview({ manifestRef, signal, dependencies });
    },
    clipStrategy: resolveProductionClipStrategy(),
  });
  previews.subscribe((state) =>
    send({ type: "website-preview", payload: state }),
  );
  // Business generation and abort. Every async website operation captures
  // the context it started under; any business change, reload, sign-out, or
  // app cleanup rotates the generation and aborts the in-flight requests, so
  // a late artifact read or handover write can never land under the next
  // business.
  let businessAbort = new AbortController();
  const invalidatePreviews = () => {
    businessGeneration += 1;
    const previous = businessAbort;
    businessAbort = new AbortController();
    previous.abort(new Error("The business context changed"));
    void previews.invalidateAll().catch(() => {});
    evidenceAuthority?.revokeAll();
    void evidenceHost?.invalidateAll().catch(() => {});
    managedBrowser?.revokeEvidenceRenewals?.();
  };
  const requireBusiness = (payload) => {
    if (!businessContext) {
      throw new Error("No active business for this request");
    }
    if (payload?.communityId !== businessContext.id) {
      throw new Error("The request is for another community");
    }
    return { context: businessContext, generation: businessGeneration };
  };
  const assertSameBusiness = (guard) => {
    if (
      guard.context === null ||
      guard.context !== businessContext ||
      guard.generation !== businessGeneration
    ) {
      throw new Error("The business context changed during the request");
    }
  };

  async function readTrustedOwnerPubkey() {
    const identity = await rendererHost.request("invoke", {
      command: "get_identity",
      args: {},
    });
    if (
      typeof identity?.pubkey !== "string" ||
      !/^[a-f0-9]{64}$/i.test(identity.pubkey)
    ) {
      throw new Error("The active owner identity is unavailable");
    }
    return identity.pubkey.toLowerCase();
  }

  function relayHttpOrigin(relay) {
    let parsed;
    try {
      parsed = new URL(relay);
    } catch {
      throw new Error("The business relay is invalid");
    }
    if (
      !["ws:", "wss:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      throw new Error("The business relay is invalid");
    }
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    return parsed.origin;
  }

  async function captureWebsiteScope(guard) {
    assertSameBusiness(guard);
    const ownerPubkey = await readTrustedOwnerPubkey();
    assertSameBusiness(guard);
    if (ownerPubkey !== guard.context.ownerPubkey)
      throw new Error("The active owner identity changed during this request");
    return Object.freeze({
      ownerPubkey,
      relay: guard.context.relay,
    });
  }

  async function websiteDependenciesFor(guard) {
    assertSameBusiness(guard);
    if (!guard.context?.relay) return undefined;
    const scope = await captureWebsiteScope(guard);
    const relayOrigin = relayHttpOrigin(scope.relay);
    const fetchMediaBytes = async (url, signal) => {
      assertSameBusiness(guard);
      const pending = rendererHost.request("invoke", {
        command: "fetch_website_artifact_bytes",
        args: nativeWebsiteArtifactArgs({
          url,
          ownerPubkey: scope.ownerPubkey,
          relay: scope.relay,
        }),
      });
      const raw = await awaitNativeArtifact(
        pending,
        signal ?? businessAbort.signal,
      );
      const bytes = decodeNativeArtifactBytes(raw);
      assertSameBusiness(guard);
      return { bytes };
    };
    return createAuthorizedDependencies({
      relayOrigin,
      fetchMediaBytes,
    });
  }

  // Evidence pages use the same pinned HTTPS implementation as website
  // previews. Public navigation stays on the default transport; only an
  // exact canonical relay-media URL may reach the host-mediated authenticated
  // reader, which captures owner identity again across the async boundary.
  const defaultEvidenceDependencies = createDefaultDependencies();
  const evidenceDependencies = {
    lookup: defaultEvidenceDependencies.lookup,
    open: defaultEvidenceDependencies.open,
    isAuthorized: ({ initialUrl, url } = {}) => {
      if (!businessContext?.relay) return false;
      try {
        return isCanonicalRelayMediaUrl({
          initialUrl,
          url,
          relayOrigin: relayHttpOrigin(businessContext.relay),
        });
      } catch {
        return false;
      }
    },
    openAuthorized: async ({ url, signal } = {}) => {
      const guard = {
        context: businessContext,
        generation: businessGeneration,
      };
      const dependencies = await websiteDependenciesFor(guard);
      const response = await dependencies.openAuthorized({ url, signal });
      assertSameBusiness(guard);
      return response;
    },
  };

  evidenceArtifactRenderer = createVerifiedArtifactRenderer({
    BrowserWindow,
    WebContentsView,
    View,
    session,
    loadPreview: async ({ manifestRef, signal }) => {
      const guard = {
        context: businessContext,
        generation: businessGeneration,
      };
      const site = await loadWebsitePreview({
        manifestRef,
        signal,
        dependencies: evidenceDependencies,
      });
      assertSameBusiness(guard);
      return site;
    },
  });

  resources.add(() => {
    const previous = businessAbort;
    businessAbort = new AbortController();
    previous.abort(new Error("The preview host is closing"));
    return previews.closeAll();
  });
  resources.add(() => evidenceArtifactRenderer?.close?.());
  const views = new BrowserViews(window, (payload) =>
    send({ type: "browser", payload }),
  );
  // Approvals this process has already begun a send for. Never cleared: a
  // journey that failed after clicking Send has still sent.
  const outreachAttempts = new Set();
  resources.add(() => views.closeAll());
  const terminalService = new TerminalService();
  const terminalIpc = registerTerminalIpc({
    ipcMain,
    webContents: window.webContents,
    service: terminalService,
  });
  resources.add(async () => {
    await Promise.race([
      terminalService.closeAll(),
      new Promise((resolve) => setTimeout(resolve, 6000)),
    ]);
  });
  resources.add(() => terminalIpc.dispose());
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
  const readManagedAgentRows = () =>
    rendererHost.request("invoke", {
      command: "list_managed_agents",
      args: {},
    });
  managedBrowser = new ManagedBrowser({
    root: runtime,
    socketPath,
    views,
    context: () => businessContext,
    roster: readManagedAgentRows,
  });

  evidenceAuthority = new EvidenceAuthority({
    context: () => businessContext,
    roster: readManagedAgentRows,
    assignment: createRelayTaskAssignmentResolver({
      read: (request) =>
        rendererHost.request("invoke", {
          command: "read_evidence_assignment",
          args: { request },
        }),
    }),
    workspace: async ({
      relayUrl,
      ownerPubkey,
      workerPubkey,
      worker,
    } = {}) => {
      if (
        worker === null ||
        typeof worker !== "object" ||
        !Number.isSafeInteger(worker.pid) ||
        worker.pid <= 0 ||
        typeof worker.last_started_at !== "string" ||
        typeof worker.browser_generation !== "string"
      ) {
        throw new Error("The assigned worker has no live native generation");
      }
      const resolved = await rendererHost.request("invoke", {
        command: "resolve_evidence_workspace",
        args: {
          request: {
            relayUrl,
            ownerPubkey,
            workerPubkey,
            pid: worker.pid,
            startedAt: worker.last_started_at,
            browserGeneration: worker.browser_generation,
          },
        },
      });
      if (typeof resolved !== "string" || !path.isAbsolute(resolved))
        throw new Error("The assigned worker has no authorized workspace");
      return resolved;
    },
  });
  evidenceHost = createEvidenceBrowserHost({
    BrowserWindow,
    WebContentsView,
    session,
    authority: evidenceAuthority,
    dependencies: evidenceDependencies,
    writeCapture: async ({
      ownerPubkey,
      relayUrl,
      workerPubkey,
      expectedPid,
      expectedStartNonce,
      fileName,
      bytesBase64,
    } = {}) => {
      if (
        !Number.isSafeInteger(expectedPid) ||
        expectedPid <= 0 ||
        typeof expectedStartNonce !== "string" ||
        typeof bytesBase64 !== "string"
      ) {
        throw new Error("Evidence capture arguments are invalid");
      }
      return rendererHost.request("invoke", {
        command: "write_evidence_capture",
        args: {
          ownerPubkey,
          relayUrl,
          workerPubkey,
          expectedPid,
          expectedStartNonce,
          fileName,
          bytesBase64,
        },
      });
    },
    artifactRenderer: evidenceArtifactRenderer,
  });
  resources.add(() => evidenceAuthority?.revokeAll());
  resources.add(() => managedBrowser?.revokeEvidenceRenewals?.());
  resources.add(() => evidenceHost?.close?.());

  async function issueEvidenceGrant(source = {}, { previousRenewalToken } = {}) {
    if (source === null || typeof source !== "object" || Array.isArray(source))
      throw new Error("Evidence scope is invalid");
    const communityId = source.communityId ?? businessContext?.id;
    const guard = requireBusiness({ communityId });
    const relayUrl = source.relayUrl
      ? normalizeRelay(source.relayUrl)
      : guard.context.relay;
    if (relayUrl !== guard.context.relay)
      throw new Error("Evidence relay scope does not match the active business");
    if (
      source.ownerPubkey !== undefined &&
      String(source.ownerPubkey).toLowerCase() !== guard.context.ownerPubkey
    )
      throw new Error("Evidence owner scope does not match the active identity");
    const scope = {
      communityId: guard.context.id,
      relayUrl: guard.context.relay,
      jobId: source.jobId,
      taskId: source.taskId,
      channelId: source.channelId,
      workerPubkey: source.workerPubkey,
      threadRoot: source.threadRoot,
    };
    const grant = await evidenceAuthority.issue(scope);
    try {
      assertSameBusiness(guard);
      await managedBrowser.writeEvidenceGrantFromAuthority(
        evidenceAuthority,
        grant.token,
        scope,
        { previousRenewalToken },
      );
      assertSameBusiness(guard);
      return Object.freeze({
        granted: true,
        communityId: scope.communityId,
        jobId: scope.jobId,
        taskId: scope.taskId,
        channelId: scope.channelId,
        workerPubkey: scope.workerPubkey,
        threadRoot: scope.threadRoot,
      });
    } catch (error) {
      evidenceAuthority.revoke(grant.token);
      throw error;
    }
  }

  const stopBroker = await startBroker(socketPath, async (request) => {
    if (request?.method === "evidence_reacquire") {
      const args = request.args;
      if (args === null || typeof args !== "object" || Array.isArray(args))
        throw new Error("Evidence renewal arguments are invalid");
      const renewal = managedBrowser.getEvidenceRenewal(
        args.renewalToken,
        args.scope,
      );
      await issueEvidenceGrant(renewal.scope, {
        previousRenewalToken: args.renewalToken,
      });
      return { reacquired: true };
    }
    if (managedBrowser.bindings.has(request?.token))
      return managedBrowser.request(request);
    if (evidenceHost?.has(request?.token))
      return evidenceHost.request(request);
    return views.request(request);
  });
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
      invalidatePreviews();
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
      invalidatePreviews();
      businessContext = null;
      views.setBusiness(null);
    }
    // The owner's approved outreach email never reaches the native host: the
    // Web tab it sends from belongs to this shell, not to the daemon.
    if (type === "invoke" && payload.command === "execute_outreach_send")
      return executeOutreachSend(payload.args, {
        tabs: () => views.ownerTabs(),
        send: ({ tabId, ...message }) => views.ownerMailSend(tabId, message),
        attempted: outreachAttempts,
      });
    // Only the original WebKit page can supply a migration snapshot.
    if (
      type === "invoke" &&
      payload.command === "electron_export_frontend_state"
    )
      throw new Error("The Electron renderer cannot supply legacy app state");
    if (["invoke", "listen", "unlisten", "emit"].includes(type))
      return rendererHost.request(type, payload);
    if (type === "shell") return shellCommand(window, payload);
    if (type === "business") {
      const relay = payload.relay ? normalizeRelay(payload.relay) : null;
      const nextId = payload.id || null;
      if (
        nextId !== null &&
        (typeof nextId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(nextId))
      )
        throw new Error("Invalid business");
      if (
        businessContext?.id !== nextId ||
        businessContext?.relay !== relay ||
        (nextId !== null && typeof businessContext?.ownerPubkey !== "string")
      ) {
        // Rotates the business generation, aborts in-flight website work,
        // and synchronously detaches every live preview before the new
        // context is installed. Only the new businessContext may open or
        // address a preview after this point.
        invalidatePreviews();
        views.setBusiness(null);
        businessContext = null;
        if (nextId !== null) {
          const generation = businessGeneration;
          const ownerPubkey = await readTrustedOwnerPubkey();
          if (generation !== businessGeneration || businessContext !== null)
            throw new Error("The business context changed during selection");
          businessContext = Object.freeze({
            id: nextId,
            relay,
            ownerPubkey,
            epoch: generation,
          });
        }
      }
      views.setBusiness(nextId);
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
    if (type === "browser:evidence-grant")
      return issueEvidenceGrant(payload.scope ?? payload);
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
    // Website previews ride the same trusted dispatch as every other native
    // call: the sender, main frame, and trusted URL were checked above. No
    // separate IPC channel and no preload bridge is added for them. Every
    // request carries the expected community, the trusted window is applied
    // last so a payload can never substitute another window, and async work
    // is aborted and re-checked against the captured business generation.
    if (
      type.startsWith("website-preview:") ||
      type.startsWith("website-artifact:") ||
      type === "website-handover:download"
    ) {
      const guard = requireBusiness(payload);
      if (type === "website-preview:open") {
        return previews.open({ ...payload, window });
      }
      if (type === "website-preview:bounds") {
        const result = previews.updateBounds({ ...payload, window });
        assertSameBusiness(guard);
        return result;
      }
      if (type === "website-preview:visible") {
        const result = previews.setVisible({ ...payload, window });
        assertSameBusiness(guard);
        return result;
      }
      if (type === "website-preview:close") {
        return previews.close({ ...payload, window });
      }
      if (type === "website-artifact:load") {
        const dependencies = await websiteDependenciesFor(guard);
        const artifact = await loadVerifiedArtifact({
          ref: payload.manifest,
          dependencies,
          signal: businessAbort.signal,
        });
        assertSameBusiness(guard);
        return {
          sha256: artifact.sha256,
          size: artifact.size,
          contentType: artifact.contentType,
          bytes: artifact.bytes,
        };
      }
      if (type === "website-handover:download") {
        const dependencies = await websiteDependenciesFor(guard);
        const result = await downloadHandover({
          window,
          items: payload.items,
          dependencies,
          signal: businessAbort.signal,
          assertCurrent: () => assertSameBusiness(guard),
          chooseDirectory: async (owner) => {
            const result = await dialog.showOpenDialog(owner, {
              title: "Choose where to save the approved handover",
              properties: [
                "openDirectory",
                "createDirectory",
                "promptToCreate",
              ],
            });
            if (result.canceled || result.filePaths.length === 0) return null;
            return result.filePaths[0];
          },
        });
        assertSameBusiness(guard);
        return result;
      }
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
        // Stable typed codes (for example `preview_closed`) survive the IPC
        // boundary as data; the preload prefixes them onto the thrown message.
        code:
          error !== null &&
          typeof error === "object" &&
          typeof error.code === "string"
            ? error.code
            : null,
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
  if (
    paths.stable ||
    packageMetadata.colonyReleaseChannel === "candidate" ||
    packageMetadata.colonyMigrationFixture === true
  ) {
    // Import before React, community selection, or onboarding can observe an empty store.
    await window.loadURL("colony://app/electron-migration.html");
    try {
      const restored = await window.webContents.executeJavaScript(
        'window.__COLONY_FRONTEND_MIGRATION__ ?? Promise.reject(new Error("App state migration did not start"))',
      );
      if (restored !== true)
        throw new Error("Saved app state could not be restored");
      window.webContents.session.flushStorageData();
    } catch (error) {
      // Keep the recovery page available; never mount an apparently empty account.
      console.error(
        "Colony app state migration failed:",
        error instanceof Error ? error.message : "App state transfer failed",
      );
      window.showInactive();
      return;
    }
  }
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

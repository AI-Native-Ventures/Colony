import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { PREVIEW_LOADING_RESERVE_BYTES } from "./host.mjs";
import {
  PREVIEW_CSP,
  PREVIEW_SCHEME,
  PREVIEW_SCHEME_DESCRIPTOR,
} from "./scheme.mjs";
import {
  MANIFEST_URL,
  SHA,
  createHost,
  createWindow,
  event,
  fakeSite,
  requestFor,
  tokenFor,
} from "./host-test-support.mjs";

const INLINE_HTML =
  '<!doctype html><button onclick="window.__n=1">go</button>' +
  "<script>window.__ready = true;</script>";

function hashToken(text) {
  const digest = createHash("sha256").update(text, "utf8").digest("base64");
  return `'sha256-${digest}'`;
}

test("scheme descriptor is the single pre-ready registration", () => {
  assert.equal(PREVIEW_SCHEME, "colony-preview");
  assert.equal(PREVIEW_SCHEME_DESCRIPTOR.scheme, PREVIEW_SCHEME);
  assert.ok(Object.isFrozen(PREVIEW_SCHEME_DESCRIPTOR));
  assert.deepEqual(PREVIEW_SCHEME_DESCRIPTOR.privileges, {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    corsEnabled: false,
    allowServiceWorkers: false,
  });
});

test("open mounts one isolated sandboxed view per identity", async () => {
  const { host, world } = createHost();
  const window = createWindow();
  const state = await host.open(requestFor(window));

  assert.equal(state.status, "ready");
  assert.ok(Object.isFrozen(state));
  assert.match(state.handle, /^[0-9a-f]{32}$/);
  assert.ok(state.scopeId.endsWith(":desktop"));
  assert.equal(state.revision, 1);
  assert.equal(state.manifestSha256, SHA);
  assert.equal(state.inlineScriptsTruncated, false);

  assert.equal(world.partitions.length, 1);
  assert.match(world.partitions[0], /^preview-[0-9a-f]{32}$/);
  assert.equal(world.partitions[0].startsWith("persist:"), false);

  const previewSession = world.sessions.get(world.partitions[0]);
  const view = world.views[0];
  const prefs = view.options.webPreferences;
  assert.equal(prefs.session, previewSession);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.nodeIntegrationInWorker, false);
  assert.equal(prefs.nodeIntegrationInSubFrames, false);
  assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.allowRunningInsecureContent, false);
  assert.equal(prefs.webviewTag, false);
  assert.equal(prefs.devTools, false);
  assert.equal(prefs.disableDialogs, true);
  assert.equal("preload" in prefs, false);

  assert.equal(window.contentView.children.length, 1);
  assert.equal(window.contentView.children[0].children[0], view);
  assert.equal(view.webContents.windowOpenHandler().action, "deny");
  assert.deepEqual(view.webContents.loaded, [
    `${PREVIEW_SCHEME}://${tokenFor(world.partitions[0])}/index.html`,
  ]);

  const again = await host.open(requestFor(window));
  assert.equal(again.handle, state.handle);
  assert.equal(world.partitions.length, 1);
  assert.equal(world.views.length, 1);
  assert.equal(host.activeCount, 1);

  await host.open(requestFor(window, { jobId: "job-2" }));
  assert.equal(world.partitions.length, 2);
  assert.notEqual(world.partitions[0], world.partitions[1]);
  assert.equal(host.activeCount, 2);
});

test("malformed scope and mismatched artifacts fail closed", async () => {
  const cases = [
    { threadRoot: "nope" },
    { revision: 0 },
    { revision: 1.5 },
    { viewport: "tablet" },
    { viewport: "mobile", pixelWidth: 1440, pixelHeight: 900 },
    { communityId: "" },
    { jobId: "bad job" },
    { manifest: { url: MANIFEST_URL, sha256: "AB" } },
    { manifest: null },
    { pixelWidth: 0 },
    { pixelHeight: 9000 },
    { signal: { aborted: false } },
  ];
  for (const overrides of cases) {
    const { host, world, loadCalls } = createHost();
    await assert.rejects(
      host.open(requestFor(createWindow(), overrides)),
      (error) => error?.name === "PreviewHostError",
    );
    assert.equal(loadCalls.length, 0);
    assert.equal(world.partitions.length, 0);
  }

  const mismatched = createHost({
    site: fakeSite({ manifestSha256: "c".repeat(64) }),
  });
  await assert.rejects(
    mismatched.host.open(requestFor(createWindow())),
    (error) => error?.code === "manifest_mismatch",
  );
  assert.equal(mismatched.world.partitions.length, 0);
  assert.equal(mismatched.host.activeCount, 0);

  const noWindow = createHost();
  await assert.rejects(
    noWindow.host.open(requestFor(null)),
    (error) => error?.code === "invalid_window",
  );
});

test("a failed first load rejects and tears the mount down", async () => {
  const { host, world } = createHost({
    loadFailure: { code: -6, description: "ERR_FILE_NOT_FOUND" },
  });
  const window = createWindow();
  await assert.rejects(
    host.open(requestFor(window)),
    (error) => error?.code === "preview_load_failed",
  );
  assert.equal(host.activeCount, 0);
  const previewSession = world.sessions.get(world.partitions[0]);
  assert.equal(previewSession.protocol.handlers.has(PREVIEW_SCHEME), false);
  assert.equal(previewSession.storageCleared, 1);
  assert.equal(world.views[0].webContents.closed, true);
  assert.equal(window.contentView.children.length, 0);
});

test("a stopped renderer after ready pushes a scoped failed state", async () => {
  const { host, world } = createHost();
  const states = [];
  const unsubscribe = host.subscribe((state) => states.push(state));
  const window = createWindow();
  const state = await host.open(requestFor(window));
  assert.equal(states.at(-1).status, "ready");
  assert.equal(states.at(-1).handle, state.handle);

  world.views[0].webContents.emit(
    "render-process-gone",
    {},
    { reason: "crash" },
  );
  const failed = states.at(-1);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "renderer_gone");
  assert.equal(failed.visible, false);
  assert.equal(failed.handle, state.handle);

  await host.close({ window, handle: state.handle });
  assert.equal(states.at(-1).status, "closed");
  unsubscribe();
});

test("the partition protocol serves only verified listed files", async () => {
  const { host, world } = createHost();
  const window = createWindow();
  const state = await host.open(requestFor(window));
  const partition = world.partitions[0];
  const previewSession = world.sessions.get(partition);
  const handler = previewSession.protocol.handlers.get(PREVIEW_SCHEME);
  const base = `${PREVIEW_SCHEME}://${tokenFor(partition)}`;

  const script = await handler({ url: `${base}/assets/app.js`, method: "GET" });
  assert.equal(script.status, 200);
  assert.equal(
    script.headers.get("content-type"),
    "text/javascript; charset=utf-8",
  );
  assert.equal(script.headers.get("x-content-type-options"), "nosniff");
  assert.equal(script.headers.get("cache-control"), "no-store");
  // Non-HTML responses carry the base CSP and never inline authorizations.
  assert.equal(script.headers.get("content-security-policy"), PREVIEW_CSP);
  assert.ok(!script.headers.get("content-security-policy").includes("sha256-"));
  assert.match(
    script.headers.get("content-security-policy"),
    /default-src 'none'/,
  );
  assert.match(
    script.headers.get("content-security-policy"),
    /connect-src 'self'/,
  );
  assert.match(
    script.headers.get("content-security-policy"),
    /form-action 'none'/,
  );
  assert.equal(
    Buffer.from(await script.arrayBuffer()).toString("utf8"),
    "console.log('ok')",
  );

  const root = await handler({ url: `${base}/`, method: "GET" });
  assert.equal(root.status, 200);
  assert.equal(root.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(
    Buffer.from(await root.arrayBuffer()).toString("utf8"),
    "<!doctype html><title>preview</title>",
  );

  for (const url of [
    `${base}/missing.js`,
    `${base}/assets/../secret.js`,
    `${base}/%252e%252e/secret.js`,
    `${base}/assets/app.js%00.png`,
    `${base}/assets%5Capp.js`,
    `${base}:8443/index.html`,
    `${base.replace("//", "//user:pass@")}/index.html`,
    `${PREVIEW_SCHEME}://other-token/index.html`,
    "https://cdn.example.com/index.html",
  ]) {
    const miss = await handler({ url, method: "GET" });
    assert.equal(miss.status, 404, url);
  }

  const post = await handler({ url: `${base}/index.html`, method: "POST" });
  assert.equal(post.status, 405);

  await host.close({ window, handle: state.handle });
  const afterClose = await handler({
    url: `${base}/index.html`,
    method: "GET",
  });
  assert.equal(afterClose.status, 404);
});

test("inline authorizations are computed per served HTML page", async () => {
  const secondPage =
    "<!doctype html><script>window.__p2 = true;</script>" +
    '<button onclick="window.__p2click = true">x</button>';
  const { host, world } = createHost({
    site: fakeSite({
      fileList: [
        ["index.html", INLINE_HTML, "text/html"],
        ["page2.html", secondPage, "text/html"],
      ],
    }),
  });
  const window = createWindow();
  const state = await host.open(requestFor(window));
  const handler = world.sessions
    .get(world.partitions[0])
    .protocol.handlers.get(PREVIEW_SCHEME);
  const base = `${PREVIEW_SCHEME}://${tokenFor(world.partitions[0])}`;

  const first = await handler({ url: `${base}/index.html`, method: "GET" });
  const firstScript = first.headers
    .get("content-security-policy")
    .split("; ")
    .find((directive) => directive.startsWith("script-src"));
  assert.ok(firstScript.includes(hashToken("window.__ready = true;")));
  assert.ok(firstScript.includes("'unsafe-hashes'"));
  assert.ok(firstScript.includes(hashToken("window.__n=1")));
  assert.ok(!firstScript.includes("'unsafe-inline'"));

  const second = await handler({ url: `${base}/page2.html`, method: "GET" });
  const secondScript = second.headers
    .get("content-security-policy")
    .split("; ")
    .find((directive) => directive.startsWith("script-src"));
  assert.ok(secondScript.includes(hashToken("window.__p2 = true;")));
  assert.ok(secondScript.includes(hashToken("window.__p2click = true")));
  assert.ok(!secondScript.includes(hashToken("window.__ready = true;")));
  assert.equal(state.inlineScriptsTruncated, false);
  await host.close({ window, handle: state.handle });
});

test("an over-limit page reports recoverable inline truncation once", async () => {
  const many = Array.from(
    { length: 129 },
    (_, index) => `<script>x${index}</script>`,
  ).join("");
  const { host, world } = createHost({
    site: fakeSite({
      fileList: [
        [
          "index.html",
          "<!doctype html><script>window.__entry=true;</script>",
          "text/html",
        ],
        ["page2.html", `<!doctype html>${many}`, "text/html"],
      ],
    }),
  });
  const states = [];
  host.subscribe((value) => states.push(value));
  const window = createWindow();
  const state = await host.open(requestFor(window));
  assert.equal(state.inlineScriptsTruncated, false);

  const handler = world.sessions
    .get(world.partitions[0])
    .protocol.handlers.get(PREVIEW_SCHEME);
  const base = `${PREVIEW_SCHEME}://${tokenFor(world.partitions[0])}`;
  const first = await handler({ url: `${base}/page2.html`, method: "GET" });
  const second = await handler({ url: `${base}/page2.html`, method: "GET" });

  assert.equal(
    first.headers.get("content-security-policy"),
    second.headers.get("content-security-policy"),
  );
  assert.equal(host.byHandle.get(state.handle).inlineScriptsTruncated, true);
  assert.equal(
    states.filter((value) => value.inlineScriptsTruncated === true).length,
    1,
  );
  await host.close({ window, handle: state.handle });
});

test("the origin root and explicit entrypoint share one authorization", async () => {
  const many = Array.from(
    { length: 129 },
    (_, index) => `<script>y${index}</script>`,
  ).join("");
  const { host, world } = createHost({
    site: fakeSite({
      fileList: [["index.html", `<!doctype html>${many}`, "text/html"]],
    }),
  });
  const states = [];
  host.subscribe((value) => states.push(value));
  const window = createWindow();
  const state = await host.open(requestFor(window));
  const handler = world.sessions
    .get(world.partitions[0])
    .protocol.handlers.get(PREVIEW_SCHEME);
  const base = `${PREVIEW_SCHEME}://${tokenFor(world.partitions[0])}`;

  const root = await handler({ url: `${base}/`, method: "GET" });
  const explicit = await handler({ url: `${base}/index.html`, method: "GET" });
  assert.equal(root.status, 200);
  assert.equal(explicit.status, 200);
  assert.equal(
    root.headers.get("content-security-policy"),
    explicit.headers.get("content-security-policy"),
  );
  assert.equal(host.byHandle.get(state.handle).cspByPath.size, 1);
  assert.equal(
    states.filter((value) => value.inlineScriptsTruncated === true).length,
    1,
  );
  await host.close({ window, handle: state.handle });
});

test("open seeds the fitted zoom and navigation re-applies it", async () => {
  const { host, world } = createHost();
  const window = createWindow();
  const state = await host.open(
    requestFor(window, {
      bounds: { x: 0, y: 0, width: 360, height: 300 },
    }),
  );
  const view = world.views[0];
  assert.equal(view.options.webPreferences.zoomFactor, 0.25);
  const before = view.webContents.zoomFactorCalls.length;
  view.webContents.emit("did-navigate");
  assert.ok(view.webContents.zoomFactorCalls.length > before);
  assert.equal(view.webContents.zoomFactorCalls.at(-1), 0.25);
  await host.close({ window, handle: state.handle });
});

test("navigation, popups, permissions, and downloads are denied", async () => {
  const { host, world } = createHost();
  const window = createWindow();
  await host.open(requestFor(window));
  const previewSession = world.sessions.get(world.partitions[0]);
  const webContents = world.views[0].webContents;
  const base = `${PREVIEW_SCHEME}://${tokenFor(world.partitions[0])}`;

  const allowedNavigation = event();
  webContents.emit("will-navigate", allowedNavigation, `${base}/assets/app.js`);
  assert.equal(allowedNavigation.prevented, false);

  for (const [name, url] of [
    ["will-navigate", "https://evil.example.com/"],
    ["will-navigate", `${PREVIEW_SCHEME}://someone-else/index.html`],
    ["will-navigate", `${base}/missing.js`],
    ["will-redirect", "https://evil.example.com/next"],
  ]) {
    const target = event();
    webContents.emit(name, target, url);
    assert.equal(target.prevented, true, `${name} ${url}`);
  }

  const frame = { ...event(), url: "https://evil.example.com/frame" };
  webContents.emit("will-frame-navigate", frame);
  assert.equal(frame.prevented, true);

  const attach = event();
  webContents.emit("will-attach-webview", attach);
  assert.equal(attach.prevented, true);

  let permission;
  previewSession.permissionRequestHandler({}, "media", (value) => {
    permission = value;
  });
  assert.equal(permission, false);
  assert.equal(previewSession.permissionCheckHandler(), false);

  let downloadPrevented = false;
  let cancelled = 0;
  previewSession.emit(
    "will-download",
    {
      preventDefault() {
        downloadPrevented = true;
      },
    },
    {
      cancel() {
        cancelled += 1;
      },
    },
  );
  assert.equal(downloadPrevented, true);
  assert.equal(cancelled, 1);

  let requestOptions;
  previewSession.webRequest.handler(
    { url: "https://evil.example.com/x" },
    (options) => {
      requestOptions = options;
    },
  );
  assert.deepEqual(requestOptions, { cancel: true });
  previewSession.webRequest.handler(
    { url: `${base}/index.html` },
    (options) => {
      requestOptions = options;
    },
  );
  assert.deepEqual(requestOptions, { cancel: false });
});

test("close and community invalidation abort a pending load", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { host, world, loadCalls } = createHost({
    loadPreview: async (request) => {
      loadCalls.push(request);
      await gate;
      return fakeSite();
    },
  });
  const window = createWindow();
  const opening = host.open(requestFor(window));
  assert.equal(host.activeCount, 1);
  await host.closeAllForCommunity("community-1");
  assert.equal(host.activeCount, 0);
  assert.equal(loadCalls[0].signal.aborted, true);
  release();
  await assert.rejects(opening, (error) => error?.code === "preview_closed");
  assert.equal(world.partitions.length, 0);
  assert.equal(world.views.length, 0);
});

test("a caller abort rejects the pending open and mounts nothing", async () => {
  const { host, world } = createHost({
    loadPreview: ({ signal }) =>
      new Promise((_resolve, reject) => {
        const abort = () =>
          reject(Object.assign(new Error("aborted"), { code: "aborted" }));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }),
  });
  const window = createWindow();
  const controller = new AbortController();
  const opening = host.open(requestFor(window, { signal: controller.signal }));
  controller.abort();
  await assert.rejects(opening, (error) => error?.code === "preview_aborted");
  assert.equal(host.activeCount, 0);
  assert.equal(world.partitions.length, 0);
});

test("owner window close tears down only that window's previews", async () => {
  const { host, world } = createHost();
  const windowA = createWindow(1);
  const windowB = createWindow(2);
  await host.open(requestFor(windowA));
  await host.open(requestFor(windowB, { jobId: "job-2" }));
  assert.equal(windowA.listenerCount("closed"), 1);
  const sessionA = world.sessions.get(world.partitions[0]);

  windowA.emit("closed");
  await host.whenIdle();

  assert.equal(host.activeCount, 1);
  assert.equal(windowA.contentView.children.length, 0);
  assert.equal(sessionA.protocol.handlers.has(PREVIEW_SCHEME), false);
  assert.equal(sessionA.webRequest.handler, null);
  assert.equal(sessionA.storageCleared, 1);
  assert.equal(sessionA.cacheCleared, 1);
  assert.equal(windowA.listenerCount("closed"), 0);
  assert.equal(windowB.contentView.children.length, 1);
});

test("community invalidation detaches synchronously then cleans up", async () => {
  const { host, world } = createHost();
  const window = createWindow();
  await host.open(requestFor(window));
  await host.open(requestFor(window, { jobId: "job-2" }));
  await host.open(
    requestFor(window, { jobId: "job-3", communityId: "community-2" }),
  );
  assert.equal(window.contentView.children.length, 3);
  const [first, second] = window.contentView.children;

  const cleanup = host.closeAllForCommunity("community-1");
  assert.equal(host.activeCount, 1);
  assert.equal(window.contentView.children.length, 1);
  assert.equal(first.children.length, 0);
  assert.equal(second.children.length, 0);
  assert.equal(first.visible, false);

  await cleanup;
  const session = world.sessions.get(world.partitions[0]);
  assert.equal(session.protocol.handlers.has(PREVIEW_SCHEME), false);
  assert.equal(session.storageCleared, 1);
  assert.equal(session.cacheCleared, 1);
  assert.equal(host.activeCount, 1);
});

test("viewport is part of identity and mismatched sizes are refused", async () => {
  const { host, world } = createHost();
  const window = createWindow();
  const desktop = await host.open(requestFor(window));
  const mobile = await host.open(
    requestFor(window, {
      viewport: "mobile",
      pixelWidth: 390,
      pixelHeight: 844,
    }),
  );
  assert.notEqual(desktop.handle, mobile.handle);
  assert.notEqual(desktop.scopeId, mobile.scopeId);
  assert.equal(mobile.viewport, "mobile");
  assert.equal(mobile.pixelWidth, 390);
  assert.equal(world.partitions.length, 2);
  assert.equal(host.activeCount, 2);
});

test("a stale handle from a closed mount is harmless after reopen", async () => {
  const { host } = createHost();
  const window = createWindow();
  const first = await host.open(requestFor(window));
  await host.close({ window, handle: first.handle });

  const reopened = await host.open(requestFor(window));
  assert.notEqual(reopened.handle, first.handle);
  assert.equal(host.activeCount, 1);

  assert.equal(
    host.updateBounds({
      window,
      handle: first.handle,
      bounds: { x: 0, y: 0, width: 720, height: 450 },
    }),
    null,
  );
  assert.equal(
    host.setVisible({ window, handle: first.handle, visible: true }),
    null,
  );
  await host.close({ window, handle: first.handle });
  assert.equal(host.activeCount, 1);

  const container = window.contentView.children[0];
  assert.equal(container.visible, false);
  assert.equal(
    host.stateFor(host.byHandle.get(reopened.handle)).visible,
    false,
  );

  await host.close({ window, handle: reopened.handle });
  assert.equal(host.activeCount, 0);
});

test("revision identities close independently and can be reopened", async () => {
  const { host, world } = createHost();
  const window = createWindow();
  const manifestA = { url: MANIFEST_URL, sha256: SHA };
  const manifestB = { url: MANIFEST_URL, sha256: "d".repeat(64) };
  const first = await host.open(
    requestFor(window, { revision: 1, manifest: manifestA }),
  );
  const second = await host.open(
    requestFor(window, { revision: 2, manifest: manifestB }),
  );
  assert.notEqual(first.handle, second.handle);
  assert.equal(host.activeCount, 2);

  await host.close({ window, handle: first.handle });
  assert.equal(host.activeCount, 1);
  assert.equal(world.views[0].webContents.closed, true);
  assert.equal(world.views[1].webContents.closed, false);

  const reopened = await host.open(
    requestFor(window, { revision: 1, manifest: manifestA }),
  );
  assert.equal(host.activeCount, 2);
  assert.equal(world.partitions.length, 3);
  assert.notEqual(world.partitions[2], world.partitions[0]);

  const otherWindow = createWindow(9);
  await assert.rejects(
    host.close({ window: otherWindow, handle: reopened.handle }),
    (error) => error?.code === "wrong_window",
  );
  assert.equal(host.activeCount, 2);
});

test("view count and memory budgets fail closed", async () => {
  const single = createHost({ maxViews: 1 });
  const window = createWindow();
  await single.host.open(requestFor(window));
  await assert.rejects(
    single.host.open(requestFor(window, { jobId: "job-2" })),
    (error) => error?.code === "too_many_views",
  );
  assert.equal(single.loadCalls.length, 1);

  const sized = createHost({
    maxTotalBytes: PREVIEW_LOADING_RESERVE_BYTES,
    site: fakeSite({ sizes: [32 * 1024 * 1024] }),
  });
  await sized.host.open(requestFor(window));
  await assert.rejects(
    sized.host.open(requestFor(window, { jobId: "job-2" })),
    (error) => error?.code === "memory_limit",
  );
  assert.equal(sized.loadCalls.length, 1);
});

test("close is idempotent and tears everything down exactly once", async () => {
  const { host, world } = createHost();
  const window = createWindow();
  const state = await host.open(requestFor(window));
  const previewSession = world.sessions.get(world.partitions[0]);
  const view = world.views[0];

  await host.close({ window, handle: state.handle });
  await host.close({ window, handle: state.handle });
  await host.close({ window, handle: "0".repeat(32) });

  assert.equal(host.activeCount, 0);
  assert.equal(view.webContents.closed, true);
  assert.deepEqual(view.webContents.closeOptions, {
    waitForBeforeUnload: false,
  });
  assert.equal(previewSession.protocol.handlers.has(PREVIEW_SCHEME), false);
  assert.equal(previewSession.webRequest.handler, null);
  assert.equal(previewSession.storageCleared, 1);
  assert.equal(previewSession.cacheCleared, 1);
  assert.equal(previewSession.listeners.get("will-download")?.length ?? 0, 0);
  assert.equal(window.listenerCount("closed"), 0);
});

test("late events after close never resurrect the view", async () => {
  const { host, world } = createHost();
  const window = createWindow();
  const state = await host.open(requestFor(window));
  host.updateBounds({
    window,
    handle: state.handle,
    bounds: { x: 0, y: 0, width: 720, height: 450 },
    clip: null,
    zoom: 1,
  });
  host.setVisible({ window, handle: state.handle, visible: true });
  const view = world.views[0];
  assert.equal(view.visible, true);

  await host.close({ window, handle: state.handle });
  view.webContents.emit("did-finish-load");
  view.webContents.emit("did-navigate");
  view.webContents.emit("render-process-gone");
  view.webContents.emit("will-navigate", event(), "https://evil.example.com/");

  assert.equal(view.visible, false);
  assert.equal(view.webContents.closed, true);
  assert.equal(host.activeCount, 0);
});

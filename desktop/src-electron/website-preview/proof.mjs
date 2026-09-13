/**
 * Real-Electron proof for the isolated website preview host.
 *
 * Run with the repository's Electron (never with Node):
 *
 *   pnpm --dir desktop exec electron src-electron/website-preview/proof.mjs
 *
 * This instantiates real `View`, `WebContentsView`, and `session` objects,
 * mounts a fixture artifact (manifest bytes and file bytes are generated
 * in-process; the network is never used) through the separate-origin native
 * clip wrapper, and measures the actual artifact child frame: CSS viewport and
 * media queries, inline-script execution, and denial of navigation, popups,
 * permissions, and network. It also attempts a composited pixel sample for
 * wrapper clipping via `desktopCapturer`;
 * when the OS withholds screen capture the clip result is reported
 * `unavailable`, never silently passed.
 *
 * This is host-fixture proof. It does not prove packaged Colony adoption,
 * relay integration, or that the real artifact loader fetched anything.
 * Results are written to `COLONY_PREVIEW_PROOF_DIR` (default
 * `test-results/website-preview-proof`) and the process exits non-zero when
 * any required check fails.
 */

import { createHash } from "node:crypto";
import path from "node:path";

import {
  BrowserWindow,
  View,
  WebContentsView,
  app,
  desktopCapturer,
  protocol,
  session,
} from "electron";

import { createWebsitePreviewHost } from "./host.mjs";
import { createProofReport } from "./proof-report.mjs";
import {
  navigationEvidence,
  observeFrameNavigation,
} from "./proof-navigation.mjs";
import { PREVIEW_SCHEME_DESCRIPTOR, parsePreviewUrl } from "./scheme.mjs";
import { PREVIEW_WRAPPER_FRAME_ID } from "./serving.mjs";

// Same pre-ready registration as the real app: the proof origin must be a
// standard secure context for relative paths and navigator APIs to behave
// like production.
protocol.registerSchemesAsPrivileged([PREVIEW_SCHEME_DESCRIPTOR]);

const PROOF_DIR =
  process.env.COLONY_PREVIEW_PROOF_DIR ??
  path.join(process.cwd(), "test-results/website-preview-proof");
// Integer fitting can move the CSS height by a fraction of a pixel; width
// must be exact. A larger gap means the fitted zoom factor is not in effect.
const MAX_ROUNDING_TOLERANCE_CSS_PX = 2;
// Chromium reports a fixed CSS size through device-scaled layout as a tiny
// subpixel fraction on some macOS display configurations. The child frame's
// viewport remains exact; this bound only admits that representation error on
// the wrapper's rect and computed style while retaining their raw values in
// proof.json.
const MAX_WRAPPER_SUBPIXEL_ERROR_CSS_PX = 0.02;

const FIXTURE_HTML =
  '<!doctype html><html><head><meta charset="utf-8">' +
  "<style>html,body{margin:0;height:100%}body{background:#123456;color:#fff}" +
  "</style></head><body>" +
  '<button id="btn" onclick="window.__clicked=(window.__clicked||0)+1">go</button>' +
  '<a id="next" href="page2.html">next</a>' +
  "<script>window.__ready = true;</script>" +
  "</body></html>";

const SECOND_PAGE_HTML =
  '<!doctype html><html><body style="margin:0;background:#234567">' +
  "<script>window.__page2 = true;</script>" +
  '<button id="p2" onclick="window.__page2Clicked = true">p2</button>' +
  "</body></html>";

const results = {
  checks: [],
  geometry: {},
  clip: { status: "unavailable", detail: null },
  notes: [],
};

// Keep the native proof from completing when a phase accidentally stops
// recording a check. The workflow repeats this contract against proof.json so
// a report serialization regression cannot turn a partial run into a pass.
const REQUIRED_CHECK_NAMES = Object.freeze([
  "geometry.desktopCssViewport",
  "geometry.desktopMediaQuery",
  "interaction.inlineScript",
  "interaction.inlineHandler",
  "interaction.secondPageNavigation",
  "interaction.secondPageInlineScript",
  "interaction.secondPageInlineHandler",
  "geometry.mobileCssViewport",
  "geometry.mobileMediaQuery",
  "denial.externalNavigation",
  "denial.popup",
  "denial.permission",
  "denial.network",
  "isolation.crossEntryNavigation",
  "isolation.distinctPartitions",
  "lifecycle.closed",
]);

// Crash-safe reporting: the file exists before any Electron work and keeps the
// last completed phase on disk. The watchdog turns a hang into a written
// timeout error instead of a job that dies with nothing to read.
const report = createProofReport({
  directory: PROOF_DIR,
  exit: (code) => app.exit(code),
});
report.attachProcessHandlers();
report.attachAppHandlers(app);

const snapshot = () => ({
  checks: results.checks,
  geometry: results.geometry,
  clip: results.clip,
  notes: results.notes,
});

function phase(name) {
  report.phase(name, snapshot());
}

function hashOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function check(name, ok, detail, extra = {}) {
  results.checks.push({ name, ok: ok === true, detail, ...extra });
}

function createFixture() {
  const files = [
    ["index.html", Buffer.from(FIXTURE_HTML, "utf8"), "text/html"],
    ["page2.html", Buffer.from(SECOND_PAGE_HTML, "utf8"), "text/html"],
    [
      "assets/app.js",
      Buffer.from("window.__assetLoaded = true;", "utf8"),
      "text/javascript",
    ],
  ];
  const metadata = new Map();
  for (const [filePath, bytes, mime] of files) {
    metadata.set(
      filePath,
      Object.freeze({
        path: filePath,
        url: `https://fixture.invalid/${filePath}`,
        sha256: hashOf(bytes),
        mime,
        size: bytes.byteLength,
        contentType: mime,
      }),
    );
  }
  const manifest = Buffer.from(
    JSON.stringify({
      schema: "colony.website-preview/1",
      entrypoint: "index.html",
      files: [...metadata.values()],
    }),
    "utf8",
  );
  const manifestSha256 = hashOf(manifest);
  const bodies = new Map(files.map(([filePath, bytes]) => [filePath, bytes]));
  const site = Object.freeze({
    schema: "colony.website-preview/1",
    entrypoint: "index.html",
    manifestSha256,
    files: Object.freeze([...metadata.values()]),
    entrypointFile: metadata.get("index.html"),
    getFile(filePath) {
      const file = metadata.get(filePath);
      if (file === undefined) return null;
      return Object.freeze({
        ...file,
        bytes: Buffer.from(bodies.get(filePath)),
      });
    },
  });
  return {
    site,
    manifestRef: {
      url: "https://fixture.invalid/manifest.json",
      sha256: manifestSha256,
    },
  };
}

function requestFor(window, fixture, communityId, overrides = {}) {
  return {
    window,
    communityId,
    jobId: "proof-job",
    threadRoot: "b".repeat(64),
    revision: 1,
    manifest: fixture.manifestRef,
    viewport: "desktop",
    pixelWidth: 1440,
    pixelHeight: 900,
    visible: true,
    ...overrides,
  };
}

async function evaluate(webContents, expression) {
  try {
    return await webContents.executeJavaScript(expression);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function artifactFrame(entry, path = entry.site.entrypoint) {
  try {
    const frames = entry.webContents.mainFrame?.frames;
    if (!Array.isArray(frames)) return null;
    return (
      frames.find((frame) => {
        const parsed = parsePreviewUrl(frame?.url);
        if (parsed === null || parsed.token !== entry.token) return false;
        const framePath =
          parsed.path === "" ? entry.site.entrypoint : parsed.path;
        return framePath === path;
      }) ?? null
    );
  } catch {
    return null;
  }
}

async function waitForArtifactFrame(entry, path = entry.site.entrypoint) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const frame = artifactFrame(entry, path);
    if (frame !== null) return frame;
    await delay(25);
  }
  throw new Error(`artifact frame did not load ${path}`);
}

async function evaluateArtifact(
  entry,
  expression,
  path = entry.site.entrypoint,
) {
  try {
    const frame = await waitForArtifactFrame(entry, path);
    return await frame.executeJavaScript(expression);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function wrapperFrameMetrics(entry) {
  return evaluate(
    entry.webContents,
    `(() => {
      const frame = document.getElementById(${JSON.stringify(PREVIEW_WRAPPER_FRAME_ID)});
      if (frame === null) return null;
      const rect = frame.getBoundingClientRect();
      const style = getComputedStyle(frame);
      return {
        width: rect.width,
        height: rect.height,
        styleWidth: style.width,
        styleHeight: style.height,
        styleWidthPx: Number.parseFloat(style.width),
        styleHeightPx: Number.parseFloat(style.height),
      };
    })()`,
  );
}

function hasExpectedWrapperSize(wrapper, width, height) {
  return (
    wrapper !== null &&
    wrapper !== undefined &&
    wrapper.width === width &&
    Math.abs(wrapper.height - height) <= MAX_WRAPPER_SUBPIXEL_ERROR_CSS_PX &&
    wrapper.styleWidthPx === width &&
    Math.abs(wrapper.styleHeightPx - height) <=
      MAX_WRAPPER_SUBPIXEL_ERROR_CSS_PX
  );
}

async function proveGeometry(host, window, fixture) {
  const desktop = await host.open(
    requestFor(window, fixture, "community-proof", {
      bounds: { x: 0, y: 64, width: 900, height: 636 },
    }),
  );
  phase("mount");
  const desktopEntry = host.byHandle.get(desktop.handle);
  const desktopWrapper = await wrapperFrameMetrics(desktopEntry);
  const desktopFrame = await waitForArtifactFrame(desktopEntry);
  const metrics = await evaluateArtifact(
    desktopEntry,
    "({ width: innerWidth, height: innerHeight, narrow: matchMedia('(max-width: 1439px)').matches, ready: window.__ready === true })",
  );
  // The native wrapper is intentionally sized to the visible slice. The
  // artifact frame retains the fitted child geometry inside its fixed CSS
  // iframe, which is the viewport this proof must measure.
  const desktopView = desktopEntry.layout.child;
  const desktopExpectedCssHeight = desktopEntry.pixelHeight;
  const desktopMeasuredDelta = Math.abs(
    metrics.height - desktopExpectedCssHeight,
  );
  const desktopTolerance = Math.abs(desktopExpectedCssHeight - 900);
  results.geometry.desktop = {
    ...metrics,
    childFrameUrl: desktopFrame.url,
    wrapperFrame: desktopWrapper,
    wrapperBounds: {
      width: desktopEntry.view.getBounds().width,
      height: desktopEntry.view.getBounds().height,
    },
    fitted: { width: desktopView.width, height: desktopView.height },
    expectedCssHeight: desktopExpectedCssHeight,
    tolerance: desktopTolerance,
  };
  check(
    "geometry.desktopCssViewport",
    metrics.width === 1440 &&
      metrics.height === 900 &&
      hasExpectedWrapperSize(desktopWrapper, 1440, 900) &&
      desktopMeasuredDelta <= 1 &&
      desktopTolerance <= MAX_ROUNDING_TOLERANCE_CSS_PX,
    `innerWidth=${metrics.width} innerHeight=${metrics.height} expectedHeight=${desktopExpectedCssHeight}`,
    {
      toleranceCssPx: desktopTolerance,
      measuredDeltaCssPx: desktopMeasuredDelta,
    },
  );
  check(
    "geometry.desktopMediaQuery",
    metrics.narrow === false,
    "matchMedia('(max-width: 1439px)')",
  );
  phase("geometry desktop");
  check(
    "interaction.inlineScript",
    metrics.ready === true,
    "verified inline script ran under the hash-authorized CSP",
  );
  await evaluateArtifact(
    desktopEntry,
    "document.getElementById('btn').click()",
  );
  const clicked = await evaluateArtifact(
    desktopEntry,
    "window.__clicked === 1",
  );
  check(
    "interaction.inlineHandler",
    clicked === true,
    "verified inline event handler ran",
  );

  // A verified second document must receive its own hash-authorized CSP; the
  // entrypoint's authorization must not be the only one that works.
  await evaluateArtifact(desktopEntry, "location.href = 'page2.html'; 'set'");
  await delay(500);
  const secondPage = await evaluateArtifact(
    desktopEntry,
    "({ url: location.href, script: window.__page2 === true })",
    "page2.html",
  );
  check(
    "interaction.secondPageNavigation",
    typeof secondPage.url === "string" &&
      secondPage.url.endsWith("/page2.html"),
    `url=${secondPage.url}`,
  );
  check(
    "interaction.secondPageInlineScript",
    secondPage.script === true,
    "second verified HTML page ran its own inline script",
  );
  const secondClicked = await evaluateArtifact(
    desktopEntry,
    "document.getElementById('p2').click(); window.__page2Clicked === true",
    "page2.html",
  );
  check(
    "interaction.secondPageInlineHandler",
    secondClicked === true,
    "second page inline handler ran",
  );
  phase("interactions");
  await evaluateArtifact(desktopEntry, "history.back(); 'set'", "page2.html");
  await delay(400);

  const mobile = await host.open(
    requestFor(window, fixture, "community-proof", {
      jobId: "proof-job-mobile",
      viewport: "mobile",
      pixelWidth: 390,
      pixelHeight: 844,
      bounds: { x: 0, y: 64, width: 360, height: 700 },
    }),
  );
  const mobileEntry = host.byHandle.get(mobile.handle);
  const mobileWrapper = await wrapperFrameMetrics(mobileEntry);
  const mobileFrame = await waitForArtifactFrame(mobileEntry);
  const mobileMetrics = await evaluateArtifact(
    mobileEntry,
    "({ width: innerWidth, height: innerHeight, narrow: matchMedia('(max-width: 500px)').matches })",
  );
  const mobileView = mobileEntry.layout.child;
  const mobileExpectedCssHeight = mobileEntry.pixelHeight;
  const mobileMeasuredDelta = Math.abs(
    mobileMetrics.height - mobileExpectedCssHeight,
  );
  const mobileTolerance = Math.abs(mobileExpectedCssHeight - 844);
  results.geometry.mobile = {
    ...mobileMetrics,
    childFrameUrl: mobileFrame.url,
    wrapperFrame: mobileWrapper,
    wrapperBounds: {
      width: mobileEntry.view.getBounds().width,
      height: mobileEntry.view.getBounds().height,
    },
    fitted: { width: mobileView.width, height: mobileView.height },
    expectedCssHeight: mobileExpectedCssHeight,
    tolerance: mobileTolerance,
  };
  check(
    "geometry.mobileCssViewport",
    mobileMetrics.width === 390 &&
      mobileMetrics.height === 844 &&
      hasExpectedWrapperSize(mobileWrapper, 390, 844) &&
      mobileMeasuredDelta <= 1 &&
      mobileTolerance <= MAX_ROUNDING_TOLERANCE_CSS_PX,
    `innerWidth=${mobileMetrics.width} innerHeight=${mobileMetrics.height} expectedHeight=${mobileExpectedCssHeight}`,
    {
      toleranceCssPx: mobileTolerance,
      measuredDeltaCssPx: mobileMeasuredDelta,
    },
  );
  check(
    "geometry.mobileMediaQuery",
    mobileMetrics.narrow === true,
    "matchMedia('(max-width: 500px)')",
  );
  phase("geometry mobile");
  return { desktop, mobile };
}

async function retryDesktopPreview(host, window, fixture, handles) {
  await host.close({ window, handle: handles.desktop.handle });
  const state = await host.open(
    requestFor(window, fixture, "community-proof", {
      bounds: { x: 0, y: 64, width: 900, height: 636 },
    }),
  );
  handles.desktop = state;
  return host.byHandle.get(state.handle);
}

async function proveDenials(host, window, fixture, handles) {
  let entry = host.byHandle.get(handles.desktop.handle);
  let wc = entry.webContents;
  let before = (await waitForArtifactFrame(entry)).url;
  const externalUrl = "https://example.com/";
  const externalNavigation = observeFrameNavigation(entry, externalUrl);
  await evaluateArtifact(
    entry,
    `location.href = ${JSON.stringify(externalUrl)}; 'set'`,
  );
  await delay(400);
  externalNavigation.stop();
  const externalEvidence = navigationEvidence(
    entry,
    before,
    externalUrl,
    externalNavigation,
  );
  let externalRecovery = { attempted: false, reopenedReady: null };
  if (
    !externalEvidence.ok ||
    externalEvidence.originalFrames.length === 0 ||
    entry.failed === true
  ) {
    entry = await retryDesktopPreview(host, window, fixture, handles);
    wc = entry.webContents;
    before = (await waitForArtifactFrame(entry)).url;
    externalRecovery = {
      attempted: true,
      reopenedReady: entry.state === "ready",
    };
  }
  check(
    "denial.externalNavigation",
    externalEvidence.ok &&
      (!externalRecovery.attempted || externalRecovery.reopenedReady),
    JSON.stringify({ ...externalEvidence, recovery: externalRecovery }),
  );

  const popup = await evaluateArtifact(
    entry,
    "window.open('https://example.com/') === null",
  );
  check("denial.popup", popup === true, "window.open returned null");

  const media = await evaluateArtifact(
    entry,
    "navigator.mediaDevices?.getUserMedia ? navigator.mediaDevices.getUserMedia({audio:true}).then(() => 'granted').catch(() => 'denied') : 'denied'",
  );
  check("denial.permission", media === "denied", `gum=${media}`);

  const network = await evaluateArtifact(
    entry,
    "fetch('https://example.com/').then(() => 'reached').catch(() => 'blocked')",
  );
  check("denial.network", network === "blocked", `fetch=${network}`);
  phase("denials");

  const other = host.byHandle.get(handles.mobile.handle);
  const otherFrame = await waitForArtifactFrame(other);
  const otherUrl = otherFrame.url;
  const wrapperBoundary = await evaluateArtifact(
    entry,
    `(() => {
      try {
        window.top.document.documentElement.dataset.colonyPreviewTampered = "yes";
        return { accessible: true };
      } catch (error) {
        return { accessible: false, name: error?.name ?? "unknown" };
      }
    })()`,
  );
  const wrapperMarker = await evaluate(
    wc,
    "document.documentElement.dataset.colonyPreviewTampered ?? null",
  );
  const crossEntryNavigation = observeFrameNavigation(entry, otherUrl);
  await evaluateArtifact(
    entry,
    `location.href = ${JSON.stringify(otherUrl)}; 'set'`,
  );
  await delay(400);
  crossEntryNavigation.stop();
  const crossEntryEvidence = navigationEvidence(
    entry,
    before,
    otherUrl,
    crossEntryNavigation,
  );
  let crossEntryRecovery = { attempted: false, reopenedReady: null };
  if (
    !crossEntryEvidence.ok ||
    crossEntryEvidence.originalFrames.length === 0 ||
    entry.failed === true
  ) {
    entry = await retryDesktopPreview(host, window, fixture, handles);
    wc = entry.webContents;
    before = (await waitForArtifactFrame(entry)).url;
    crossEntryRecovery = {
      attempted: true,
      reopenedReady: entry.state === "ready",
    };
  }
  check(
    "isolation.crossEntryNavigation",
    crossEntryEvidence.ok &&
      (!crossEntryRecovery.attempted || crossEntryRecovery.reopenedReady) &&
      wrapperBoundary?.accessible === false &&
      wrapperMarker === null,
    JSON.stringify({
      ...crossEntryEvidence,
      recovery: crossEntryRecovery,
      wrapperBoundary,
      wrapperMarker,
    }),
  );
  const urls = [before, otherUrl].map((value) => new URL(value).hostname);
  check(
    "isolation.distinctPartitions",
    urls[0] !== urls[1],
    `tokens ${urls[0]} vs ${urls[1]}`,
  );
  phase("isolation");
}

async function proveLifecycle(window, fixture) {
  const host = createWebsitePreviewHost({
    WebContentsView,
    View,
    session,
    loadPreview: async () => fixture.site,
  });
  const state = await host.open(
    requestFor(window, fixture, "community-lifecycle", {
      bounds: { x: 0, y: 64, width: 400, height: 300 },
    }),
  );
  const wc = host.byHandle.get(state.handle).webContents;
  await host.close({ window, handle: state.handle });
  let usable = false;
  try {
    await wc.executeJavaScript("1");
    usable = true;
  } catch {
    usable = false;
  }
  check(
    "lifecycle.closed",
    host.activeCount === 0 && (wc.isDestroyed() === true || usable === false),
    `destroyed=${wc.isDestroyed()}`,
  );
  phase("teardown");
}

function pixelAt(bitmap, width, x, y) {
  const offset = (y * width + x) * 4;
  return {
    a: bitmap[offset + 3],
    aOrder: [bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]],
    bOrder: [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]],
  };
}

function closeEnough(actual, expected, tolerance = 60) {
  return Math.abs(actual - expected) <= tolerance;
}

async function proveClipPixels(window) {
  try {
    const content = window.getContentSize();
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: content[0] * 2, height: content[1] * 2 },
    });
    const source = sources.find((entry) => entry.name === window.getTitle());
    if (source === undefined) {
      results.clip = {
        status: "unavailable",
        detail: "window source not found",
      };
      return;
    }
    const image = source.thumbnail;
    const size = image.getSize();
    if (size.width < 2 || size.height < 2) {
      results.clip = { status: "unavailable", detail: "empty thumbnail" };
      return;
    }
    const bitmap = image.toBitmap();
    const scaleX = size.width / content[0];
    const scaleY = size.height / content[1];
    const sample = (x, y) =>
      pixelAt(
        bitmap,
        size.width,
        Math.round(x * scaleX),
        Math.round(y * scaleY),
      );
    // Keep the control sample outside the 900px preview and below the 64px
    // header so it is an unobscured, known-white app pixel.
    const background = sample(950, 300);
    const header = sample(500, 30);
    const page = sample(500, 300);
    const backgroundTarget = [255, 255, 255];
    const headerTarget = [255, 0, 170];
    const pageTarget = [18, 52, 86];
    const orderOf = (pixel, target) =>
      ["bOrder", "aOrder"].find((order) =>
        [0, 1, 2].every((index) =>
          closeEnough(pixel[order][index], target[index]),
        ),
      ) ?? null;
    // The capture is usable only when a window pixel with no native view on
    // it reads as the app background. Anything else means no usable frames.
    const captureOrder = orderOf(background, backgroundTarget);
    if (captureOrder === null) {
      results.clip = {
        status: "unavailable",
        detail: `background sample ${JSON.stringify(background)}; screen capture unavailable`,
      };
      return;
    }
    const headerMatches = orderOf(header, headerTarget) === captureOrder;
    const pageMatches = orderOf(page, pageTarget) === captureOrder;
    results.clip = {
      status: headerMatches && pageMatches ? "proven" : "failed",
      detail: { background, header, page, captureOrder },
    };
  } catch (error) {
    results.clip = {
      status: "unavailable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  await app.whenReady();
  const fixture = createFixture();
  phase("loader");
  const window = new BrowserWindow({
    width: 1000,
    height: 800,
    useContentSize: true,
    frame: false,
    show: true,
    title: "Colony website preview proof",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const header = encodeURIComponent(
    "<style>html,body{margin:0;background:#fff}#header{height:64px;background:#ff00aa}</style>" +
      "<div id=header></div>",
  );
  await window.loadURL(`data:text/html,${header}`);

  const host = createWebsitePreviewHost({
    WebContentsView,
    View,
    session,
    loadPreview: async ({ manifestRef }) => {
      if (manifestRef.sha256 !== fixture.manifestRef.sha256) {
        throw new Error("fixture ref mismatch");
      }
      return fixture.site;
    },
    // Clip is opt-in for this proof only; production stays on the safe
    // `hide` default until this pixel proof is green on a platform.
    clipStrategy: "clip",
  });

  const handles = await proveGeometry(host, window, fixture);
  await proveDenials(host, window, fixture, handles);
  await proveLifecycle(window, fixture);

  // Clip proof is opt-in: production defaults to the safe `hide` strategy
  // until this pixel proof passes on a platform. Move the pane under the
  // header with an explicit clip, then sample the composited window.
  host.updateBounds({
    window,
    handle: handles.desktop.handle,
    bounds: { x: 0, y: -100, width: 900, height: 636 },
    clip: { top: 64, left: 0, right: 10000, bottom: 10000 },
    zoom: 1,
  });
  await delay(300);
  await proveClipPixels(window);
  phase("capture");

  await host.closeAll();
  window.destroy();

  const failed = results.checks.filter((entry) => entry.ok !== true);
  const actualCheckNames = results.checks.map((entry) => entry.name);
  const checkNames = new Set(actualCheckNames);
  const missing = REQUIRED_CHECK_NAMES.filter((name) => !checkNames.has(name));
  const unexpected = [
    ...new Set(
      actualCheckNames.filter((name) => !REQUIRED_CHECK_NAMES.includes(name)),
    ),
  ];
  const duplicate = [
    ...new Set(
      actualCheckNames.filter(
        (name, index) => actualCheckNames.indexOf(name) !== index,
      ),
    ),
  ];
  const geometryReady = [
    [results.geometry.desktop, 1440, 900],
    [results.geometry.mobile, 390, 844],
  ].every(
    ([entry, expectedWidth, expectedHeight]) =>
      entry !== null &&
      typeof entry === "object" &&
      entry.width === expectedWidth &&
      entry.height === expectedHeight &&
      entry.expectedCssHeight === expectedHeight &&
      entry.tolerance === 0 &&
      typeof entry.childFrameUrl === "string" &&
      entry.childFrameUrl.startsWith("colony-preview:") &&
      hasExpectedWrapperSize(
        entry.wrapperFrame,
        expectedWidth,
        expectedHeight,
      ) &&
      entry.wrapperBounds !== null &&
      typeof entry.wrapperBounds === "object" &&
      Number.isFinite(entry.wrapperBounds.width) &&
      Number.isFinite(entry.wrapperBounds.height) &&
      entry.fitted !== null &&
      typeof entry.fitted === "object" &&
      Number.isFinite(entry.fitted.width) &&
      Number.isFinite(entry.fitted.height),
  );
  const clipReady =
    results.clip !== null &&
    typeof results.clip === "object" &&
    (results.clip.status === "proven" ||
      results.clip.status === "unavailable") &&
    results.clip.detail !== null;
  const gateFailures = [
    results.checks.length === 0 ? "no proof checks were recorded" : null,
    missing.length > 0 ? `missing checks: ${missing.join(", ")}` : null,
    unexpected.length > 0
      ? `unexpected checks: ${unexpected.join(", ")}`
      : null,
    duplicate.length > 0 ? `duplicate checks: ${duplicate.join(", ")}` : null,
    geometryReady ? null : "desktop/mobile geometry evidence is incomplete",
    clipReady ? null : "clip evidence is missing or invalid",
    failed.length > 0 ? `${failed.length} proof check(s) failed` : null,
  ].filter(Boolean);
  if (gateFailures.length > 0) {
    report.fail("checks", new Error(gateFailures.join("; ")));
    app.exit(1);
    return;
  }
  const payload = report.complete();
  console.log(JSON.stringify(payload, null, 2));
  app.exit(0);
}

void main().catch((error) => {
  console.error(
    "website preview proof failed to run:",
    error instanceof Error ? error.stack : error,
  );
  report.fail("main", error);
  app.exit(1);
});

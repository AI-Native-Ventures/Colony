/**
 * Real-Electron proof for the isolated website preview host.
 *
 * Run with the repository's Electron (never with Node):
 *
 *   pnpm --dir desktop exec electron src-electron/website-preview/proof.mjs
 *
 * This instantiates real `View`, `WebContentsView`, and `session` objects,
 * mounts a fixture artifact (manifest bytes and file bytes are generated
 * in-process; the network is never used), and measures actual rendered
 * behavior: CSS viewport and media queries, inline-script execution, and
 * denial of navigation, popups, permissions, and network. It also attempts a
 * composited pixel sample for container clipping via `desktopCapturer`;
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
import { PREVIEW_SCHEME_DESCRIPTOR } from "./scheme.mjs";

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function proveGeometry(host, window, fixture) {
  const desktop = await host.open(
    requestFor(window, fixture, "community-proof", {
      bounds: { x: 0, y: 64, width: 900, height: 636 },
    }),
  );
  phase("mount");
  const wc = host.byHandle.get(desktop.handle).webContents;
  const metrics = await evaluate(
    wc,
    "({ width: innerWidth, height: innerHeight, narrow: matchMedia('(max-width: 1439px)').matches, ready: window.__ready === true })",
  );
  const desktopView = host.byHandle.get(desktop.handle).view.getBounds();
  const desktopExpectedCssHeight =
    desktopView.height / (desktopView.width / 1440);
  const desktopMeasuredDelta = Math.abs(
    metrics.height - desktopExpectedCssHeight,
  );
  const desktopTolerance = Math.abs(desktopExpectedCssHeight - 900);
  results.geometry.desktop = {
    ...metrics,
    fitted: { width: desktopView.width, height: desktopView.height },
    expectedCssHeight: desktopExpectedCssHeight,
    tolerance: desktopTolerance,
  };
  check(
    "geometry.desktopCssViewport",
    metrics.width === 1440 &&
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
  await evaluate(wc, "document.getElementById('btn').click()");
  const clicked = await evaluate(wc, "window.__clicked === 1");
  check(
    "interaction.inlineHandler",
    clicked === true,
    "verified inline event handler ran",
  );

  // A verified second document must receive its own hash-authorized CSP; the
  // entrypoint's authorization must not be the only one that works.
  await evaluate(wc, "location.href = 'page2.html'; 'set'");
  await delay(500);
  const secondPage = await evaluate(
    wc,
    "({ url: location.href, script: window.__page2 === true })",
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
  const secondClicked = await evaluate(
    wc,
    "document.getElementById('p2').click(); window.__page2Clicked === true",
  );
  check(
    "interaction.secondPageInlineHandler",
    secondClicked === true,
    "second page inline handler ran",
  );
  phase("interactions");
  await evaluate(wc, "history.back(); 'set'");
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
  const mobileWc = host.byHandle.get(mobile.handle).webContents;
  const mobileMetrics = await evaluate(
    mobileWc,
    "({ width: innerWidth, height: innerHeight, narrow: matchMedia('(max-width: 500px)').matches })",
  );
  const mobileView = host.byHandle.get(mobile.handle).view.getBounds();
  const mobileExpectedCssHeight = mobileView.height / (mobileView.width / 390);
  const mobileMeasuredDelta = Math.abs(
    mobileMetrics.height - mobileExpectedCssHeight,
  );
  const mobileTolerance = Math.abs(mobileExpectedCssHeight - 844);
  results.geometry.mobile = {
    ...mobileMetrics,
    fitted: { width: mobileView.width, height: mobileView.height },
    expectedCssHeight: mobileExpectedCssHeight,
    tolerance: mobileTolerance,
  };
  check(
    "geometry.mobileCssViewport",
    mobileMetrics.width === 390 &&
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

async function proveDenials(host, _fixture, handles) {
  const entry = host.byHandle.get(handles.desktop.handle);
  const wc = entry.webContents;
  const before = wc.getURL();
  await evaluate(wc, "location.href = 'https://example.com/'; 'set'");
  await delay(400);
  check(
    "denial.externalNavigation",
    wc.getURL() === before,
    `url=${wc.getURL()}`,
  );

  const popup = await evaluate(
    wc,
    "window.open('https://example.com/') === null",
  );
  check("denial.popup", popup === true, "window.open returned null");

  const media = await evaluate(
    wc,
    "navigator.mediaDevices.getUserMedia({audio:true}).then(() => 'granted').catch(() => 'denied')",
  );
  check("denial.permission", media === "denied", `gum=${media}`);

  const network = await evaluate(
    wc,
    "fetch('https://example.com/').then(() => 'reached').catch(() => 'blocked')",
  );
  check("denial.network", network === "blocked", `fetch=${network}`);
  phase("denials");

  const other = host.byHandle.get(handles.mobile.handle);
  const otherUrl = other.webContents.getURL();
  await evaluate(wc, `location.href = ${JSON.stringify(otherUrl)}; 'set'`);
  await delay(400);
  check(
    "isolation.crossEntryNavigation",
    wc.getURL() === before,
    "entry A refused entry B's origin",
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
    const background = sample(950, 12);
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
    "<style>html,body{margin:0}#header{height:64px;background:#ff00aa}</style>" +
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
  await proveDenials(host, fixture, handles);
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
    [results.geometry.desktop, 1440],
    [results.geometry.mobile, 390],
  ].every(([entry, expectedWidth]) =>
    entry !== null &&
    typeof entry === "object" &&
    entry.width === expectedWidth &&
    Number.isFinite(entry.height) &&
    Number.isFinite(entry.expectedCssHeight) &&
    Number.isFinite(entry.tolerance) &&
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

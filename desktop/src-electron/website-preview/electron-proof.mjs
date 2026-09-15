// Real Electron host proof with fixture bytes; no relay, loader network or model.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { app, BrowserWindow, WebContentsView, View, session, protocol, desktopCapturer } from "electron";
import { createWebsitePreviewHost } from "./host.mjs";
import { PREVIEW_SCHEME_DESCRIPTOR } from "./scheme.mjs";
protocol.registerSchemesAsPrivileged([PREVIEW_SCHEME_DESCRIPTOR]);
const sha = "a".repeat(64);
const bodies = new Map([
  ["index.html", ["text/html", '<!doctype html><link rel="stylesheet" href="site.css"><h1>Saved website</h1><img src="logo.svg"><script src="site.js"></script>']],
  ["site.css", ["text/css", 'body{background:rgb(24, 32, 48);color:white}h1{color:rgb(120, 220, 180)}']],
  ["site.js", ["text/javascript", 'window.fixtureReady=true;']],
  ["logo.svg", ["image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="cyan"/></svg>']],
]);
const files = [...bodies].map(([path, [mime, body]]) => ({ path, mime, size: Buffer.byteLength(body) }));
const site = {
  entrypoint: "index.html", manifestSha256: sha, files,
  getFile(path) {
    const file = files.find((item) => item.path === path);
    return file ? { ...file, bytes: Buffer.from(bodies.get(path)[1]) } : null;
  },
};
let stage = "app readiness";
const watchdog = setTimeout(() => {
  console.error(`Native preview proof timed out at: ${stage}`);
  app.exit(1);
}, 60_000);
let host;
let window;
// Let Electron finish evaluating its ESM entrypoint before awaiting readiness.
async function run() {
try {
  await app.whenReady();
  stage = "create window";
  console.log(stage);
  window = new BrowserWindow({ width: 1000, height: 800, show: true, title: "Colony native preview proof" });
  await window.loadURL("data:text/html,<html><body style='margin:0;background:white'></body></html>");
  host = createWebsitePreviewHost({ WebContentsView, View, session, clipStrategy: "clip", loadPreview: async () => site });
  stage = "open preview";
  console.log(stage);
  const state = await host.open({
    window, communityId: "fixture", artifactId: "b".repeat(64), threadRoot: "c".repeat(64),
    revision: 1, manifest: { url: "https://example.com/manifest.json", sha256: sha },
    viewport: "desktop", bounds: { x: 0, y: 0, width: 960, height: 600 },
  });
  const entry = host.byHandle.get(state.handle);
  const frame = entry.webContents.mainFrame.frames.find((item) => item.url.includes(entry.token));
  assert.ok(frame, "artifact child frame must exist");
  stage = "inspect artifact frame";
  console.log(stage);
  const evidence = await frame.executeJavaScript(`({
    title: document.querySelector('h1').textContent,
    color: getComputedStyle(document.querySelector('h1')).color,
    image: document.querySelector('img').complete && document.querySelector('img').naturalWidth,
    script: window.fixtureReady === true,
    bridge: typeof window.colonyDesktop,
    node: typeof window.require,
    width: innerWidth
  })`);
  assert.equal(evidence.title, "Saved website");
  assert.equal(evidence.color, "rgb(120, 220, 180)");
  assert.equal(evidence.image, 64);
  assert.equal(evidence.script, true);
  assert.equal(evidence.bridge, "undefined");
  assert.equal(evidence.node, "undefined");
  assert.ok(Math.abs(evidence.width - 1440) < 2);
  await mkdir("test-results/native-website-preview", { recursive: true });
  await writeFile("test-results/native-website-preview/proof.json", JSON.stringify({ evidence, scope: "real Electron host, fixture loader, not packaged app" }, null, 2));
  stage = "capture preview";
  console.log(stage);
  await frame.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  // DOM readiness precedes the OS compositor. Poll the actual output, bounded
  // to five seconds, without changing the view hierarchy under test.
  let screenshot;
  let cyan = 0;
  let attempts = 0;
  const deadline = Date.now() + 5_000;
  do {
    attempts += 1;
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1280, height: 1024 } });
    assert.equal(sources.length, 1, "single isolated CI display must be available for composed capture");
    screenshot = sources[0].thumbnail;
    const pixels = screenshot.toBitmap();
    cyan = 0;
    for (let index = 0; index + 3 < pixels.length; index += 4) {
      if (pixels[index] > 220 && pixels[index + 1] > 220 && pixels[index + 2] < 30) cyan += 1;
    }
    if (cyan > 100) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  await writeFile("test-results/native-website-preview/preview.png", screenshot.toPNG());
  await writeFile("test-results/native-website-preview/capture.json", JSON.stringify({
    cyan, attempts, size: screenshot.getSize(), state, layout: entry.layout,
    bounds: entry.view.getBounds(), visible: entry.view.getVisible(),
    container: entry.container.getBounds(),
  }, null, 2));
  assert.ok(cyan > 100, "composited capture must contain the fixture image");
  await host.closeAll();
  window.destroy();
  clearTimeout(watchdog);
  app.exit(0);
} catch (error) {
  console.error(error);
  await host?.closeAll();
  window?.destroy();
  app.exit(1);
}

}
void run();

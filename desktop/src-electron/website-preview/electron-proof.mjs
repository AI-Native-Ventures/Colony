// Real Electron host proof with fixture bytes; no relay, loader network or model.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { app, BrowserWindow, WebContentsView, View, session, protocol } from "electron";
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
let host;
let window;
try {
  await app.whenReady();
  window = new BrowserWindow({ width: 1000, height: 800, show: false });
  host = createWebsitePreviewHost({ WebContentsView, View, session, clipStrategy: "clip", loadPreview: async () => site });
  const state = await host.open({
    window, communityId: "fixture", artifactId: "b".repeat(64), threadRoot: "c".repeat(64),
    revision: 1, manifest: { url: "https://example.com/manifest.json", sha256: sha },
    viewport: "desktop", bounds: { x: 0, y: 0, width: 960, height: 600 },
  });
  const entry = host.byHandle.get(state.handle);
  const frame = entry.webContents.mainFrame.frames.find((item) => item.url.includes(entry.token));
  assert.ok(frame, "artifact child frame must exist");
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
  const screenshot = await entry.webContents.capturePage();
  await writeFile("test-results/native-website-preview/preview.png", screenshot.toPNG());
  await host.closeAll();
  window.destroy();
  app.exit(0);
} catch (error) {
  console.error(error);
  await host?.closeAll();
  window?.destroy();
  app.exit(1);
}

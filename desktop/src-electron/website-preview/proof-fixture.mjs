import { createHash } from "node:crypto";
// Deterministic bytes used only by CI preview proofs.
export const sha = "a".repeat(64);
const bodies = new Map([
  ["index.html", ["text/html", '<!doctype html><link rel="stylesheet" href="site.css"><h1>Saved website</h1><img src="logo.svg"><script src="site.js"></script>']],
  ["site.css", ["text/css", 'body{background:rgb(24, 32, 48);color:white}h1{color:rgb(120, 220, 180)}']],
  ["site.js", ["text/javascript", 'window.fixtureReady=true;']],
  ["logo.svg", ["image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="cyan"/></svg>']],
]);
const files = [...bodies].map(([path, [mime, body]]) => ({ path, mime, size: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex") }));
export const site = {
  entrypoint: "index.html", manifestSha256: sha, files,
  getFile(path) {
    const file = files.find((item) => item.path === path);
    return file ? { ...file, bytes: Buffer.from(bodies.get(path)[1]) } : null;
  },
};

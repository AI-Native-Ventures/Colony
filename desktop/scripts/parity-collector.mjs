#!/usr/bin/env node
/**
 * Local parity trace collector (dev-only).
 *
 * The webview has no filesystem access, so the in-app parity driver POSTs
 * its trace and replay reports here; this script writes them under
 * `desktop/parity-traces/` for commit. It also serves traces back so a
 * replay can run against a previously committed trace.
 *
 *   node scripts/parity-collector.mjs [port]   (default 9199)
 *
 * Routes:
 *   POST /traces/<name>          body=JSONL -> parity-traces/<name>.jsonl
 *   GET  /traces/<name>          -> the JSONL file
 *   POST /traces/<name>.timing.json -> parity-traces/<name>.timing.json
 *   POST /reports/<name>         -> parity-traces/<name>.replay.json
 *   GET  /health
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.argv[2] ?? 9199);
const OUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "parity-traces",
);
fs.mkdirSync(OUT_DIR, { recursive: true });

function sanitize(name) {
  const base = path.basename(name);
  if (!/^[a-zA-Z0-9._-]+$/.test(base)) {
    throw new Error(`bad trace name: ${name}`);
  }
  return base;
}

// The webview origin is http://localhost:1420 in dev; without CORS the
// trace POSTs are preflighted and blocked. This is a loopback dev tool.
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const log = (status, extra = "") =>
    console.log(
      `${new Date().toISOString()} ${req.method} ${url.pathname} ${status}${extra ? ` ${extra}` : ""}`,
    );

  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      log(204);
      return;
    }
    if (req.method === "POST" && url.pathname === "/lifecycle") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        console.log(
          `${new Date().toISOString()} lifecycle ${body.slice(0, 400)}`,
        );
        res.writeHead(200, { ...CORS_HEADERS, "content-type": "text/plain" });
        res.end("ok");
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, {
        ...CORS_HEADERS,
        "content-type": "application/json",
      });
      res.end(JSON.stringify({ ok: true, outDir: OUT_DIR }));
      log(200);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/traces/")) {
      const name = sanitize(url.pathname.slice("/traces/".length));
      const file = path.join(OUT_DIR, name);
      if (!fs.existsSync(file)) {
        res.writeHead(404, { ...CORS_HEADERS, "content-type": "text/plain" });
        res.end("not found");
        log(404, name);
        return;
      }
      res.writeHead(200, {
        ...CORS_HEADERS,
        "content-type": "application/x-ndjson",
      });
      fs.createReadStream(file).pipe(res);
      log(200, name);
      return;
    }

    if (req.method === "POST") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const body = Buffer.concat(chunks).toString("utf8");
          let file;
          if (url.pathname.startsWith("/traces/")) {
            const name = sanitize(url.pathname.slice("/traces/".length));
            file = path.join(OUT_DIR, name);
            fs.writeFileSync(file, body);
          } else if (url.pathname.startsWith("/reports/")) {
            const name = sanitize(url.pathname.slice("/reports/".length));
            file = path.join(OUT_DIR, `${name}.replay.json`);
            fs.writeFileSync(file, body);
          } else {
            res.writeHead(404, {
              ...CORS_HEADERS,
              "content-type": "text/plain",
            });
            res.end("not found");
            log(404, url.pathname);
            return;
          }
          res.writeHead(200, {
            ...CORS_HEADERS,
            "content-type": "application/json",
          });
          res.end(JSON.stringify({ ok: true, file }));
          log(200, `${path.basename(file)} (${body.length} bytes)`);
        } catch (error) {
          res.writeHead(400, { ...CORS_HEADERS, "content-type": "text/plain" });
          res.end(String(error));
          log(400, String(error));
        }
      });
      return;
    }

    res.writeHead(405, { ...CORS_HEADERS, "content-type": "text/plain" });
    res.end("method not allowed");
    log(405);
  } catch (error) {
    res.writeHead(400, { ...CORS_HEADERS, "content-type": "text/plain" });
    res.end(String(error));
    log(400, String(error));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`parity collector listening on http://127.0.0.1:${PORT}`);
  console.log(`writing traces to ${OUT_DIR}`);
});

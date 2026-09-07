import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("..", import.meta.url));
const electron = createRequire(import.meta.url)("electron");
const profile = await mkdtemp(path.join(os.tmpdir(), "colony-eb-proof-"));
const evidenceDir = path.join(root, "evidence");
await mkdir(evidenceDir, { recursive: true });
const html = await readFile(new URL("./fixture.html", import.meta.url));
const server = createServer((_req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const fixtureUrl = `http://127.0.0.1:${server.address().port}`;

function phase(name) {
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [root, `--proof=${name}`], {
      cwd: root,
      env: {
        ...process.env,
        COLONY_BROWSER_STATE_DIR: profile,
        COLONY_PROOF_OUTPUT: path.join(evidenceDir, `${name}.json`),
        COLONY_PROOF_URL: fixtureUrl,
        COLONY_PROOF_EVIDENCE: evidenceDir,
        COLONY_NODE_BINARY: process.execPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${name} exceeded 60 seconds`));
    }, 60000);
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error(`Electron ${name} exited ${code}`));
    });
  });
}
try {
  await phase("first");
  await phase("restart");
  const first = JSON.parse(
    await readFile(path.join(evidenceDir, "first.json")),
  );
  const restart = JSON.parse(
    await readFile(path.join(evidenceDir, "restart.json")),
  );
  await writeFile(
    path.join(evidenceDir, "summary.json"),
    JSON.stringify(
      {
        fixtureUrl,
        profile,
        first,
        restart,
        limits: [
          "Local fixture only; no Instagram authentication",
          "No matched Tauri resource comparison",
          "Scripted MCP worker; no model inference or production ACP session",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: real Electron, stdio MCP control, isolation and restart persistence.",
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}

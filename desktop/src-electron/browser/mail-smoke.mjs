// Runner for the real-Electron mail_send proof. It launches the repo's own
// Electron on mail-smoke-main.mjs, which holds every assertion, and fails this
// process when that one fails.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const electronDir = path.join(here, "../../node_modules/electron");
const binary = path.join(
  electronDir,
  "dist",
  (await readFile(path.join(electronDir, "path.txt"), "utf8")).trim(),
);
const child = spawn(binary, [path.join(here, "mail-smoke-main.mjs")], {
  stdio: "inherit",
  cwd: path.join(here, "../.."),
});
const code = await new Promise((resolve) => child.on("exit", resolve));
if (code !== 0) {
  console.error(`Electron mail_send proof exited with ${code}`);
  process.exit(code ?? 1);
}

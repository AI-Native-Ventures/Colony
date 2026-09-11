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
// Two launches, because the agent-facing tool is gated on the main process
// environment. The first proves the worker path with the gate open; the second
// proves that without the gate a worker cannot reach the journey even by
// talking to the broker directly, while the owner-side send still works.
const launch = (mailSend) =>
  new Promise((resolve) => {
    const env = { ...process.env };
    if (mailSend) env.BUZZ_BROWSER_MAIL_SEND = mailSend;
    else delete env.BUZZ_BROWSER_MAIL_SEND;
    const child = spawn(binary, [path.join(here, "mail-smoke-main.mjs")], {
      stdio: "inherit",
      cwd: path.join(here, "../.."),
      env,
    });
    child.on("exit", resolve);
  });

for (const [label, value] of [
  ["gated worker", "enabled"],
  ["ungated worker and owner-side send", null],
]) {
  const code = await launch(value);
  if (code !== 0) {
    console.error(`Electron mail proof (${label}) exited with ${code}`);
    process.exit(code ?? 1);
  }
}

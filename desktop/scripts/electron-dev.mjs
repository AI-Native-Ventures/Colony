import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("..", import.meta.url));
const children = [];
function stop() {
  for (const child of children) child.kill("SIGTERM");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const vite = spawn(
  process.execPath,
  [
    path.join(root, "node_modules/vite/bin/vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    "1425",
    "--strictPort",
  ],
  { cwd: root, stdio: "inherit", env: { ...process.env, VITE_PORT: "1425" } },
);
children.push(vite);
vite.on("exit", stop);
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (vite.exitCode !== null) throw Error("Development server exited");
    try {
      ready = (await fetch("http://127.0.0.1:1425")).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw Error("Development server did not start");
  const electron = spawn(
    process.execPath,
    [
      path.join(root, "node_modules/electron/cli.js"),
      path.join(root, "src-electron/main.mjs"),
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        COLONY_ELECTRON_DEV_URL: "http://127.0.0.1:1425",
        COLONY_NATIVE_HOST:
          process.env.COLONY_NATIVE_HOST ||
          path.join(root, "src-tauri/target/debug/colony-native-host"),
      },
    },
  );
  children.push(electron);
  await new Promise((resolve) =>
    electron.once("exit", (code) => {
      process.exitCode = code ?? 1;
      resolve();
    }),
  );
} finally {
  stop();
}

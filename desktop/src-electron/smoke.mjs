import { waitForAnimations } from "../tests/helpers/animations.ts";
import { verifyReload } from "./reload-smoke.mjs";
import { verifyImport } from "./import-smoke.mjs";
// Real Electron + Rust smoke gate. No mock native bridge or personal browser data.
import { _electron as electron } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, rm, copyFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const desktop = fileURLToPath(new URL("..", import.meta.url));
const appVersion = JSON.parse(
  await readFile(path.join(desktop, "package.json"), "utf8"),
).version;
const data = await mkdtemp(path.join(os.tmpdir(), "colony-electron-smoke-"));
const frozenHost = path.join(data, "colony-native-host");
await copyFile(
  path.join(desktop, "src-tauri/target/debug/colony-native-host"),
  frozenHost,
);
const launch = () =>
  electron.launch({
    args: [path.join(desktop, "src-electron/main.mjs")],
    env: {
      ...process.env,
      COLONY_ELECTRON_DEV_URL:
        process.env.COLONY_SMOKE_BUILT === "1"
          ? undefined
          : "http://127.0.0.1:1425",
      COLONY_ELECTRON_USER_DATA: data,
      COLONY_NATIVE_HOST: frozenHost,
      BUZZ_PRIVATE_KEY: `${"0".repeat(63)}1`,
      BUZZ_SHARE_IDENTITY: "1",
      BUZZ_RELAY_URL: "ws://127.0.0.1:1",
    },
    timeout: 30000,
  });
let application;
try {
  application = await launch();
  const page = await application.firstWindow();
  await page.waitForFunction(() => !!window.colonyDesktop);
  assert.equal(
    await page.evaluate(() =>
      window.colonyDesktop.request("shell", { operation: "version" }),
    ),
    appVersion,
    "Settings must report Colony's version, not the Electron engine version",
  );
  const cspErrors = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      message.text().includes("Content Security Policy")
    )
      cspErrors.push(message.text());
  });
  await page.waitForFunction(
    () => !!document.querySelector("#root")?.children.length,
    {},
    { timeout: 30000 },
  );
  page.on("pageerror", (error) =>
    console.log("Renderer error:", error.message),
  );
  await page.waitForFunction(
    () => document.body.innerText.length > 0,
    {},
    { timeout: 25000 },
  );
  // Let the app finish its initial same-document route replacement.
  await page.waitForTimeout(1500);
  await page
    .getByText("Inbox", { exact: true })
    .filter({ visible: true })
    .first()
    .waitFor();
  assert.deepEqual(cspErrors, [], "the app bootstrap must satisfy its CSP");
  if (process.env.COLONY_SMOKE_BUILT === "1") {
    await page.reload();
    await page
      .getByText("Inbox", { exact: true })
      .filter({ visible: true })
      .first()
      .waitFor();
    assert.deepEqual(
      cspErrors,
      [],
      "SPA routes must reload under the production CSP",
    );
  }
  await verifyReload(page);
  const result = await page.evaluate(async () => {
    const api = window.colonyDesktop;
    const identity = await api.request("invoke", { command: "get_identity" });
    const seen = [];
    const off = api.subscribe((message) => {
      if (message.type === "event") seen.push(message);
    });
    const id = await api.request("listen", { event: "electron-smoke" });
    await api.request("emit", { event: "electron-smoke", payload: "fixture" });

    await api.request("unlisten", { subscription: id });
    off();
    let unknown = false;
    try {
      await api.request("invoke", { command: "missing_smoke_command" });
    } catch (error) {
      unknown = String(error).includes("not found");
    }
    return {
      identity: identity.storage,
      event: seen.some((event) => event.payload === "fixture"),
      unknown,
      text: document.body.innerText.slice(0, 300),
    };
  });
  assert.ok(
    result.text.includes("Inbox"),
    "the existing Colony app must render",
  );
  assert.equal(result.event, true);
  assert.equal(result.unknown, true);
  console.log("Real renderer/Rust:", JSON.stringify(result));
  await page
    .getByRole("dialog", { name: "Bring your signed-in accounts" })
    .waitFor();
  await waitForAnimations(page);
  await page.screenshot({ path: path.join(data, "actual-app.png") });
  await page
    .getByRole("button", { name: "Done / do this later", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.getByTestId("open-settings").click();
  await page.getByTestId("profile-popover-settings").click();
  await page.getByTestId("settings-nav-browser").click();
  await page.getByTestId("browser-import").waitFor();
  await page.getByRole("combobox", { name: "Browser profile" }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Import sign-ins", exact: true })
      .isDisabled(),
    true,
  );
  await waitForAnimations(page);
  await page.screenshot({ path: path.join(data, "browser-settings.png") });
  console.log("First-launch invitation and repeat Settings import UI: PASS");
  await page.evaluate(async () => {
    await window.colonyDesktop.request("business", { id: "smoke-business" });
    await window.colonyDesktop.request("browser:open", {
      id: "smoke-tab",
      business: "smoke-business",
      url: "https://example.com",
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const isolated = await application.evaluate(({ webContents }) => {
    const remote = webContents
      .getAllWebContents()
      .find((w) => w.getURL().startsWith("https://example.com"));
    return remote
      ? remote.executeJavaScript(
          "({node:typeof process,bridge:typeof window.colonyDesktop})",
        )
      : null;
  });
  assert.deepEqual(isolated, { node: "undefined", bridge: "undefined" });
  await page.evaluate(() =>
    window.colonyDesktop.request("business", { id: "other-business" }),
  );
  const denied = await page.evaluate(async () => {
    try {
      await window.colonyDesktop.request("browser:action", {
        id: "smoke-tab",
        action: "reload",
      });
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(denied, true);
  console.log("Remote view isolation and business revocation: PASS");
  await verifyImport(application, page);
  console.log("Evidence:", path.join(data, "actual-app.png"));
  await application.close();
  application = await launch();
  await application.firstWindow();
  const persisted = await application.evaluate(async ({ session }) => {
    const { createHash } = process.getBuiltinModule("crypto");
    const partition =
      "persist:colony-business-" +
      createHash("sha256").update("import-proof").digest("hex");
    const cookies = await session
      .fromPartition(partition)
      .cookies.get({ name: "colony_fixture" });
    return cookies.some(
      (cookie) => cookie.value === "test-only" && cookie.httpOnly,
    );
  });
  assert.equal(
    persisted,
    true,
    "imported persistent cookies must survive an app restart",
  );
  console.log(
    "Imported persistent session survives real Electron restart: PASS",
  );
} finally {
  await application?.close();
  if (!application) await rm(data, { recursive: true, force: true });
}

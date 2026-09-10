import { waitForAnimations } from "../tests/helpers/animations.ts";
import { verifyReload } from "./reload-smoke.mjs";
import { verifyImport } from "./import-smoke.mjs";
import { verifyTerminal } from "./terminal-smoke.mjs";
import { ELECTRON_BETA_RELAY } from "../scripts/electron-package-config.mjs";
// Real Electron + Rust smoke gate. No mock native bridge or personal browser data.
import { _electron as electron } from "@playwright/test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  copyFile,
  cp,
  readFile,
  realpath,
  mkdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const desktop = fileURLToPath(new URL("..", import.meta.url));
const appVersion = JSON.parse(
  await readFile(path.join(desktop, "package.json"), "utf8"),
).version;
const data = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "colony-electron-smoke-")),
);
const packagedApp = process.env.COLONY_SMOKE_APP;
const relocatedApp = path.join(data, "Relocated Colony.app");
const frozenHost = path.join(data, "colony-native-host");
if (packagedApp) {
  await cp(packagedApp, relocatedApp, {
    recursive: true,
    verbatimSymlinks: true,
  });
} else {
  await copyFile(
    path.join(desktop, "src-tauri/target/debug/colony-native-host"),
    frozenHost,
  );
}
const built = !!packagedApp || process.env.COLONY_SMOKE_BUILT === "1";
const launch = () =>
  electron.launch({
    ...(packagedApp
      ? {
          executablePath: path.join(
            relocatedApp,
            `Contents/MacOS/${process.env.COLONY_SMOKE_EXECUTABLE ?? "Colony Electron Beta"}`,
          ),
        }
      : {}),
    args: packagedApp ? [] : [path.join(desktop, "src-electron/main.mjs")],
    cwd: data,
    env: {
      ...process.env,
      COLONY_ELECTRON_DEV_URL: built ? undefined : "http://127.0.0.1:1425",
      COLONY_ELECTRON_USER_DATA: data,
      COLONY_NATIVE_HOST: packagedApp ? undefined : frozenHost,
      ...(packagedApp ? { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } : {}),
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
  if (built) {
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
  if (packagedApp) {
    // This reads the compiled default, unaffected by this test's local relay
    // override. Previously the entire smoke passed with an app that sent
    // real signup requests to the customer's own localhost:3000.
    const relayConfig = await page.evaluate(async () => ({
      relay: await window.colonyDesktop.request("invoke", {
        command: "get_build_default_relay_url",
      }),
      autoConnect: await window.colonyDesktop.request("invoke", {
        command: "auto_connect_default_relay_enabled",
      }),
    }));
    assert.equal(relayConfig.relay, ELECTRON_BETA_RELAY.websocket);
    assert.equal(relayConfig.autoConnect, false);
    console.log("Packaged signup targets the hosted account service: PASS");
    const packagedState = await application.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
    }));
    assert.equal(packagedState.packaged, true);
    assert.ok(packagedState.appPath.startsWith(relocatedApp));
    const runtimes = await page.evaluate(() =>
      window.colonyDesktop.request("invoke", {
        command: "discover_acp_providers",
      }),
    );
    const builtin = runtimes.find((runtime) => runtime.id === "buzz-agent");
    assert.ok(builtin, "bundled Colony Agent must be in the runtime catalog");
    assert.equal(builtin.availability, "available");
    assert.equal(
      builtin.binary_path,
      path.join(relocatedApp, "Contents/Resources/native/buzz-agent"),
    );
    console.log("Relocated app discovers its bundled Colony Agent: PASS");
  }
  const importInvitation = page.getByRole("dialog", {
    name: "Bring your signed-in accounts",
  });
  assert.equal(
    await importInvitation.count(),
    0,
    "optional browser import must not interrupt an unfinished business setup",
  );
  // This smoke intentionally uses an unreachable relay, so it cannot finish a
  // hosted business signup. Mark only its isolated synthetic business complete
  // to exercise the deferred import invitation. signup-smoke.mjs separately
  // proves the real renderer/native account and recovery path.
  await page.evaluate(async () => {
    const identity = await window.colonyDesktop.request("invoke", {
      command: "get_identity",
    });
    const businessId = localStorage.getItem("buzz-active-community-id");
    const businesses = JSON.parse(
      localStorage.getItem("buzz-communities") ?? "[]",
    );
    const business = businesses.find((entry) => entry.id === businessId);
    if (!business?.relayUrl || !identity.pubkey) {
      throw new Error("The synthetic business and native identity must exist");
    }
    localStorage.setItem(
      `buzz-community-onboarding-complete.v1:${encodeURIComponent(business.relayUrl)}:${identity.pubkey}`,
      "true",
    );
    window.dispatchEvent(new Event("colony:onboarding-complete"));
  });
  await importInvitation.waitFor();
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
  await verifyTerminal(application, page, {
    proofDir: process.env.COLONY_SMOKE_PROOF_DIR,
  });
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
} catch (error) {
  const page = application
    ? await application.firstWindow().catch(() => null)
    : null;
  const state = page
    ? await page
        .evaluate(() => ({
          pathname: location.pathname,
          rootMounted: !!document.querySelector("#root")?.children.length,
          status: document.querySelector("#status")?.textContent ?? null,
          migrationError: window.__COLONY_FRONTEND_MIGRATION_ERROR__ ?? null,
        }))
        .catch(() => ({ status: "The renderer was unavailable" }))
    : { status: "No app window was available" };
  console.error("Package startup state:", JSON.stringify(state));
  if (process.env.COLONY_SMOKE_PROOF_DIR) {
    await mkdir(process.env.COLONY_SMOKE_PROOF_DIR, { recursive: true });
    await writeFile(
      path.join(
        process.env.COLONY_SMOKE_PROOF_DIR,
        "package-startup-state.json",
      ),
      JSON.stringify(state, null, 2),
    );
  }
  throw error;
} finally {
  await application?.close();
  if (packagedApp) await rm(relocatedApp, { recursive: true, force: true });
  if (!application) await rm(data, { recursive: true, force: true });
}

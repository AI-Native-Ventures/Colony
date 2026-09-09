// Real packaged Account -> Recovery -> relaunch gate. Only the account HTTP response is a
// fixture: renderer password derivation, native backups and the UI stay real.
import { _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, rm, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { createHash, pbkdf2Sync } from "node:crypto";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { waitForAnimations } from "../tests/helpers/animations.ts";

const packagedApp = process.env.COLONY_SMOKE_APP;
assert.ok(
  packagedApp && path.isAbsolute(packagedApp) && packagedApp.endsWith(".app"),
  "COLONY_SMOKE_APP must name the absolute path to the packaged macOS app",
);
assert.equal(process.platform, "darwin");
const data = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "colony-signup-fixture-")),
);
const profile = createHash("sha256").update(data).digest("hex").slice(0, 16);
const nativeProfile = `xyz.block.buzz.app.dev-electron.${profile}`;
const proofDirectory = process.env.COLONY_SMOKE_PROOF_DIR;
const exec = promisify(execFile);
const pubkey =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const password = "fixture-only-long-passphrase-2026";
const email = "signup-fixture@example.invalid";
let signupBody;
let posts = 0;
const server = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  response.setHeader("Content-Type", "application/json");
  if (request.method === "OPTIONS") {
    response.end("{}");
    return;
  }
  if (request.url === "/api/accounts/signup" && request.method === "POST") {
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 16 * 1024) {
          response.writeHead(413).end("{}");
          return;
        }
      }
      signupBody = JSON.parse(body);
      posts++;
      response.writeHead(201).end(JSON.stringify({ pubkey }));
    } catch {
      response.writeHead(400).end("{}");
    }
    return;
  }
  response.writeHead(404).end("{}");
});
let application;
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const accountBase = `http://127.0.0.1:${port}`;
  const launch = () =>
    electron.launch({
      executablePath: path.join(
        packagedApp,
        `Contents/MacOS/${process.env.COLONY_SMOKE_EXECUTABLE ?? "Colony Electron Beta"}`,
      ),
      args: [],
      cwd: data,
      env: {
        ...process.env,
        COLONY_ELECTRON_USER_DATA: data,
        BUZZ_PRIVATE_KEY: `${"0".repeat(63)}1`,
        // Shared identities auto-create a Local Dev community and bypass the
        // public signup flow. The environment key remains a synthetic identity.
        BUZZ_SHARE_IDENTITY: "0",
        BUZZ_RELAY_URL: `ws://127.0.0.1:${port}`,
        BUZZ_RELAY_HTTP: accountBase,
      },
      timeout: 30_000,
    });
  application = await launch();
  const page = await application.firstWindow();
  // Defense in depth: even a regression in endpoint selection cannot turn this
  // gate into a real account creation request against a hosted service.
  let blockedAccountRequest = false;
  await page.route("**/api/accounts/**", async (route) => {
    if (route.request().url() !== `${accountBase}/api/accounts/signup`) {
      blockedAccountRequest = true;
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await page.waitForFunction(() => !!window.colonyDesktop);
  // The migration page has the same preload. Wait until app startup completes
  // before reloading, otherwise this fixture interrupts the state transfer.
  await page.waitForFunction(
    () => !!document.querySelector("#root")?.children.length,
    {},
    { timeout: 30_000 },
  );
  assert.equal(
    await page.evaluate(() =>
      window.colonyDesktop.request("invoke", {
        command: "get_relay_http_url",
      }),
    ),
    accountBase,
    "Signup must target only this gate's ephemeral HTTP fixture",
  );
  // Seed only the completed machine-identity step and fresh-founder marker.
  // No mock bridge, fake auth service, completed account or business is seeded.
  await page.evaluate((key) => {
    localStorage.setItem(`colony.identity.fresh:${key}`, "true");
    localStorage.setItem(`buzz-machine-onboarding-complete.v2:${key}`, "true");
  }, pubkey);
  await page.reload();
  await page.locator("#onb-account-email").waitFor({
    state: "visible",
    timeout: 20_000,
  });
  await page.locator("#onb-account-email").fill(email);
  await page.locator("#onb-account-name").fill("Signup Owner");
  await page.locator("#onb-account-password").fill(password);
  if (proofDirectory) {
    await mkdir(proofDirectory, { recursive: true });
    await waitForAnimations(page);
    await page.screenshot({
      path: path.join(proofDirectory, "packaged-account.png"),
    });
  }
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByTestId("onboarding-recovery").waitFor({
    state: "visible",
    timeout: 60_000,
  });
  assert.equal(blockedAccountRequest, false);
  assert.equal(posts, 1);
  assert.equal(signupBody.email, email);
  assert.equal(signupBody.pubkey, pubkey);
  assert.equal(signupBody.kdfVersion, 1);
  assert.equal(JSON.stringify(signupBody).includes(password), false);
  // Keep assertions boolean so even a failure cannot print the wire secrets.
  assert.ok(signupBody.passwordBlob?.startsWith("ncryptsec1"));
  assert.ok(signupBody.recoveryBlob?.startsWith("ncryptsec1"));
  const expected = pbkdf2Sync(
    password,
    createHash("sha256").update(`colony-auth-v1:${email}`).digest(),
    600_000,
    32,
    "sha256",
  ).toString("hex");
  assert.ok(
    signupBody.authKey === expected,
    "Renderer auth derivation matches",
  );
  const code = await page.getByTestId("onboarding-recovery-code").innerText();
  assert.ok(/^[A-Z0-9]{5}(?:-[A-Z0-9]{5}){3}$/.test(code));
  assert.ok(
    signupBody.recoveryCodeHash ===
      createHash("sha256").update(code).digest("hex"),
    "The recovery screen displays the code escrowed by signup",
  );
  const verified = await page.evaluate(
    async ({ passwordBlob, recoveryBlob, password, code }) => {
      const verify = (ncryptsec, password) =>
        window.colonyDesktop.request("invoke", {
          command: "verify_ncryptsec_backup",
          args: { ncryptsec, password },
        });
      const first = await verify(passwordBlob, password);
      const second = await verify(recoveryBlob, code);
      return {
        passwordMatches: first.matchesCurrentIdentity,
        recoveryMatches: second.matchesCurrentIdentity,
      };
    },
    { ...signupBody, password, code },
  );
  assert.deepEqual(verified, {
    passwordMatches: true,
    recoveryMatches: true,
  });
  // The same protected checkpoint must survive process exit without submitting
  // another signup or generating a replacement recovery code.
  await application.close();
  application = await launch();
  const resumedPage = await application.firstWindow();
  await resumedPage.route("**/api/accounts/**", (route) =>
    route.abort("blockedbyclient"),
  );
  await resumedPage
    .getByTestId("onboarding-recovery")
    .waitFor({ state: "visible", timeout: 30_000 });
  const resumedCode = await resumedPage
    .getByTestId("onboarding-recovery-code")
    .innerText();
  assert.ok(
    resumedCode === code,
    "Relaunch retains the registered recovery code",
  );
  assert.equal(posts, 1, "Relaunch must not submit another account");
  if (proofDirectory) {
    await waitForAnimations(resumedPage);
    await resumedPage.screenshot({
      path: path.join(proofDirectory, "packaged-recovery-relaunch.png"),
      mask: [resumedPage.getByTestId("onboarding-recovery-code")],
    });
  }
  console.log(
    "Packaged Account -> Recovery -> relaunch, real renderer KDF and native backups: PASS (local HTTP fixture only)",
  );
} catch (error) {
  const page = application
    ? await application.firstWindow().catch(() => null)
    : null;
  if (page) {
    const state = await page
      .evaluate(() => ({
        pathname: location.pathname,
        rootMounted: !!document.querySelector("#root")?.children.length,
        migrationError: window.__COLONY_FRONTEND_MIGRATION_ERROR__ ?? null,
      }))
      .catch(() => ({ status: "The renderer was unavailable" }));
    // No form content, storage values or recovery codes enter diagnostics.
    console.error("Signup fixture startup state:", JSON.stringify(state));
  }
  throw error;
} finally {
  try {
    await application?.close();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await Promise.all([
      rm(data, { recursive: true, force: true }),
      rm(
        path.join(os.homedir(), "Library/Application Support", nativeProfile),
        { recursive: true, force: true },
      ),
      // Remove only the unique test profile's keyring blob, never a user's
      // installed Colony service. The native checkpoint deliberately survives
      // deleting browser files, so filesystem cleanup alone is insufficient.
      exec("security", [
        "delete-generic-password",
        "-s",
        nativeProfile,
        "-a",
        "secrets",
      ]).catch((error) => {
        if (error.code !== 44)
          throw new Error(
            "Could not clean up the signup fixture keyring entry",
          );
      }),
    ]);
  }
}

// Joined native account/provisioning gate. All services and identities belong to
// this process's unique local fixture; no hosted accounts or paid models are used.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { _electron as electron, expect } from "@playwright/test";
import { waitForAnimations } from "../tests/helpers/animations.ts";
import { completeFixtureOnboarding } from "./onboarding-fixture/account.mjs";
import { createPassiveAccountDiagnostics } from "./onboarding-fixture/account-diagnostics.mjs";
import { createOnboardingFixtureProvider } from "./onboarding-fixture/provider.mjs";
import { createOnboardingFixtureProxy } from "./onboarding-fixture/proxy.mjs";
import { startOnboardingFixtureRelay } from "./onboarding-fixture/relay.mjs";
import { completeFixtureWork } from "./onboarding-fixture/work.mjs";

assert.ok(
  process.argv.includes("--account-only") !==
    process.argv.includes("--with-work"),
  "Choose exactly one joined gate: --account-only or --with-work",
);
assert.equal(process.platform, "darwin");
const bundle = process.env.COLONY_SMOKE_APP;
assert.ok(
  bundle &&
    path.isAbsolute(bundle) &&
    path.basename(bundle) === "Colony Onboarding Fixture.app",
  "COLONY_SMOKE_APP must identify the separately named fixture package",
);
const manifestPath = path.join(
  path.dirname(path.dirname(bundle)),
  "manifest.json",
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.equal(
  manifest.onboardingFixture,
  true,
  "Never run the joined fixture against a normal release",
);
assert.equal(manifest.app, bundle);
const repo = fileURLToPath(new URL("../..", import.meta.url));
const relayBinary =
  process.env.COLONY_SMOKE_RELAY_BINARY ||
  path.join(repo, "target/debug/buzz-relay");
const adminBinary =
  process.env.COLONY_SMOKE_ADMIN_BINARY ||
  path.join(repo, "target/debug/buzz-admin");
const serviceBinaries = await Promise.all(
  [relayBinary, adminBinary].map(async (binary) => {
    assert.ok(
      path.isAbsolute(binary),
      "Fixture service binaries must use absolute paths",
    );
    return {
      name: path.basename(binary),
      path: binary,
      sha256: createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
    };
  }),
);
const data = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "colony-onboarding-joined-")),
);
const profile = createHash("sha256").update(data).digest("hex").slice(0, 16);
const nativeProfile = `xyz.block.buzz.app.dev-electron.${profile}`;
const domain = `onboarding-${profile}.invalid`;
const proofDirectory =
  process.env.COLONY_SMOKE_PROOF_DIR ||
  (await mkdtemp(path.join(os.tmpdir(), "colony-onboarding-proof-")));
assert.ok(
  path.isAbsolute(proofDirectory) && !proofDirectory.startsWith(`${data}/`),
);
await mkdir(proofDirectory, { recursive: true });
const recoveryPath = path.join(data, "exports", "colony-recovery-code.txt");
await mkdir(path.dirname(recoveryPath));
const exec = promisify(execFile);
const owner =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
let provider;
let relay;
let proxy;
let application;
let page;
let repositoryModuleUrls = [];
let networkTrap;
let failure;
const cleanup = [];
const accountDiagnostics = createPassiveAccountDiagnostics();
// Playwright's Electron context-created callback can reject outside launch()
// when the app exits during startup. Keep its original failure, let the bounded
// launch deadline settle, and run the same owned-resource cleanup below.
const recordUnhandled = (error) => {
  failure ??= error;
};
process.on("unhandledRejection", recordUnhandled);
const blocked = [];
const proof = {
  gate: process.argv.includes("--with-work")
    ? "account-and-work"
    : "account-only",
  fixture: true,
  completed: false,
  packageManifest: manifestPath,
  packageBinaries: manifest.binaries.map(({ name, sha256 }) => ({
    name,
    sha256,
  })),
  canonicalDomain: domain,
  serviceBinaries,
  fixtureScripts: await Promise.all(
    [
      "onboarding-smoke.mjs",
      "onboarding-fixture/account.mjs",
      "onboarding-fixture/account-diagnostics.mjs",
      "onboarding-fixture/work.mjs",
      "onboarding-fixture/instruction.mjs",
      "onboarding-fixture/native-team.mjs",
      "onboarding-fixture/native-services.mjs",
      "onboarding-fixture/service-sources.json",
      "onboarding-fixture/diagnostics.mjs",
      "onboarding-fixture/tool-result.mjs",
      "onboarding-fixture/task-head.mjs",
      "onboarding-fixture/provider.mjs",
      "onboarding-fixture/relay.mjs",
      "onboarding-fixture/proxy.mjs",
      "onboarding-fixture/certificates.mjs",
    ].map(async (name) => ({
      name,
      sha256: createHash("sha256")
        .update(await readFile(new URL(name, import.meta.url)))
        .digest("hex"),
    })),
  ),
  appArchiveSha256: createHash("sha256")
    .update(await readFile(path.join(bundle, "Contents/Resources/app.asar")))
    .digest("hex"),
};

async function invoke(command, args = {}) {
  return page.evaluate(
    ({ command, args }) =>
      window.colonyDesktop.request("invoke", { command, args }),
    { command, args },
  );
}

async function launch() {
  application = await electron.launch({
    executablePath: path.join(
      bundle,
      "Contents/MacOS/Colony Onboarding Fixture",
    ),
    args: proxy.chromiumArgs,
    cwd: data,
    timeout: 30_000,
    // Whitelist only runtime plumbing. User provider keys, proxy variables and
    // development overrides must not become fixture authority.
    env: {
      PATH: process.env.PATH,
      // SecKeychain resolves the user's default keychain through HOME. Keep
      // that OS context; the app/profile hash still isolates the secret entry.
      HOME: os.homedir(),
      // The existing browser broker uses a Unix socket under TMPDIR. Nesting
      // the fixture profile here exceeds macOS's sockaddr_un path limit.
      TMPDIR: os.tmpdir(),
      COLONY_ELECTRON_USER_DATA: data,
      BUZZ_PRIVATE_KEY: `${"0".repeat(63)}1`,
      BUZZ_SHARE_IDENTITY: "0",
      BUZZ_RELAY_URL: `wss://${proxy.bootstrapHost}`,
      BUZZ_RELAY_HTTP: proxy.bootstrapHttpUrl,
      BUZZ_ONBOARDING_FIXTURE_TRANSPORT: proxy.transportConfig,
      BUZZ_ONBOARDING_FIXTURE_RECOVERY_PATH: recoveryPath,
    },
  });
  accountDiagnostics.observeApplication(application);
  // Installed before any signup interaction. DNS rules cannot deny literal-IP
  // destinations, so every current/future Chromium session also gets this guard.
  await application.evaluate(
    (
      { app, BrowserWindow, session, webContents },
      { origins, assetPrefix },
    ) => {
      // Only this launched fixture process is controlled. Keep the proof off
      // the shared desktop while allowing renderer work without background caps.
      const hideFixtureWindow = (window) => {
        window.webContents.setBackgroundThrottling(false);
        window.hide();
      };
      for (const window of BrowserWindow.getAllWindows())
        hideFixtureWindow(window);
      app.on("browser-window-created", (_event, window) =>
        hideFixtureWindow(window),
      );
      const allowed = new Set(origins);
      const sessions = new Set();
      globalThis.__COLONY_FIXTURE_BLOCKED__ = [];
      const guard = (current) => {
        if (sessions.has(current)) return;
        sessions.add(current);
        current.webRequest.onBeforeRequest(
          { urls: ["<all_urls>"] },
          (details, callback) => {
            let accept = false;
            try {
              const url = new URL(details.url);
              accept =
                !url.username &&
                !url.password &&
                (allowed.has(url.origin) ||
                  (url.protocol === "colony:" && url.hostname === "app") ||
                  (url.protocol === "file:" &&
                    url.href.startsWith(assetPrefix) &&
                    !url.search &&
                    !url.hash &&
                    !/%(?:2e|2f|5c)/i.test(url.href)) ||
                  ["data:", "blob:"].includes(url.protocol));
              if (!accept)
                globalThis.__COLONY_FIXTURE_BLOCKED__.push({
                  method: details.method,
                  origin: url.origin,
                  path: url.pathname,
                });
            } catch {
              /* Malformed requests also fail closed. */
            }
            callback({ cancel: !accept });
          },
        );
      };
      guard(session.defaultSession);
      for (const contents of webContents.getAllWebContents())
        guard(contents.session);
      app.on("session-created", guard);
    },
    {
      origins: [
        proxy.bootstrapHttpUrl,
        `https://${proxy.businessHost}`,
        `wss://${proxy.bootstrapHost}`,
        proxy.businessRelayUrl,
      ],
      assetPrefix: pathToFileURL(
        path.join(bundle, "Contents/Resources/app.asar/dist") + path.sep,
      ).href,
    },
  );
  page = await application.firstWindow();
  accountDiagnostics.observePage(page);
  repositoryModuleUrls = await application.evaluate(({ app }) => {
    const fs = process.getBuiltinModule("fs");
    return fs
      .readdirSync(`${app.getAppPath()}/dist/assets`)
      .filter((name) =>
        /^(?:workRepository|companyRepository)-[^/]+\.js$/.test(name),
      )
      .map((name) => `colony://app/assets/${name}`);
  });
  await page.waitForFunction(() => !!window.colonyDesktop);
  // The migration page also has the preload. Do not reload or seed app state
  // until the normal transfer has completed and React has mounted.
  await page.waitForFunction(
    () => !!document.querySelector("#root")?.children.length,
    {},
    { timeout: 30_000 },
  );
  if (failure) throw failure;
  return page;
}

async function closeApp() {
  if (!application) return;
  try {
    blocked.push(
      ...(await application.evaluate(
        () => globalThis.__COLONY_FIXTURE_BLOCKED__ || [],
      )),
    );
  } finally {
    await application.close();
    application = undefined;
  }
}

try {
  provider = await createOnboardingFixtureProvider();
  relay = await startOnboardingFixtureRelay({
    profile,
    domain,
    directory: data,
    relayBinary,
    adminBinary,
    providerHttpUrl: provider.httpUrl,
  });
  proof.backingServices = relay.backingServices;
  proxy = await createOnboardingFixtureProxy({
    domain,
    upstreamHttpUrl: relay.upstreamHttpUrl,
    directory: data,
  });
  await launch();
  // DNS restrictions cannot cover literal IPs. Verify the Electron guard
  // cancels one harmless local trap request before it reaches any listener.
  let trapRequests = 0;
  networkTrap = createServer((_request, response) => {
    trapRequests += 1;
    response.end("fixture trap");
  });
  await new Promise((resolve, reject) => {
    networkTrap.once("error", reject);
    networkTrap.listen(0, "127.0.0.1", resolve);
  });
  const denied = await application.evaluate(async ({ session }, url) => {
    let rejected = false;
    try {
      await session.defaultSession.fetch(url);
    } catch {
      rejected = true;
    }
    const target = new URL(url);
    return (
      rejected &&
      globalThis.__COLONY_FIXTURE_BLOCKED__.some(
        (entry) =>
          entry.origin === target.origin && entry.path === target.pathname,
      )
    );
  }, `http://127.0.0.1:${networkTrap.address().port}/fixture-egress-check`);
  assert.ok(
    denied && trapRequests === 0,
    "Literal-IP request must be denied before network I/O",
  );
  proof.literalIpGuard = "denied before listener";
  // Only machine onboarding is marked complete. The account, protected pending
  // recovery and business are all created through their actual UI/native paths.
  await page.evaluate((pubkey) => {
    localStorage.setItem(`colony.identity.fresh:${pubkey}`, "true");
    localStorage.setItem(
      `buzz-machine-onboarding-complete.v2:${pubkey}`,
      "true",
    );
  }, owner);
  await page.reload();
  const result = await completeFixtureOnboarding({
    page,
    relaunch: async () => {
      await closeApp();
      return launch();
    },
    proxy,
    recoveryPath,
    proofDirectory,
    onProgress(stage) {
      proof.stage = stage;
      console.log(`Joined fixture: ${stage}`);
    },
  });
  page = result.page;
  const where = `community_id=(SELECT id FROM communities WHERE host='${proxy.businessHost}')`;
  assert.equal(
    await relay.query("SELECT count(*) FROM email_accounts;"),
    "1",
    "One real account was registered",
  );
  assert.equal(
    await relay.query("SELECT count(*) FROM communities;"),
    "2",
    "Only bootstrap and the UI-created business exist",
  );
  const counts = async () => ({
    suggestion: await relay.query(
      `SELECT count(*) FROM events WHERE ${where} AND kind=9 AND tags @> '[["client","colony:first-job-suggestion:v1"]]'::jsonb;`,
    ),
    instruction: await relay.query(
      `SELECT count(*) FROM events WHERE ${where} AND kind=9 AND tags @> '[["client","colony:first-job-start:v1"]]'::jsonb;`,
    ),
    tasks: await relay.query(
      `SELECT count(*) FROM events WHERE ${where} AND kind=30181;`,
    ),
  });
  assert.deepEqual(await counts(), {
    suggestion: "1",
    instruction: "0",
    tasks: "0",
  });
  const credits = await invoke("get_colony_credits_account");
  assert.equal(credits.available_balance_nanousd, "0");
  const card = page
    .getByTestId("first-job-suggestion")
    .filter({ visible: true })
    .first();
  await card
    .getByRole("button", { name: "Approve team and start", exact: true })
    .click();
  await expect(card.getByTestId("first-job-status")).toHaveText(
    "Add credits before starting this job. Your brief stays here.",
    { timeout: 30_000 },
  );
  assert.deepEqual(await counts(), {
    suggestion: "1",
    instruction: "0",
    tasks: "0",
  });
  provider.assertHealthy();
  assert.equal(provider.requests.length, 0);
  await waitForAnimations(page);
  await page.screenshot({
    path: path.join(proofDirectory, "joined-zero-credit-block.png"),
  });
  const { page: _page, rootEvent: _event, ...identifiers } = result;
  Object.assign(proof, identifiers, {
    accountCompleted: true,
    zeroCreditStart: "blocked without Task, instruction or model call",
    hostedSignup: "not tested",
    workerCompletion: "not completed",
  });
  const workerCompletion = process.argv.includes("--with-work")
    ? await completeFixtureWork({
        page,
        account: result,
        proxy,
        relay,
        provider,
        directory: data,
        bundle,
        proofDirectory,
        repositoryModuleUrls,
        onEvidence: (evidence) => {
          proof.approvalEvidence = { ...proof.approvalEvidence, ...evidence };
        },
        onProgress: (stage) => {
          proof.stage = stage;
          console.log(`Joined fixture: ${stage}`);
        },
      })
    : "not tested";
  Object.assign(proof, identifiers, {
    completed: true,
    zeroCreditStart: "blocked without Task, instruction or model call",
    hostedSignup: "not tested",
    workerCompletion,
    chromiumTrust:
      "exact leaf SPKI exception; native transport separately validates CA and hostname",
  });
} catch (error) {
  failure ??= error;
  proof.failure =
    error instanceof Error ? error.message : "Joined fixture failed";
  if (Array.isArray(error?.startupDiagnostics))
    proof.relayStartupDiagnostics = error.startupDiagnostics;
  if (page && !page.isClosed()) {
    proof.failureState = await page
      .evaluate(async (owner) => {
        const state = {
          url: location.href,
          rootMounted: !!document.querySelector("#root")?.children.length,
          migrationError: window.__COLONY_FRONTEND_MIGRATION_ERROR__ ?? null,
          alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(
            (node) => node.textContent,
          ),
          browserCrypto: {
            secureContext: window.isSecureContext,
            subtleAvailable: !!globalThis.crypto?.subtle,
          },
        };
        const read = (command) =>
          window.colonyDesktop?.request("invoke", { command });
        const native = await Promise.race([
          Promise.allSettled([
            read("get_relay_ws_url"),
            read("get_identity"),
            read("load_pending_signup"),
          ]),
          new Promise((resolve) => setTimeout(() => resolve(null), 5_000)),
        ]);
        if (native) {
          state.nativeReadStatuses = native.map((result) => result.status);
          state.relayUrl =
            native[0].status === "fulfilled" ? native[0].value : "unavailable";
          state.ownerPubkey =
            native[1].status === "fulfilled"
              ? native[1].value?.pubkey
              : "unavailable";
          const pending = native[2];
          state.pendingSignup =
            pending.status === "fulfilled"
              ? pending.value
                ? {
                    present: true,
                    phase: ["prepared", "registered"].includes(
                      pending.value.phase,
                    )
                      ? pending.value.phase
                      : "unknown",
                    ownerMatchesExpected: pending.value.pubkey === owner,
                    hasRecoveryCode:
                      typeof pending.value.recoveryCode === "string" &&
                      pending.value.recoveryCode.length > 0,
                  }
                : { present: false }
              : { unavailable: true };
        } else {
          state.nativeReadStatuses = "diagnostic deadline reached";
        }
        return state;
      }, owner)
      .catch(() => ({ unavailable: true }));
    await waitForAnimations(page).catch(() => {});
    await page
      .screenshot({
        path: path.join(proofDirectory, "joined-failure.png"),
        mask: [
          page.getByTestId("onboarding-recovery-code"),
          page.locator("#onb-account-password"),
        ],
      })
      .catch(() => {});
  }
  if (relay) {
    proof.failureCounts = await Promise.all([
      relay.query("SELECT count(*) FROM email_accounts;"),
      relay.query("SELECT count(*) FROM communities;"),
      relay.query("SELECT count(*) FROM events WHERE kind=30181;"),
    ])
      .then(([accounts, communities, taskHeadEvents]) => ({
        accounts,
        communities,
        taskHeadEvents,
      }))
      .catch(() => ({ unavailable: true }));
    if (
      proxy &&
      /^[a-f0-9-]{36}$/.test(proof.channelId ?? "") &&
      /^[a-f0-9]{64}$/.test(proof.rootEventId ?? "")
    ) {
      proof.failureCounts.logicalTasks = await relay
        .query(
          `SELECT count(DISTINCT content::jsonb->>'id') FROM events WHERE community_id=(SELECT id FROM communities WHERE host='${proxy.businessHost}') AND kind=30181 AND content::jsonb->>'sourceChannelId'='${proof.channelId}' AND content::jsonb->>'threadRoot'='${proof.rootEventId}';`,
        )
        .catch(() => "unavailable");
    }
  }
} finally {
  if (failure) proof.accountDiagnostics = accountDiagnostics.snapshot();
  accountDiagnostics.close();
  proof.modelRequests = provider?.requests || [];
  proof.modelTools = provider?.tools || [];
  proof.modelToolResults = provider?.toolResults || [];
  for (const close of [
    closeApp,
    () => proxy?.close(),
    () => relay?.close(),
    () => provider?.close(),
    async () => {
      if (networkTrap) {
        networkTrap.closeAllConnections();
        await new Promise((resolve) => networkTrap.close(resolve));
      }
    },
  ]) {
    try {
      await close();
    } catch {
      cleanup.push("Owned fixture service cleanup failed");
    }
  }
  proof.requests = proxy?.requests || [];
  proof.blockedRendererRequests = blocked;
  try {
    await exec("security", [
      "delete-generic-password",
      "-s",
      nativeProfile,
      "-a",
      "secrets",
    ]);
  } catch (error) {
    if (error.code !== 44)
      cleanup.push("Could not remove unique fixture keychain entry");
  }
  for (const directory of [
    data,
    path.join(os.homedir(), "Library/Application Support", nativeProfile),
  ]) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      cleanup.push("Could not remove unique fixture profile");
    }
  }
  proof.cleanup = cleanup.length ? cleanup : "complete";
  await writeFile(
    path.join(proofDirectory, "account-proof.json"),
    JSON.stringify(proof, null, 2),
  );
  process.removeListener("unhandledRejection", recordUnhandled);
}
if (failure || cleanup.length) {
  throw new AggregateError(
    [
      ...(failure ? [failure] : []),
      ...cleanup.map((message) => new Error(message)),
    ],
    "Joined account fixture did not pass; see its proof and cleanup record",
  );
}
console.log(`Joined native ${proof.gate}: PASS. Proof: ${proofDirectory}`);

// Hosted macOS proof only: persistent legacy-layout WebKit -> native -> Chromium.
// Requires the separately compiled onboarding fixture; never a production override.
import { _electron as electron } from "@playwright/test";
import { createFixtureCertificates } from "./onboarding-fixture/certificates.mjs";
import {
  openLegacyStorage,
  readLegacyStorage,
} from "./onboarding-fixture/legacy-storage.mjs";
import { persistLegacyFixture } from "./onboarding-fixture/legacy-persistence.mjs";
import { createLegacyDiagnostics } from "./onboarding-fixture/legacy-diagnostics.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
const manifest = JSON.parse(
  await readFile(process.env.COLONY_MIGRATION_MANIFEST, "utf8"),
);
assert.equal(
  process.env.GITHUB_ACTIONS,
  "true",
  "Run this proof on an isolated hosted runner",
);
assert.equal(process.platform, "darwin");
assert.equal(manifest.onboardingFixture, true);
assert.notEqual(manifest.channel, "stable");
const data = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "colony-migration-proof-")),
);
const profileId = createHash("sha256").update(data).digest("hex").slice(0, 16);
const namespace = `xyz.block.buzz.app.dev-electron.${profileId}`;
const exec = promisify(execFile);
// The fixture binary requires its process-private transport even when this
// proof only reads storage. Keep every allowed host on an unused loopback port;
// no real DNS, certificate trust or account service is used.
const fixtureHosts = ["alpha.example.invalid", "bravo.example.invalid"];
const certificates = await createFixtureCertificates(data, fixtureHosts);
const transport = JSON.stringify({
  version: 1,
  ca_der_base64: certificates.caDerBase64,
  routes: fixtureHosts.map((host) => ({ host, address: "127.0.0.1:1" })),
});
certificates.key.fill(0);
const fixtureEnv = {
  ...process.env,
  COLONY_ELECTRON_USER_DATA: data,
  COLONY_ELECTRON_PACKAGED: "1",
  COLONY_ELECTRON_PROFILE_ID: profileId,
  COLONY_ELECTRON_INSTANCE_ID: namespace,
  BUZZ_ONBOARDING_FIXTURE_TRANSPORT: transport,
  BUZZ_PRIVATE_KEY: `${"0".repeat(63)}1`,
  BUZZ_SHARE_IDENTITY: "0",
  BUZZ_RELAY_URL: "wss://alpha.example.invalid",
  BUZZ_RELAY_HTTP: "https://alpha.example.invalid",
};
const diagnostics = createLegacyDiagnostics({ manifest, env: fixtureEnv });
diagnostics.snapshot("before-seed");
const legacy = (mode) =>
  readLegacyStorage({
    manifest,
    directory: data,
    env: fixtureEnv,
    mode,
    diagnostics,
  });
const sourceHash = (entries) =>
  createHash("sha256")
    .update(JSON.stringify([...entries].sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex");
let phase = "legacy-seed";
let app;
const launch = () =>
  electron.launch({
    executablePath: path.join(
      manifest.app,
      "Contents/MacOS/Colony Onboarding Fixture",
    ),
    cwd: data,
    args: [],
    env: {
      ...fixtureEnv,
      // Deliberately no seeding: this process must find the previous WebKit store.
      COLONY_MIGRATION_PROOF: "import",
    },
    timeout: 30_000,
  });
async function readState(page, expectedTheme) {
  await page.waitForURL(
    (url) =>
      url.protocol === "colony:" &&
      url.hostname === "app" &&
      url.pathname !== "/electron-migration.html",
  );
  await page.waitForFunction(
    () =>
      localStorage.getItem("colony.electron.webview-migration.v1") ===
      "complete",
  );
  // Import completion precedes React startup. Wait for the retired theme to
  // resolve to Default and for the scoped controller to apply its preference.
  await page.waitForFunction(
    (theme) =>
      localStorage.getItem("buzz-theme") === theme &&
      document.documentElement.dataset.buzzTheme === theme &&
      localStorage.getItem("buzz-accent-color") !== null,
    expectedTheme,
  );
  return page.evaluate(() => ({
    communities: JSON.parse(localStorage.getItem("buzz-communities") ?? "[]"),
    active: localStorage.getItem("buzz-active-community-id"),
    ownerComplete: localStorage.getItem(
      "buzz-machine-onboarding-complete.v2:79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    ),
    draft: localStorage.getItem("buzz-drafts.v1:migration-proof"),
    theme: localStorage.getItem("buzz-theme"),
  }));
}
try {
  phase = "legacy-persistence";
  const source = await persistLegacyFixture({
    writer: await openLegacyStorage({
      manifest,
      directory: data,
      env: fixtureEnv,
      mode: "legacy-seed",
      diagnostics,
    }),
    read: () => legacy("legacy-read"),
  });
  assert.equal(source.length, 6);
  const expectedHash = sourceHash(source);
  phase = "electron-import";
  app = await launch();
  let page = await app.firstWindow();
  const migrated = await readState(page, "buzz-dark");
  const importSeed = await page.evaluate(() =>
    window.colonyDesktop.request("invoke", {
      command: "electron_frontend_migration_fixture",
      args: {},
    }),
  );
  assert.equal(
    importSeed,
    null,
    "The Electron import phase must not reseed WebKit",
  );
  assert.deepEqual(
    migrated.communities.map((business) => business.id),
    ["proof-alpha", "proof-bravo"],
  );
  assert.equal(migrated.active, "proof-bravo");
  assert.equal(migrated.ownerComplete, "true");
  assert.ok(migrated.draft.includes("Unsent migration proof"));
  assert.equal(migrated.theme, "buzz-dark");
  // Edit after the scoped startup preference has settled, so this proves
  // later Electron edits survive relaunch without importing the legacy store again.
  // This offline storage fixture has no connected workspace UI. Update the
  // authoritative scoped record as well as its global cache, just as a saved
  // Appearance edit does; changing only the cache is intentionally overwritten.
  await page.evaluate(() => {
    const owner =
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const communities = JSON.parse(localStorage.getItem("buzz-communities"));
    const active = communities.find(
      (community) =>
        community.id === localStorage.getItem("buzz-active-community-id"),
    );
    const scope = `${owner}:${encodeURIComponent(active.relayUrl.replace(/\/$/, ""))}`;
    const key = `buzz-community-theme.v2:${scope}`;
    const preference = JSON.parse(localStorage.getItem(key)) ?? {
      version: 1,
      accent: localStorage.getItem("buzz-accent-color"),
      gradientPattern:
        localStorage.getItem("buzz-workspace-gradient") ?? "soft-mesh",
    };
    const edited = JSON.stringify({
      ...preference,
      theme: "buzz",
      followSystem: false,
    });
    localStorage.setItem(key, edited);
    localStorage.setItem(`buzz-community-theme-outbox.v1:${scope}`, edited);
    localStorage.setItem("buzz-theme", "buzz");
    localStorage.setItem("buzz-follow-system", "false");
    localStorage.setItem(
      "buzz-drafts.v1:migration-proof",
      "newer Electron draft",
    );
  });
  // Electron's DOMStorage flush API is synchronous (Electron 44 types expose
  // `flushStorageData(): void`). Exercise the same persistence boundary as
  // production before closing the fixture; do not rely on app.close() timing.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Migration fixture window disappeared");
    window.webContents.session.flushStorageData();
  });
  await app.close();
  app = null;
  phase = "electron-relaunch";
  app = await launch();
  page = await app.firstWindow();
  const resumed = await readState(page, "buzz");
  assert.equal(resumed.draft, "newer Electron draft");
  assert.equal(resumed.theme, "buzz");
  assert.deepEqual(resumed.communities, migrated.communities);
  await app.close();
  app = null;
  phase = "legacy-source-unchanged";
  const finalSource = await legacy("legacy-read");
  assert.equal(sourceHash(finalSource), expectedHash);
  const proof = {
    legacySourceHash: expectedHash,
    finalSourceHash: sourceHash(finalSource),
    sourceEntryCount: source.length,
    importedBusinesses: 2,
    electronReseeding: false,
    electronEditsPreserved: true,
  };
  if (process.env.COLONY_MIGRATION_PROOF_DIR) {
    await mkdir(process.env.COLONY_MIGRATION_PROOF_DIR, { recursive: true });
    await writeFile(
      path.join(process.env.COLONY_MIGRATION_PROOF_DIR, "migration-proof.json"),
      JSON.stringify(proof, null, 2),
    );
  }
  console.log(
    "PASS: separate legacy-layout WebKit process persisted two businesses, owner marker, draft and theme; Electron imported without reseeding and preserved later edits. Independent legacy reread has the original key/value hash. Signed released-app upgrade remains a separate gate.",
  );
} catch (error) {
  const page = app ? await app.firstWindow().catch(() => null) : null;
  const state = page
    ? await page
        .evaluate(() => ({
          pathname: location.pathname,
          rootMounted: !!document.querySelector("#root")?.children.length,
          status: document.querySelector("#status")?.textContent ?? null,
          migrationError: window.__COLONY_FRONTEND_MIGRATION_ERROR__ ?? null,
          theme: localStorage.getItem("buzz-theme"),
          renderedTheme: document.documentElement.dataset.buzzTheme,
          followSystem: localStorage.getItem("buzz-follow-system"),
        }))
        .catch(() => ({ status: "The renderer was unavailable" }))
    : {
        status:
          phase === "legacy-persistence"
            ? "Electron has not launched; legacy WebKit persistence failed"
            : "No app window was available",
      };
  console.error(
    "Migration fixture startup state:",
    JSON.stringify({ phase, ...state }),
  );
  if (process.env.COLONY_MIGRATION_PROOF_DIR) {
    await mkdir(process.env.COLONY_MIGRATION_PROOF_DIR, { recursive: true });
    await writeFile(
      path.join(process.env.COLONY_MIGRATION_PROOF_DIR, "startup-state.json"),
      JSON.stringify({ phase, ...state }, null, 2),
    );
  }
  throw error;
} finally {
  try {
    await app?.close();
  } finally {
    diagnostics.snapshot("before-cleanup");
    await diagnostics.save(process.env.COLONY_MIGRATION_PROOF_DIR).catch(() => {
      console.error(
        "Legacy fixture diagnostics could not be saved; cleanup will continue.",
      );
    });
    await Promise.all([
      rm(data, { recursive: true, force: true }),
      rm(path.join(os.homedir(), "Library/Application Support", namespace), {
        recursive: true,
        force: true,
      }),
      exec("security", [
        "delete-generic-password",
        "-s",
        namespace,
        "-a",
        "secrets",
      ]).catch((error) => {
        if (error.code !== 44)
          throw new Error("Could not remove the migration proof keyring entry");
      }),
    ]);
  }
}

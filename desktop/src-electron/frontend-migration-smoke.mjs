// Hosted macOS proof only: nonempty incognito WebKit -> native -> Chromium.
// Requires the separately compiled onboarding fixture; never a production override.
import { _electron as electron } from "@playwright/test";
import { createFixtureCertificates } from "./onboarding-fixture/certificates.mjs";
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
const namespace = `xyz.block.buzz.app.dev-electron.${createHash("sha256").update(data).digest("hex").slice(0, 16)}`;
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
      ...process.env,
      COLONY_ELECTRON_USER_DATA: data,
      COLONY_MIGRATION_PROOF: "1",
      BUZZ_ONBOARDING_FIXTURE_TRANSPORT: transport,
      BUZZ_PRIVATE_KEY: `${"0".repeat(63)}1`,
      BUZZ_SHARE_IDENTITY: "0",
      BUZZ_RELAY_URL: "wss://alpha.example.invalid",
      BUZZ_RELAY_HTTP: "https://alpha.example.invalid",
    },
    timeout: 30_000,
  });
async function readState(page) {
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
  app = await launch();
  let page = await app.firstWindow();
  const migrated = await readState(page);
  assert.deepEqual(
    migrated.communities.map((business) => business.id),
    ["proof-alpha", "proof-bravo"],
  );
  assert.equal(migrated.active, "proof-bravo");
  assert.equal(migrated.ownerComplete, "true");
  assert.ok(migrated.draft.includes("Unsent migration proof"));
  assert.equal(migrated.theme, "github-dark");
  await page.evaluate(() => {
    localStorage.setItem("buzz-theme", "github-light");
    localStorage.setItem(
      "buzz-drafts.v1:migration-proof",
      "newer Electron draft",
    );
  });
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  const resumed = await readState(page);
  assert.equal(resumed.draft, "newer Electron draft");
  assert.equal(resumed.theme, "github-light");
  assert.deepEqual(resumed.communities, migrated.communities);
  console.log(
    "PASS: real private WebKit export, two businesses, owner marker, draft and theme imported before React; relaunch preserves Electron edits. Source immutability is covered by pure migration tests; signed default-store upgrade remains a separate gate.",
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
        }))
        .catch(() => ({ status: "The renderer was unavailable" }))
    : { status: "No app window was available" };
  console.error("Migration fixture startup state:", JSON.stringify(state));
  if (process.env.COLONY_MIGRATION_PROOF_DIR) {
    await mkdir(process.env.COLONY_MIGRATION_PROOF_DIR, { recursive: true });
    await writeFile(
      path.join(process.env.COLONY_MIGRATION_PROOF_DIR, "startup-state.json"),
      JSON.stringify(state, null, 2),
    );
  }
  throw error;
} finally {
  try {
    await app?.close();
  } finally {
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

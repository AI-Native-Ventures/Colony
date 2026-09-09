// Actual renderer account, recovery export and business provisioning. No response
// substitution or completed account/community state is installed by this driver.
import assert from "node:assert/strict";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { verifyEvent } from "nostr-tools/pure";
import { waitForAnimations } from "../../tests/helpers/animations.ts";

const OWNER =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const EMAIL = "onboarding-fixture@example.invalid";
const PASSWORD = "fixture-only-long-passphrase-2026";
const BUSINESS =
  "We build websites and manage social media for small service businesses.";

async function invoke(page, command, args) {
  return page.evaluate(
    ({ command, args }) =>
      window.colonyDesktop.request("invoke", { command, args }),
    { command, args },
  );
}

async function screenshot(page, directory, filename, mask = []) {
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await waitForAnimations(page);
  await page.screenshot({ path: path.join(directory, filename), mask });
}

function accountPosts(proxy) {
  return proxy.requests.filter(
    (request) =>
      request.method === "POST" && request.path === "/api/accounts/signup",
  );
}

/** Caller owns guarded app launch/relaunch and final cleanup of its unique profile. */
export async function completeFixtureOnboarding({
  page,
  relaunch,
  proxy,
  recoveryPath,
  proofDirectory,
  onProgress = () => {},
}) {
  assert.ok(path.isAbsolute(recoveryPath));
  await page.waitForFunction(() => !!window.colonyDesktop);
  assert.equal((await invoke(page, "get_identity")).pubkey, OWNER);
  assert.equal(
    await invoke(page, "get_relay_http_url"),
    proxy.bootstrapHttpUrl,
  );
  await page
    .locator("#onb-account-email")
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.locator("#onb-account-email").fill(EMAIL);
  await page.locator("#onb-account-name").fill("Horizon Owner");
  await page.locator("#onb-account-password").fill(PASSWORD);
  onProgress("account-ready");
  await screenshot(page, proofDirectory, "joined-account.png");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page
    .getByTestId("onboarding-recovery-code")
    // Signup performs two real logN18 encryptions in sequence. Each native
    // operation keeps its production timeout; debug builds take ~35s each.
    .waitFor({ state: "visible", timeout: 150_000 });
  const code = await page.getByTestId("onboarding-recovery-code").innerText();
  assert.ok(
    /^[A-Z0-9]{5}(?:-[A-Z0-9]{5}){3}$/.test(code),
    "Native recovery code has the expected format",
  );
  const checkpointMatches = await page.evaluate(
    async ({ code, owner, email }) => {
      const pending = await window.colonyDesktop.request("invoke", {
        command: "load_pending_signup",
      });
      return (
        pending?.phase === "registered" &&
        pending.pubkey === owner &&
        pending.email === email &&
        pending.recoveryCode === code
      );
    },
    { code, owner: OWNER, email: EMAIL },
  );
  assert.ok(
    checkpointMatches,
    "Real registered native checkpoint matches the displayed code",
  );
  assert.deepEqual(
    accountPosts(proxy).map(({ host, status }) => ({ host, status })),
    [{ host: proxy.bootstrapHost, status: 201 }],
  );
  onProgress("account-registered");

  page = await relaunch();
  await page
    .getByTestId("onboarding-recovery-code")
    .waitFor({ state: "visible", timeout: 30_000 });
  assert.ok(
    (await page.getByTestId("onboarding-recovery-code").innerText()) === code,
    "Relaunch retains the same registered recovery code",
  );
  assert.equal(
    accountPosts(proxy).length,
    1,
    "Relaunch does not resubmit signup",
  );
  onProgress("recovery-restored");
  await screenshot(page, proofDirectory, "joined-recovery-relaunch.png", [
    page.getByTestId("onboarding-recovery-code"),
  ]);
  await page
    .getByRole("button", { name: "Save and continue", exact: true })
    .click();
  await page
    .locator("#onb-company-name")
    .waitFor({ state: "visible", timeout: 30_000 });
  assert.ok(
    (await readFile(recoveryPath, "utf8")).includes(`\n${code}\n`),
    "Native export really wrote the same recovery code",
  );
  assert.equal(
    (await stat(recoveryPath)).mode & 0o777,
    0o600,
    "Export remains private",
  );
  assert.ok(
    (await invoke(page, "load_pending_signup")) === null,
    "Actual acknowledgement cleared the registered checkpoint",
  );
  onProgress("recovery-exported");
  await page.locator("#onb-company-name").fill("Horizon Labs");
  await page.locator("#onb-company-description").fill(BUSINESS);
  await screenshot(page, proofDirectory, "joined-business.png");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByTestId("onboarding-power").waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: "Open my Colony", exact: true })
    .click({ trial: true });
  await screenshot(page, proofDirectory, "joined-power.png");
  await page
    .getByRole("button", { name: "Open my Colony", exact: true })
    .click();
  await page
    .getByTestId("first-job-suggestion")
    .first()
    .waitFor({ state: "visible", timeout: 90_000 });
  onProgress("business-provisioned");
  // Fresh packaged profiles offer optional browser import after completion.
  // Exercise its real defer action; never inspect or import personal cookies.
  const importPrompt = page.getByRole("dialog", {
    name: "Bring your signed-in accounts",
  });
  await importPrompt.waitFor({ state: "visible", timeout: 15_000 });
  await importPrompt
    .getByRole("button", { name: "Done / do this later", exact: true })
    .click();
  await importPrompt.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => {
      const route = new URL(location.hash.slice(1), "https://fixture.invalid");
      return (
        /^\/channels\/[^/]+$/.test(route.pathname) &&
        /^[a-f0-9]{64}$/.test(route.searchParams.get("thread") ?? "")
      );
    },
    undefined,
    { timeout: 30_000 },
  );
  const route = new URL(
    new URL(page.url()).hash.slice(1),
    "https://fixture.invalid",
  );
  const channelId = decodeURIComponent(
    route.pathname.slice("/channels/".length),
  );
  // threadRootId is a fetch hint cleared after deep-link resolution; thread
  // is the canonical open pane state retained by the router.
  const rootEventId = route.searchParams.get("thread");
  const relayUrl = await invoke(page, "get_relay_ws_url");
  assert.equal(
    relayUrl,
    proxy.businessRelayUrl,
    "Actual native workspace keeps the canonical tenant URL",
  );
  assert.equal((await invoke(page, "get_identity")).pubkey, OWNER);
  const ownerProfile = await invoke(page, "get_profile");
  assert.equal(ownerProfile.display_name, "Horizon Owner");
  assert.equal(ownerProfile.has_profile_event, true);
  await page.getByTestId("sidebar-profile-name").waitFor({ state: "visible" });
  assert.equal(
    await page.getByTestId("sidebar-profile-name").innerText(),
    "Horizon Owner",
    "The name entered before recovery survives relaunch and appears in the workspace",
  );
  const { channels } = await invoke(page, "get_channels", { knownHash: null });
  const welcome = channels.find((channel) => channel.id === channelId);
  assert.ok(
    welcome &&
      welcome.name.toLowerCase() === "welcome" &&
      welcome.visibility === "private",
    "The UI entered its actual private Welcome channel",
  );
  const rootEvent = JSON.parse(
    await invoke(page, "get_event", { eventId: rootEventId }),
  );
  assert.equal(rootEvent.id, rootEventId);
  assert.equal(rootEvent.kind, 9);
  assert.equal(rootEvent.pubkey, OWNER);
  assert.ok(
    verifyEvent(rootEvent),
    "Setup root retains its real owner signature",
  );
  assert.ok(
    !rootEvent.tags.some((tag) => tag[0] === "e"),
    "Suggestion is a root, not fabricated work output",
  );
  assert.deepEqual(
    rootEvent.tags.filter((tag) => tag[0] === "h"),
    [["h", channelId]],
  );
  const tags = rootEvent.tags.filter(
    (tag) => tag[0] === "client" && tag[1] === "colony:first-job-suggestion:v1",
  );
  assert.equal(tags.length, 1);
  const suggestion = JSON.parse(tags[0][2]);
  assert.equal(suggestion.ownerPubkey, OWNER);
  assert.equal(suggestion.relayUrl, relayUrl);
  assert.equal(suggestion.channelId, channelId);
  assert.equal(suggestion.businessName, "Horizon Labs");
  assert.equal(suggestion.business, BUSINESS);
  assert.ok(suggestion.brief.trim());
  onProgress("welcome-suggestion");
  await screenshot(page, proofDirectory, "joined-welcome-suggestion.png");
  return {
    page,
    ownerPubkey: OWNER,
    relayUrl,
    channelId,
    rootEventId,
    suggestion,
    rootEvent,
  };
}

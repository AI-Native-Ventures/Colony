import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

const SHOTS = "test-results/agent-rank-screenshots";

// The mock fixtures these pubkeys belong to live in e2eBridge.ts:
// mira is a profile-only agent in #general, charlie a bot member of #agents
// (and the peer of the generic "DM" channel), nadia an owned relay agent in
// #agents. Employee heads are seeded per spec so each shot controls its own
// payroll.
const MIRA_PUBKEY =
  "8f83d6b7f3d74f7d933ae3a54dd8c6cc85c7f98e531c16e5a827b953441a8d67";
const CHARLIE_PUBKEY =
  "554cef57437abac34522ac2c9f0490d685b72c80478cf9f7ed6f9570ee8624ea";
const NADIA_PUBKEY =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00";

const ALL_HEADS = [
  { pubkey: MIRA_PUBKEY, role: "researcher", name: "mira", rank: "worker" },
  {
    pubkey: CHARLIE_PUBKEY,
    role: "chief-of-staff",
    name: "charlie",
    rank: "executive",
  },
  { pubkey: NADIA_PUBKEY, role: "team-lead", name: "nadia", rank: "leader" },
] as const;

async function waitForMockLiveSubscription(
  page: import("@playwright/test").Page,
  channelName: string,
) {
  await expect
    .poll(async () => {
      return page.evaluate(
        ({ currentChannelName }) => {
          return (
            (
              window as Window & {
                __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
                  channelName: string;
                }) => boolean;
              }
            ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
              channelName: currentChannelName,
            }) ?? false
          );
        },
        { currentChannelName: channelName },
      );
    })
    .toBe(true);
}

test("member list shows each agent's rank", async ({ page }) => {
  await installMockBridge(page, { employeeHeads: [...ALL_HEADS] });
  await page.goto("/");

  await page.getByTestId("channel-agents").click();
  await expect(page.getByTestId("chat-title")).toHaveText("agents");

  await page.getByTestId("channel-members-trigger").click();
  const sidebar = page.getByTestId("members-sidebar");
  await expect(sidebar).toBeVisible();

  // Charlie (executive) and nadia (leader) both carry their rank; the viewer
  // and any headless member show none.
  const charlieRow = sidebar.getByTestId(`sidebar-member-${CHARLIE_PUBKEY}`);
  await expect(charlieRow.getByText("Chief of staff")).toBeVisible();
  const nadiaRow = sidebar.getByTestId(`sidebar-member-${NADIA_PUBKEY}`);
  await expect(nadiaRow.getByText("Team lead")).toBeVisible();

  await waitForAnimations(page);
  await sidebar.screenshot({ path: `${SHOTS}/01-members-sidebar.png` });
});

test("profile panel shows the agent's rank", async ({ page }) => {
  await installMockBridge(page, { employeeHeads: [...ALL_HEADS] });
  await page.goto("/");

  await page.getByTestId("channel-agents").click();
  await expect(page.getByTestId("chat-title")).toHaveText("agents");

  await page.getByTestId("channel-members-trigger").click();
  const sidebar = page.getByTestId("members-sidebar");
  await sidebar
    .getByTestId(`sidebar-member-open-profile-${CHARLIE_PUBKEY}`)
    .click();

  const panel = page.getByTestId("user-profile-panel");
  await expect(panel).toBeVisible();
  const rankRow = panel.getByTestId("user-profile-rank");
  await expect(rankRow).toContainText("Chief of staff");

  await waitForAnimations(page);
  await panel.screenshot({ path: `${SHOTS}/02-profile-panel.png` });
});

test("dm header shows the agent's rank next to the name", async ({ page }) => {
  await installMockBridge(page, { employeeHeads: [...ALL_HEADS] });
  await page.goto("/");

  // The generic-named DM whose peer is charlie.
  await page.getByTestId("channel-DM").click();
  await expect(page.getByTestId("chat-title")).toHaveText("charlie");

  const headerBadge = page
    .getByTestId("chat-header")
    .getByTestId("agent-rank-badge");
  await expect(headerBadge).toHaveText("Chief of staff");

  await waitForAnimations(page);
  await page
    .getByTestId("chat-header")
    .screenshot({ path: `${SHOTS}/03-dm-header.png` });
});

test("profile popover shows the agent's rank", async ({ page }) => {
  await installMockBridge(page, { employeeHeads: [...ALL_HEADS] });
  await page.goto("/");

  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");

  // A message authored by mira gives the popover an agent with a worker rank
  // to resolve. Emitted live so it lands after the seeded rows.
  await page.evaluate(
    ({ pubkey }) => {
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content: "Rank check: this badge should say Worker.",
        pubkey,
      });
    },
    { pubkey: MIRA_PUBKEY },
  );

  const miraRow = page
    .getByTestId("message-row")
    .filter({ hasText: "Rank check" })
    .first();
  await expect(miraRow).toBeVisible();
  await expect(miraRow).toContainText("mira");

  // The popover opens on a 500ms hover over the author control.
  await miraRow.locator("button").first().hover();
  const popover = page.getByTestId("user-profile-popover");
  await expect(popover).toBeVisible();
  await expect(popover.getByText("Worker")).toBeVisible();

  await waitForAnimations(page);
  await popover.screenshot({ path: `${SHOTS}/04-profile-popover.png` });
});

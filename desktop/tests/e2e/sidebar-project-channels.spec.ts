import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, openCreateChannelDialog } from "../helpers/bridge";

const SHOTS = "test-results/sidebar-project-channels";
const SIDEBAR_CLIP = { x: 0, y: 0, width: 320, height: 720 };
/** The mock's second project, seeded deliberately without a channel. */
const UNLINKED_PROJECT = "side-quests";

async function openApp(page: Page): Promise<void> {
  await installMockBridge(page);
  await page.goto("/");
  await expect(page.getByTestId("app-sidebar")).toBeVisible();
}

async function openManagementSheet(
  page: Page,
  channelTestId: string,
  title: string,
): Promise<void> {
  await page.getByTestId(channelTestId).click();
  await expect(page.getByTestId("chat-title")).toHaveText(title);
  await page.getByTestId("channel-management-trigger").click();
  await expect(page.getByTestId("channel-management-sheet")).toBeVisible();
}

async function closeManagementSheet(page: Page): Promise<void> {
  // The sheet renders as a split-layout side panel here, so Escape does not
  // reach it; its own close button does.
  await page.getByRole("button", { name: "Close panel" }).click();
  // `toBeVisible` passes on an element behind an overlay, so the sheet's
  // absence — not the sidebar's visibility — is what proves it closed.
  await expect(page.getByTestId("channel-management-sheet")).toHaveCount(0);
}

/** Pick a project in an open Radix dropdown and confirm the trigger label. */
async function chooseProject(
  page: Page,
  triggerTestId: string,
  projectName: string,
): Promise<void> {
  await page.getByTestId(triggerTestId).click();
  await page.getByRole("menuitemradio", { name: projectName }).click();
  await expect(page.getByTestId(triggerTestId)).toContainText(projectName);
}

test.describe("project channels", () => {
  test("01 — the sidebar gives project channels their own section", async ({
    page,
  }) => {
    await openApp(page);

    const projectSection = page.getByTestId("project-channel-list");
    await expect(projectSection).toBeVisible();

    // `general` is the mock's project channel: repo icon, and the project's
    // default branch as trailing meta.
    const projectChannel = projectSection.getByTestId("channel-general");
    await expect(projectChannel).toBeVisible();
    await expect(
      projectChannel.locator("svg.lucide-folder-git-2"),
    ).toBeVisible();
    await expect(page.getByTestId("channel-meta-general")).toHaveText("main");

    // It left the plain channel list; everything else stayed a `#` channel.
    const streamList = page.getByTestId("stream-list");
    await expect(streamList).toBeVisible();
    await expect(streamList.getByTestId("channel-general")).toHaveCount(0);
    const plainChannel = streamList.getByTestId("channel-random");
    await expect(plainChannel).toBeVisible();
    await expect(plainChannel.locator("svg.lucide-hash")).toBeVisible();
    await expect(page.getByTestId("channel-meta-random")).toHaveCount(0);

    await waitForAnimations(page);
    await page.screenshot({
      path: `${SHOTS}/01-projects-section.png`,
      clip: SIDEBAR_CLIP,
    });
  });

  test("02 — the channel header names the project, repo and branch", async ({
    page,
  }) => {
    await openApp(page);
    await page.getByTestId("channel-general").click();
    await expect(page.getByTestId("chat-title")).toHaveText("general");

    await expect(page.getByTestId("chat-header-project-icon")).toBeVisible();
    await expect(page.getByTestId("chat-header-project-badge")).toHaveText(
      "project",
    );
    // "<repo> · <branch> · N employee(s)" — the employee count is whatever
    // share of the seeded members are agents, so the shape is what is pinned.
    await expect(page.getByTestId("chat-header-description")).toHaveText(
      /^buzz · main · \d+ employees?$/,
    );

    await waitForAnimations(page);
    await page.getByTestId("chat-header").screenshot({
      path: `${SHOTS}/02-project-header.png`,
    });
  });

  test("03 — channel settings show the linked project", async ({ page }) => {
    await openApp(page);
    await openManagementSheet(page, "channel-general", "general");

    const row = page.getByTestId("channel-management-project");
    await expect(row).toBeVisible();
    await expect(row).toContainText("buzz");
    await expect(
      page.getByTestId("channel-management-project-unlink"),
    ).toBeVisible();
    // A linked channel offers no picker — re-pointing happens after Unlink.
    await expect(
      page.getByTestId("channel-management-project-select"),
    ).toHaveCount(0);
  });

  // `agents` is the mock's other channel owned by the viewer, so the link
  // controls are gated open there; `random`, where the viewer is a plain
  // member, is the control that proves the gate.
  test("04 — linking a project from settings moves the channel", async ({
    page,
  }) => {
    await openApp(page);
    await openManagementSheet(page, "channel-agents", "agents");

    const row = page.getByTestId("channel-management-project");
    await expect(row).toBeVisible();
    await expect(row).toContainText("No project");
    await chooseProject(
      page,
      "channel-management-project-select",
      UNLINKED_PROJECT,
    );
    await page.getByTestId("channel-management-project-link").click();

    // The row flips to the linked state once the announcement is republished.
    await expect(
      page.getByTestId("channel-management-project-unlink"),
    ).toBeVisible();
    await expect(row).toContainText(UNLINKED_PROJECT);

    await closeManagementSheet(page);
    const projectSection = page.getByTestId("project-channel-list");
    await expect(projectSection.getByTestId("channel-agents")).toBeVisible();
    await expect(
      page.getByTestId("stream-list").getByTestId("channel-agents"),
    ).toHaveCount(0);
  });

  test("05 — a channel can be created into a project", async ({ page }) => {
    await openApp(page);
    const channelName = `factory-${Date.now()}`;

    await openCreateChannelDialog(page);
    await expect(page.getByTestId("create-channel-project")).toBeVisible();
    await page.getByTestId("create-channel-name").fill(channelName);
    await chooseProject(page, "create-channel-project", UNLINKED_PROJECT);
    await page.getByTestId("create-channel-submit").click();

    await expect(page.getByTestId("chat-title")).toHaveText(channelName);
    await expect(page.getByTestId("project-channel-list")).toContainText(
      channelName,
    );
    await expect(page.getByTestId("stream-list")).not.toContainText(
      channelName,
    );
  });
});

import { expect, test } from "@playwright/test";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";
import { openSettings } from "../helpers/settings";
import {
  emitMessage,
  emitSignedEvent,
  fixtureUuid,
  GENERAL_CHANNEL_ID,
  OWNER_PUBKEY,
  readCoreManifest,
  settleTimelineAtLatest,
  signBlockInstance,
  signManifest,
  waitForLiveChannel,
} from "./blocks-test-helpers";

const AGENT = TEST_IDENTITIES.charlie.pubkey;
const PERSONA = "redesign-social-manager";
const ROLE = "Social media manager";
const MESSAGE = `mock-agents-managed-${AGENT.slice(0, 8)}`;
const REPORT_MANIFEST = signManifest(readCoreManifest("report"));

async function setup(page: import("@playwright/test").Page) {
  page.on("pageerror", (error) =>
    console.error("REDESIGN_RENDER_ERROR", error.stack),
  );
  await page.addInitScript(() => {
    localStorage.setItem("buzz-theme", "buzz");
    localStorage.setItem("buzz-follow-system", "false");
    localStorage.setItem("buzz-accent-color", "#895AF6");
    localStorage.setItem("buzz.channels.threadViewMode", "split");
  });
  await installMockBridge(page, {
    blockEvents: [REPORT_MANIFEST],
    relaySelf: OWNER_PUBKEY,
    bakedBuildEnv: [
      { key: "BUZZ_AGENT_PROVIDER", value: "anthropic", masked: false },
      { key: "BUZZ_AGENT_MODEL", value: "claude-opus-4-8", masked: false },
      {
        key: "ANTHROPIC_API_KEY",
        value: "sk-ant-synthetic-test",
        masked: true,
      },
    ],
    managedAgents: [
      {
        pubkey: AGENT,
        name: "Sarah",
        personaId: PERSONA,
        status: "stopped",
        channelNames: ["agents"],
      },
    ],
    personas: [
      {
        id: PERSONA,
        displayName: "Sarah",
        roleId: "social-media-manager",
        roleTitle: ROLE,
        systemPrompt: "Prepare social content for review.",
      },
    ],
  });
  await page.goto("/");
}

test("agent job identity appears in conversations and DMs and keeps its colour across accents", async ({
  page,
}) => {
  await setup(page);
  await page.getByTestId("channel-agents").click();
  const row = page.locator(`[data-message-id="${MESSAGE}"]`);
  await expect(row.getByTestId("message-agent-role")).toHaveText(
    `${ROLE} · Agent`,
  );
  await expect(row).toContainText("Sarah");
  const dm = page.getByTestId("channel-DM");
  await expect(dm.getByTestId("dm-agent-role")).toHaveText(`${ROLE} · Agent`);
  await expect(dm).toContainText("Sarah");
  await dm.scrollIntoViewIfNeeded();
  const fallback = row.getByTestId("message-avatar-fallback");
  await expect(fallback).toBeVisible();
  const colour = await fallback.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/redesign/agent-identity-violet.png",
  });
  await openSettings(page, "appearance");
  await page.getByTestId("accent-color-orange").click();
  await page.getByRole("button", { name: "Back to app" }).click();
  await page.getByTestId("channel-agents").click();
  await expect(fallback).toHaveCSS("background-color", colour);
  await expect(row.getByTestId("message-agent-role")).toHaveText(
    `${ROLE} · Agent`,
  );
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/redesign/agent-identity-orange.png",
  });
  // A person is not labelled as an agent merely for sharing the same channel.
  await page.getByTestId("channel-general").click();
  const human = page
    .getByTestId("message-row")
    .filter({ hasText: "Welcome to" })
    .first();
  await expect(human).toBeVisible();
  await expect(human.getByTestId("message-agent-role")).toHaveCount(0);
});

test("long agent messages and existing inline work stay readable beside their replies", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await setup(page);
  await page.getByTestId("channel-general").click();
  await waitForLiveChannel(page, "general");
  const root = await emitMessage(page, {
    channelName: "general",
    pubkey: AGENT,
    content: [
      "**Your content plan is ready for review.**",
      "The first week introduces the people behind the business and explains the problems you solve. The second week uses practical examples to answer the questions customers ask before getting in touch. Each post has one clear message, a suggested image direction and a caption in your brand's voice.",
      "I have kept the publishing schedule to one post each weekday on Instagram. The designs alternate between photography and typography so the feed feels connected without every post looking identical. The opening lines are deliberately short; the detail sits below for readers who want to learn more.",
      "Please review the wording and confirm that the examples reflect your actual services. Anything that needs a real customer quote or a project photograph is marked for your input. These are sample drafts for this visual check; nothing has been scheduled or published.",
    ].join("\n\n"),
  });
  const report = signBlockInstance({
    channelId: GENERAL_CHANNEL_ID,
    handle: "report",
    instanceId: fixtureUuid(81),
    manifestId: REPORT_MANIFEST.id,
    content: "Two weeks of content — 10 sample drafts ready for review.",
    data: {
      title: "Two weeks of content",
      summary: "Sample plan for review · Instagram",
      headline_value: "10 drafts",
      series: [
        { label: "Week 1", value: 5 },
        { label: "Week 2", value: 5 },
      ],
      rows: [
        { label: "Ready for review", value: 8 },
        { label: "Needs your input", value: 2 },
      ],
      sources: ["Illustrative content plan"],
    },
  });
  await emitSignedEvent(page, "general", report);
  await emitMessage(page, {
    channelName: "general",
    parentEventId: root.id,
    content:
      "The practical examples feel right. Please make the introductory post warmer and include the founder's photograph before we review the final designs.",
    createdAt: root.created_at + 1,
  });
  await settleTimelineAtLatest(page);
  const channel = page.getByTestId("channel-drop-zone");
  const row = channel.locator(`[data-message-id="${root.id}"]`);
  await expect(channel.locator('[data-block-handle="report"]')).toHaveAttribute(
    "data-block-trust",
    "core",
  );
  await channel
    .locator(
      `[data-testid="message-thread-summary"][data-thread-head-id="${root.id}"]`,
    )
    .click();
  const thread = page.getByTestId("message-thread-panel");
  await expect(thread).toBeVisible();
  await expect(thread).toContainText(
    "Please make the introductory post warmer",
  );
  await expect(thread.getByTestId("message-agent-role").first()).toHaveText(
    `${ROLE} · Agent`,
  );
  await expect(
    thread.getByTestId("message-avatar-fallback").first(),
  ).toBeVisible();
  const body = row
    .locator("p")
    .filter({ hasText: "The first week introduces" });
  const typography = await body.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      font: Number.parseFloat(style.fontSize),
      line: Number.parseFloat(style.lineHeight),
    };
  });
  expect(typography.font).toBeGreaterThanOrEqual(13);
  expect(typography.font).toBeLessThanOrEqual(16);
  expect(typography.line).toBeGreaterThanOrEqual(typography.font * 1.4);
  for (const pane of [channel, thread]) {
    expect(
      await pane.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  }
  await row.scrollIntoViewIfNeeded();
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/redesign/long-message-inline-work-split.png",
  });
  await waitForAnimations(page);
  await channel.locator('[data-block-handle="report"]').screenshot({
    path: "test-results/redesign/inline-work-report.png",
  });
});

test("definition editor keeps the stable job ID when its human title changes", async ({
  page,
}) => {
  await setup(page);
  await page.getByTestId("open-agents-view").click();
  await page.getByRole("button", { name: "Sarah agent profile" }).click();
  await page.getByTestId("user-profile-edit-agent").click();
  const dialog = page.getByTestId("persona-dialog");
  await expect(page.locator("#persona-display-name")).toHaveValue("Sarah");
  await expect(page.locator("#persona-role-title")).toHaveValue(ROLE);
  await page.locator("#persona-role-title").fill("Brand designer");
  await waitForAnimations(page);
  await dialog.screenshot({
    path: "test-results/redesign/agent-job-title.png",
  });
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const payload = await page.evaluate(() => {
    const entries = window.__BUZZ_E2E_COMMAND_LOG__ ?? [];
    return entries.filter((entry) => entry.command === "update_persona").at(-1)
      ?.payload;
  });
  expect(payload).toMatchObject({
    input: {
      displayName: "Sarah",
      roleId: "social-media-manager",
      roleTitle: "Brand designer",
    },
  });
});

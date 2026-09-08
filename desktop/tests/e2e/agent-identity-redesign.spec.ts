import { expect, test } from "@playwright/test";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";
import { openSettings } from "../helpers/settings";
import {
  POST_IMAGE,
  POST_IMAGE_URL,
  POST_PREVIEW,
} from "./redesign-post-fixture";
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
const SCOUT = TEST_IDENTITIES.bob.pubkey;
const PERSONA = "redesign-social-manager";
const ROLE = "Social media manager";
const MESSAGE = `mock-agents-managed-${AGENT.slice(0, 8)}`;
const REPORT_MANIFEST = signManifest(readCoreManifest("report"));
const PRODUCTION_READING_FONT =
  '"Inter Variable", Inter, "Avenir Next", "Segoe UI", sans-serif';

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
    blockEvents: [REPORT_MANIFEST, ...POST_PREVIEW.events],
    searchProfiles: [
      { pubkey: TEST_IDENTITIES.tyler.pubkey, displayName: "Basheer Phiri" },
    ],
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
        pubkey: SCOUT,
        name: "Scout",
        personaId: "redesign-scout",
        status: "stopped",
        channelNames: ["agents"],
      },
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
        id: "redesign-scout",
        displayName: "Scout",
        roleId: "chief-of-staff",
        roleTitle: "Chief of staff",
        systemPrompt: "Coordinate the work for review.",
      },
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
  await page.setViewportSize({ width: 1440, height: 1120 });
  await page.route(POST_IMAGE_URL, (route) =>
    route.fulfill({ contentType: "image/png", body: POST_IMAGE }),
  );
  await setup(page);
  await page.getByTestId("channel-general").click();
  await waitForLiveChannel(page, "general");
  const root = await emitMessage(page, {
    channelName: "general",
    pubkey: SCOUT,
    content: [
      "**Your content plan is ready for review.**",
      "The first week introduces the people behind the business and explains the problems you solve. The second week uses practical examples to answer the questions customers ask before getting in touch. Each post has one clear message, a suggested image direction and a caption in your brand's voice.",
      "I have kept the publishing schedule to one post each weekday on Instagram. The designs alternate between photography and typography so the feed feels connected without every post looking identical. The opening lines are deliberately short; the detail sits below for readers who want to learn more.",
      "Please review the wording and confirm that the examples reflect your actual services. Anything that needs a real customer quote or a project photograph is marked for your input. These are sample drafts for this visual check; nothing has been scheduled or published.",
    ].join("\n\n"),
  });
  const report = signBlockInstance({
    channelId: GENERAL_CHANNEL_ID,
    handle: "brand-post-preview",
    instanceId: fixtureUuid(81),
    manifestId: POST_PREVIEW.events[0].id,
    parentEventId: root.id,
    createdAt: root.created_at + 2,
    content: "Here is a sample post direction. You can review it right here.",
    data: {
      title: "Monday · Instagram",
      description:
        "Your logo, website and social posts should feel like the same business. Horizon Labs brings them together, so every first impression feels clear and consistent.\n\nTell us where your brand needs a little more attention.",
      url: POST_IMAGE_URL,
      alt: "Horizon Labs sample post: A brand people remember.",
      status: "draft",
    },
  });
  await emitSignedEvent(page, "general", report);
  await emitMessage(page, {
    channelName: "general",
    parentEventId: root.id,
    pubkey: OWNER_PUBKEY,
    content:
      "The practical examples feel right. Please make the introductory post warmer and include the founder's photograph before we review the final designs.",
    createdAt: root.created_at + 3,
  });
  await emitMessage(page, {
    channelName: "general",
    createdAt: root.created_at + 4,
    pubkey: OWNER_PUBKEY,
    content: "For the next batch, please use South African spelling.",
  });
  await settleTimelineAtLatest(page);
  const channel = page.getByTestId("channel-drop-zone");
  const row = channel.locator(`[data-message-id="${root.id}"]`);
  await expect(
    row.getByRole("button", { name: "Read full message", exact: true }),
  ).toBeVisible();
  await channel
    .locator(
      `[data-testid="message-thread-summary"][data-thread-head-id="${root.id}"]`,
    )
    .click();
  const thread = page.getByTestId("message-thread-panel");
  await expect(thread).toBeVisible();
  await expect(channel.getByTestId("chat-title")).toHaveCSS(
    "font-size",
    "20px",
  );
  await expect(thread.locator(".colony-replies-label")).toBeVisible();
  const post = thread.locator('[data-block-handle="brand-post-preview"]');
  await expect(post).toHaveAttribute("data-block-trust", "workspace-custom");
  await expect(post.getByRole("img")).toBeVisible();
  await expect(thread).toContainText(
    "Please make the introductory post warmer",
  );
  await expect(thread.getByTestId("message-agent-role").first()).toHaveText(
    "Chief of staff · Agent",
  );
  await expect(
    thread.getByTestId("message-avatar-fallback").first(),
  ).toBeVisible();
  // Both reading panes inherit production's regular Inter, including long
  // prose, existing inline Blocks and the editable reply composers.
  for (const message of [row, thread.getByTestId("message-thread-head")]) {
    const body = message
      .locator("p")
      .filter({ hasText: "The first week introduces" });
    await expect(body).toHaveCSS("font-family", PRODUCTION_READING_FONT);
    await expect(body).toHaveCSS("font-weight", "400");
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
  }
  await expect(post.getByText("Caption draft", { exact: true })).toHaveCSS(
    "font-family",
    PRODUCTION_READING_FONT,
  );
  await expect(
    post.getByText("Your logo, website and social posts", { exact: false }),
  ).toHaveCSS("font-family", PRODUCTION_READING_FONT);
  for (const pane of [channel, thread]) {
    await expect(pane.getByTestId("message-input")).toHaveCSS(
      "font-family",
      PRODUCTION_READING_FONT,
    );
    expect(
      await pane.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  }
  await row.scrollIntoViewIfNeeded();
  await thread.getByTestId("message-thread-body").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.mouse.move(0, 0);
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/redesign/long-message-inline-work-split.png",
  });
  await waitForAnimations(page);
  await post.screenshot({
    path: "test-results/redesign/inline-work-post.png",
  });

  const channelDisclosure = row.getByRole("button", {
    name: "Read full message",
    exact: true,
  });
  const threadHead = thread.getByTestId("message-thread-head");
  const threadDisclosure = threadHead.getByRole("button", {
    name: "Read full message",
    exact: true,
  });
  const disclosureContrast = await channelDisclosure.evaluate((element) => {
    const surface = element.closest('[data-testid="channel-drop-zone"]');
    if (!surface) throw new Error("Missing reading surface");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Missing colour probe");
    const luminance = (colour: string) => {
      context.fillStyle = colour;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = Array.from(context.getImageData(0, 0, 1, 1).data)
        .slice(0, 3)
        .map((byte) => {
          const value = byte / 255;
          return value <= 0.04045
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4;
        });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const values = [
      luminance(getComputedStyle(element).color),
      luminance(getComputedStyle(surface).backgroundColor),
    ].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  });
  expect(disclosureContrast).toBeGreaterThanOrEqual(4.5);
  await channelDisclosure.click();
  await expect(
    row.getByText("I have kept the publishing schedule", { exact: false }),
  ).toBeVisible();
  await expect(threadDisclosure).toHaveAttribute("aria-expanded", "false");
  const channelDraft = channel.getByTestId("message-input");
  const threadDraft = thread.getByTestId("message-input");
  await channelDraft.fill("A separate channel draft");
  await threadDraft.fill("A separate thread draft");
  await thread
    .getByRole("button", { name: "Close panel", exact: true })
    .click();
  await expect(thread).toHaveCount(0);
  await expect(channelDraft).toContainText("A separate channel draft");
  await expect(
    row.getByRole("button", { name: "Show less", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await channel
    .locator(
      `[data-testid="message-thread-summary"][data-thread-head-id="${root.id}"]`,
    )
    .click();
  await expect(threadDraft).toContainText("A separate thread draft");
  await expect(threadDisclosure).toHaveAttribute("aria-expanded", "false");
  await threadDisclosure.click();
  await expect(
    threadHead.getByRole("button", { name: "Show less", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(channelDraft).toContainText("A separate channel draft");
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

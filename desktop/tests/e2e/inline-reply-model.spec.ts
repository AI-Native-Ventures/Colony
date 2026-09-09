import { createHash } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const AGENT = TEST_IDENTITIES.charlie.pubkey;
const models = [
  "model-one",
  "model-one[high]",
  "model-one[max]",
  "model-two",
  "model-two[low]",
].map((id) => ({ id, name: id }));

async function captureOpenReplySettings(
  page: Page,
  composer: Locator,
  path: string,
) {
  const settings = page.getByRole("dialog", {
    name: "Next teammate reply settings",
  });
  await expect(settings).toBeVisible();
  await expect(composer).toBeVisible();
  await waitForAnimations(page);
  const [composerBox, settingsBox] = await Promise.all([
    composer.boundingBox(),
    settings.boundingBox(),
  ]);
  const viewport = page.viewportSize();
  if (!composerBox || !settingsBox || !viewport) {
    throw new Error("Reply settings and composer must be laid out.");
  }
  // The settings are portaled, so a composer locator screenshot excludes them.
  // Capture both surfaces with a small margin to retain the draft context.
  const x = Math.max(0, Math.min(composerBox.x, settingsBox.x) - 12);
  const y = Math.max(0, Math.min(composerBox.y, settingsBox.y) - 12);
  const right = Math.min(
    viewport.width,
    Math.max(
      composerBox.x + composerBox.width,
      settingsBox.x + settingsBox.width,
    ) + 12,
  );
  const bottom = Math.min(
    viewport.height,
    Math.max(
      composerBox.y + composerBox.height,
      settingsBox.y + settingsBox.height,
    ) + 12,
  );
  return page.screenshot({
    path,
    clip: { x, y, width: right - x, height: bottom - y },
  });
}

for (const surface of ["channel", "thread"] as const) {
  test(`${surface} reply model and reasoning travel on one selected teammate message`, async ({
    page,
  }, testInfo) => {
    await installMockBridge(page, {
      managedAgents: [
        {
          pubkey: AGENT,
          name: "Jason",
          status: "running",
          channelNames: ["general"],
        },
      ],
      discoverAgentModels: { models, supportsSwitching: true },
    });
    await page.goto("/");
    await page.getByTestId("channel-general").click();
    if (surface === "thread") {
      await page.goto(
        "/#/channels/9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50?messageId=mock-general-welcome&thread=mock-general-welcome",
      );
      await expect(page.getByTestId("message-thread-panel")).toBeVisible();
    }
    const composer =
      surface === "thread"
        ? page.getByTestId("thread-composer-overlay")
        : page.getByTestId("channel-composer-overlay");
    const input = composer.getByTestId("message-input");
    await input.fill("@Jason");
    await composer
      .getByTestId("mention-autocomplete")
      .locator("button", { hasText: "Jason" })
      .first()
      .click();
    await input.pressSequentially(" please reply");
    await composer.getByTestId("reply-model-controls").click();
    await page
      .getByLabel("Reply model", { exact: true })
      .selectOption("model-one");
    await page
      .getByLabel("Reply reasoning", { exact: true })
      .selectOption("max");
    await page
      .getByLabel("Reply model", { exact: true })
      .selectOption("model-two");
    await expect(
      page.getByLabel("Reply reasoning", { exact: true }).locator("option"),
    ).toHaveText(["Teammate defaults", "low"]);
    await page
      .getByLabel("Reply reasoning", { exact: true })
      .selectOption("low");
    await expect(page.getByLabel("Reply model", { exact: true })).toHaveValue(
      "model-two",
    );
    await expect(
      page.getByLabel("Reply reasoning", { exact: true }),
    ).toHaveValue("low");
    const controlsShot = await captureOpenReplySettings(
      page,
      composer,
      testInfo.outputPath(`${surface}-reply-settings-open.png`),
    );
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "Next teammate reply settings" }),
    ).toHaveCount(0);
    await input.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const calls =
            (
              window as Window & {
                __BUZZ_E2E_COMMAND_PAYLOADS__?: Array<{
                  command: string;
                  payload: { replyModelTags?: string[][] };
                }>;
              }
            ).__BUZZ_E2E_COMMAND_PAYLOADS__ ?? [];
          return calls.findLast(
            (call) => call.command === "send_channel_message",
          )?.payload.replyModelTags;
        }),
      )
      .toEqual([["agent-reply", "1", AGENT, "model-two[low]"]]);
    await expect(page.getByTestId("reply-model-request")).toContainText(
      "Requested for teammate reply: model-two · reasoning low",
    );
    await expect(
      composer.getByTestId("reply-model-controls"),
    ).not.toContainText("model-two");
    const requestedMessage = page.getByTestId("message-row").filter({
      has: page.getByTestId("reply-model-request"),
    });
    await expect(requestedMessage).toHaveCount(1);
    await expect(requestedMessage).toContainText("please reply");
    await requestedMessage.scrollIntoViewIfNeeded();
    await waitForAnimations(page);
    const requestedShot = await requestedMessage.screenshot({
      path: testInfo.outputPath(`${surface}-reply-settings-requested.png`),
    });
    expect(createHash("sha256").update(requestedShot).digest("hex")).not.toBe(
      createHash("sha256").update(controlsShot).digest("hex"),
    );
  });
}

test("discovery failure remains an error and never becomes unsupported or success", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: AGENT,
        name: "Jason",
        status: "running",
        channelNames: ["general"],
      },
    ],
    discoverAgentModelsError: "catalog unavailable",
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  const composer = page.getByTestId("message-composer");
  await composer.getByTestId("message-input").fill("@Jason");
  await composer
    .getByTestId("mention-autocomplete")
    .locator("button", { hasText: "Jason" })
    .first()
    .click();
  await composer.getByTestId("reply-model-controls").click();
  await expect(page.getByRole("alert")).toContainText("could not be loaded");
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Reply model", { exact: true })).toHaveCount(0);
});

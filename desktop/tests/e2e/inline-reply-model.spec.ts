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

async function replyDiscoveryCount(page: Page) {
  return page.evaluate(
    () =>
      (
        (
          window as Window & {
            __BUZZ_E2E_COMMAND_PAYLOADS__?: Array<{ command: string }>;
          }
        ).__BUZZ_E2E_COMMAND_PAYLOADS__ ?? []
      ).filter((call) => call.command === "get_agent_models").length,
  );
}

async function captureOpenReplyModelMenu(
  page: Page,
  composer: Locator,
  path: string,
) {
  // Radix labels the menu by its trigger, so its accessible name is the
  // trigger's "Reply model" label.
  const settings = page.getByRole("menu", { name: "Reply model" });
  await expect(settings).toBeVisible();
  await expect(composer).toBeVisible();
  await waitForAnimations(page);
  const [composerBox, settingsBox] = await Promise.all([
    composer.boundingBox(),
    settings.boundingBox(),
  ]);
  const viewport = page.viewportSize();
  if (!composerBox || !settingsBox || !viewport) {
    throw new Error("Reply model menu and composer must be laid out.");
  }
  // The menu is portaled, so a composer locator screenshot excludes it.
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

for (const theme of ["buzz", "buzz-dark"] as const) {
  for (const surface of ["channel", "thread"] as const) {
    test(`${surface} reply model and reasoning travel on one selected teammate message in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.addInitScript((value) => {
        localStorage.setItem("buzz-theme", value);
        localStorage.setItem("buzz-follow-system", "false");
        localStorage.setItem("buzz-accent-color", "#895AF6");
      }, theme);
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
      await expect(page.locator("html")).toHaveAttribute(
        "data-buzz-theme",
        theme,
      );
      await page.getByTestId("channel-general").click();
      if (surface === "thread") {
        await page.goto(
          "/#/channels/9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50?messageId=mock-general-welcome&thread=mock-general-welcome",
        );
        await expect(page.getByTestId("message-thread-panel")).toBeVisible();
        // The app rewrites its own URL once the deep-linked row settles; an
        // evaluate in flight during that rewrite dies with a destroyed context.
        await expect.poll(() => page.url()).not.toContain("messageId");
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
      const controls = composer.getByTestId("reply-model-controls");
      const modelChoice = controls.getByRole("button", {
        name: "Reply model",
        exact: true,
      });
      const reasoningChoice = controls.getByRole("button", {
        name: "Reply reasoning",
        exact: true,
      });
      await expect(controls).toContainText("Jason");
      await expect(controls).toContainText("This reply only");
      await expect(modelChoice).toHaveText("ModelDefault");
      await expect(reasoningChoice).toBeDisabled();
      expect(await replyDiscoveryCount(page)).toBe(0);
      await modelChoice.click();
      await expect.poll(() => replyDiscoveryCount(page)).toBe(1);
      await page
        .getByRole("menuitemradio", { name: "model-one", exact: true })
        .click();
      await reasoningChoice.click();
      await page
        .getByRole("menuitemradio", { name: "max", exact: true })
        .click();
      await modelChoice.click();
      await page
        .getByRole("menuitemradio", { name: "model-two", exact: true })
        .click();
      await reasoningChoice.click();
      await expect(page.getByRole("menuitemradio")).toHaveText([
        "Teammate defaults",
        "low",
      ]);
      await page
        .getByRole("menuitemradio", { name: "low", exact: true })
        .click();
      await expect(modelChoice).toHaveText("Modelmodel-two");
      await expect(reasoningChoice).toHaveText("Reasoninglow");
      await modelChoice.click();
      await expect(
        page.getByRole("menuitemradio", { name: "model-two", exact: true }),
      ).toHaveAttribute("aria-checked", "true");
      const controlsShot = await captureOpenReplyModelMenu(
        page,
        composer,
        testInfo.outputPath(`${surface}-${theme}-reply-model-menu.png`),
      );
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(modelChoice).toBeFocused();
      await waitForAnimations(page);
      const inlineShot = await composer.screenshot({
        path: testInfo.outputPath(
          `${surface}-${theme}-reply-settings-inline.png`,
        ),
      });
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
      await expect(composer.getByTestId("reply-model-controls")).toHaveCount(0);
      const requestedMessage = page.getByTestId("message-row").filter({
        has: page.getByTestId("reply-model-request"),
      });
      await expect(requestedMessage).toHaveCount(1);
      await expect(requestedMessage).toContainText("please reply");
      await requestedMessage.scrollIntoViewIfNeeded();
      await waitForAnimations(page);
      const requestedShot = await requestedMessage.screenshot({
        path: testInfo.outputPath(
          `${surface}-${theme}-reply-settings-requested.png`,
        ),
      });
      expect(
        new Set(
          [controlsShot, inlineShot, requestedShot].map((shot) =>
            createHash("sha256").update(shot).digest("hex"),
          ),
        ).size,
      ).toBe(3);
      // Sending clears the mention and therefore hides reply controls. Select
      // the teammate again to prove that this message's choice was not retained.
      await input.fill("@Jason");
      await composer
        .getByTestId("mention-autocomplete")
        .locator("button", { hasText: "Jason" })
        .first()
        .click();
      await expect(modelChoice).toHaveText("ModelDefault");
      await expect(reasoningChoice).toHaveText("ReasoningDefault");
      await expect(reasoningChoice).toBeDisabled();
    });
  }
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
  const controls = composer.getByTestId("reply-model-controls");
  await expect(controls).toBeVisible();
  expect(await replyDiscoveryCount(page)).toBe(0);
  await controls
    .getByRole("button", { name: "Reply model", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("could not be loaded");
  await expect(
    page.getByRole("menuitem", { name: "Retry", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("menuitemradio")).toHaveCount(0);
  await expect(
    page.getByText("This teammate does not expose reply settings.", {
      exact: false,
    }),
  ).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Retry", exact: true }).click();
  await expect.poll(() => replyDiscoveryCount(page)).toBe(2);
  await expect(page.getByRole("alert")).toContainText("could not be loaded");
});

import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { expectEmojiMartStylesInstalled } from "../helpers/css";
import { seedActiveIdentity } from "../helpers/onboarding";

/**
 * A key that exists on this machine but has no relay profile: signing in with
 * an existing account, a reinstall, a second machine, or an imported nsec.
 * The relay has no name for them, so onboarding opens on the canvas profile
 * screen and asks for one.
 */
const BLANK_TYLER_IDENTITY = {
  ...TEST_IDENTITIES.tyler,
  username: "",
};

test("an existing key with no profile lands on the canvas profile screen", async ({
  page,
}) => {
  await seedActiveIdentity(page, BLANK_TYLER_IDENTITY);
  await installMockBridge(page, undefined, { skipOnboardingSeed: true });
  await page.goto("/");

  await expect(page.getByTestId("onboarding-gate")).toBeVisible();
  await expect(page.getByTestId("onboarding-page-profile")).toBeVisible();
  await expect(page.getByTestId("onboarding-profile-avatar")).toBeVisible();

  // No password, no recovery code and no second avatar screen: this identity
  // already has a key, so the only open question is the name.
  await expect(page.getByTestId("onboarding-page-avatar")).toHaveCount(0);
  await expect(page.getByTestId("onboarding-next")).toBeDisabled();
});

test("saving a name finishes onboarding and enters the app", async ({
  page,
}) => {
  await seedActiveIdentity(page, BLANK_TYLER_IDENTITY);
  await installMockBridge(page, undefined, { skipOnboardingSeed: true });
  await page.goto("/");

  await page.getByTestId("onboarding-display-name").fill("Morty QA");
  await expect(page.getByTestId("onboarding-next")).toBeEnabled();
  await page.getByTestId("onboarding-next").click();

  await expect(page.getByTestId("onboarding-gate")).toHaveCount(0);
});

test("creating a community starts the founder walk at the company screen", async ({
  page,
}) => {
  // An identity that already exists and has no community: the account and
  // recovery screens are behind them, so the walk opens on the company
  // question and the counter counts only the screens they will see.
  await installMockBridge(page, undefined, { skipCommunitySeed: true });
  await page.goto("/");

  await expect(page.getByTestId("workspace-setup-gate")).toBeVisible();
  await page.getByTestId("community-choice-create").click();

  await expect(page.getByText("Now, your company.")).toBeVisible();
  // The company screen is this run's first screen, and the total counts only
  // what is coming: the account and recovery screens are behind them, invites
  // ship dark, and the brain screen appears only if the probe finds a tool
  // they already pay for. So the position is pinned and the total is not.
  await expect(page.getByTestId("onboarding-step-counter")).toHaveText(
    /^01 \/ 0[1-9]$/,
  );
  // The request is recorded, so a relaunch halfway through the walk resumes
  // it instead of dropping the person back on the choice screen.
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(window.localStorage).some((key) =>
          key.startsWith("colony.founder.run:"),
        ),
      ),
    )
    .toBe(true);
});

test("leaving the founder walk returns to the community choice", async ({
  page,
}) => {
  await installMockBridge(page, undefined, { skipCommunitySeed: true });
  await page.goto("/");

  await page.getByTestId("community-choice-create").click();
  await expect(page.getByText("Now, your company.")).toBeVisible();

  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("workspace-setup-gate")).toBeVisible();
  await expect(page.getByTestId("community-choice-create")).toBeVisible();
});

test("the photo control shares the profile emoji picker", async ({ page }) => {
  // Ported from the avatar step this screen replaced: the editor is shared
  // with Profile settings, so its controls have to keep their sizes wherever
  // it is opened from.
  await seedActiveIdentity(page, BLANK_TYLER_IDENTITY);
  await installMockBridge(page, undefined, { skipOnboardingSeed: true });
  await page.goto("/");

  await page.getByTestId("onboarding-profile-avatar").click();
  await expect(page.getByTestId("onboarding-avatar-editor")).toBeVisible();
  await page.getByRole("tab", { name: "Emoji" }).click();

  const picker = page.locator("em-emoji-picker");
  await expect(picker.locator("input[type='search']")).toBeVisible();
  await expectEmojiMartStylesInstalled(picker);
  // The old spec pinned the picker box to 384px, which was the deleted avatar
  // step's dialog height rather than anything about the control. What is
  // shared, and what actually broke when the stylesheet failed to load, is
  // the size of the controls inside it.
  await expect(
    page.getByTestId("onboarding-avatar-emoji-picker"),
  ).toBeVisible();

  const controlHeights = await picker.evaluate((element) => {
    const input = element.shadowRoot?.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    const toneControl =
      element.shadowRoot?.querySelector<HTMLElement>(".search + .flex");
    if (!input || !toneControl) {
      throw new Error("Onboarding emoji picker controls did not render.");
    }
    return {
      input: input.getBoundingClientRect().height,
      tone: toneControl.getBoundingClientRect().height,
    };
  });
  expect(controlHeights).toEqual({ input: 48, tone: 48 });
});

test("a chosen picture is kept on the same screen as the name", async ({
  page,
}) => {
  await seedActiveIdentity(page, BLANK_TYLER_IDENTITY);
  await installMockBridge(page, undefined, { skipOnboardingSeed: true });
  await page.goto("/");

  await page.getByTestId("onboarding-profile-avatar").click();
  await page
    .getByTestId("onboarding-avatar-url")
    .fill("https://example.com/onboarding-avatar.png");
  await page.getByTestId("onboarding-avatar-done").click();

  // No second screen to advance to: the photo is set and the name is still
  // the only thing the action waits on.
  await expect(page.getByTestId("onboarding-page-profile")).toBeVisible();
  await expect(page.getByTestId("onboarding-profile-avatar")).toHaveAttribute(
    "data-has-avatar",
    "true",
  );
  await expect(page.getByTestId("onboarding-next")).toBeDisabled();
});

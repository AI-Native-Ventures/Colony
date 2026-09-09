import { expect, test, type Page } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity, seedFreshFounder } from "../helpers/onboarding";

/**
 * The onboarding canvas has to survive the window it is actually given.
 *
 * `src-tauri/tauri.conf.json` sets the window minimum to 800x500, and a
 * 1280x720 laptop is the common case, so both are measured here rather than
 * assumed. Before this spec the account screen's Continue button ran from y
 * 660 to 718 in a 720-tall window: it touched the bottom edge, and the canvas
 * clipped instead of scrolling, so at 800x500 the button was simply gone with
 * nothing on screen saying so.
 *
 * Three things are asserted, on the account and company screens:
 *
 * 1. at 1280x720 the primary button's bottom clears the viewport bottom by at
 *    least 24px, and nothing needs scrolling;
 * 2. at 800x500 the story and form keep readable widths side by side
 *    without horizontal overflow;
 * 3. when the content is taller than the window the stage scrolls, a bottom
 *    fade says so, and the primary button is reachable.
 */

// A blank username means the mock bridge reports no kind:0 profile event for
// the active identity, which is what keeps the app-level onboarding gate open.
const FIRST_RUN_IDENTITY = { ...TEST_IDENTITIES.tyler, username: "" };

/** Clearance the primary action must keep below it in a 720-tall window. */
const BOTTOM_CLEARANCE_PX = 24;

/**
 * Answers that resume the flow straight onto the company screen.
 *
 * `resumeStep` reads these: an account and an acknowledged recovery code are
 * answered, and none of the company screen's three questions are. Walking the
 * screens before it by hand would measure the same layout while spending a
 * minute per viewport on screens this spec does not assert.
 *
 * The business form includes its editable description, so it is measured
 * beside account entry rather than splitting those fields across screens.
 */
const RESUMED_ONTO_COMPANY = JSON.stringify({
  account: { email: "aisha@rosebankauto.co.za" },
  founder: {
    fullName: "Aisha Bello",
    city: "Johannesburg",
    country: "South Africa",
    gender: null,
    selfDescribedGender: "",
    avatarUrl: "",
  },
  recoveryAcknowledged: true,
  company: null,
  track: null,
  brain: null,
  stage: null,
  hasWebsite: null,
  website: null,
  description: null,
  paid: false,
  communitySlug: null,
});

async function seedFreshFirstRun(
  page: Page,
  extraStorage: Record<string, string> = {},
) {
  await page.addInitScript((extra) => {
    for (const [key, value] of Object.entries(extra)) {
      window.localStorage.setItem(key, value);
    }
  }, extraStorage);
  await seedFreshFounder(page, FIRST_RUN_IDENTITY.pubkey);
  await seedActiveIdentity(page, FIRST_RUN_IDENTITY);
  await installMockBridge(page, undefined, {
    skipOnboardingSeed: true,
    skipCommunitySeed: true,
  });
}

/** Geometry of the one screen on the canvas, read in one round trip. */
async function readLayout(page: Page) {
  return page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>(".onb-stage");
    const headline = document.querySelector<HTMLElement>(".onb-simple-heading");
    const panel = document.querySelector<HTMLElement>(".onb-simple-card");
    if (!stage || !headline || !panel) {
      throw new Error("onboarding canvas is not on screen");
    }
    const headlineBox = headline.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rootFontSize: Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      ),
      documentWidth: document.documentElement.scrollWidth,
      scrollHeight: stage.scrollHeight,
      clientHeight: stage.clientHeight,
      headline: {
        x: headlineBox.x,
        y: headlineBox.y,
        width: headlineBox.width,
        height: headlineBox.height,
      },
      panel: { x: panelBox.x, y: panelBox.y, width: panelBox.width },
    };
  });
}

async function scrollStageToBottom(page: Page) {
  await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>(".onb-stage");
    if (!stage) throw new Error("no onboarding stage");
    stage.scrollTop = stage.scrollHeight;
    stage.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

/** Point 1: the whole screen fits a 1280x720 window with room under the action. */
async function assertFitsLaptopWindow(
  page: Page,
  screenName: string,
  action: string,
) {
  await page.setViewportSize({ width: 1280, height: 720 });
  const layout = await readLayout(page);
  const button = await page.getByRole("button", { name: action }).boundingBox();
  if (!button) throw new Error(`no primary button on the ${screenName} screen`);
  const clearance = layout.viewport.height - (button.y + button.height);
  expect(
    clearance,
    `${screenName} screen at 1280x720: primary button bottom is ${Math.round(
      button.y + button.height,
    )}, only ${Math.round(clearance)}px above the viewport bottom`,
  ).toBeGreaterThanOrEqual(BOTTOM_CLEARANCE_PX);
  expect(
    layout.scrollHeight - layout.clientHeight,
    `${screenName} screen at 1280x720 should not need scrolling`,
  ).toBeLessThanOrEqual(1);
}

/** Points 2 and 3: readable columns, a scroll cue, and a reachable action. */
async function assertColumnsAndScrollsAtMinimumWindow(
  page: Page,
  screenName: string,
  action: string,
) {
  await page.setViewportSize({ width: 800, height: 500 });
  const layout = await readLayout(page);

  expect(
    layout.panel.width,
    `${screenName} screen at 800 wide must retain a readable form column`,
  ).toBeGreaterThanOrEqual(19 * layout.rootFontSize);
  expect(layout.documentWidth).toBe(layout.viewport.width);
  expect(
    layout.panel.x,
    `${screenName} screen at 800 wide keeps the approved story and form beside each other`,
  ).toBeGreaterThanOrEqual(layout.headline.x + layout.headline.width);

  if (layout.scrollHeight > layout.clientHeight + 1) {
    await expect(
      page.getByTestId("onboarding-canvas-scroll-fade"),
      `${screenName} screen at 800x500 shows no bottom cue for its overflow`,
    ).toBeVisible();
  } else {
    await expect(page.getByTestId("onboarding-canvas-scroll-fade")).toHaveCount(
      0,
    );
  }

  await scrollStageToBottom(page);
  const button = await page.getByRole("button", { name: action }).boundingBox();
  if (!button) throw new Error(`no primary button on the ${screenName} screen`);
  expect(
    button.y,
    `${screenName} screen at 800x500: primary button is above the window after scrolling to the bottom`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    button.y + button.height,
    `${screenName} screen at 800x500: primary button is still below the window after scrolling to the bottom`,
  ).toBeLessThanOrEqual(500);
}

test("the account screen fits the window it is given", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await seedFreshFirstRun(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Create your account", exact: true }),
  ).toBeVisible();

  await assertFitsLaptopWindow(page, "account", "Create account");
  await assertColumnsAndScrollsAtMinimumWindow(
    page,
    "account",
    "Create account",
  );
});

test("the company screen fits the window it is given", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await seedFreshFirstRun(page, {
    [`colony.onboarding.answers.identity:${FIRST_RUN_IDENTITY.pubkey}`]:
      RESUMED_ONTO_COMPANY,
    [`buzz-machine-onboarding-complete.v2:${FIRST_RUN_IDENTITY.pubkey}`]:
      "true",
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your business" }),
  ).toBeVisible();

  await assertFitsLaptopWindow(page, "company", "Continue");
  await assertColumnsAndScrollsAtMinimumWindow(page, "company", "Continue");
});

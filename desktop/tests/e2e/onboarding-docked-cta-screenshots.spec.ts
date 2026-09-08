import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";
import { createFounderAccount } from "../helpers/simpleFounder";

const BLANK_TYLER_IDENTITY = {
  ...TEST_IDENTITIES.tyler,
  username: "",
};

const SHOT_DIR = "test-results/onboarding-docked-cta";
const NCRYPTSEC =
  "ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p";

test.use({ viewport: { width: 1280, height: 800 } });

test("machine onboarding: simple entry and account recovery", async ({
  page,
}) => {
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");

  const gate = page.getByTestId("machine-onboarding-gate");
  await expect(gate).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/01-landing.png` });

  await expect(
    page.getByRole("button", { name: "Create account", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // The sign-in door now opens the email sign-in page first; key import sits
  // behind its private-key detour.
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await page.getByTestId("signin-use-private-key").click();
  await expect(
    page.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();
  const importCard = page.getByTestId("nostr-import-card");
  await expect(importCard).toBeVisible();
  await expect(page.getByLabel("Private key", { exact: true })).toBeVisible();
  // Inside the onboarding canvas the card drops its nine-slice texture: over
  // a saturated field the texture read as a white smear, so the field is a
  // rule here like every other field in the flow.
  await expect(importCard).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(importCard).toHaveCSS("border-top-width", "0px");
  await expect(importCard).toHaveCSS("border-image-source", "none");
  // Icon SVGs (e.g. the reveal toggle) are fine. A filter here would mean the
  // card regressed to the runtime SVG texture pipeline, which measures and
  // regenerates on every resize; that must stay gone whatever the styling.
  await expect(importCard.locator("svg filter")).toHaveCount(0);
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/01b-enter-key.png` });

  await page.getByTestId("nostr-import-nsec-input").fill(NCRYPTSEC);
  await expect(
    page.getByRole("heading", { name: "Unlock your account" }),
  ).toBeVisible();
  await expect(page.getByTestId("backup-password-timeline")).toBeVisible();
  await expect(page.getByTestId("restore-ncryptsec-affordance")).toBeVisible();
  await expect(page.getByTestId("restore-unlock-icon")).toBeVisible();
  await expect(page.getByTestId("nostr-import-passphrase")).toBeFocused();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/01c-restore-backup.png` });

  // The first Back returns to key entry; the second returns to simple entry.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(importCard).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create account", exact: true }),
  ).toBeVisible();
  await createFounderAccount(page, "founder@recovery-example.test");
  await expect(page.getByTestId("machine-onboarding-gate")).toHaveCount(0);
  await expect(page.getByTestId("onboarding-page-backup")).toHaveCount(0);
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/02-account-recovery.png` });
});

/**
 * Every window the key-import and unlock screens have to survive. 1280x720 is
 * the smallest ordinary laptop window; 800x500 is the narrow-and-short corner
 * where the canvas grid has to stack. Both used to lay the card out below the
 * fold, and neither was covered: the old assertion only compared the input
 * against the heading and the footer, and `toBeVisible()` says nothing about
 * where in the window an element landed.
 */
const MACHINE_VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 800, height: 500 },
] as const;

/** Fails with the measured box rather than a bare boolean. */
function expectInsideViewport(
  label: string,
  box: { x: number; y: number; width: number; height: number } | null,
  viewport: { width: number; height: number },
) {
  expect(box, `${label} has no bounding box`).not.toBeNull();
  if (box === null) return;
  const inside =
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= viewport.width &&
    box.y + box.height <= viewport.height;
  expect(
    inside,
    `${label} must sit inside ${viewport.width}x${viewport.height}, measured ${JSON.stringify(box)}`,
  ).toBe(true);
}

for (const viewport of MACHINE_VIEWPORTS) {
  const size = `${viewport.width}x${viewport.height}`;

  test(`machine key import and unlock stay inside a ${size} window`, async ({
    page,
  }) => {
    // Reach key import before resizing so this test measures the existing
    // import/unlock layout; account geometry has its own coverage below.
    await page.setViewportSize({ width: 1280, height: 800 });
    await installMockBridge(page, undefined, {
      skipCommunitySeed: true,
      skipOnboardingSeed: true,
    });
    await page.goto("/");
    // Settle the entry before opening the existing-account detour.
    await waitForAnimations(page);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    // The sign-in door now opens the email sign-in page first; key import sits
    // behind its private-key detour.
    await expect(
      page.getByRole("heading", { name: "Welcome back." }),
    ).toBeVisible();
    await page.getByTestId("signin-use-private-key").click();
    await page.setViewportSize({ ...viewport });

    const heading = page.getByRole("heading", {
      name: "Enter your private key",
    });
    const input = page.getByLabel("Private key", { exact: true });
    const footer = page.getByTestId("onboarding-footer-slot");
    await expect(heading).toBeVisible();
    await expect(input).toBeVisible();
    await expect(footer).toBeVisible();
    // The headline slides in over 300ms; measuring through it reads a box that
    // is still 10px high of where it lands.
    await waitForAnimations(page);

    const nsecBox = await page
      .getByTestId("nostr-import-nsec-input")
      .boundingBox();
    const cardBox = await page.getByTestId("nostr-import-card").boundingBox();
    const panelBox = await page.locator(".onb-panel").boundingBox();
    expectInsideViewport("nsec input", nsecBox, viewport);
    expectInsideViewport("import card", cardBox, viewport);

    const layout = await page.evaluate(() => {
      const rect = (selector: string) =>
        document.querySelector(selector)?.getBoundingClientRect() ?? null;
      const headingRect = rect("h1");
      const inputRect = rect("#nostr-private-key");
      const footerRect = rect('[data-testid="onboarding-footer-slot"]');
      return {
        footerTop: footerRect?.top ?? 0,
        headingBottom: headingRect?.bottom ?? 0,
        headingRight: headingRect?.right ?? 0,
        inputBottom: inputRect?.bottom ?? 0,
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.documentElement.scrollHeight,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    // The CTA is docked over the canvas, so "inside the window" is not enough:
    // a field underneath it cannot be clicked into.
    expect(layout.inputBottom).toBeLessThanOrEqual(layout.footerTop);
    expect(layout.scrollHeight).toBeGreaterThanOrEqual(viewport.height);
    expect(layout.scrollWidth).toBe(layout.clientWidth);

    if (viewport.width > 900) {
      // Two columns: the form sits in the right column, clear of the headline,
      // and that column has to be wide enough to be a form.
      expect(panelBox?.x ?? 0).toBeGreaterThanOrEqual(layout.headingRight);
      expect(panelBox?.width ?? 0).toBeGreaterThanOrEqual(420);
    } else {
      // One column: the panel stacks under the headline instead of squeezing
      // beside it.
      expect(panelBox?.y ?? 0).toBeGreaterThan(layout.headingBottom);
    }

    // Unlock: pasting an encrypted backup swaps the same screen to the
    // passphrase stage, which had been pushing its heading off the top of the
    // window and collapsing the timeline to a sliver against the right edge.
    await page.getByTestId("nostr-import-nsec-input").fill(NCRYPTSEC);
    await expect(
      page.getByRole("heading", { name: "Unlock your account" }),
    ).toBeVisible();
    await waitForAnimations(page);

    const unlockHeadingBox = await page
      .getByRole("heading", { name: "Unlock your account" })
      .boundingBox();
    expect(unlockHeadingBox?.y ?? -1).toBeGreaterThanOrEqual(0);
    expectInsideViewport("unlock heading", unlockHeadingBox, viewport);

    const passphraseBox = await page
      .getByTestId("nostr-import-passphrase")
      .boundingBox();
    expectInsideViewport("passphrase input", passphraseBox, viewport);
    expect(passphraseBox?.width ?? 0).toBeGreaterThanOrEqual(360);

    // The decorative timeline hides itself under 40rem of height, so it is
    // only measurable on the taller window.
    const timeline = page.getByTestId("backup-password-timeline");
    if (await timeline.isVisible()) {
      const timelineBox = await timeline.boundingBox();
      expectInsideViewport("password timeline", timelineBox, viewport);
      expect(timelineBox?.width ?? 0).toBeGreaterThanOrEqual(360);
    }
  });
}

test("simple account entry keeps one-column geometry on narrow windows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 700 });
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");
  const account = page.getByTestId("onboarding-account");
  await expect(account).toBeVisible();
  await expect(
    account.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  const controls = account.locator(
    'input[type="email"], input[type="password"], button[type="submit"]',
  );
  await expect(controls).toHaveCount(3);
  await waitForAnimations(page);
  const geometry = await controls.evaluateAll((elements) => {
    const boxes = elements.map((element) => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        center: box.left + box.width / 2,
      };
    });
    return {
      boxes,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  for (let index = 1; index < geometry.boxes.length; index += 1) {
    expect(
      Math.abs(geometry.boxes[index].center - geometry.boxes[0].center),
    ).toBeLessThan(1);
    expect(geometry.boxes[index].top).toBeGreaterThan(
      geometry.boxes[index - 1].bottom,
    );
  }
  expect(
    geometry.boxes.every(
      (box) => box.left >= 0 && box.right <= geometry.clientWidth,
    ),
  ).toBe(true);
  expect(geometry.scrollWidth).toBe(geometry.clientWidth);
});

test("relay onboarding: the profile screen and its action", async ({
  page,
}) => {
  await seedActiveIdentity(page, BLANK_TYLER_IDENTITY);
  await installMockBridge(page, undefined, { skipOnboardingSeed: true });
  await page.goto("/");

  // Name and photo are one screen now, so there is one shot where there were
  // two, and the action sits on the canvas rather than in a docked footer.
  await expect(page.getByTestId("onboarding-page-profile")).toBeVisible();
  await page.getByTestId("onboarding-display-name").fill("Ada Lovelace");
  await expect(page.getByTestId("onboarding-next")).toBeEnabled();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOT_DIR}/04-profile.png` });
});

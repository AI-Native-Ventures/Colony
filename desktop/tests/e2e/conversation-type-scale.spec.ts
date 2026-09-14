import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

/**
 * `message-body` is the container; the prose itself is `.message-markdown`
 * inside it, which is where the type token lands.
 *
 * Colony styles chat text twice: through Tailwind tokens, and again through
 * `globals/conversation-appearance.css`, whose `:root[data-buzz-sidebar]`
 * rules outrank the utilities on the author and role lines.
 *
 * Since #5644 the root stays at 16px and text scales through
 * `--buzz-type-rem`, so any size still written in real `rem` would freeze at
 * every zoom step and ignore the Font size preference. These cases pin both
 * surfaces to the virtual rem.
 */

const TYPE_REM_DEFAULT = 16;
const MESSAGE_RATIO = 0.875;
const AUTHOR_RATIO = 0.8125;

async function seedTextScale(
  page: import("@playwright/test").Page,
  scale: number,
) {
  await page.addInitScript((value) => {
    window.localStorage.setItem("buzz:text-scale", String(value));
  }, scale);
}

async function seedFontSize(
  page: import("@playwright/test").Page,
  size: string,
) {
  await page.addInitScript((value) => {
    window.localStorage.setItem("buzz.appearance.fontSize", value);
  }, size);
}

async function openGeneral(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
}

function fontSizePx(locator: import("@playwright/test").Locator) {
  return locator
    .first()
    .evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize),
    );
}

test("chat body and author text follow the virtual type rem", async ({
  page,
}) => {
  await installMockBridge(page);
  await openGeneral(page);

  const body = page.getByTestId("message-body").locator(".message-markdown");
  const author = page.getByTestId("message-author");
  await expect(body.first()).toBeVisible();

  expect(await fontSizePx(body)).toBeCloseTo(
    TYPE_REM_DEFAULT * MESSAGE_RATIO,
    1,
  );
  expect(await fontSizePx(author)).toBeCloseTo(
    TYPE_REM_DEFAULT * AUTHOR_RATIO,
    1,
  );
});

test("Cmd +/- text zoom scales chat text without moving the root font size", async ({
  page,
}) => {
  await installMockBridge(page);
  await seedTextScale(page, 1.5);
  await openGeneral(page);

  const body = page.getByTestId("message-body").locator(".message-markdown");
  await expect(body.first()).toBeVisible();

  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--buzz-type-rem")
          .trim(),
      ),
    )
    .toBe("24px");
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize,
    ),
  ).toBe("16px");

  expect(await fontSizePx(body)).toBeCloseTo(24 * MESSAGE_RATIO, 1);
  // Colony's own appearance sheet owns this one, so it is the case that
  // catches a size left in real rem.
  expect(await fontSizePx(page.getByTestId("message-author"))).toBeCloseTo(
    24 * AUTHOR_RATIO,
    1,
  );
});

test("the larger Font size preference grows the same text", async ({
  page,
}) => {
  await installMockBridge(page);
  await seedFontSize(page, "larger");
  await openGeneral(page);

  const body = page.getByTestId("message-body").locator(".message-markdown");
  await expect(body.first()).toBeVisible();

  const typeRem = 15 / MESSAGE_RATIO;
  expect(await fontSizePx(body)).toBeCloseTo(15, 1);
  expect(await fontSizePx(page.getByTestId("message-author"))).toBeCloseTo(
    typeRem * AUTHOR_RATIO,
    1,
  );
});

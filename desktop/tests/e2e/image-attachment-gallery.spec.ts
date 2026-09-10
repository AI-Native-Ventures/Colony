import { expect, type Page, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

import { installMockBridge } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

const IMAGE_SHAS = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
const SPOILER_VISIBLE_SHA = "d".repeat(64);
const SPOILER_HIDDEN_SHA = "e".repeat(64);
const SPOILER_VISIBLE_URL = `http://localhost:3000/media/${SPOILER_VISIBLE_SHA}.png`;
const SPOILER_HIDDEN_URL = `http://localhost:3000/media/${SPOILER_HIDDEN_SHA}.png`;
const NO_DIM_WIDE_URL = "https://example.com/e2e/gallery-wide.png";
const NO_DIM_PORTRAIT_URL = "https://example.com/e2e/gallery-portrait.png";
const NO_DIM_SECOND_URL = "https://example.com/e2e/gallery-second.png";
const PROGRESSIVE_URL = "https://example.com/e2e/progressive-full.png";
const PROGRESSIVE_THUMB_URL = "https://example.com/e2e/progressive-thumb.jpg";

async function waitForMockLiveSubscription(page: Page, channelName: string) {
  await expect
    .poll(async () => {
      return page.evaluate((name) => {
        return (
          (
            window as Window & {
              __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
                channelName: string;
              }) => boolean;
            }
          ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
            channelName: name,
          }) ?? false
        );
      }, channelName);
    })
    .toBe(true);
}

function imageImetaTag({
  dim,
  filename,
  sha,
  thumb,
  url,
}: {
  dim: string;
  filename: string;
  sha: string;
  thumb?: string;
  url: string;
}) {
  return [
    "imeta",
    `url ${url}`,
    "m image/png",
    `x ${sha}`,
    "size 1234",
    `dim ${dim}`,
    `filename ${filename}`,
    ...(thumb ? [`thumb ${thumb}`] : []),
  ];
}

async function installNoDimImageRoutes(page: Page) {
  await page.route(
    /^https:\/\/example\.com\/e2e\/gallery-[^/]+\.png(?:\?.*)?$/,
    (route) => {
      const requestedUrl = route.request().url();
      const isPortrait = requestedUrl.includes("portrait");
      const isSecond = requestedUrl.includes("second");
      const width = isPortrait ? 120 : 320;
      const height = isPortrait ? 320 : 120;
      const fill = isSecond ? "#a78bfa" : isPortrait ? "#f4b860" : "#4aa3df";
      route.fulfill({
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${fill}"/></svg>`,
        contentType: "image/svg+xml",
      });
    },
  );
}

async function getLightboxFrameBox(page: Page) {
  const box = await page.locator("[data-image-lightbox-frame]").boundingBox();
  if (!box) {
    throw new Error("Expected lightbox frame to have a layout box");
  }
  return box;
}

test.beforeEach(async ({ page }) => {
  // Real image bytes keep loading/click/copy proof distinct from broken-image boxes.
  const fixtures = new Map([
    [IMAGE_SHAS[0], "first"],
    [IMAGE_SHAS[1], "second"],
    [IMAGE_SHAS[2], "third"],
    [SPOILER_VISIBLE_SHA, "visible"],
    [SPOILER_HIDDEN_SHA, "hidden"],
  ]);
  await page.route("**/media/*.png", async (route) => {
    const sha =
      new URL(route.request().url()).pathname
        .split("/")
        .pop()
        ?.replace(/\.png$/, "") ?? "";
    const fixture = fixtures.get(sha);
    if (!fixture) return route.continue();
    await route.fulfill({
      path: fileURLToPath(
        new URL(`../fixtures/image-gallery/${fixture}.png`, import.meta.url),
      ),
      contentType: "image/png",
    });
  });
  await installMockBridge(page, {
    uploadDescriptors: [
      {
        url: `http://localhost:3000/media/${IMAGE_SHAS[0]}.png`,
        sha256: IMAGE_SHAS[0],
        size: 1234,
        type: "image/png",
        uploaded: Math.floor(Date.now() / 1000),
        dim: "160x100",
        filename: "first.png",
      },
      {
        url: `http://localhost:3000/media/${IMAGE_SHAS[1]}.png`,
        sha256: IMAGE_SHAS[1],
        size: 2345,
        type: "image/png",
        uploaded: Math.floor(Date.now() / 1000),
        dim: "100x160",
        filename: "second.png",
      },
      {
        url: `http://localhost:3000/media/${IMAGE_SHAS[2]}.png`,
        sha256: IMAGE_SHAS[2],
        size: 3456,
        type: "image/png",
        uploaded: Math.floor(Date.now() / 1000),
        dim: "140x140",
        filename: "third.png",
      },
    ],
  });
});

test("image bundle lightbox navigates as a gallery", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  await page.getByTestId("message-input").fill("gallery bundle");
  await page.getByRole("button", { name: "Attach file" }).click();
  await page.getByTestId("send-message").click();
  await expect(page.getByText("Sending")).toHaveCount(0);

  const row = page
    .getByTestId("message-row")
    .filter({ hasText: "gallery bundle" })
    .last();
  await expect(row).toBeVisible();

  const carousel = row.getByRole("region", { name: "Image carousel" });
  const trigger = carousel.getByTestId("message-image-lightbox-trigger");
  await expect(trigger).toHaveCount(1);
  await expect(carousel.getByTestId("media-preview-count")).toHaveText("1 / 3");
  await expect(trigger.locator("img")).toHaveJSProperty("naturalWidth", 160);
  await expect(trigger.locator("img")).toHaveCSS("object-fit", "contain");
  const inlineBox = await trigger.boundingBox();
  const carouselBox = await carousel.boundingBox();
  if (!inlineBox || !carouselBox) throw new Error("Expected carousel layout");
  expect(Math.abs(inlineBox.width - carouselBox.width)).toBeLessThanOrEqual(2);
  await trigger.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(`img[src*="${IMAGE_SHAS[0]}"]`)).toHaveJSProperty(
    "naturalWidth",
    160,
  );
  await expect(
    dialog.getByRole("button", { name: "Previous image" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Next image" }).click();
  await expect(dialog.locator(`img[src*="${IMAGE_SHAS[1]}"]`)).toHaveJSProperty(
    "naturalHeight",
    160,
  );
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByTestId("media-preview-count")).toHaveText("3 / 3");
  await expect(dialog.locator(`img[src*="${IMAGE_SHAS[2]}"]`)).toHaveCSS(
    "object-fit",
    "contain",
  );
  await expect(
    dialog.getByRole("button", { name: "Next image" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(carousel.getByTestId("media-preview-count")).toHaveText("3 / 3");
  await expect(trigger).toBeFocused();
  const returnedBox = await trigger.boundingBox();
  expect(returnedBox?.width).toBeCloseTo(inlineBox.width, 0);
  expect(returnedBox?.height).toBeCloseTo(inlineBox.height, 0);
});

test("hidden spoiler images are excluded from gallery navigation until revealed", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");

  await page.evaluate(
    ({ content, extraTags }) => {
      (
        window as Window & {
          __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
            channelName: string;
            content: string;
            extraTags?: string[][];
          }) => unknown;
        }
      ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content,
        extraTags,
      });
    },
    {
      content: [
        "spoiler gallery",
        `![visible](${SPOILER_VISIBLE_URL})`,
        `||![hidden](${SPOILER_HIDDEN_URL})||`,
      ].join("\n"),
      extraTags: [
        imageImetaTag({
          dim: "160x100",
          filename: "visible.png",
          sha: SPOILER_VISIBLE_SHA,
          url: SPOILER_VISIBLE_URL,
        }),
        imageImetaTag({
          dim: "100x160",
          filename: "hidden.png",
          sha: SPOILER_HIDDEN_SHA,
          url: SPOILER_HIDDEN_URL,
        }),
      ],
    },
  );

  const row = page
    .getByTestId("message-row")
    .filter({ hasText: "spoiler gallery" })
    .last();
  await expect(row).toBeVisible();

  await row.locator(`img[src*="${SPOILER_VISIBLE_SHA}"]`).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Next image" }),
  ).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  const spoiler = row.locator(".buzz-spoiler[data-spoiler]").first();
  await expect(spoiler).toHaveAttribute("data-revealed", "false");
  await spoiler.click();
  await expect(spoiler).toHaveAttribute("data-revealed", "true");

  await row.locator(`img[src*="${SPOILER_VISIBLE_SHA}"]`).click();
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Next image" }),
  ).toBeVisible();
});

// Regression guard for the CI-only flake where the gallery froze at one image
// after a reveal. The reveal flips data-revealed instantly, but the content
// fades in over 500ms starting from computed opacity 0. A click that lands on
// the first animation frame (a busy runner stalls exactly like this) used to
// hit the gallery builder's opacity===0 exclusion, and membership is captured
// once per lightbox open, so "Next image" stayed absent for the dialog's whole
// life. Pinning the content at opacity 0 makes that frame deterministic:
// membership must follow the reveal state, not the paint state.
test("a just-revealed spoiler image joins the gallery before its fade-in paints", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");

  await page.evaluate(
    ({ content, extraTags }) => {
      (
        window as Window & {
          __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
            channelName: string;
            content: string;
            extraTags?: string[][];
          }) => unknown;
        }
      ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content,
        extraTags,
      });
    },
    {
      content: [
        "spoiler first frame",
        `![visible](${SPOILER_VISIBLE_URL})`,
        `||![hidden](${SPOILER_HIDDEN_URL})||`,
      ].join("\n"),
      extraTags: [
        imageImetaTag({
          dim: "160x100",
          filename: "visible.png",
          sha: SPOILER_VISIBLE_SHA,
          url: SPOILER_VISIBLE_URL,
        }),
        imageImetaTag({
          dim: "100x160",
          filename: "hidden.png",
          sha: SPOILER_HIDDEN_SHA,
          url: SPOILER_HIDDEN_URL,
        }),
      ],
    },
  );

  const row = page
    .getByTestId("message-row")
    .filter({ hasText: "spoiler first frame" })
    .last();
  await expect(row).toBeVisible();

  const spoiler = row.locator(".buzz-spoiler[data-spoiler]").first();
  await spoiler.click();
  await expect(spoiler).toHaveAttribute("data-revealed", "true");

  // Hold the reveal animation at its first frame.
  await spoiler.evaluate((element) => {
    element.querySelectorAll(".buzz-spoiler__content").forEach((content) => {
      (content as HTMLElement).style.opacity = "0";
      content.querySelectorAll("*").forEach((child) => {
        (child as HTMLElement).style.opacity = "0";
      });
    });
  });

  await row.locator(`img[src*="${SPOILER_VISIBLE_SHA}"]`).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Next image" }),
  ).toBeVisible();
});

test("message images load a thumbnail before requesting the original", async ({
  page,
}) => {
  let fullRequested = false;
  let releaseThumbnail: (() => void) | undefined;
  let releaseFull: (() => void) | undefined;
  const thumbnailGate = new Promise<void>((resolve) => {
    releaseThumbnail = resolve;
  });
  const fullGate = new Promise<void>((resolve) => {
    releaseFull = resolve;
  });
  const svg = (fill: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="100%" height="100%" fill="${fill}"/></svg>`;

  await page.route(PROGRESSIVE_THUMB_URL, async (route) => {
    await thumbnailGate;
    await route.fulfill({ body: svg("#f4b860"), contentType: "image/svg+xml" });
  });
  await page.route(PROGRESSIVE_URL, async (route) => {
    fullRequested = true;
    await fullGate;
    await route.fulfill({ body: svg("#4aa3df"), contentType: "image/svg+xml" });
  });

  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await waitForMockLiveSubscription(page, "general");
  await page.evaluate(
    ({ content, extraTags }) => {
      (
        window as Window & {
          __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
            channelName: string;
            content: string;
            extraTags: string[][];
          }) => unknown;
        }
      ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content,
        extraTags,
      });
    },
    {
      content: `progressive image\n![progressive](${PROGRESSIVE_URL})`,
      extraTags: [
        imageImetaTag({
          dim: "320x200",
          filename: "progressive.png",
          sha: "f".repeat(64),
          thumb: PROGRESSIVE_THUMB_URL,
          url: PROGRESSIVE_URL,
        }),
      ],
    },
  );

  const row = page
    .getByTestId("message-row")
    .filter({ hasText: "progressive image" })
    .last();
  const trigger = row.getByTestId("message-image-lightbox-trigger");
  await expect(
    trigger.locator(`img[src="${PROGRESSIVE_THUMB_URL}"]`),
  ).toHaveCount(1);
  await expect(trigger.locator(`img[src="${PROGRESSIVE_URL}"]`)).toHaveCount(0);
  expect(fullRequested).toBe(false);
  const before = await trigger.boundingBox();
  const rowBefore = await row.boundingBox();

  releaseThumbnail?.();
  const full = trigger.locator(`img[src="${PROGRESSIVE_URL}"]`);
  await expect(full).toHaveCount(1);
  await expect(full).toHaveClass(/opacity-0/);
  expect(fullRequested).toBe(true);
  releaseFull?.();
  await expect(full).toBeVisible();
  await expect(full).not.toHaveClass(/opacity-0/);
  expect(await trigger.boundingBox()).toEqual(before);
  expect(await row.boundingBox()).toEqual(rowBefore);
});

test("carousel images without imeta retain their intrinsic geometry without cropping", async ({
  page,
}) => {
  await installNoDimImageRoutes(page);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");

  await page.evaluate(
    ({ content }) => {
      (
        window as Window & {
          __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
            channelName: string;
            content: string;
          }) => unknown;
        }
      ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content,
      });
    },
    {
      content: [
        "no dim gallery",
        `![wide](${NO_DIM_WIDE_URL})`,
        `![portrait](${NO_DIM_PORTRAIT_URL})`,
      ].join("\n"),
    },
  );

  const row = page
    .getByTestId("message-row")
    .filter({ hasText: "no dim gallery" })
    .last();
  await expect(row).toBeVisible();
  const stage = row.getByTestId("message-image-lightbox-trigger");
  await expect(stage.locator(`img[src="${NO_DIM_WIDE_URL}"]`)).toBeVisible();
  await expect(stage.locator(`img[src="${NO_DIM_PORTRAIT_URL}"]`)).toHaveCount(
    0,
  );

  await stage.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(`img[src="${NO_DIM_WIDE_URL}"]`)).toBeVisible();
  await page.waitForTimeout(350);
  const wideFrameBox = await getLightboxFrameBox(page);
  await expect(
    dialog.locator(`img[src="${NO_DIM_WIDE_URL}"]`),
  ).toHaveJSProperty("naturalWidth", 320);
  await expect(dialog.locator("img")).toHaveCSS("object-fit", "contain");

  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Next image" })
    .click();
  await expect(
    dialog.locator(`img[src="${NO_DIM_PORTRAIT_URL}"]`),
  ).toBeVisible();
  await page.waitForTimeout(350);
  const portraitFrameBox = await getLightboxFrameBox(page);
  await expect(
    dialog.locator(`img[src="${NO_DIM_PORTRAIT_URL}"]`),
  ).toHaveJSProperty("naturalHeight", 320);
  await expect(dialog.locator("img")).toHaveCSS("object-fit", "contain");
  expect(portraitFrameBox.width).toBeCloseTo(wideFrameBox.width, 0);
  expect(portraitFrameBox.height).toBeCloseTo(wideFrameBox.height, 0);
});

test("forum markdown images use the markdown root as their gallery scope", async ({
  page,
}) => {
  await installNoDimImageRoutes(page);
  await page.goto("/");
  await expect
    .poll(() => {
      return page.evaluate(() => {
        return (
          typeof (
            window as Window & {
              __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: unknown;
            }
          ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__ === "function"
        );
      });
    })
    .toBe(true);

  const postId = await page.evaluate(
    ({ content }) => {
      const event = (
        window as Window & {
          __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
            channelName: string;
            content: string;
            kind: number;
          }) => { id: string };
        }
      ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "watercooler",
        content,
        kind: 45001,
      });
      return event?.id ?? null;
    },
    {
      content: [
        "forum gallery scope",
        `![wide](${NO_DIM_WIDE_URL})`,
        `![portrait](${NO_DIM_PORTRAIT_URL})`,
      ].join("\n"),
    },
  );
  expect(postId).not.toBeNull();

  await page.getByTestId("channel-watercooler").click();
  await expect(page.getByTestId("chat-title")).toHaveText("watercooler");

  await page
    .getByRole("button")
    .filter({ hasText: "forum gallery scope" })
    .first()
    .getByText("forum gallery scope")
    .click();

  const threadPost = page.locator(`[data-forum-event-id="${postId}"]`);
  await expect(threadPost).toBeVisible();
  const triggers = threadPost.getByTestId("message-image-lightbox-trigger");
  await expect(triggers).toHaveCount(1);
  await expect
    .poll(() =>
      triggers.first().evaluate((trigger) => {
        return trigger.closest("[data-testid='message-row']") !== null;
      }),
    )
    .toBe(false);

  await triggers.first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(`img[src="${NO_DIM_WIDE_URL}"]`)).toBeVisible();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Previous image" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Next image" }),
  ).toBeVisible();

  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Next image" })
    .click();
  await expect(
    dialog.locator(`img[src="${NO_DIM_PORTRAIT_URL}"]`),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Previous image" }),
  ).toBeVisible();
});

test("multi-image carousels fill the message width with stable contained stages", async ({
  page,
}) => {
  await installNoDimImageRoutes(page);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");

  const urls = Array.from(
    { length: 5 },
    (_, index) =>
      `https://example.com/e2e/gallery-${index % 2 === 0 ? "wide" : "portrait"}.png?item=${index}`,
  );

  await page.evaluate((imageUrls) => {
    const emit = (
      window as Window & {
        __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
          channelName: string;
          content: string;
        }) => unknown;
      }
    ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__;

    for (const count of [2, 4, 5]) {
      emit?.({
        channelName: "general",
        content: [
          `${count} image carousel`,
          ...imageUrls.slice(0, count).map((url) => `![image](${url})`),
        ].join("\n"),
      });
    }
  }, urls);

  const carousels: Array<{ count: number; height: number; width: number }> = [];
  for (const count of [2, 4, 5]) {
    const row = page
      .getByTestId("message-row")
      .filter({ hasText: `${count} image carousel` })
      .last();
    const carousel = row.getByTestId("media-image-preview");
    await expect(carousel.getByTestId("media-preview-count")).toHaveText(
      `1 / ${count}`,
    );
    await expect(
      carousel.getByTestId("message-image-lightbox-trigger").locator("img"),
    ).toHaveCount(1);
    await expect(
      carousel.getByTestId("message-image-lightbox-trigger").locator("img"),
    ).toHaveCSS("object-fit", "contain");
    await expect(
      carousel.getByTestId("message-image-lightbox-trigger").locator("img"),
    ).toHaveJSProperty("naturalWidth", 320);
    // Wait for an actual layout, then compare equal stages across item counts.
    let box: Awaited<ReturnType<typeof carousel.boundingBox>> = null;
    await expect
      .poll(async () => {
        box = await carousel.boundingBox();
        return box !== null && box.height > 0 && box.width > 0;
      })
      .toBe(true);
    if (!box) throw new Error(`Expected ${count}-image carousel layout box`);
    carousels.push({ count, height: box.height, width: box.width });
  }

  expect(carousels[0].width).toBeCloseTo(carousels[1].width, 0);
  expect(carousels[1].width).toBeCloseTo(carousels[2].width, 0);
  expect(carousels[1].height).toBeCloseTo(carousels[0].height, 0);
  expect(carousels[2].height).toBeCloseTo(carousels[1].height, 0);
});

test("image carousel screenshot", async ({ page }) => {
  await installNoDimImageRoutes(page);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");

  await page.evaluate(
    ({ portraitUrl, secondUrl, wideUrl }) => {
      (
        window as Window & {
          __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
            channelName: string;
            content: string;
          }) => unknown;
        }
      ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content: [
          "Weekend photo dump",
          `![Coastal overlook](${wideUrl})`,
          `![Boardwalk detail](${portraitUrl})`,
          `![Golden hour](${secondUrl})`,
        ].join("\n"),
      });
    },
    {
      portraitUrl: NO_DIM_PORTRAIT_URL,
      secondUrl: NO_DIM_SECOND_URL,
      wideUrl: NO_DIM_WIDE_URL,
    },
  );

  const row = page
    .getByTestId("message-row")
    .filter({ hasText: "Weekend photo dump" })
    .last();
  await expect(
    row.getByTestId("message-image-lightbox-trigger").locator("img"),
  ).toHaveCount(1);
  await expect(row.getByTestId("media-preview-count")).toHaveText("1 / 3");
  await waitForAnimations(page);
  await row.screenshot({
    path: "test-results/image-carousel/three-image-carousel.png",
  });
});

test("carousel image context menu is portaled outside the clipped gallery", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  await page.getByTestId("message-input").fill("carousel context menu");
  await page.getByRole("button", { name: "Attach file" }).click();
  await page.getByTestId("send-message").click();
  await expect(page.getByText("Sending")).toHaveCount(0);

  const row = page
    .getByTestId("message-row")
    .filter({ hasText: "carousel context menu" })
    .last();
  const carousel = row.getByTestId("media-image-preview");
  const trigger = row.getByTestId("message-image-lightbox-trigger").last();
  await expect(carousel).toBeVisible();
  const triggerBox = await trigger.boundingBox();
  if (!triggerBox) throw new Error("Expected image trigger layout");
  await trigger.click({
    button: "right",
    position: { x: triggerBox.width - 8, y: triggerBox.height / 2 },
  });

  const menu = page.locator("[data-image-context-menu]");
  await expect(menu).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy image" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download image" }),
  ).toBeVisible();
  await expect(carousel.locator("[data-image-context-menu]")).toHaveCount(0);
  expect(
    await menu.evaluate((element) => element.parentElement === document.body),
  ).toBe(true);

  const carouselBox = await carousel.boundingBox();
  const menuBox = await menu.boundingBox();
  if (!carouselBox || !menuBox) {
    throw new Error("Expected carousel and image context menu layout boxes");
  }
  expect(menuBox.x + menuBox.width).toBeGreaterThan(
    carouselBox.x + carouselBox.width,
  );
});

test("lightbox image context menu stays inside the dialog focus scope", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  await page.getByTestId("message-input").fill("lightbox context menu");
  await page.getByRole("button", { name: "Attach file" }).click();
  await page.getByTestId("send-message").click();
  await expect(page.getByText("Sending")).toHaveCount(0);

  const row = page
    .getByTestId("message-row")
    .filter({ hasText: "lightbox context menu" })
    .last();
  await row.getByTestId("message-image-lightbox-trigger").first().click();

  const dialog = page.getByRole("dialog");
  const lightboxImage = dialog.locator(`img[src*="${IMAGE_SHAS[0]}"]`);
  await expect(lightboxImage).toBeVisible();
  const nextButton = dialog.getByRole("button", { name: "Next image" });
  await expect(nextButton).toBeFocused();
  await lightboxImage.click({ button: "right" });

  const menu = dialog.locator("[data-image-context-menu]");
  const copyButton = menu.getByRole("button", { name: "Copy image" });
  const downloadButton = menu.getByRole("button", { name: "Download image" });
  await expect(menu).toBeVisible();
  await expect(page.locator("body > [data-image-context-menu]")).toHaveCount(0);
  await expect(copyButton).toBeVisible();
  await expect(downloadButton).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }),
  ).toBeVisible();

  // Radix follows the DOM tab order, including the portaled menu and Close.
  const tabStops = dialog.locator("button:not([disabled])");
  await expect(tabStops).toHaveCount(5);
  await expect(tabStops.first()).toHaveAttribute("aria-label", "Next image");
  await nextButton.focus();
  for (let position = 1; position < 5; position += 1) {
    await page.keyboard.press("Tab");
    await expect(tabStops.nth(position)).toBeFocused();
  }
  await page.keyboard.press("Tab");
  await expect(nextButton).toBeFocused();
  for (let position = 4; position >= 0; position -= 1) {
    await page.keyboard.press("Shift+Tab");
    await expect(tabStops.nth(position)).toBeFocused();
  }
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    row.getByTestId("message-image-lightbox-trigger").first(),
  ).toBeFocused();
});

test("right-click image shows Copy image and invokes copy command", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  await page.getByTestId("message-input").fill("copy me");
  await page.getByRole("button", { name: "Attach file" }).click();
  await page.getByTestId("send-message").click();
  await expect(page.getByText("Sending")).toHaveCount(0);

  const row = page
    .getByTestId("message-row")
    .filter({ hasText: "copy me" })
    .last();
  const trigger = row.getByTestId("message-image-lightbox-trigger").first();
  await expect(trigger).toBeVisible();

  await trigger.click({ button: "right" });

  const copyButton = page.getByRole("button", { name: "Copy image" });
  await expect(copyButton).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download image" }),
  ).toBeVisible();

  // The image menu carries the shared generic marker plus its own image-
  // specific attribute, and never the link/video attributes — so e2e locators
  // can target one surface without aliasing another.
  await expect(page.locator("[data-media-context-menu]")).toBeVisible();
  await expect(page.locator("[data-image-context-menu]")).toBeVisible();
  await expect(page.locator("[data-link-context-menu]")).toHaveCount(0);
  await expect(page.locator("[data-video-context-menu]")).toHaveCount(0);

  await copyButton.click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __BUZZ_E2E_COMMANDS__?: string[] })
            .__BUZZ_E2E_COMMANDS__ ?? [],
      ),
    )
    .toContain("copy_image_to_clipboard");
});

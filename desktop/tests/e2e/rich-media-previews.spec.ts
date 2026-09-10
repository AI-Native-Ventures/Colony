import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";
import { mediaFixtureRange } from "../helpers/mediaFixtureRange";

// Match the real relay's SVG headers while exercising Chromium's image loader.
// The real Rust upload/GET/Range round trip is covered by e2e_media_extended.
async function installMediaFixtures(page: Page) {
  const responses: Array<{ filename: string; status: number }> = [];
  await page.route("**/rich-previews/launch-0*.svg", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop() || "";
    if (!/^launch-0[123]\.svg$/.test(name)) return route.continue();
    await route.fulfill({
      path: fileURLToPath(
        new URL(`../../public/rich-previews/${name}`, import.meta.url),
      ),
      contentType: "image/svg+xml",
      headers: {
        "content-disposition": "attachment",
        "content-security-policy": "default-src 'none'",
        "x-content-type-options": "nosniff",
      },
    });
  });
  // Python's static CI server has no Range support. Use the real fixture bytes
  // with the same 206/Content-Range contract as the relay/native media proxy.
  for (const [filename, contentType] of [
    ["preview-audio.wav", "audio/wav"],
    ["preview-video.mp4", "video/mp4"],
  ]) {
    const bytes = await readFile(
      new URL(`../../public/rich-previews/${filename}`, import.meta.url),
    );
    await page.route(`**/rich-previews/${filename}`, async (route) => {
      const response = mediaFixtureRange(
        bytes,
        route.request().headers().range,
      );
      responses.push({ filename, status: response.status });
      await route.fulfill({ ...response, contentType });
    });
  }
  return responses;
}

async function seedAppearance(page: Page, theme: "buzz" | "buzz-dark") {
  await page.addInitScript((value) => {
    localStorage.setItem("buzz-theme", value);
    localStorage.setItem("buzz-follow-system", "false");
    localStorage.setItem("buzz-accent-color", "#895AF6");
    localStorage.setItem("buzz.channels.threadViewMode", "split");
    sessionStorage.setItem("buzz.desktop.thread-panel-width", "400");
  }, theme);
}

async function openGallery(page: Page) {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("profile-popover-settings").click();
  await page.getByTestId("settings-nav-blocks").click();
  await page.getByRole("tab", { name: "Examples", exact: true }).click();
  const gallery = page.getByTestId("rich-preview-gallery");
  await expect(gallery).toBeVisible();
  return gallery;
}

for (const theme of ["buzz", "buzz-dark"] as const) {
  test(`rich media gallery: original images, playback and downloads in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await seedAppearance(page, theme);
    const mediaResponses = await installMediaFixtures(page);
    await installMockBridge(page);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute(
      "data-buzz-theme",
      theme,
    );
    const gallery = await openGallery(page);
    await gallery.getByRole("tab", { name: "Images", exact: true }).click();
    const singleImage = gallery
      .getByRole("region", { name: "Image preview", exact: true })
      .locator("img");
    await expect(singleImage).toHaveJSProperty("naturalWidth", 1080);
    await expect(singleImage.locator("..")).toHaveCSS("max-height", "none");
    await expect
      .poll(() =>
        singleImage.evaluate((element) => {
          const image = element as HTMLImageElement;
          const box = image.getBoundingClientRect();
          return Math.abs(
            box.height - (box.width * image.naturalHeight) / image.naturalWidth,
          );
        }),
      )
      .toBeLessThanOrEqual(1);
    const carousel = gallery.getByRole("region", { name: "Image carousel" });
    await expect(carousel).toBeVisible();
    await expect(
      carousel.getByTestId("message-image-lightbox-trigger").locator("img"),
    ).toHaveCount(1);
    await expect(
      carousel.getByTestId("message-image-lightbox-trigger").locator("img"),
    ).toHaveCSS("object-fit", "contain");
    await expect(
      carousel.getByTestId("message-image-lightbox-trigger").locator("img"),
    ).toHaveJSProperty("naturalWidth", 1080);
    const originalHeight = (await carousel.boundingBox())?.height ?? 0;
    await carousel
      .getByRole("button", { name: "Next image", exact: true })
      .focus();
    await page.keyboard.press("ArrowRight");
    await expect(carousel.getByTestId("media-preview-count")).toHaveText(
      "2 / 3",
    );
    await expect(
      carousel.getByTestId("message-image-lightbox-trigger").locator("img"),
    ).toHaveJSProperty("naturalWidth", 900);
    expect(
      Math.abs(((await carousel.boundingBox())?.height ?? 0) - originalHeight),
    ).toBeLessThanOrEqual(1);
    const artUrl = await carousel
      .getByTestId("message-image-lightbox-trigger")
      .locator("img")
      .getAttribute("src");
    await waitForAnimations(page);
    await carousel.screenshot({
      path: testInfo.outputPath(`image-carousel-inline-${theme}.png`),
    });
    await carousel.getByRole("button", { name: "Expand image" }).click();
    const expanded = page.getByRole("dialog");
    await expect(expanded).toBeVisible();
    await expect(expanded.locator("img")).toHaveAttribute("src", artUrl ?? "");
    await expect(expanded.locator("img")).toHaveCSS("object-fit", "contain");
    await page.keyboard.press("ArrowRight");
    await expect(expanded.getByTestId("media-preview-count")).toHaveText(
      "3 / 3",
    );
    await waitForAnimations(page);
    await expanded.screenshot({
      path: testInfo.outputPath(`image-expanded-${theme}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      carousel.getByRole("button", { name: "Expand image" }),
    ).toBeFocused();
    await expect(carousel.getByTestId("media-preview-count")).toHaveText(
      "3 / 3",
    );
    const downloadEvent = page.waitForEvent("download");
    await carousel.getByRole("link", { name: "Download", exact: true }).click();
    expect((await downloadEvent).suggestedFilename()).toMatch(/\.svg$/);

    await gallery.getByRole("tab", { name: "Video", exact: true }).click();
    const player = gallery.getByTestId("video-player");
    const video = player.locator("video");
    await expect(video).toHaveJSProperty("paused", true);
    await expect(video).toHaveJSProperty("currentTime", 0);
    await expect
      .poll(() =>
        video.evaluate((element) => {
          const { seekable } = element as HTMLVideoElement;
          return seekable.length ? seekable.end(seekable.length - 1) : 0;
        }),
      )
      .toBeGreaterThanOrEqual(3);
    expect(
      mediaResponses.some(
        ({ filename, status }) =>
          filename === "preview-video.mp4" && status === 206,
      ),
    ).toBe(true);
    await expect(
      player.getByTestId("video-review-poster-preview"),
    ).toHaveJSProperty("naturalWidth", 640);
    await expect(player.getByTestId("video-poster-surface")).toBeVisible();
    await expect(video).toHaveCSS("object-fit", "contain");
    await waitForAnimations(page);
    await player.screenshot({
      path: testInfo.outputPath(`video-poster-${theme}.png`),
    });
    await player
      .getByRole("button", { name: "Play video", exact: true })
      .click();
    await expect(video).toHaveJSProperty("paused", false);
    await expect(player.getByTestId("video-poster-surface")).toHaveCount(0);
    await expect
      .poll(() =>
        video.evaluate((element) => (element as HTMLMediaElement).currentTime),
      )
      .toBeGreaterThan(0.25);
    await player
      .getByRole("button", { name: "Pause video", exact: true })
      .click();
    const savedTime = await video.evaluate(
      (element) => (element as HTMLMediaElement).currentTime,
    );
    expect(savedTime).toBeGreaterThan(0.25);
    await player
      .getByRole("button", { name: "Open video review", exact: true })
      .click();
    const review = page.getByTestId("video-review-dialog");
    await expect(review).toBeVisible();
    await expect
      .poll(() =>
        review
          .locator("video")
          .evaluate(
            (element, saved) =>
              Math.abs((element as HTMLMediaElement).currentTime - saved),
            savedTime,
          ),
      )
      .toBeLessThan(0.05);
    await review
      .getByRole("button", { name: "Close video review", exact: true })
      .click();
    await expect(page.getByTestId("video-review-dialog")).toHaveCount(0);

    await gallery.getByRole("tab", { name: "Audio", exact: true }).click();
    const audioPlayer = gallery.getByTestId("media-audio-preview");
    const audio = audioPlayer.locator("audio");
    await expect(audio).toHaveJSProperty("paused", true);
    await expect
      .poll(() =>
        audio.evaluate((element) => {
          const { seekable } = element as HTMLAudioElement;
          return seekable.length ? seekable.end(seekable.length - 1) : 0;
        }),
      )
      .toBeGreaterThanOrEqual(3);
    expect(
      mediaResponses.some(
        ({ filename, status }) =>
          filename === "preview-audio.wav" && status === 206,
      ),
    ).toBe(true);
    await expect(
      audioPlayer.getByRole("slider", { name: "Seek audio" }),
    ).toBeEnabled();
    // Keep the deterministic tone silent while exercising the real decoder.
    await audio.evaluate((element) => {
      (element as HTMLMediaElement).muted = true;
    });
    await audioPlayer.getByRole("button", { name: "Play audio" }).click();
    await expect(audio).toHaveJSProperty("paused", false);
    await audioPlayer.getByRole("button", { name: "Pause audio" }).click();
    await audioPlayer.getByRole("slider", { name: "Seek audio" }).fill("3");
    await expect(audio).toHaveJSProperty("currentTime", 3);
    await waitForAnimations(page);
    await audioPlayer.screenshot({
      path: testInfo.outputPath(`audio-paused-${theme}.png`),
    });
  });
}

test("message carousel fits a narrow native thread and supports touch without losing order", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await seedAppearance(page, "buzz-dark");
  await installMediaFixtures(page);
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await page.waitForFunction(() =>
    Boolean(window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
            channelName: "general",
          }) ?? false,
      ),
    )
    .toBe(true);
  const rootId = await page.evaluate(() => {
    const emit = window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__;
    if (!emit) throw new Error("Mock message emitter unavailable");
    const root = emit({
      channelName: "general",
      content: "Review the launch images in order.",
    });
    const base = window.location.origin;
    emit({
      channelName: "general",
      parentEventId: root.id,
      content: [1, 2, 3]
        .map(
          (index) =>
            `![Launch image ${index}](${base}/rich-previews/launch-0${index}.svg)`,
        )
        .join("\n"),
    });
    // No imeta dimensions: the image decoder must supply the portrait ratio.
    emit({
      channelName: "general",
      parentEventId: root.id,
      content: `![Portrait artwork](${base}/rich-previews/launch-02.svg)`,
    });
    return root.id;
  });
  await page
    .locator(
      `[data-testid="message-thread-summary"][data-thread-head-id="${rootId}"]`,
    )
    .click();
  const thread = page.getByTestId("message-thread-panel");
  const carousel = thread.getByRole("region", { name: "Image carousel" });
  await expect(carousel).toBeVisible();
  await expect(
    carousel.getByTestId("message-image-lightbox-trigger").locator("img"),
  ).toHaveJSProperty("naturalWidth", 1080);
  const threadBox = await thread.boundingBox();
  const carouselBox = await carousel.boundingBox();
  expect(threadBox?.width).toBeLessThanOrEqual(500);
  expect(carouselBox?.width).toBeGreaterThan(220);
  expect(carouselBox?.width).toBeLessThanOrEqual(threadBox?.width ?? 0);
  expect(
    await carousel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  const stage = carousel
    .getByTestId("message-image-lightbox-trigger")
    .locator("img")
    .locator("..");
  await stage.dispatchEvent("pointerdown", {
    pointerType: "touch",
    clientX: 200,
    clientY: 100,
  });
  await stage.dispatchEvent("pointerup", {
    pointerType: "touch",
    clientX: 120,
    clientY: 105,
  });
  await expect(carousel.getByTestId("media-preview-count")).toHaveText("2 / 3");
  await stage.dispatchEvent("pointerdown", {
    pointerType: "touch",
    clientX: 200,
    clientY: 100,
  });
  await stage.dispatchEvent("pointerup", {
    pointerType: "touch",
    clientX: 160,
    clientY: 200,
  });
  await expect(carousel.getByTestId("media-preview-count")).toHaveText("2 / 3");
  const singleImage = thread
    .getByRole("region", { name: "Image preview", exact: true })
    .locator("img");
  await singleImage.scrollIntoViewIfNeeded();
  await expect(singleImage).toHaveJSProperty("naturalWidth", 900);
  await expect(singleImage.locator("..")).toHaveCSS("max-height", "none");
  await expect
    .poll(() =>
      singleImage.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return Math.abs(box.height - (box.width * 1200) / 900);
      }),
    )
    .toBeLessThanOrEqual(1);
  expect((await singleImage.boundingBox())?.width).toBeGreaterThan(220);
  await waitForAnimations(page);
  await thread.screenshot({
    path: testInfo.outputPath("media-narrow-thread-dark.png"),
  });
});

test("gallery controls change with the selected accent and colour mode", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await seedAppearance(page, "buzz");
  await installMediaFixtures(page);
  await installMockBridge(page);
  await page.goto("/");
  const gallery = await openGallery(page);
  await gallery.getByRole("tab", { name: "Audio", exact: true }).click();
  const audio = gallery.getByTestId("media-audio-preview");
  const play = audio.getByRole("button", { name: "Play audio", exact: true });
  const violet = await play.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  const lightSurface = await audio.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await page.getByTestId("settings-nav-appearance").click();
  await page.getByTestId("accent-color-green").click();
  await page.getByTestId("settings-nav-blocks").click();
  await page.getByRole("tab", { name: "Examples", exact: true }).click();
  await gallery.getByRole("tab", { name: "Audio", exact: true }).click();
  await expect(play).not.toHaveCSS("background-color", violet);
  const green = await play.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "hsl(var(--primary))";
    element.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return expected;
  });
  await expect(play).toHaveCSS("background-color", green);
  await page.getByTestId("settings-nav-appearance").click();
  await page.getByTestId("appearance-mode-dark").click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-buzz-theme",
    "buzz-dark",
  );
  await page.getByTestId("settings-nav-blocks").click();
  await page.getByRole("tab", { name: "Examples", exact: true }).click();
  await gallery.getByRole("tab", { name: "Audio", exact: true }).click();
  await expect(audio).not.toHaveCSS("background-color", lightSurface);
});

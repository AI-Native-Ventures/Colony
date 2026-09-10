import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

/**
 * Discovery entity tiles under a message.
 *
 * Each message carries `["discovery", kind, id, label]` tags exactly as the
 * composer and `buzz messages send --discovery` write them. The fixture
 * Discovery source resolves them deterministically, so these captures are the
 * real render path with no relay: parse, resolve, lay out, paint.
 */

const SHOTS = "test-results/discovery-entity-tiles";

// Tall enough that a whole tile strip fits between the channel header and the
// composer; at 720 the wide vertical tile is clipped by both.
test.use({ viewport: { width: 1280, height: 1100 } });
const THEME_STORAGE_KEY = "buzz-theme";

const VERTICAL_TAG = [
  "discovery",
  "vertical",
  "construction/plumbers",
  "Plumbers",
];

const LEAD_IDS = [
  "6f1c9d2e-4a71-4f2b-9c3d-0b7a5e21f8ac",
  "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  "2b3c4d5e-6f70-4b8c-9d0e-1f2a3b4c5d6e",
  "3c4d5e6f-7081-4c9d-8e0f-2a3b4c5d6e7f",
  "4d5e6f70-8192-4d0e-9f1a-3b4c5d6e7f80",
  "5e6f7081-92a3-4e1f-8a2b-4c5d6e7f8091",
] as const;

function leadTags(count: number, offset = 0): string[][] {
  return LEAD_IDS.slice(offset, offset + count).map((id) => [
    "discovery",
    "lead",
    id,
  ]);
}

async function waitForMockLiveSubscription(page: Page, channelName: string) {
  await page.waitForFunction(
    () =>
      typeof (
        window as Window & {
          __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: unknown;
        }
      ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__ === "function",
  );
  await expect
    .poll(() =>
      page.evaluate(
        (name) =>
          (
            window as Window & {
              __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
                channelName: string;
              }) => boolean;
            }
          ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
            channelName: name,
          }) ?? false,
        channelName,
      ),
    )
    .toBe(true);
}

/**
 * Seed the theme before the bridge installs: init scripts run in registration
 * order and ThemeProvider reads storage on mount, which the bridge triggers.
 */
async function openSeededChannel(page: Page, theme: string) {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: THEME_STORAGE_KEY, value: theme },
  );
  await installMockBridge(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("channel-general").click();
  await waitForMockLiveSubscription(page, "general");

  await page.evaluate(
    ({ vertical, four, six }) => {
      const emit = (
        window as Window & {
          __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
            channelName: string;
            content: string;
            extraTags?: string[][];
            createdAt?: number;
          }) => unknown;
        }
      ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__;
      if (!emit) throw new Error("The mock message bridge is not installed.");
      // Distinct timestamps: three messages emitted inside the same second
      // land in an order the timeline is free to choose.
      const base = Math.floor(Date.now() / 1_000);
      emit({
        channelName: "general",
        content: "Starting on @Plumbers in Cape Town.",
        extraTags: [vertical],
        createdAt: base,
      });
      emit({
        channelName: "general",
        content: "First four retained leads.",
        extraTags: four,
        createdAt: base + 1,
      });
      emit({
        channelName: "general",
        content: "Six leads, so the strip caps at four.",
        extraTags: six,
        createdAt: base + 2,
      });
    },
    {
      vertical: VERTICAL_TAG,
      // Offset so the four-lead strip and the overflow strip show different
      // businesses: two captures of the same four leads read as a duplicate.
      four: leadTags(4, 2),
      six: leadTags(6),
    },
  );

  // Scoped to the message that owns each strip, not to timeline position: the
  // row order is the timeline's business, and a strip picked by index would
  // silently photograph the wrong message.
  const strips = {
    vertical: stripOfMessage(page, "Starting on @Plumbers"),
    four: stripOfMessage(page, "First four retained leads."),
    six: stripOfMessage(page, "Six leads, so the strip caps at four."),
  };
  await expect(page.getByTestId("discovery-entity-tiles")).toHaveCount(3);
  // The unread pill floats over the timeline. Dismiss it before capturing, or
  // it lands in the middle of whichever strip is nearest the top.
  const unreadPill = page.getByTestId("message-unread-pill");
  if (await unreadPill.isVisible()) {
    await unreadPill.click();
  }
  await expect(unreadPill).toHaveCount(0);
  // "Jump to latest" floats over the timeline whenever an older row is
  // scrolled into view, which is exactly what capturing the first strip does.
  // Hiding it changes nothing about the tiles under test.
  await page.addStyleTag({
    content: '[data-testid="message-scroll-to-latest"] { display: none; }',
  });
  await waitForAnimations(page);
  return strips;
}

/** The tile strip under the message carrying this text. */
function stripOfMessage(page: Page, text: string) {
  return page
    .getByTestId("message-row")
    .filter({ hasText: text })
    .getByTestId("discovery-entity-tiles");
}

async function captureStrips(page: Page, theme: string, suffix: string) {
  const strips = await openSeededChannel(page, theme);
  await capture(page, strips.vertical, `${SHOTS}/01-vertical-${suffix}.png`);
  await capture(page, strips.four, `${SHOTS}/02-four-${suffix}.png`);
  await capture(page, strips.six, `${SHOTS}/03-overflow-${suffix}.png`);
  return strips;
}

async function capture(
  page: Page,
  strip: ReturnType<typeof stripOfMessage>,
  path: string,
) {
  // Centre it: `scrollIntoViewIfNeeded` stops as soon as the element is
  // inside the scroll container, which leaves a strip near the bottom sitting
  // under the composer, and the capture photographs the composer instead.
  await strip.evaluate((element) => {
    element.scrollIntoView({ block: "center" });
  });
  await waitForAnimations(page);
  await strip.screenshot({ path });
}

test("one vertical, four leads and an overflow strip render in light mode", async ({
  page,
}) => {
  const strips = await captureStrips(page, "buzz", "light");

  // One entity is the wide artwork tile; four are lead tiles; six are capped.
  await expect(
    strips.vertical.getByTestId("discovery-tile-vertical"),
  ).toBeVisible();
  await expect(strips.four.getByTestId("discovery-tile-lead")).toHaveCount(4);
  await expect(strips.six.getByTestId("discovery-tile-lead")).toHaveCount(4);
  await expect(strips.six.getByTestId("discovery-tiles-show-all")).toHaveText(
    "Show all 6",
  );
  await expect(
    strips.vertical.getByTestId("discovery-tiles-show-all"),
  ).toHaveCount(0);
  await expect(strips.four.getByTestId("discovery-tiles-show-all")).toHaveCount(
    0,
  );

  // Every lead tile carries its lowercase funnel pill.
  await expect(
    strips.four.getByTestId("discovery-tile-pill").first(),
  ).toBeVisible();
});

test("the tiles render in dark mode too", async ({ page }) => {
  const strips = await captureStrips(page, "buzz-dark", "dark");
  await expect(
    strips.vertical.getByTestId("discovery-tile-vertical"),
  ).toBeVisible();
  await expect(strips.six.getByTestId("discovery-tile-lead")).toHaveCount(4);
});

test("every captured strip is a distinct image", async () => {
  const files = (await readdir(SHOTS)).filter((name) => name.endsWith(".png"));
  expect(files.length).toBe(6);
  const hashes = new Map<string, string>();
  for (const file of files) {
    const digest = createHash("sha256")
      .update(await readFile(join(SHOTS, file)))
      .digest("hex");
    // Two identical hashes mean two captures photographed the same state,
    // which is the most common screenshot regression in this repo.
    expect(hashes.get(digest), `${file} duplicates ${hashes.get(digest)}`).toBe(
      undefined,
    );
    hashes.set(digest, file);
  }
});

test("clicking a lead tile opens that lead in Discovery", async ({ page }) => {
  const strips = await openSeededChannel(page, "buzz");
  await strips.four.getByTestId("discovery-tile-lead").first().click();
  // The drawer is the proof: `leadId` is route state the Discovery screen
  // reads, and this build's router does not put it in `window.location`.
  await expect(page.getByTestId("lead-detail-drawer")).toBeVisible();
});

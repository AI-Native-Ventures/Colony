import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

/**
 * The Content calendar, with a real campaign in it.
 *
 * The screen had only ever been looked at empty, which is how it shipped with a
 * day-detail panel pinned at 26rem that clipped its own approve controls off
 * the right edge on a normal window. Seeding the records is the only way to see
 * that, so these shots are the regression guard for the populated layout.
 */

const AUTHOR = "b".repeat(64);
const CAMPAIGN_ID = "colony-launch";

const DAYS = [
  {
    date: "2026-08-31",
    headline: "Run a company without the headcount",
    job: "who",
    slug: "w1-mon-who",
  },
  {
    date: "2026-09-01",
    headline: "They hold roles, not prompts",
    job: "what",
    slug: "w1-tue-what",
  },
  {
    date: "2026-09-02",
    headline: "Nothing goes out without you",
    job: "why",
    slug: "w1-wed-why",
  },
  {
    date: "2026-09-03",
    headline: "Every card is measured before you see it",
    job: "proof",
    slug: "w1-thu-proof",
  },
  {
    date: "2026-09-04",
    headline: "Your company is hiring",
    job: "when",
    slug: "w1-fri-when",
  },
];

function seededEvents() {
  const campaign = {
    content: JSON.stringify({
      name: "Colony launch week",
      purpose: "Say what Colony is to someone who has never heard of it.",
      running_order: "who-what-why-proof-when",
      schema: "colony/content-campaign/v1",
      status: "active",
      weeks: [
        { index: 1, label: "Week 1 — first contact", starts_on: "2026-08-31" },
      ],
    }),
    created_at: 1_800_000_000,
    id: "c".repeat(64),
    kind: 30195,
    pubkey: AUTHOR,
    tags: [["d", CAMPAIGN_ID]],
  };

  const posts = DAYS.map((day, index) => ({
    content: JSON.stringify({
      alt: `A card reading: ${day.headline}.`,
      caption:
        "Colony gives you a company of AI employees. They hold roles, report to each other, and bring you the decisions that are actually yours.",
      channel: "linkedin",
      hashtags: ["agents"],
      headline: day.headline,
      job: day.job,
      schema: "colony/content-post/v1",
      scheduled_for: day.date,
      status: "draft",
      style: { family: "night", hues: ["violet", "pink"], layout: "statement" },
      week: 1,
    }),
    created_at: 1_800_000_100 + index,
    id: `${index}`.repeat(64).slice(0, 64),
    kind: 30196,
    pubkey: AUTHOR,
    tags: [["d", `${CAMPAIGN_ID}:${day.slug}`]],
  }));

  // The logo travels as data: URIs so the mock needs no media server; the
  // Brand page hands them to <img> unchanged.
  const logoSvg = (fill: string) =>
    `data:image/svg+xml;utf8,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="20" cy="32" r="12" fill="${fill}"/><rect x="36" y="20" width="24" height="24" rx="4" fill="${fill}"/></svg>`,
    )}`;

  const kit = {
    content: JSON.stringify({
      canvases: [{ h: 1350, name: "post", w: 1080 }],
      hues: [
        {
          base: "#5b2ee5",
          name: "violet",
          ramp: ["#120b26", "#5b2ee5", "#f6f3ff"],
        },
        { base: "#e52ea8", name: "magenta", ramp: [] },
      ],
      id: "acme",
      marks: [
        {
          media_hash: "f".repeat(64),
          media_url: logoSvg("#5b2ee5"),
          role: "logo",
          variants: [
            {
              media_hash: "a".repeat(64),
              media_url: logoSvg("#ffffff"),
              purpose: "on-dark",
            },
            {
              media_hash: "b".repeat(64),
              media_url: logoSvg("#171717"),
              purpose: "on-light",
            },
          ],
        },
      ],
      rules: { claim_strictness: "strict" },
      schema: "colony/content-brand-kit/v1",
      source: { type: "scan", url: "https://acme.example" },
      templates: ["statement"],
      version: "1",
    }),
    created_at: 1_800_000_200,
    id: "e".repeat(64),
    kind: 30198,
    pubkey: AUTHOR,
    tags: [["d", "acme"]],
  };

  const style = {
    content: JSON.stringify({
      rules: [
        {
          active: true,
          id: "r1-1",
          origin: { at: 1_756_600_000, quote: "stop using exclamation marks" },
          text: "No exclamation marks",
        },
      ],
      schema: "colony/content-style/v1",
      settings: {
        banned_words: ["synergy"],
        voice: { sound: "Plain and confident.", tagline: "Run the company." },
      },
      version: "5",
    }),
    created_at: 1_800_000_300,
    id: "f".repeat(64),
    kind: 30197,
    pubkey: AUTHOR,
    tags: [["d", "house"]],
  };

  return [campaign, kit, style, ...posts];
}

test.beforeEach(async ({ page }) => {
  const events = seededEvents();
  await page.addInitScript((seeded) => {
    (window as unknown as Record<string, unknown>).__BUZZ_E2E_SEEDED_EVENTS__ =
      seeded;
  }, events);
  await installMockBridge(page);
  // Navigated in-app rather than deep-linked: the preview server serves the
  // built files with no SPA fallback, so goto("/content") is a 404.
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-content-view").click();
});

test("the calendar shows the week, and the day detail resizes like every other panel", async ({
  page,
}) => {
  await expect(page.getByText("Colony launch week")).toBeVisible();
  await expect(page.getByText("Week 1 — first contact")).toBeVisible();

  // The week label already carries its number; it used to be printed twice.
  await expect(page.getByText(/^Week 1$/)).toHaveCount(0);

  // The card carries its headline: a week of undrawn posts used to be five
  // identical "Not rendered" boxes with nothing to tell them apart.
  await expect(page.getByTestId(`content-day-${DAYS[0].slug}`)).toContainText(
    DAYS[0].headline,
  );
  await page.getByTestId(`content-day-${DAYS[0].slug}`).click();
  const panel = page.getByTestId("content-day-detail-panel");
  await expect(panel).toBeVisible();

  // The resize handle is what the pinned-width panel never had.
  const handle = page.getByTestId("content-day-detail-resize");
  await expect(handle).toBeVisible();

  // The panel slides in. Measuring the handle mid-animation reads a position
  // it has already left, so the press lands beside it and the drag does
  // nothing - which fails as "the panel did not resize" rather than as
  // "nothing was dragged". Settle first, then measure.
  await waitForAnimations(page);

  const before = (await panel.boundingBox())?.width ?? 0;
  const box = await handle.boundingBox();
  if (!box) {
    throw new Error("the resize handle has no box to drag");
  }
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Separate move calls rather than one with `steps`, matching the drag in
  // threadpane-ultrawide.spec.ts that has survived this CI. The drag's move
  // listener is attached in the pointerdown handler, and a single call can
  // outrun it.
  for (let x = startX; x >= startX - 200; x -= 40) {
    await page.mouse.move(x, startY);
  }
  await page.mouse.up();

  // Polled rather than asserted once: the width lands after a paint. The
  // callback returns a value and never throws, because expect.poll rethrows on
  // the first call instead of retrying.
  await expect
    .poll(async () => (await panel.boundingBox())?.width ?? 0)
    .toBeGreaterThan(before + 80);

  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/content/01-calendar-detail.png",
  });
});

test("the Brand page shows the logo in its versions, each on its ground", async ({
  page,
}) => {
  await page.getByTestId("content-open-style").click();

  // The scanned website is named up top, in plain words.
  await expect(page.getByText("acme.example")).toBeVisible();

  // The derived versions render as labeled plates, never a lone logo.
  await expect(page.getByText("As it is")).toBeVisible();
  await expect(page.getByText("On dark cards")).toBeVisible();
  await expect(page.getByText("On light cards")).toBeVisible();
  await expect(page.getByAltText("Your logo, for dark cards")).toBeVisible();
  await expect(page.getByAltText("Your logo, for light cards")).toBeVisible();

  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/content/02-brand-book.png",
    fullPage: false,
  });
});

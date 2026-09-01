import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

/**
 * The Brand page, and the correction loop that fills it.
 *
 * The page is written for someone who knows nothing about design and does
 * not want to: plain sections, no ratios, no versions, no type terms. The
 * loop under test is the one the Style tab promised for weeks with no writer
 * behind it: send a card back with "every card, from now on", and the
 * sentence lands in Your rules, verbatim, with its date.
 */

const AUTHOR = "b".repeat(64);
const CAMPAIGN_ID = "brand-loop";

function seededEvents() {
  const campaign = {
    content: JSON.stringify({
      name: "Brand loop week",
      schema: "colony/content-campaign/v1",
      status: "active",
      weeks: [{ index: 1, label: "Week 1", starts_on: "2026-08-31" }],
    }),
    created_at: 1_700_000_000,
    id: "c".repeat(64),
    kind: 30195,
    pubkey: AUTHOR,
    tags: [["d", CAMPAIGN_ID]],
  };

  const post = {
    content: JSON.stringify({
      caption: "A caption.",
      headline: "Too many words on this card",
      schema: "colony/content-post/v1",
      scheduled_for: "2026-08-31",
      status: "draft",
      style: { family: "night", hues: ["violet"], layout: "statement" },
      week: 1,
    }),
    created_at: 1_700_000_100,
    id: "d".repeat(64),
    kind: 30196,
    pubkey: AUTHOR,
    tags: [["d", `${CAMPAIGN_ID}:w1-mon`]],
  };

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
      rules: { claim_strictness: "strict" },
      schema: "colony/content-brand-kit/v1",
      source: { type: "scan", url: "https://acme.example" },
      templates: ["statement", "poster"],
      version: "1",
    }),
    created_at: 1_700_000_200,
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
    created_at: 1_700_000_300,
    id: "f".repeat(64),
    kind: 30197,
    pubkey: AUTHOR,
    tags: [["d", "house"]],
  };

  return [campaign, post, kit, style];
}

test.beforeEach(async ({ page }) => {
  const events = seededEvents();
  await page.addInitScript((seeded) => {
    (window as unknown as Record<string, unknown>).__BUZZ_E2E_SEEDED_EVENTS__ =
      seeded;
  }, events);
  await installMockBridge(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-content-view").click();
});

test("the Brand page reads in plain words: logo, colors, words, likes, rules", async ({
  page,
}) => {
  await page.getByTestId("content-open-style").click();

  // Every section in owner language. No design vocabulary anywhere.
  await expect(page.getByRole("heading", { name: "Your logo" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add your logo" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your colors" }),
  ).toBeVisible();
  await expect(page.getByText("violet")).toBeVisible();
  await expect(page.getByText("magenta")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your words" })).toBeVisible();
  await expect(page.getByTestId("brand-tagline-input")).toHaveValue(
    "Run the company.",
  );
  await expect(
    page.getByRole("heading", { name: "Things you like" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your rules" })).toBeVisible();

  // The seeded rule shows the sentence and what caused it.
  await expect(page.getByText("No exclamation marks")).toBeVisible();
  await expect(page.getByText(/stop using exclamation marks/)).toBeVisible();

  // The version number exists in the record and never on the page.
  await expect(page.getByText(/^5$/)).toHaveCount(0);
});

test("a change binned for every card lands in Your rules, verbatim", async ({
  page,
}) => {
  await page.getByTestId("content-day-w1-mon").click();
  const note = "Use fewer words on the card";
  await page.getByPlaceholder("What is wrong with it?").fill(note);
  await page.getByRole("button", { name: "Every card, from now on" }).click();
  await page.getByRole("button", { name: "Send it back" }).click();

  // The decision records first; the rule write follows it. Both land in the
  // mock's seeded store, so the Brand page's refetch sees the new head.
  await expect(page.getByText("Sent back")).toBeVisible();

  await page.getByTestId("content-open-style").click();
  await expect(page.getByText(note).first()).toBeVisible();
});

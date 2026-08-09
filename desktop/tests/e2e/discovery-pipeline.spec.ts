import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";

const SCREENSHOT_DIR = path.resolve("test-results/discovery-pipeline");
const SCREENSHOTS = [
  "pipeline-six-columns.png",
  "pipeline-after-move.png",
  "pipeline-terminal.png",
] as const;

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 1000 } });

async function openPipeline(page: Page) {
  await seedActiveIdentity(page, TEST_IDENTITIES.tyler);
  await installMockBridge(page);
  await page.goto("/#/discovery?surface=leads");
  await expect(page.getByTestId("discovery-top-tab-pipeline")).toBeVisible();
  await page.getByTestId("discovery-top-tab-pipeline").click();
  await expect(page).toHaveURL(/#\/discovery\?surface=pipeline$/);
  await expect(page.getByTestId("pipeline-workspace")).toBeVisible();
  // The tab must survive the navigation it just performed. Asserting it only
  // before the click missed a regression where the trigger disappeared on the
  // Pipeline surface, leaving the tab bar with nothing selected.
  await expect(page.getByTestId("discovery-top-tab-pipeline")).toBeVisible();
}

async function capture(page: Page, filename: string) {
  const subject = page.getByTestId("pipeline-workspace");
  await expect(subject).toBeVisible();
  await subject.evaluate((element) =>
    element.scrollIntoView({ block: "center", inline: "nearest" }),
  );
  await waitForAnimations(page);
  await subject.screenshot({
    animations: "disabled",
    path: path.join(SCREENSHOT_DIR, filename),
  });
}

function assertDistinctScreenshots() {
  const paths = SCREENSHOTS.map((filename) =>
    path.join(SCREENSHOT_DIR, filename),
  );
  expect(
    paths.filter((screenshot) => !existsSync(screenshot)),
    "Every Pipeline state must have a screenshot.",
  ).toEqual([]);
  const hashes = paths.map((screenshot) =>
    createHash("sha256").update(readFileSync(screenshot)).digest("hex"),
  );
  expect(
    new Set(hashes).size,
    "Every Pipeline state must produce distinct pixels.",
  ).toBe(hashes.length);
  console.log(
    hashes.map((hash, index) => `${SCREENSHOTS[index]} ${hash}`).join("\n"),
  );
}

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test.beforeAll(() => mkdirSync(SCREENSHOT_DIR, { recursive: true }));
test.afterAll(assertDistinctScreenshots);

test("Pipeline renders six columns with response totals and bounded pages", async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openPipeline(page);

  // The fixture totals are cross-checked against status-filtered getLeads
  // pages in discoveryData.test.mjs; the UI renders those response totals.
  for (const [status, label, total] of [
    ["candidate", "Candidate", "248"],
    ["accepted", "Accepted", "78"],
    ["qualified", "Qualified", "1"],
    ["dormant", "Dormant", "1"],
    ["disqualified", "Disqualified", "0"],
    ["client_active", "Converted", "0"],
  ]) {
    const column = page.getByTestId(`pipeline-column-${status}`);
    await expect(column).toBeVisible();
    await expect(column).toContainText(label);
    await expect(
      column.getByTestId(`pipeline-column-${status}-total`),
    ).toHaveText(total);
  }
  // Bounded fetch: 100 candidate cards loaded against a 248 total.
  await expect(page.getByTestId("pipeline-column-candidate")).toContainText(
    "Showing first 100 of 248",
  );
  await capture(page, "pipeline-six-columns.png");
  expect(errors, "pipeline render emitted browser errors").toEqual([]);
});

test("a legal move calls updateLead and moves the card on the receipt", async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openPipeline(page);

  // candidate -> accepted is legal; qualified is greyed out; Converted is
  // never offered.
  const candidateMove = page.getByTestId("pipeline-move-lead-002");
  await expect(candidateMove).toBeVisible();
  await expect(
    candidateMove.locator('option[value="accepted"]'),
  ).not.toHaveAttribute("disabled", "");
  await expect(
    candidateMove.locator('option[value="qualified"]'),
  ).toHaveAttribute("disabled", "");
  const moveOptions = await candidateMove.locator("option").allTextContents();
  expect(
    moveOptions.some((text) => text.includes("Converted")),
    "a Lead must never be offered a move into Converted",
  ).toBe(false);

  await candidateMove.selectOption("accepted");
  await expect(page.getByTestId("pipeline-column-candidate")).not.toContainText(
    "Soweto Motor Works",
  );
  await expect(page.getByTestId("pipeline-column-accepted")).toContainText(
    "Soweto Motor Works",
  );
  await expect(page.getByTestId("pipeline-column-candidate-total")).toHaveText(
    "247",
  );
  await expect(page.getByTestId("pipeline-column-accepted-total")).toHaveText(
    "79",
  );
  await capture(page, "pipeline-after-move.png");
  expect(errors, "pipeline move emitted browser errors").toEqual([]);
});

test("disqualified is terminal: the card keeps its move control disabled", async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openPipeline(page);

  // accepted -> disqualified is legal; the resulting card has no moves left.
  const acceptedMove = page.getByTestId("pipeline-move-lead-003");
  await acceptedMove.selectOption("disqualified");
  await expect(page.getByTestId("pipeline-column-accepted")).not.toContainText(
    "Randburg Auto Clinic",
  );
  await expect(page.getByTestId("pipeline-column-disqualified")).toContainText(
    "Randburg Auto Clinic",
  );
  await expect(
    page.getByTestId("pipeline-column-disqualified-total"),
  ).toHaveText("1");
  const terminalMove = page.getByTestId("pipeline-move-lead-003");
  await expect(terminalMove).toBeDisabled();
  await expect(terminalMove).toContainText("Terminal");
  await capture(page, "pipeline-terminal.png");
  expect(errors, "pipeline terminal state emitted browser errors").toEqual([]);
});

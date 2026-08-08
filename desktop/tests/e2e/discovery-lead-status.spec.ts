import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";

const SCREENSHOT_DIR = path.resolve("test-results/discovery-lead-status");

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(() => mkdirSync(SCREENSHOT_DIR, { recursive: true }));

/**
 * The drawer's funnel status control.
 *
 * A status move and a field edit are separate writes with separate failure
 * modes, so the control is disabled during an edit rather than folded into the
 * edit form's submit. These cases pin that seam down, plus the two things the
 * relay owns: which moves are legal, and what a refusal says.
 *
 * The fixture lead `lead-001` starts Qualified, which is the useful case: it
 * has legal moves in one direction (Dormant, Disqualified) and illegal ones in
 * the other (Candidate, Accepted), so the same control proves both halves.
 */
async function openLeadDrawer(page: Page) {
  await seedActiveIdentity(page, TEST_IDENTITIES.tyler);
  await installMockBridge(page);
  await page.goto("/#/discovery?surface=leads");
  await expect(page.getByTestId("global-lead-table")).toBeVisible();
  const row = page.getByTestId("lead-row-lead-001");
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await row.click();
  const drawer = page.getByRole("dialog", { name: /Rosebank Auto Care/ });
  await expect(drawer).toBeVisible();
  return drawer;
}

test("the drawer offers the legal moves and marks the rest not allowed", async ({
  page,
}) => {
  const drawer = await openLeadDrawer(page);
  const control = drawer.getByTestId("lead-status-move");
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();

  // Converted is never offered. A Lead cannot belong to `active`, so the relay
  // refuses it before the transition matrix is consulted, and rendering it as
  // merely "not allowed" would imply it is a move somebody could earn.
  await expect(control.getByRole("option", { name: /Converted/ })).toHaveCount(
    0,
  );

  // `toBeDisabled` does not apply to <option>, which Playwright treats as
  // always enabled, so the assertion has to read the property itself.
  await expect(
    control.getByRole("option", { name: "Dormant", exact: true }),
  ).toHaveJSProperty("disabled", false);
  await expect(
    control.getByRole("option", { name: "Disqualified", exact: true }),
  ).toHaveJSProperty("disabled", false);
  await expect(
    control.getByRole("option", { name: /Candidate \(not allowed\)/ }),
  ).toHaveJSProperty("disabled", true);
  await expect(
    control.getByRole("option", { name: /Accepted \(not allowed\)/ }),
  ).toHaveJSProperty("disabled", true);

  // The lead's own status is not a move, so it is absent rather than disabled.
  await expect(control.getByRole("option", { name: /^Qualified/ })).toHaveCount(
    0,
  );

  await waitForAnimations(page);
  await drawer.screenshot({
    animations: "disabled",
    path: path.join(SCREENSHOT_DIR, "lead-status-control.png"),
  });
});

test("the status control is disabled while an edit is in progress", async ({
  page,
}) => {
  const drawer = await openLeadDrawer(page);
  await expect(drawer.getByTestId("lead-status-move")).toBeEnabled();

  await drawer.getByTestId("lead-detail-edit").click();
  await expect(drawer.getByTestId("lead-edit-save")).toBeVisible();
  // Disabled, not absent: the user should see that moving is possible and
  // simply not right now, rather than wonder where the control went.
  await expect(drawer.getByTestId("lead-status-control")).toBeVisible();
  await expect(drawer.getByTestId("lead-status-move")).toBeDisabled();

  await drawer.getByTestId("lead-edit-cancel").click();
  await expect(drawer.getByTestId("lead-status-move")).toBeEnabled();
});

test("a legal move re-renders from the receipt and the list follows", async ({
  page,
}) => {
  const drawer = await openLeadDrawer(page);
  const control = drawer.getByTestId("lead-status-move");

  await control.selectOption("dormant");

  await expect(drawer.getByTestId("lead-status-error")).toBeHidden();
  // Asserting on the option set rather than on drawer text, because the labels
  // also appear inside the select and a text match would pass either way.
  // Dormant is now the lead's own status, so it drops out of the options, and
  // Qualified becomes a legal move back.
  await expect(control.getByRole("option", { name: /^Dormant/ })).toHaveCount(
    0,
  );
  await expect(
    control.getByRole("option", { name: "Qualified", exact: true }),
  ).toHaveJSProperty("disabled", false);
});

test("a relay refusal renders inline and leaves the drawer usable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (
      window as Window & { __BUZZ_E2E_DISCOVERY_UPDATE_LEAD_REJECT__?: string }
    ).__BUZZ_E2E_DISCOVERY_UPDATE_LEAD_REJECT__ =
      "invalid: Lead status transition Qualified -> Dormant is not allowed";
  });
  const drawer = await openLeadDrawer(page);

  const control = drawer.getByTestId("lead-status-move");
  await control.selectOption("dormant");

  // The relay's own words, not a generic failure.
  await expect(drawer.getByTestId("lead-status-error")).toContainText(
    "Lead status transition Qualified -> Dormant is not allowed",
  );
  // The refusal did not move the lead: Qualified is still its status, so it is
  // still absent from the options and Dormant is still offered.
  await expect(control.getByRole("option", { name: /^Qualified/ })).toHaveCount(
    0,
  );
  await expect(control).toBeEnabled();
});

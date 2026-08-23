import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

const SHOTS = "test-results/org-chart-screenshots";

// A real two-level org, matching the shape a Colony workspace actually takes:
// one Chief of staff, a Team lead reporting to it, a Worker under the lead.
const CHARLIE_PUBKEY =
  "554cef57437abac34522ac2c9f0490d685b72c80478cf9f7ed6f9570ee8624ea";
const NADIA_PUBKEY =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00";
const MIRA_PUBKEY =
  "8f83d6b7f3d74f7d933ae3a54dd8c6cc85c7f98e531c16e5a827b953441a8d67";

const ORG = [
  {
    pubkey: CHARLIE_PUBKEY,
    role: "chief-of-staff",
    name: "charlie",
    rank: "executive",
  },
  {
    pubkey: NADIA_PUBKEY,
    role: "team-lead",
    name: "nadia",
    rank: "leader",
    manager: CHARLIE_PUBKEY,
  },
  {
    pubkey: MIRA_PUBKEY,
    role: "researcher",
    name: "mira",
    rank: "worker",
    manager: NADIA_PUBKEY,
  },
] as const;

test("the org chart draws a populated two-level tree", async ({ page }) => {
  await installMockBridge(page, { employeeHeads: [...ORG] });
  await page.goto("/#/agents?section=people");

  const section = page.getByTestId("people-roles-section");
  await expect(section).toBeVisible();

  const tree = page.getByTestId("org-tree");
  await expect(tree).toBeVisible();

  // The executive is the root and both others nest beneath it.
  await expect(page.getByTestId(`org-node-${CHARLIE_PUBKEY}`)).toBeVisible();
  await expect(page.getByTestId(`org-node-${NADIA_PUBKEY}`)).toBeVisible();
  await expect(page.getByTestId(`org-node-${MIRA_PUBKEY}`)).toBeVisible();

  // Span of control: charlie manages one directly but carries two underneath.
  await expect(page.getByTestId(`org-node-load-${CHARLIE_PUBKEY}`)).toHaveText(
    "1 direct / 2 total",
  );
  await expect(page.getByTestId(`org-node-load-${NADIA_PUBKEY}`)).toHaveText(
    "1 direct",
  );

  await waitForAnimations(page);
  await section.screenshot({ path: `${SHOTS}/01-populated-tree.png` });
});

test("an unranked agent is an action, not an empty page", async ({ page }) => {
  // No employee heads at all: the section must still explain itself rather
  // than claiming nobody is employed while agents are listed above it.
  await installMockBridge(page, {});
  await page.goto("/#/agents?section=people");

  const section = page.getByTestId("people-roles-section");
  await expect(section).toBeVisible();

  await waitForAnimations(page);
  await section.screenshot({ path: `${SHOTS}/02-nobody-ranked.png` });
});

import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";
import type { RelayEvent } from "../../src/shared/api/types";

const SHOTS = "test-results/org-delegation-authority-screenshots";

// The mock viewer is the community's owner by default (mock.relayMembers
// seeds the active identity at role "owner"), so grant heads authored by
// this key are the heads the owner-authorship scan trusts.
const OWNER_PUBKEY = "deadbeef".repeat(8);

// Distinct from every fixture pubkey in e2eBridge.ts: these employees are
// minted by this spec alone.
const EXEC_PUBKEY = "11111111".repeat(8);
const LEAD_PUBKEY = "22222222".repeat(8);
const WORKER_PUBKEY = "33333333".repeat(8);

function employeePayroll() {
  return [
    {
      pubkey: EXEC_PUBKEY,
      role: "chief-of-staff",
      name: "charlie",
      rank: "executive" as const,
    },
    {
      pubkey: LEAD_PUBKEY,
      role: "team-lead",
      name: "nadia",
      rank: "leader" as const,
      manager: EXEC_PUBKEY,
    },
    {
      pubkey: WORKER_PUBKEY,
      role: "researcher",
      name: "mira",
      rank: "worker" as const,
      manager: LEAD_PUBKEY,
    },
  ];
}

let eventSeq = 0;

/**
 * A kind-30189 head. The client-side scan verifies shape and authorship,
 * not signatures, so a fixed sig and a synthetic id are enough here.
 */
function grantHead({
  grantId,
  active,
  createdAt,
}: {
  grantId: string;
  active: boolean;
  createdAt: number;
}): RelayEvent {
  eventSeq += 1;
  return {
    id: `ee${String(eventSeq).padStart(62, "0")}`,
    pubkey: OWNER_PUBKEY,
    created_at: createdAt,
    kind: 30189,
    tags: [["d", grantId]],
    content: JSON.stringify({
      category: "vendor selection",
      scope: "under 50 dollars per decision",
      cap_nano_usd: 50_000_000_000,
      active,
    }),
    sig: "f".repeat(128),
  };
}

async function openPeopleSection(page: Page) {
  await page.goto("/#/agents?section=people");
  const section = page.getByTestId("people-roles-section");
  await expect(section).toBeVisible();
  await expect(page.getByTestId(`org-node-${WORKER_PUBKEY}`)).toBeVisible();
  return section;
}

test("the community line counts active grants and nodes state rank capability", async ({
  page,
}) => {
  await installMockBridge(page, {
    employeeHeads: employeePayroll(),
    delegationGrantEvents: [
      grantHead({ grantId: "vendors", active: true, createdAt: 900 }),
      grantHead({ grantId: "tooling", active: true, createdAt: 800 }),
    ],
    relayMembers: true,
  });

  const section = await openPeopleSection(page);

  await expect(page.getByTestId("org-active-delegations")).toHaveText(
    "2 active delegations, available to every Team lead and Chief of staff.",
  );
  // Rank capability is stated on the node itself, and never as ownership:
  // the line above stays the only place a count appears.
  await expect(
    page.getByTestId(`org-node-authority-${WORKER_PUBKEY}`),
  ).toHaveText("Cannot use delegations");
  await expect(
    page.getByTestId(`org-node-authority-${LEAD_PUBKEY}`),
  ).toHaveText("Can use delegations");
  await expect(
    page.getByTestId(`org-node-authority-${EXEC_PUBKEY}`),
  ).toHaveText("Can use delegations");
  await expect(page.getByTestId("org-authority-warning")).toHaveCount(0);

  await waitForAnimations(page);
  await section.screenshot({ path: `${SHOTS}/01-active-grants.png` });
});

test("leaders on the chart with no active grants raise the authority gap", async ({
  page,
}) => {
  await installMockBridge(page, {
    employeeHeads: employeePayroll(),
    relayMembers: true,
  });

  const section = await openPeopleSection(page);

  await expect(page.getByTestId("org-active-delegations")).toHaveText(
    "0 active delegations, available to every Team lead and Chief of staff.",
  );
  await expect(page.getByTestId("org-authority-warning")).toBeVisible();
  await expect(page.getByTestId("org-authority-warning")).toContainText(
    "Escalated work has somewhere to go and no authority when it gets there.",
  );

  await waitForAnimations(page);
  await section.screenshot({ path: `${SHOTS}/02-no-grants-warning.png` });
});

test("revoked grants do not count toward the line", async ({ page }) => {
  await installMockBridge(page, {
    employeeHeads: employeePayroll(),
    delegationGrantEvents: [
      grantHead({ grantId: "live", active: true, createdAt: 900 }),
      grantHead({ grantId: "revoked", active: false, createdAt: 950 }),
    ],
    relayMembers: true,
  });

  const section = await openPeopleSection(page);

  // The revoked head is newer; counting raw events would say two.
  await expect(page.getByTestId("org-active-delegations")).toHaveText(
    "1 active delegation, available to every Team lead and Chief of staff.",
  );
  await expect(page.getByTestId("org-authority-warning")).toHaveCount(0);

  await waitForAnimations(page);
  await section.screenshot({ path: `${SHOTS}/03-revoked-excluded.png` });
});

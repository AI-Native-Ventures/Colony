import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import {
  blockTags,
  canonicalJson,
  emitMessage,
  fixtureUuid,
  openChannel,
  OWNER_PUBKEY,
  readCoreManifest,
  sha256Text,
  signManifest,
  waitForLiveChannel,
} from "./blocks-test-helpers";

/**
 * Approving a Blueprint is the one Block action that creates something before
 * anything is published, so the seam between the button and the backend is
 * worth proving rather than assuming. These specs drive the real React
 * handler; only the Tauri commands and the relay are mocked.
 */

const REQUEST_ID = "3f6c1a2e-0000-4000-8000-000000000001";

/** A blueprint document, as the agent would embed it in the Block. */
const BLUEPRINT = canonicalJson({
  schema: "colony.company-blueprint/v1",
  requestId: REQUEST_ID,
  company: {
    id: "horizon-labs",
    tradingName: "Horizon Labs Café",
    summary: "Marketing websites.",
    businessType: "agency",
    services: [{ id: "web", name: "Web", description: "Sites" }],
    customerSegments: ["smb"],
  },
  roster: [
    { roleId: "chief-of-staff", personalName: "Fizz", enabled: true },
    { roleId: "cto", personalName: "Jason", enabled: true },
  ],
  teams: [
    {
      id: "engineering",
      name: "Engineering",
      description: "Builds",
      leadRoleId: "cto",
      memberRoleIds: ["cto"],
      kind: "baseline",
    },
  ],
  costCentres: [{ id: "internal", name: "Internal", kind: "internal" }],
  readinessGaps: [],
  proposedInitiatives: [1, 2, 3].map((index) => ({
    id: `init-${index}`,
    title: `Initiative ${index}`,
    summary: "First",
    ownerRoleId: "chief-of-staff",
    costCentreId: "internal",
    commercialPurpose: "administration",
  })),
});

function blueprintData(overrides: Record<string, unknown> = {}) {
  return {
    request_id: REQUEST_ID,
    blueprint_hash: sha256Text(BLUEPRINT),
    blueprint: BLUEPRINT,
    company_id: "horizon-labs",
    trading_name: "Horizon Labs Café",
    summary: "The smallest team that covers the work you described.",
    roster: [
      {
        role_id: "cto",
        role_title: "CTO",
        personal_name: "Jason",
        team: "Engineering",
        enabled: true,
      },
    ],
    teams: [
      {
        id: "engineering",
        name: "Engineering",
        lead: "Jason (CTO)",
        members: "Jason",
        accountable_for: "Client websites",
      },
    ],
    initiatives: [1, 2, 3].map((index) => ({
      title: `Initiative ${index}`,
      owner: "Fizz (Chief of Staff)",
      why_first: "Worth doing first",
    })),
    gaps: [{ label: "Pricing", cost_of_leaving_open: "No margin visibility." }],
    ...overrides,
  };
}

async function showBlueprint(
  page: import("@playwright/test").Page,
  data: Record<string, unknown>,
) {
  const manifest = readCoreManifest("company-blueprint");
  const manifestEvent = signManifest(manifest);
  await installMockBridge(page, {
    blockEvents: [manifestEvent],
    relaySelf: OWNER_PUBKEY,
    // The relay mints a community profile head for every community at boot
    // (`run_profile_backfill`), so approval always edits that head. Without
    // this, `getActiveCompanyHead()` finds nothing and the approve flow
    // never reaches `execute_company_blueprint` at all.
    communityProfileHead: {
      signerSecretHex: TEST_IDENTITIES.tyler.privateKey,
    },
  });
  await openChannel(page, "general");
  // Without a live subscription the mock bridge silently drops the message.
  await waitForLiveChannel(page, "general");
  await emitMessage(page, {
    channelName: "general",
    content: "Here is the company I'd propose.",
    kind: 9,
    extraTags: blockTags({
      data,
      handle: "company-blueprint",
      instanceId: fixtureUuid(91),
      manifestId: manifestEvent.id,
      // The Chief of Staff published this proposal, and the record of the
      // decision is addressed back to it.
      processorPubkey: OWNER_PUBKEY,
    }),
  });
  return manifestEvent;
}

/** Every Tauri command the app called, in order. */
async function commandLog(page: import("@playwright/test").Page) {
  return await page.evaluate(
    () =>
      (
        window as unknown as {
          __BUZZ_E2E_COMMAND_LOG__?: Array<{
            command: string;
            payload: unknown;
          }>;
        }
      ).__BUZZ_E2E_COMMAND_LOG__ ?? [],
  );
}

test("approving sends the exact document the block carries", async ({
  page,
}) => {
  await showBlueprint(page, blueprintData());

  await page
    .getByRole("button", { name: /approve and create the company/i })
    .click();

  await expect
    .poll(async () =>
      (await commandLog(page)).some(
        (entry) => entry.command === "execute_company_blueprint",
      ),
    )
    .toBe(true);
  const log = await commandLog(page);
  const executed = log.find(
    (entry) => entry.command === "execute_company_blueprint",
  );
  const payload = executed?.payload as Record<string, unknown>;

  expect(payload.blueprint).toBe(BLUEPRINT);
  expect(payload.requestId).toBe(REQUEST_ID);
  expect(payload.expectedHash).toBe(sha256Text(BLUEPRINT));
  // The relay's own key addresses the company's records.
  expect(payload.relayPubkey).toBe(OWNER_PUBKEY);
  // The bug this spec exists to catch: approval must read the profile head
  // the relay already minted at boot and carry it through as the
  // compare-and-set token, rather than asserting a fresh head into
  // existence (which the relay refuses unconditionally once one exists).
  expect(payload.expectedHeadEventId).toMatch(/^[0-9a-f]{64}$/);
  expect(payload.expectedHeadCreatedAt).toBe(1_780_000_000);
  expect(payload.expectedHeadUpdatedAt).toBe(1_780_000_000);
});

// The dangerous half. By the time publishing runs the employees exist, so a
// publish that fails must not mark the transaction complete: a resumed run
// would then skip a write that never landed. The owner is told their team was
// created rather than shown a failure, which would invite approving twice.
test("a company that cannot be announced is not marked complete", async ({
  page,
}) => {
  await showBlueprint(page, blueprintData());

  await page
    .getByRole("button", { name: /approve and create the company/i })
    .click();

  await expect
    .poll(async () =>
      (await commandLog(page)).some(
        (entry) => entry.command === "execute_company_blueprint",
      ),
    )
    .toBe(true);

  // The mock returns an unpublishable action, standing in for a relay that is
  // unreachable at exactly the wrong moment.
  await expect(page.getByText(/your team was created/i)).toBeVisible({
    timeout: 10_000,
  });

  const commands = (await commandLog(page)).map((entry) => entry.command);
  expect(commands).not.toContain("complete_company_blueprint");
});

// A Block is agent-authored, so an instance missing the document it proposes
// is an expected input. Approving on it would execute a document the owner
// never saw a hash of.
test("a blueprint missing its document cannot be approved", async ({
  page,
}) => {
  await showBlueprint(page, blueprintData({ blueprint: "" }));

  // The control's inputs are derived from the instance, so an instance with
  // no document produces none and the control stays unusable. Failing closed
  // beats erroring on click: there is nothing here the owner could approve.
  await expect(
    page.getByRole("button", { name: /approve and create the company/i }),
  ).toBeDisabled();

  const commands = (await commandLog(page)).map((entry) => entry.command);
  expect(commands).not.toContain("execute_company_blueprint");
});

test("asking for changes creates no company", async ({ page }) => {
  await showBlueprint(page, blueprintData());

  // This used to assert that an "Ask for changes" button was visible, and it
  // passed for as long as that button was dead: the control declared a
  // required input nothing supplied, so it rendered permanently disabled and
  // visibility was the most the test could claim. The request now goes through
  // the question that collects the words, so assert the owner can actually
  // make one, and that making it still creates no company.
  const question = page.locator(
    '[data-block-handle="company-blueprint"] [data-block-primitive="question"]',
  );
  await expect(question).toBeVisible();
  const submit = question.getByRole("button", { name: "Submit" });
  await expect(
    submit,
    "a change request with no words is a rejection with extra steps",
  ).toBeDisabled();
  await question
    .getByLabel("Something else")
    .fill("The roster is missing whoever runs support.");
  await expect(submit).toBeEnabled();
  await submit.click();

  const commands = (await commandLog(page)).map((entry) => entry.command);
  expect(commands).not.toContain("execute_company_blueprint");
  expect(commands).not.toContain("complete_company_blueprint");
});

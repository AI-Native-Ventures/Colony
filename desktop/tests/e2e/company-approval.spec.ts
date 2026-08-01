import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";
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
 * UNFINISHED. These specs do not pass yet, and the reason is worth recording
 * rather than deleting.
 *
 * The Block renders, its manifest is trusted, and both controls appear. The
 * approve control reaches `submitBlockAction`, which signs and publishes the
 * record of the decision. What does not happen is the local half:
 * `execute_company_blueprint` is never invoked, so no company is created.
 *
 * The wiring lives in BlockRenderContext's submit handler, and the derived
 * action inputs are unit-tested in blueprintApproval.test.mjs, so the gap is
 * somewhere between the actions primitive's control invocation and that
 * handler. Marked fixme instead of deleted because the assertions themselves
 * are the specification of what approving should do.
 *
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

test.fixme("approving sends the exact document the block carries", async ({
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
});

// The employees are created before the decision is recorded, so a relay that
// refuses the record cannot leave an owner holding a company they were told
// was created.
test.fixme("the company is created before the decision is published", async ({
  page,
}) => {
  await showBlueprint(page, blueprintData());

  await page
    .getByRole("button", { name: /approve and create the company/i })
    .click();

  await expect
    .poll(async () =>
      (await commandLog(page)).some(
        (entry) => entry.command === "complete_company_blueprint",
      ),
    )
    .toBe(true);

  const commands = (await commandLog(page)).map((entry) => entry.command);
  expect(commands.indexOf("execute_company_blueprint")).toBeLessThan(
    commands.indexOf("complete_company_blueprint"),
  );
});

// A Block is agent-authored, so an instance missing the document it proposes
// is an expected input. Approving on it would execute a document the owner
// never saw a hash of.
test.fixme("a blueprint missing its document cannot be approved", async ({
  page,
}) => {
  await showBlueprint(page, blueprintData({ blueprint: "" }));

  await page
    .getByRole("button", { name: /approve and create the company/i })
    .click();

  await expect(page.getByText(/missing the document it proposes/i)).toBeVisible(
    { timeout: 10_000 },
  );

  const commands = (await commandLog(page)).map((entry) => entry.command);
  expect(commands).not.toContain("execute_company_blueprint");
});

// Asking for changes is not approval. It must publish the request and create
// nothing.
test.fixme("asking for changes creates no company", async ({ page }) => {
  await showBlueprint(page, blueprintData());
  await page.getByRole("button", { name: /ask for changes/i }).click();

  await page.waitForTimeout(1_000);
  const commands = (await commandLog(page)).map((entry) => entry.command);
  expect(commands).not.toContain("execute_company_blueprint");
  expect(commands).not.toContain("complete_company_blueprint");
});

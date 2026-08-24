import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

const SHOTS = "test-results/context-surfaces-screenshots";

// The mock fixtures these pubkeys belong to live in e2eBridge.ts:
// mira is a profile-only agent in #general, charlie a bot member of #agents,
// nadia an owned relay agent in #agents, and deadbeef… the active identity
// (the community owner). Employee heads are seeded per spec so each shot
// controls its own payroll and reporting lines.
const MIRA_PUBKEY =
  "8f83d6b7f3d74f7d933ae3a54dd8c6cc85c7f98e531c16e5a827b953441a8d67";
const CHARLIE_PUBKEY =
  "554cef57437abac34522ac2c9f0490d685b72c80478cf9f7ed6f9570ee8624ea";
const NADIA_PUBKEY =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00";
const OWNER_PUBKEY = "deadbeef".repeat(8);
const RELAY_PUBKEY =
  "ee1122334455566778899900aabbccddeeff00112233445566778899aabbccff";

// A real ladder: mira reports to nadia, nadia to charlie, charlie to nobody.
const LADDER_HEADS = [
  {
    pubkey: MIRA_PUBKEY,
    role: "researcher",
    name: "mira",
    rank: "worker",
    manager: NADIA_PUBKEY,
  },
  {
    pubkey: NADIA_PUBKEY,
    role: "team-lead",
    name: "nadia",
    rank: "leader",
    manager: CHARLIE_PUBKEY,
  },
  {
    pubkey: CHARLIE_PUBKEY,
    role: "chief-of-staff",
    name: "charlie",
    rank: "executive",
  },
] as const;

const PRIOR_ASK_ID = "b".repeat(64);
const PROMOTED_ASK_ID = "c".repeat(64);

function askEvent({
  id,
  pubkey,
  createdAt,
  audiencePubkey,
  extraTags = [],
}: {
  id: string;
  pubkey: string;
  createdAt: number;
  audiencePubkey: string;
  extraTags?: string[][];
}) {
  return {
    id,
    pubkey,
    created_at: createdAt,
    kind: 44300,
    tags: [["p", audiencePubkey], ...extraTags],
    content: JSON.stringify({
      type: "decision",
      headline: "Choose the launch vendor",
      cost_of_delay: "onboarding is blocked",
    }),
    sig: "mocksig".repeat(20).slice(0, 128),
  };
}

type EmitWindow = Window & {
  __BUZZ_E2E_EMIT_MOCK_EVENT__?: (input: {
    channelName: string;
    event: ReturnType<typeof askEvent>;
  }) => unknown;
  __BUZZ_E2E_QUERY_CLIENT__?: {
    invalidateQueries: (filters: {
      queryKey: readonly unknown[];
    }) => Promise<unknown>;
  };
};

test("profile panel shows the reporting line under the rank", async ({
  page,
}) => {
  await installMockBridge(page, { employeeHeads: [...LADDER_HEADS] });
  await page.goto("/");

  await page.getByTestId("channel-agents").click();
  await expect(page.getByTestId("chat-title")).toHaveText("agents");

  await page.getByTestId("channel-members-trigger").click();
  const sidebar = page.getByTestId("members-sidebar");

  // Nadia is a team lead whose manager is charlie; her row says so right
  // next to the rank badge, and her panel carries the same line as a field.
  const nadiaRow = sidebar.getByTestId(`sidebar-member-${NADIA_PUBKEY}`);
  await expect(nadiaRow.getByTestId("agent-rank-badge")).toHaveText(
    "Team lead",
  );
  await expect(
    nadiaRow.getByTestId(`sidebar-member-reporting-line-${NADIA_PUBKEY}`),
  ).toContainText(/reports to\s*charlie/);

  await sidebar
    .getByTestId(`sidebar-member-open-profile-${NADIA_PUBKEY}`)
    .click();

  const panel = page.getByTestId("user-profile-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("user-profile-rank")).toContainText(
    "Team lead",
  );
  await expect(panel.getByTestId("user-profile-reports-to")).toContainText(
    "charlie",
  );

  await waitForAnimations(page);
  await panel.screenshot({ path: `${SHOTS}/01-profile-reporting-line.png` });
});

test("ask detail shows how the ask was routed", async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/");
  await expect(page.getByTestId("home-inbox")).toBeVisible();

  // A worker asked its leader; the deadline passed, and the relay signed a
  // successor addressed to the owner: new p tag, prior naming the original,
  // filer carrying the original filer forward.
  // The events are built here in Node, not inside `page.evaluate`: the
  // callback is serialized into the browser, so a helper defined in this
  // module is not in scope there.
  const now = Math.floor(Date.now() / 1_000);
  const priorEvent = askEvent({
    id: PRIOR_ASK_ID,
    pubkey: MIRA_PUBKEY,
    createdAt: now - 3_600,
    audiencePubkey: NADIA_PUBKEY,
  });
  const promotedEvent = askEvent({
    id: PROMOTED_ASK_ID,
    pubkey: RELAY_PUBKEY,
    createdAt: now - 60,
    audiencePubkey: OWNER_PUBKEY,
    extraTags: [
      ["prior", PRIOR_ASK_ID],
      ["filer", MIRA_PUBKEY],
    ],
  });
  await page.evaluate(
    ({ events }) => {
      const win = window as EmitWindow;
      for (const event of events) {
        win.__BUZZ_E2E_EMIT_MOCK_EVENT__?.({ channelName: "general", event });
      }
      void win.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({
        queryKey: ["open-asks"],
      });
    },
    { events: [priorEvent, promotedEvent] },
  );

  const askRow = page.getByTestId(`home-inbox-item-${PROMOTED_ASK_ID}`);
  await expect(askRow).toBeVisible();
  await expect(askRow).toContainText("Promoted up the ladder");
  await askRow.click();

  const card = page.getByTestId("ask-detail-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("ask-routing-promoted")).toContainText(
    "Promoted up the ladder by the relay",
  );
  await expect(card.getByTestId("ask-routing-promoted")).toContainText(
    "was addressed to nadia",
  );

  await waitForAnimations(page);
  await card.screenshot({ path: `${SHOTS}/02-ask-routing.png` });
});

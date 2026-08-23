import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";
import type { RelayEvent } from "../../src/shared/api/types";

const SHOTS = "test-results/decision-log-screenshots";

// Same fixture payroll as org-delegation-authority-screenshots.spec.ts: a
// minted executive, her team lead, and a worker. Distinct pubkeys from every
// other spec file.
const EXEC_PUBKEY = "11111111".repeat(8);
const LEAD_PUBKEY = "22222222".repeat(8);
const WORKER_PUBKEY = "33333333".repeat(8);

// Fixed timestamps so newest-first ordering is deterministic across runs.
const T1 = 1_800_000_100;
const T2 = 1_800_000_200;
const T3 = 1_800_000_300;

let eventSeq = 0;

function decisionLog({
  author,
  createdAt,
  grantId,
  category,
  decision,
  undoPath,
  amountNanoUsd,
}: {
  author: string;
  createdAt: number;
  grantId: string;
  category: string;
  decision: string;
  undoPath: string;
  amountNanoUsd?: number;
}): RelayEvent {
  eventSeq += 1;
  const tags: string[][] = [
    ["grant", grantId],
    ["task", `task-${eventSeq}`],
  ];
  const content: Record<string, unknown> = {
    decision,
    undo_path: undoPath,
    category,
  };
  if (amountNanoUsd !== undefined) {
    content.amount_nano_usd = amountNanoUsd;
  }
  return {
    id: `dd${String(eventSeq).padStart(62, "0")}`,
    pubkey: author,
    created_at: createdAt,
    kind: 44303,
    tags,
    content: JSON.stringify(content),
    sig: "f".repeat(128),
  };
}

async function openLeadDecisionLog(page: Page) {
  await page.goto("/#/agents?section=people");
  const entry = page.getByTestId(`decision-log-entry-${LEAD_PUBKEY}`);
  await expect(entry).toBeVisible();
  await entry.click();
  const dialog = page.getByTestId("decision-log-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("decision-log-list")).toBeVisible();
  return dialog;
}

test("the log opens scoped to the deciding agent, undo paths leading", async ({
  page,
}) => {
  await installMockBridge(page, {
    employeeHeads: [
      {
        pubkey: EXEC_PUBKEY,
        role: "chief-of-staff",
        name: "charlie",
        rank: "executive",
      },
      {
        pubkey: LEAD_PUBKEY,
        role: "team-lead",
        name: "nadia",
        rank: "leader",
        manager: EXEC_PUBKEY,
      },
      {
        pubkey: WORKER_PUBKEY,
        role: "researcher",
        name: "mira",
        rank: "worker",
        manager: LEAD_PUBKEY,
      },
    ],
    delegationGrantEvents: [
      {
        id: "ee0001".padEnd(64, "0"),
        pubkey: "deadbeef".repeat(8),
        created_at: 900,
        kind: 30189,
        tags: [["d", "vendors"]],
        content: JSON.stringify({
          category: "vendor selection",
          scope: "under 50 dollars per decision",
          cap_nano_usd: 50_000_000_000,
          active: true,
        }),
        sig: "f".repeat(128),
      },
      {
        id: "ee0002".padEnd(64, "0"),
        pubkey: "deadbeef".repeat(8),
        created_at: 800,
        kind: 30189,
        tags: [["d", "copy-delegation"]],
        content: JSON.stringify({
          category: "copy change",
          scope: "blog titles",
          active: true,
        }),
        sig: "f".repeat(128),
      },
    ],
    decisionLogEvents: [
      // Oldest first in source order; the view must reverse them.
      decisionLog({
        author: EXEC_PUBKEY,
        createdAt: T1,
        grantId: "vendors",
        category: "vendor selection",
        decision: "Renewed Acme support for another quarter",
        undoPath: "buzz vendor renew --undo acme-q4",
        amountNanoUsd: 40_000_000_000,
      }),
      decisionLog({
        author: LEAD_PUBKEY,
        createdAt: T2,
        grantId: "copy-delegation",
        category: "copy change",
        decision: "Reworded the pricing page headline",
        undoPath: "git revert abc1234 on marketing-site",
      }),
      decisionLog({
        author: LEAD_PUBKEY,
        createdAt: T3,
        grantId: "vendors",
        category: "vendor selection",
        decision: "Switched blog illustrations to Acme",
        undoPath: "buzz vendor switch-back acme-prev",
        amountNanoUsd: 50_000_000_000,
      }),
    ],
    relayMembers: true,
  });

  const dialog = await openLeadDecisionLog(page);

  // Scoped to the clicked agent, newest first.
  const rows = page.getByTestId("decision-log-list").locator("> li");
  await expect(rows).toHaveCount(2);
  const undoTexts = await page
    .locator("[data-testid^='decision-log-undo-']")
    .allTextContents();
  expect(undoTexts).toEqual([
    "buzz vendor switch-back acme-prev",
    "git revert abc1234 on marketing-site",
  ]);

  // The row leads with its undo path and states what moved.
  const firstRow = rows.first();
  await expect(
    firstRow.locator("[data-testid^='decision-log-amount-']"),
  ).toHaveText("$50.00");

  await waitForAnimations(page);
  await dialog.screenshot({ path: `${SHOTS}/01-agent-scoped.png` });
});

test("widening and narrowing filters changes the visible record", async ({
  page,
}) => {
  await installMockBridge(page, {
    employeeHeads: [
      {
        pubkey: EXEC_PUBKEY,
        role: "chief-of-staff",
        name: "charlie",
        rank: "executive",
      },
      {
        pubkey: LEAD_PUBKEY,
        role: "team-lead",
        name: "nadia",
        rank: "leader",
        manager: EXEC_PUBKEY,
      },
      {
        pubkey: WORKER_PUBKEY,
        role: "researcher",
        name: "mira",
        rank: "worker",
        manager: LEAD_PUBKEY,
      },
    ],
    delegationGrantEvents: [
      {
        id: "ee0001".padEnd(64, "0"),
        pubkey: "deadbeef".repeat(8),
        created_at: 900,
        kind: 30189,
        tags: [["d", "vendors"]],
        content: JSON.stringify({
          category: "vendor selection",
          scope: "under 50 dollars per decision",
          cap_nano_usd: 50_000_000_000,
          active: true,
        }),
        sig: "f".repeat(128),
      },
      {
        id: "ee0002".padEnd(64, "0"),
        pubkey: "deadbeef".repeat(8),
        created_at: 800,
        kind: 30189,
        tags: [["d", "copy-delegation"]],
        content: JSON.stringify({
          category: "copy change",
          scope: "blog titles",
          active: true,
        }),
        sig: "f".repeat(128),
      },
    ],
    decisionLogEvents: [
      decisionLog({
        author: EXEC_PUBKEY,
        createdAt: T1,
        grantId: "vendors",
        category: "vendor selection",
        decision: "Renewed Acme support for another quarter",
        undoPath: "buzz vendor renew --undo acme-q4",
        amountNanoUsd: 40_000_000_000,
      }),
      decisionLog({
        author: LEAD_PUBKEY,
        createdAt: T2,
        grantId: "copy-delegation",
        category: "copy change",
        decision: "Reworded the pricing page headline",
        undoPath: "git revert abc1234 on marketing-site",
      }),
      decisionLog({
        author: LEAD_PUBKEY,
        createdAt: T3,
        grantId: "vendors",
        category: "vendor selection",
        decision: "Switched blog illustrations to Acme",
        undoPath: "buzz vendor switch-back acme-prev",
        amountNanoUsd: 50_000_000_000,
      }),
    ],
    relayMembers: true,
  });

  const dialog = await openLeadDecisionLog(page);
  const rows = page.getByTestId("decision-log-list").locator("> li");
  await expect(rows).toHaveCount(2);

  // Widen past the entry point's agent pre-filter: the whole record shows.
  await page
    .getByTestId("decision-log-filter-agent")
    .selectOption({ label: "All agents" });
  await expect(rows).toHaveCount(3);

  // Narrow by grant: both of the lead's records sit under her copy grant...
  await page
    .getByTestId("decision-log-filter-grant")
    .selectOption({ label: "copy-delegation" });
  await expect(rows).toHaveCount(1);

  // ...and no vendor-grant decision was ever a copy decision: fail closed
  // to an explicit empty state rather than silently showing anything.
  await page
    .getByTestId("decision-log-filter-grant")
    .selectOption({ label: "vendors" });
  await page
    .getByTestId("decision-log-filter-category")
    .selectOption({ label: "copy change" });
  await expect(page.getByTestId("decision-log-filtered-empty")).toBeVisible();

  // Back to a populated, differently-filtered state for the second shot.
  await page
    .getByTestId("decision-log-filter-category")
    .selectOption({ label: "All categories" });
  await expect(rows).toHaveCount(2);
  // Newest first across both deciding agents.
  const undoTexts = await page
    .locator("[data-testid^='decision-log-undo-']")
    .allTextContents();
  expect(undoTexts).toEqual([
    "buzz vendor switch-back acme-prev",
    "buzz vendor renew --undo acme-q4",
  ]);

  await waitForAnimations(page);
  await dialog.screenshot({ path: `${SHOTS}/02-filtered.png` });
});

async function waitForMockLiveSubscription(page: Page, channelName: string) {
  await expect
    .poll(() =>
      page.evaluate(
        ({ channelName }) =>
          window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
            channelName,
          }) ?? false,
        { channelName },
      ),
    )
    .toBe(true);
}

test("the agent's profile carries the decision log ingress", async ({
  page,
}) => {
  await installMockBridge(page, {
    relayAgents: [{ pubkey: LEAD_PUBKEY, name: "nadia" }],
    decisionLogEvents: [
      decisionLog({
        author: LEAD_PUBKEY,
        createdAt: T3,
        grantId: "vendors",
        category: "vendor selection",
        decision: "Switched blog illustrations to Acme",
        undoPath: "buzz vendor switch-back acme-prev",
        amountNanoUsd: 50_000_000_000,
      }),
    ],
    relayMembers: true,
  });

  // Open the deciding agent's profile the way a viewer does: from a message
  // they authored.
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");
  await page.evaluate(
    ({ pubkey }) => {
      const emit = (
        window as Window & {
          __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
            channelName: string;
            content: string;
            pubkey: string;
          }) => unknown;
        }
      ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__;
      if (!emit) {
        throw new Error("Mock message emitter is unavailable.");
      }
      emit({
        channelName: "general",
        content: "The Acme switch is done and reversible",
        pubkey,
      });
    },
    { pubkey: LEAD_PUBKEY },
  );

  const row = page
    .getByTestId("message-row")
    .filter({ hasText: "The Acme switch is done and reversible" });
  await expect(row).toBeVisible();
  await row.locator("button").first().click();
  await expect(page.getByTestId("user-profile-panel")).toBeVisible();

  const ingress = page.getByTestId(`user-profile-decision-log-${LEAD_PUBKEY}`);
  await expect(ingress).toBeVisible();
  await ingress.click();
  await expect(page.getByTestId("decision-log-dialog")).toBeVisible();
  const rows = page.getByTestId("decision-log-list").locator("> li");
  await expect(rows).toHaveCount(1);
});

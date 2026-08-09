import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

const AGENT_PUBKEY =
  "554cef57437abac34522ac2c9f0490d685b72c80478cf9f7ed6f9570ee8624ea";

async function openManagedAgentRuntime(page: import("@playwright/test").Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("channel-agents").click();
  await expect(page.getByTestId("chat-title")).toHaveText("agents");
  const message = page.getByTestId("message-row").filter({
    has: page.getByText("Colony Agent", { exact: false }),
  });
  await expect(message.first()).toBeVisible({ timeout: 10_000 });
  await message.first().getByRole("button").first().click();
  const panel = page.getByTestId("user-profile-panel");
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await panel.getByRole("tab", { name: "Runtime" }).click();
  await expect(panel.getByTestId("user-profile-runtime")).toBeVisible();
  return panel;
}

async function seedDenial(
  page: import("@playwright/test").Page,
  status: 401 | 402,
) {
  await page.evaluate(
    ({ agentPubkey, status: denialStatus }) => {
      const e2eWindow = window as Window & {
        __BUZZ_E2E_SEED_OBSERVER_EVENTS__?: (input: {
          agentPubkey: string;
          events: Array<{
            seq: number;
            timestamp: string;
            kind: string;
            agentIndex: number | null;
            channelId: string | null;
            sessionId: string | null;
            turnId: string | null;
            payload: unknown;
          }>;
        }) => void;
      };
      e2eWindow.__BUZZ_E2E_SEED_OBSERVER_EVENTS__?.({
        agentPubkey,
        events: [
          {
            seq: 1,
            timestamp: "2026-08-08T00:00:00.000Z",
            kind: "turn_error",
            agentIndex: 0,
            channelId: "agents",
            sessionId: "session-1",
            turnId: "turn-1",
            payload: {
              gateway_status: denialStatus,
              gateway_marker: `COLONY_CREDITS_GATEWAY_STATUS_${denialStatus}`,
              action: "reconnect",
              error: "meter denial",
            },
          },
        ],
      });
    },
    { agentPubkey: AGENT_PUBKEY, status },
  );
}

for (const status of [401, 402] as const) {
  test(`renders one ${status} reconnect action and catches a failed rotation`, async ({
    page,
  }) => {
    await installMockBridge(page, {
      managedAgents: [
        {
          pubkey: AGENT_PUBKEY,
          name: "Colony Agent",
          status: "running",
          channelNames: ["agents"],
        },
      ],
      colonyCreditsReconnectError: "gateway unavailable during reconnect",
    });

    const panel = await openManagedAgentRuntime(page);
    await seedDenial(page, status);

    const recovery = panel.getByTestId("colony-credits-recovery");
    await expect(recovery).toBeVisible();
    const reconnect = recovery.getByTestId(
      "managed-agent-colony-credits-reconnect",
    );
    await expect(reconnect).toHaveCount(1);
    if (status === 402) {
      await expect(recovery).toContainText("top up");
    }
    await reconnect.click();
    await expect(
      recovery.getByTestId("managed-agent-colony-credits-reconnect-error"),
    ).toHaveText("Reconnect failed — try again.");
    await expect(
      recovery.getByTestId("managed-agent-colony-credits-reconnect"),
    ).toHaveCount(1);
  });
}

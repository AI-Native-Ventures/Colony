/**
 * The Activity pane when a fallback answered.
 *
 * What a unit test cannot cover: the model on the usage payload reaches the
 * reply it belongs to through the live observer store, and the pane says which
 * model answered instead of leaving a fallback turn indistinguishable from a
 * primary one.
 */
import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const AGENT_PUBKEY = TEST_IDENTITIES.tyler.pubkey;
const CHANNEL_ID = "94a444a4-c0a3-5966-ab05-530c6ddc2301"; // #agents
const NOW = "2026-09-15T12:00:00.000Z";
const PRIMARY = "z/primary:free";
const FALLBACK = "a/one:free";

const MANAGED_AGENTS = [
  {
    pubkey: AGENT_PUBKEY,
    name: "Observer Agent",
    status: "running" as const,
    channelNames: ["agents"],
  },
];

const GLOBAL_CONFIG = {
  credential_mode: "byok" as const,
  env_vars: { OPENROUTER_API_KEY: "sk-test" },
  fallback_models: [FALLBACK, "b/two:free"],
  model: PRIMARY,
  preferred_runtime: "buzz-agent",
  provider: "openrouter",
};

function sessionUpdate(seq: number, update: Record<string, unknown>) {
  return {
    seq,
    timestamp: NOW,
    kind: "acp_read",
    agentIndex: 0,
    channelId: CHANNEL_ID,
    sessionId: "session-001",
    turnId: "turn-001",
    payload: {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "session-001", update },
    },
  };
}

const REPLY = sessionUpdate(1, {
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: "Done, the report is in the channel." },
});

function usage(model: string) {
  return sessionUpdate(2, {
    sessionUpdate: "usage_update",
    used: 1200,
    size: 200000,
    model,
  });
}

async function openActivityPanel(page: import("@playwright/test").Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__ === "function",
    null,
    { timeout: 10_000 },
  );
  await page.getByTestId("channel-agents").click();
  await expect(page.getByTestId("chat-title")).toHaveText("agents");

  const messageRow = page
    .getByTestId("message-row")
    .filter({ has: page.getByText("Observer Agent", { exact: false }) });
  await expect(messageRow.first()).toBeVisible({ timeout: 8_000 });
  await messageRow.first().getByRole("button").first().click();
  await expect(page.getByTestId("user-profile-panel")).toBeVisible({
    timeout: 10_000,
  });
  await page.getByTestId(`user-profile-view-activity-${AGENT_PUBKEY}`).click();
  const panel = page.getByTestId("agent-session-thread-panel");
  await expect(panel).toBeVisible({ timeout: 10_000 });
  return panel;
}

async function seed(
  page: import("@playwright/test").Page,
  events: ReturnType<typeof sessionUpdate>[],
) {
  await page.evaluate(
    ({ pubkey, evts }) => {
      window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__?.({
        agentPubkey: pubkey,
        events: evts,
      });
    },
    { pubkey: AGENT_PUBKEY, evts: events },
  );
}

test("a reply served by a fallback says which model answered", async ({
  page,
}) => {
  await installMockBridge(page, {
    globalAgentConfig: GLOBAL_CONFIG,
    managedAgents: MANAGED_AGENTS,
  });
  const panel = await openActivityPanel(page);
  await seed(page, [REPLY, usage(FALLBACK)]);

  await expect(panel.getByTestId("transcript-served-model")).toHaveText(
    `Answered by ${FALLBACK}, fallback 1 of 2`,
    { timeout: 10_000 },
  );
});

test("a reply served by the agent's own model says nothing", async ({
  page,
}) => {
  await installMockBridge(page, {
    globalAgentConfig: GLOBAL_CONFIG,
    managedAgents: MANAGED_AGENTS,
  });
  const panel = await openActivityPanel(page);
  await seed(page, [REPLY, usage(PRIMARY)]);

  await expect(panel.getByTestId("transcript-assistant-message")).toBeVisible({
    timeout: 10_000,
  });
  await expect(panel.getByTestId("transcript-served-model")).toHaveCount(0);
});

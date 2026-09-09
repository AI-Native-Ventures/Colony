import { expect, test, type Page } from "@playwright/test";
import type { QueryClient } from "@tanstack/react-query";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { hexToBytes } from "@noble/hashes/utils.js";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";
import { waitForAnimations } from "../helpers/animations";
import {
  firstJobSuggestionBody,
  firstJobSuggestionTag,
} from "../../src/features/onboarding/firstJobSuggestion";
import { firstJobStorageKey } from "../../src/features/onboarding/firstJobStorage";
import type { RelayEvent } from "../../src/shared/api/types";

// This is the actual React app with native/relay/payment fixtures. No hosted
// payment, process or model call is made. Native worker output is a separate gate.
const CHANNEL = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
const OWNER = TEST_IDENTITIES.tyler;
const SCOUT = getPublicKey(new Uint8Array(32).fill(3));
const WORKER = getPublicKey(new Uint8Array(32).fill(4));
const RELAY = "ws://localhost:3000";
const TASK = "horizon:first-job";
const TEAM = "horizon:coordination";
type FixtureWindow = Window & {
  __BUZZ_E2E_INVOKE_MOCK_COMMAND__?: (
    command: string,
    payload?: Record<string, unknown>,
  ) => Promise<unknown>;
  __BUZZ_E2E_EMIT_MOCK_EVENT__?: (input: {
    channelName: string;
    event: RelayEvent;
  }) => RelayEvent;
  __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
    channelName: string;
    kind?: number;
  }) => boolean;
  __BUZZ_E2E_QUERY_CLIENT__?: QueryClient;
  __BUZZ_E2E_SET_COLONY_CREDITS__?: (input: {
    availableNanousd?: string;
    error?: string | null;
  }) => void;
  __BUZZ_E2E_COMMANDS__?: string[];
  __BUZZ_E2E_PUBLISHED_EVENTS__?: RelayEvent[];
};
const sign = (input: Parameters<typeof finalizeEvent>[0]) =>
  finalizeEvent(input, hexToBytes(OWNER.privateKey));
const head = (pubkey: string, tier: string) =>
  sign({
    kind: 30177,
    created_at: 1780000000,
    tags: [["d", pubkey]],
    content: JSON.stringify({ name: "Fixture teammate", tier }),
  });

async function setup(
  page: Page,
  options: {
    staffed?: boolean;
    funded?: boolean;
    dark?: boolean;
    businessReady?: boolean;
  } = {},
) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await seedActiveIdentity(page, OWNER);
  await page.addInitScript(
    ({ owner, relay, dark }) => {
      localStorage.setItem("buzz-theme", dark ? "buzz-dark" : "buzz");
      localStorage.setItem("buzz-follow-system", "false");
      localStorage.setItem("buzz-accent-color", "#895AF6");
      localStorage.setItem("buzz.channels.threadViewMode", "split");
      localStorage.setItem(
        `colony.first-job-setup.v1:${JSON.stringify([owner, relay])}`,
        JSON.stringify({
          version: 1,
          ownerPubkey: owner,
          relayUrl: relay,
          mode: "explicit",
        }),
      );
    },
    { owner: OWNER.pubkey, relay: RELAY, dark: options.dark ?? false },
  );
  await page.route("http://localhost:3000/**", async (route) => {
    if (route.request().url().endsWith("/api/payments/packs")) {
      await route.fulfill({
        json: {
          currency: "ZAR",
          packs: [
            {
              id: "starter",
              name: "Starter",
              zarCents: 9000,
              usdCents: 500,
              grantNanousd: 5000000000,
            },
          ],
        },
      });
    } else if (route.request().url().endsWith("/api/payments/initialize")) {
      await route.fulfill({
        json: {
          reference: "fixture-checkout-one",
          authorizationUrl: "https://checkout.example.test/fixture",
        },
      });
    } else if (route.request().url().endsWith("/api/payments/verify")) {
      await route.fulfill({ json: { paid: true, usdCents: 500 } });
    } else await route.fulfill({ status: 404, json: {} });
  });
  await installMockBridge(page, {
    relaySelf: getPublicKey(new Uint8Array(32).fill(0x2b)),
    relayMembers: true,
    relayRole: "owner",
    globalAgentConfig: {
      credential_mode: "colony_credits",
      provider: "openai",
      model: "gpt-4o",
      preferred_runtime: "buzz-agent",
      env_vars: {},
    },
    colonyCreditsAccount: {
      balance_nanousd: options.funded ? "5000000000" : "0",
      available_balance_nanousd: options.funded ? "5000000000" : "0",
      currency: "USD",
      status: options.funded ? "active" : "depleted",
    },
    companyWorkContext:
      options.businessReady === false
        ? undefined
        : {
            taskId: TASK,
            owningTeamId: TEAM,
            qaPersonaId: "builtin:fizz",
            costCentreId: "general",
            tradingName: "Horizon Labs",
          },
    managedAgents: options.staffed
      ? [
          {
            pubkey: SCOUT,
            name: "Scout",
            personaId: "builtin:fizz",
            channelIds: [CHANNEL],
            status: "stopped",
          },
          {
            pubkey: WORKER,
            name: "Sarah",
            personaId: "fixture-writer",
            channelIds: [CHANNEL],
            status: "stopped",
          },
        ]
      : [],
    activePersonaIds: ["builtin:fizz"],
    personas: [
      {
        id: "fixture-writer",
        displayName: "Sarah",
        roleId: "writer",
        roleTitle: "Writer",
        systemPrompt: "Draft for review",
        isActive: true,
      },
    ],
    managedAgentHeadEvents: options.staffed
      ? [head(SCOUT, "executive"), head(WORKER, "worker")]
      : [],
  });
  await page.goto("/");
  await page.waitForFunction(() =>
    Boolean((window as FixtureWindow).__BUZZ_E2E_INVOKE_MOCK_COMMAND__),
  );
  await page.evaluate(async (channelId) => {
    const fixture = window as FixtureWindow;
    await fixture.__BUZZ_E2E_INVOKE_MOCK_COMMAND__?.("update_channel", {
      input: { channelId, name: "Welcome", visibility: "private" },
    });
    await fixture.__BUZZ_E2E_INVOKE_MOCK_COMMAND__?.("join_channel", {
      channelId,
    });
    await fixture.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries();
    window.location.hash = `/channels/${channelId}`;
  }, CHANNEL);
  await page.waitForFunction(() =>
    (window as FixtureWindow).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
      channelName: "Welcome",
      kind: 9,
    }),
  );
  const payload = {
    version: 1 as const,
    ownerPubkey: OWNER.pubkey,
    relayUrl: RELAY,
    channelId: CHANNEL,
    requestId: "first-job-e2e",
    businessName: "Horizon Labs",
    business:
      "We build websites and manage social media for small service businesses.",
    website: "",
    brief:
      'Draft five Instagram captions and five matching visual briefs for "Horizon Labs". Use the business context shared in this thread. Keep them ready for my review; do not create images or publish posts.',
  };
  const root = sign({
    kind: 9,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["h", CHANNEL], firstJobSuggestionTag(payload)],
    content: firstJobSuggestionBody(payload),
  });
  await page.evaluate((event) => {
    (window as FixtureWindow).__BUZZ_E2E_EMIT_MOCK_EVENT__?.({
      channelName: "Welcome",
      event,
    });
  }, root);
  const card = page.getByTestId("first-job-suggestion");
  await expect(card).toHaveCount(1);
  await expect(
    card.getByRole("button", { name: "Start this job" }),
  ).toBeVisible();
  return { root, payload, errors };
}
async function openThread(page: Page, root: RelayEvent) {
  await page.evaluate(
    ({ channel, id }) => {
      window.location.hash = `/channels/${channel}?thread=${id}&threadRootId=${id}`;
    },
    { channel: CHANNEL, id: root.id },
  );
  await expect(page.getByTestId("message-thread-panel")).toBeVisible();
}
async function setCredits(
  page: Page,
  input: { availableNanousd?: string; error?: string | null },
) {
  await page.evaluate(
    (next) => (window as FixtureWindow).__BUZZ_E2E_SET_COLONY_CREDITS__?.(next),
    input,
  );
}
async function commandCount(page: Page, command: string) {
  return page.evaluate(
    (name) =>
      (window as FixtureWindow).__BUZZ_E2E_COMMANDS__?.filter(
        (item) => item === name,
      ).length ?? 0,
    command,
  );
}

test("starting examples share the editable brief, respect Discovery access and never start work", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const { root, payload, errors } = await setup(page);
  await openThread(page, root);
  const cards = page.getByTestId("first-job-suggestion");
  await expect(cards).toHaveCount(2);
  const left = cards.nth(0),
    right = cards.nth(1);
  for (const card of [left, right]) {
    await expect(card.getByLabel("The brief", { exact: true })).toHaveValue(
      payload.brief,
    );
    await expect(card.getByTestId("first-job-outputs")).toContainText(
      "5 Instagram caption drafts",
    );
    await expect(card.getByTestId("first-job-outputs")).toContainText(
      "5 matching visual briefs",
    );
    await expect(
      card.getByRole("button", { name: "Find potential clients" }),
    ).toHaveCount(0);
  }
  const accessKey = [
    "first-job-discovery",
    OWNER.pubkey,
    RELAY,
    "e2e-default-community",
  ];
  // Fixture only: resolve the existing account/business-scoped access query.
  // It does not prove a live Discovery entitlement or create a campaign.
  await page.waitForFunction((key) => {
    const query = (
      window as FixtureWindow
    ).__BUZZ_E2E_QUERY_CLIENT__?.getQueryState(key);
    return query?.fetchStatus === "idle";
  }, accessKey);
  await page.evaluate((key) => {
    const client = (window as FixtureWindow).__BUZZ_E2E_QUERY_CLIENT__;
    client?.setQueryData([...key.slice(0, 3), "another-business"], true);
    client?.setQueryData(key, false);
  }, accessKey);
  await expect(
    left.getByRole("button", { name: "Find potential clients" }),
  ).toHaveCount(0);
  await page.evaluate((key) => {
    (window as FixtureWindow).__BUZZ_E2E_QUERY_CLIENT__?.setQueryData(
      key,
      true,
    );
  }, accessKey);
  await expect(
    right.getByRole("button", { name: "Find potential clients" }),
  ).toBeVisible();
  await page.evaluate(async (key) => {
    await (window as FixtureWindow).__BUZZ_E2E_QUERY_CLIENT__
      ?.fetchQuery({
        queryKey: key,
        staleTime: 0,
        retry: false,
        queryFn: async () => {
          throw new Error("Fixture access refresh failed");
        },
      })
      .catch(() => undefined);
  }, accessKey);
  await expect(
    right.getByRole("button", { name: "Find potential clients" }),
  ).toHaveCount(0);
  await expect(
    left.getByRole("button", { name: "Draft Instagram captions" }),
  ).toBeVisible();
  await page.evaluate(async (key) => {
    await (window as FixtureWindow).__BUZZ_E2E_QUERY_CLIENT__?.fetchQuery({
      queryKey: key,
      staleTime: 0,
      retry: false,
      queryFn: async () => true,
    });
  }, accessKey);
  await right.getByRole("button", { name: "Find potential clients" }).click();
  for (const card of [left, right]) {
    await expect(
      card.getByRole("button", { name: "Find potential clients" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(card.getByLabel("The brief", { exact: true })).toHaveValue(
      /^Find ten potential clients/,
    );
    await expect(card.getByTestId("first-job-outputs")).toContainText(
      "10 potential clients",
    );
  }
  await left.getByRole("button", { name: "Draft Instagram captions" }).click();
  await expect(right.getByLabel("The brief", { exact: true })).toHaveValue(
    payload.brief,
  );
  await page.mouse.move(0, 0);
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/first-job/06-starter-examples.png",
  });
  const custom = "Write one caption about our new monthly branding offer.";
  await right.getByLabel("The brief", { exact: true }).fill(custom);
  await expect(left.getByLabel("The brief", { exact: true })).toHaveValue(
    custom,
  );
  await expect(cards.getByTestId("first-job-outputs")).toHaveCount(0);
  expect(await commandCount(page, "attach_thread_task")).toBe(0);
  expect(await commandCount(page, "start_managed_agent_runtime")).toBe(0);
  expect(
    await page.evaluate(
      () =>
        (window as FixtureWindow).__BUZZ_E2E_PUBLISHED_EVENTS__?.some((event) =>
          event.tags.some(
            (tag) =>
              tag[0] === "client" && tag[1] === "colony:first-job-start:v1",
          ),
        ) ?? false,
    ),
  ).toBe(false);
  // Rehydrate the same accepted root after a full renderer reload. Only the
  // mock relay channel/event are re-injected; the saved brief is the app's own storage.
  await page.reload();
  await page.waitForFunction(() =>
    Boolean((window as FixtureWindow).__BUZZ_E2E_INVOKE_MOCK_COMMAND__),
  );
  await page.evaluate(async (channelId) => {
    const fixture = window as FixtureWindow;
    await fixture.__BUZZ_E2E_INVOKE_MOCK_COMMAND__?.("update_channel", {
      input: { channelId, name: "Welcome", visibility: "private" },
    });
    await fixture.__BUZZ_E2E_INVOKE_MOCK_COMMAND__?.("join_channel", {
      channelId,
    });
    await fixture.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries();
    window.location.hash = `/channels/${channelId}`;
  }, CHANNEL);
  await page.waitForFunction(() =>
    (window as FixtureWindow).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
      channelName: "Welcome",
      kind: 9,
    }),
  );
  await page.evaluate((event) => {
    (window as FixtureWindow).__BUZZ_E2E_EMIT_MOCK_EVENT__?.({
      channelName: "Welcome",
      event,
    });
  }, root);
  await expect(cards).toHaveCount(1);
  await expect(left.getByLabel("The brief", { exact: true })).toHaveValue(
    custom,
  );
  // The restored mock channel has finished mounting before its root is opened.
  // Use the real row action instead of racing a second raw hash assignment.
  const restoredRoot = page.locator(`[data-message-id="${root.id}"]`);
  await restoredRoot.hover();
  await restoredRoot
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await expect(page.getByTestId("message-thread-panel")).toBeVisible();
  await expect(cards).toHaveCount(2);
  for (const card of [left, right]) {
    await expect(card.getByLabel("The brief", { exact: true })).toHaveValue(
      custom,
    );
    await expect(card.getByTestId("first-job-outputs")).toHaveCount(0);
  }
  expect(await commandCount(page, "attach_thread_task")).toBe(0);
  expect(await commandCount(page, "start_managed_agent_runtime")).toBe(0);
  expect(errors).toEqual([]);
});

test("Welcome suggestion shares edits across adjacent panes and zero credits never start work", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { root, errors } = await setup(page);
  await openThread(page, root);
  const cards = page.getByTestId("first-job-suggestion");
  await expect(cards).toHaveCount(2);
  const left = cards.nth(0),
    right = cards.nth(1);
  await left
    .getByLabel("The brief", { exact: true })
    .fill(
      "Draft three positioning improvements for Horizon Labs, with reasons and next steps.",
    );
  await expect(right.getByLabel("The brief", { exact: true })).toHaveValue(
    "Draft three positioning improvements for Horizon Labs, with reasons and next steps.",
  );
  const labels = await cards
    .getByLabel("The brief", { exact: true })
    .evaluateAll((elements) => elements.map((element) => element.id));
  expect(new Set(labels).size).toBe(2);
  expect(await commandCount(page, "start_managed_agent_runtime")).toBe(0);
  await right.getByRole("button", { name: "Start this job" }).click();
  await expect(left).toHaveAttribute("data-phase", "needs-credits");
  await expect(right).toHaveAttribute("data-phase", "needs-credits");
  expect(await commandCount(page, "attach_thread_task")).toBe(0);
  expect(await commandCount(page, "start_managed_agent_runtime")).toBe(0);
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/first-job/01-welcome-shared-zero.png",
  });
  expect(errors).toEqual([]);
});

test("unknown credits remain an error and a funded business without an approved worker remains blocked", async ({
  page,
}) => {
  const { errors } = await setup(page);
  const card = page.getByTestId("first-job-suggestion");
  await setCredits(page, { error: "Fixture balance unavailable" });
  await card.getByRole("button", { name: "Start this job" }).click();
  await expect(card).toHaveAttribute("data-phase", "error");
  await expect(card.getByRole("alert")).toContainText(
    "Fixture balance unavailable",
  );
  await expect(
    card.getByRole("button", { name: "Add credits", exact: true }),
  ).toHaveCount(0);
  await setCredits(page, { error: null, availableNanousd: "5000000000" });
  await card.getByRole("button", { name: "Try again" }).click();
  await expect(card).toHaveAttribute("data-phase", "blocked");
  await expect(card.getByRole("button", { name: "Review team" })).toBeVisible();
  expect(await commandCount(page, "start_managed_agent_runtime")).toBe(0);
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/first-job/02-worker-unavailable.png",
  });
  expect(errors).toEqual([]);
});

test("a funded account without an approved company setup stays editable and creates no task", async ({
  page,
}) => {
  const { errors } = await setup(page, {
    staffed: true,
    funded: true,
    businessReady: false,
  });
  const card = page.getByTestId("first-job-suggestion");
  await card.getByRole("button", { name: "Start this job" }).click();
  await expect(card).toHaveAttribute("data-phase", "blocked");
  await expect(card.getByRole("alert")).toContainText(
    "could not find this business’s setup",
  );
  await expect(card.getByLabel("The brief", { exact: true })).toBeEditable();
  expect(await commandCount(page, "attach_thread_task")).toBe(0);
  expect(await commandCount(page, "start_managed_agent_runtime")).toBe(0);
  expect(errors).toEqual([]);
});

test("checkout return preserves the same brief and requires a separate Start", async ({
  page,
}) => {
  const { root, errors } = await setup(page);
  const card = page.getByTestId("first-job-suggestion");
  const brief = "Review the offer before making any public changes.";
  await card.getByLabel("The brief", { exact: true }).fill(brief);
  await card.getByRole("button", { name: "Start this job" }).click();
  await card.getByRole("button", { name: "Add credits", exact: true }).click();
  await card
    .getByLabel("Receipt email", { exact: true })
    .fill("owner@horizon.example");
  await card.getByRole("button", { name: /^Pay R/ }).click();
  await expect(
    card.getByRole("button", { name: "Open checkout again" }),
  ).toBeVisible();
  await card.getByRole("button", { name: "Explore for now" }).click();
  await page.evaluate(() => {
    window.location.hash = "/channels/9dae0116-799b-5071-a0a8-fdd30a91a35d";
  });
  await page.evaluate(
    ({ id, rootId }) => {
      window.location.hash = `/channels/${id}?thread=${rootId}&threadRootId=${rootId}`;
    },
    { id: CHANNEL, rootId: root.id },
  );
  const right = page
    .getByTestId("message-thread-panel")
    .getByTestId("first-job-suggestion");
  await expect(right.getByLabel("The brief", { exact: true })).toHaveValue(
    brief,
  );
  await setCredits(page, { availableNanousd: "5000000000" });
  await right
    .getByRole("button", { name: /Check.*credits|Check payment/ })
    .click();
  await expect(right.getByTestId("first-job-funded")).toBeVisible();
  await expect(page.getByTestId("sidebar-credits-balance")).toContainText(
    "$5.00",
  );
  await expect(
    right.getByRole("button", { name: "Start this job" }),
  ).toBeVisible();
  expect(await commandCount(page, "attach_thread_task")).toBe(0);
  expect(await commandCount(page, "start_managed_agent_runtime")).toBe(0);
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/first-job/03-checkout-return.png",
  });
  expect(errors).toEqual([]);
});

test("an approved fixture pair starts only on explicit Start and the task status comes from the relay", async ({
  page,
}) => {
  const { root, errors } = await setup(page, { staffed: true, funded: true });
  const card = page.getByTestId("first-job-suggestion");
  expect(await commandCount(page, "start_managed_agent_runtime")).toBe(0);
  await card.getByRole("button", { name: "Start this job" }).click();
  await expect(card).toHaveAttribute("data-phase", "sent");
  await expect(
    card.getByRole("group", { name: "Starting job examples" }),
  ).toHaveCount(0);
  await expect(card.getByTestId("first-job-status")).toHaveText("In progress");
  expect(await commandCount(page, "attach_thread_task")).toBe(1);
  expect(await commandCount(page, "start_managed_agent_runtime")).toBe(2);
  await expect(card.getByLabel("The brief", { exact: true })).toHaveAttribute(
    "readonly",
    "",
  );
  const instructions = await page.evaluate(
    () =>
      (window as FixtureWindow).__BUZZ_E2E_PUBLISHED_EVENTS__?.filter(
        (event) =>
          event.kind === 9 &&
          event.tags.some(
            (tag) =>
              tag[0] === "client" && tag[1] === "colony:first-job-start:v1",
          ),
      ) ?? [],
  );
  expect(instructions).toHaveLength(1);
  expect(instructions[0]?.tags.filter((tag) => tag[0] === "p")).toEqual([
    ["p", SCOUT],
  ]);
  expect(instructions[0]?.tags.filter((tag) => tag[0] === "mention")).toEqual([
    ["mention", WORKER],
  ]);
  await openThread(page, root);
  const instruction = page
    .getByTestId("message-thread-panel")
    .locator(`[data-message-id="${instructions[0]?.id}"]`);
  await expect(instruction).toContainText("Ask Sarah to do the work");
  await expect(instruction).not.toContainText("nostr:");
  await expect(instruction.locator("[data-mention]")).toHaveText("Sarah");
  await instruction.scrollIntoViewIfNeeded();
  await waitForAnimations(page);
  await page.getByTestId("message-thread-panel").screenshot({
    path: "test-results/first-job/06-friendly-worker-reference.png",
  });
  // Continue the receipt-recovery check through the original channel card.
  await page.evaluate((channel) => {
    window.location.hash = `/channels/${channel}`;
  }, CHANNEL);
  await expect(page.getByTestId("message-thread-panel")).toHaveCount(0);
  // Lose only the locally saved acknowledgement after the actual signed event
  // was accepted. Recovery must query that same event before a zero-credit gate.
  const dispatchKey = firstJobStorageKey(
    {
      ownerPubkey: OWNER.pubkey,
      relayUrl: RELAY,
      channelId: CHANNEL,
      threadRootId: root.id,
      requestId: "first-job-e2e",
    },
    "dispatch",
  );
  await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) throw new Error("The actual Start did not persist its attempt");
    const saved = JSON.parse(raw);
    if (!saved.value.acknowledged || !saved.value.message?.id)
      throw new Error("The fixture did not reach an accepted instruction");
    saved.value.acknowledged = false;
    localStorage.setItem(key, JSON.stringify(saved));
    window.dispatchEvent(
      new CustomEvent("colony:first-job-storage", { detail: key }),
    );
  }, dispatchKey);
  await expect(card).toHaveAttribute("data-phase", "uncertain");
  await setCredits(page, { availableNanousd: "0" });
  await card.getByRole("button", { name: "Check request" }).click();
  await expect(card).toHaveAttribute("data-phase", "sent");
  expect(await commandCount(page, "attach_thread_task")).toBe(1);
  expect(await commandCount(page, "start_managed_agent_runtime")).toBe(2);
  const recoveredInstructions = await page.evaluate(
    () =>
      (window as FixtureWindow).__BUZZ_E2E_PUBLISHED_EVENTS__
        ?.filter(
          (event) =>
            event.kind === 9 &&
            event.tags.some(
              (tag) =>
                tag[0] === "client" && tag[1] === "colony:first-job-start:v1",
            ),
        )
        .map((event) => event.id) ?? [],
  );
  expect(recoveredInstructions).toEqual([instructions[0]?.id]);
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/first-job/05-canonical-task-recovered.png",
  });
  expect(errors).toEqual([]);
});

for (const dark of [false, true]) {
  test(`first-job thread remains readable at360 in ${dark ? "dark" : "light"}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    const { root, errors } = await setup(page, { dark });
    await openThread(page, root);
    const card = page
      .getByTestId("message-thread-panel")
      .getByTestId("first-job-suggestion");
    await expect(
      card.getByRole("button", { name: "Start this job" }),
    ).toBeVisible();
    expect(
      await card.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    // Opening a thread can preserve its previous/bottom reading position.
    // Frame the screenshot at the actual top so sender and setup context are
    // visible; this does not alter the product's scrolling or dimensions.
    const body = page.getByTestId("message-thread-body");
    await body.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(
      card.getByRole("heading", { name: "A first job for Horizon Labs" }),
    ).toBeInViewport({ ratio: 1 });
    await waitForAnimations(page);
    const thread = page.getByTestId("message-thread-panel");
    const article = thread.locator(`[data-message-id="${root.id}"]`);
    for (const surface of [thread, article, card]) {
      const box = await surface.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(361);
      expect(
        await surface.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
    }
    await expect(article.getByTestId("message-author")).toBeInViewport({
      ratio: 1,
    });
    await expect(
      card.getByRole("heading", { name: "A first job for Horizon Labs" }),
    ).toBeInViewport({ ratio: 1 });
    await expect(card.locator("textarea")).toHaveCSS(
      "font-family",
      '"Inter Variable", Inter, "Avenir Next", "Segoe UI", sans-serif',
    );
    await page.mouse.move(0, 0);
    await waitForAnimations(page);
    await page.screenshot({
      path: `test-results/first-job/04-thread-${dark ? "dark" : "light"}-360.png`,
    });
    // A readable font and the community rail can make the brief taller than
    // the reading area. Prove ordinary scrolling reaches the action without
    // requiring the entire message to fit onscreen at once.
    await body.hover({ position: { x: 10, y: 100 } });
    await page.mouse.wheel(0, 300);
    await expect
      .poll(() => body.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    const start = card.getByRole("button", { name: "Start this job" });
    await expect(start).toBeInViewport({ ratio: 1 });
    await start.click({ trial: true });
    await page.mouse.move(0, 0);
    await waitForAnimations(page);
    await page.screenshot({
      path: `test-results/first-job/04-thread-${dark ? "dark" : "light"}-360-action.png`,
    });
    expect(errors).toEqual([]);
  });
}

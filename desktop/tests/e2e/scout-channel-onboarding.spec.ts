import { expect, test, type Page } from "@playwright/test";
import { hexToBytes } from "@noble/hashes/utils.js";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";

import type { RelayEvent } from "../../src/shared/api/types";
import {
  createScoutOnboardingRootPayload,
  parseScoutOnboardingRoot,
  ROOT_PROTOCOL,
  scoutOnboardingRootBody,
  scoutOnboardingRootTags,
  type ScoutOnboardingRootSeedInput,
} from "../../src/features/onboarding/channelOnboardingRuntime/protocol";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";
import { seedActiveIdentity } from "../helpers/onboarding";

const CHANNEL_ID = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
const CHANNEL_NAME = "Welcome";
const RELAY = "ws://localhost:3000";
const OWNER = TEST_IDENTITIES.tyler;

type Theme = "light" | "dark";
type Route = "new" | "existing" | "deciding";

type FixtureWindow = Window & {
  __BUZZ_E2E_COMMANDS__?: string[];
  __BUZZ_E2E_EMIT_MOCK_EVENT__?: (input: {
    channelName: string;
    event: RelayEvent;
  }) => RelayEvent;
  __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
    channelName: string;
    kind?: number;
  }) => boolean;
  __BUZZ_E2E_INVOKE_MOCK_COMMAND__?: (
    command: string,
    payload?: Record<string, unknown>,
  ) => Promise<unknown>;
  __BUZZ_E2E_PUBLISHED_EVENTS__?: RelayEvent[];
  __BUZZ_E2E_QUERY_CLIENT__?: {
    invalidateQueries: (...args: never[]) => Promise<unknown>;
  };
};

const DEFAULT_SEED: ScoutOnboardingRootSeedInput = {
  ownerName: "Horizon Owner",
  ownerNote: "I want to make the first step useful and understandable.",
  businessName: "Horizon Labs",
  businessDescription: "A small service business helping local owners online.",
  website: "https://horizon.example",
  websiteState: "provided",
  hasWebsite: true,
};

const SETUP_MUTATION_COMMANDS = new Set([
  "add_channel_members",
  "attach_thread_task",
  "create_channel",
  "create_company",
  "create_managed_agent",
  "create_team",
  "create_user_task",
  "execute_agent_proposal",
  "publish_note",
  "publish_event",
  "publish_relay_event",
  "send_channel_message",
  "send_managed_agent_channel_message",
  "send_stream_message",
  "set_canvas",
  "set_persona_active",
  "set_thread_canvas",
  "sign_community_profile_update",
  "sign_event",
  "sign_relay_event",
  "start_managed_agent_runtime",
  "update_company_profile",
]);

function setupMutationCommands(commands: readonly string[]) {
  return commands.filter((command) => SETUP_MUTATION_COMMANDS.has(command));
}

function signedRoot(
  requestId: string,
  seedOverrides: Partial<ScoutOnboardingRootSeedInput> = {},
): RelayEvent {
  const payload = createScoutOnboardingRootPayload(
    {
      ownerPubkey: OWNER.pubkey,
      relayUrl: RELAY,
      channelId: CHANNEL_ID,
      requestId,
    },
    { ...DEFAULT_SEED, ...seedOverrides },
  );
  return finalizeEvent(
    {
      kind: ROOT_PROTOCOL.kind,
      created_at: Math.floor(Date.now() / 1_000),
      tags: scoutOnboardingRootTags(payload),
      content: scoutOnboardingRootBody(payload),
    },
    hexToBytes(OWNER.privateKey),
  );
}

function scoutSurface(page: Page) {
  return page
    .locator('section[aria-label="Scout onboarding conversation"]')
    .last();
}

async function commandLog(page: Page) {
  return page.evaluate(() => [
    ...((window as FixtureWindow).__BUZZ_E2E_COMMANDS__ ?? []),
  ]);
}

async function publishedEventIds(page: Page) {
  return page.evaluate(() =>
    ((window as FixtureWindow).__BUZZ_E2E_PUBLISHED_EVENTS__ ?? []).map(
      (event) => event.id,
    ),
  );
}

async function waitForMockCommandSeam(page: Page) {
  await page.waitForFunction(
    () =>
      typeof (window as FixtureWindow).__BUZZ_E2E_INVOKE_MOCK_COMMAND__ ===
      "function",
  );
}

async function focusWelcome(page: Page) {
  await waitForMockCommandSeam(page);
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
  }, CHANNEL_ID);
  await expect(page.getByTestId("chat-title")).toContainText(CHANNEL_NAME);
  await page.waitForFunction(
    ({ channelName, kind }) =>
      Boolean(
        (window as FixtureWindow).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
          channelName,
          kind,
        }),
      ),
    { channelName: CHANNEL_NAME, kind: ROOT_PROTOCOL.kind },
  );
}

async function openRootThread(page: Page, root: RelayEvent) {
  const row = page.locator(
    `[data-testid="message-row"][data-message-id="${root.id}"]`,
  );
  await expect(row).toBeVisible();
  await page.evaluate(
    ({ channelId, eventId }) => {
      window.location.hash = `/channels/${channelId}?thread=${eventId}&threadRootId=${eventId}`;
    },
    { channelId: CHANNEL_ID, eventId: root.id },
  );
  await expect(page.getByTestId("message-thread-panel")).toBeVisible();
  await expect(scoutSurface(page)).toBeVisible();
}

async function bootScoutRoot(
  page: Page,
  root: RelayEvent,
  theme: Theme = "light",
) {
  await page.setViewportSize({ width: 1_280, height: 960 });
  await seedActiveIdentity(page, OWNER);
  await page.addInitScript((selectedTheme) => {
    window.localStorage.setItem(
      "buzz-theme",
      selectedTheme === "dark" ? "buzz-dark" : "buzz",
    );
    window.localStorage.setItem("buzz-follow-system", "false");
  }, theme);
  await installMockBridge(page, {
    activeIdentityInDefaultChannels: true,
    blockTimelineEvents: [{ channelName: "general", event: root }],
    relayMembers: true,
    relayRole: "owner",
  });
  await page.goto("/");
  await focusWelcome(page);
  await openRootThread(page, root);

  expect(verifyEvent(root)).toBe(true);
  expect(parseScoutOnboardingRoot(root.tags)).not.toBeNull();
  expect(root.tags).toEqual(
    expect.arrayContaining([
      ["h", CHANNEL_ID],
      ["client", ROOT_PROTOCOL.legacySuppressionMarker],
    ]),
  );
  return scoutSurface(page);
}

async function waitForDraftPersistence(page: Page) {
  await page.waitForFunction(() =>
    Object.keys(window.localStorage).some(
      (key) =>
        key.startsWith("colony.scout-channel-onboarding.v1:") &&
        key.includes('"draft"]'),
    ),
  );
}

async function completeRouteToUnderstanding(page: Page, route: Route) {
  let surface = scoutSurface(page);
  await surface.getByTestId(`scout-route-${route}`).click();

  if (route === "new") {
    await surface.getByRole("button", { name: /^Local services/ }).click();
    await surface
      .getByRole("button", { name: "Continue to the idea stage" })
      .click();
    await surface.getByRole("button", { name: /^Still an idea/ }).click();
    await surface
      .getByRole("button", { name: "Continue to one useful priority" })
      .click();
    await surface
      .getByRole("button", { name: /^Learn whether people want it/ })
      .click();
    await surface
      .getByRole("button", { name: "Review the understanding" })
      .click();
  } else if (route === "existing") {
    await surface
      .getByRole("button", { name: "Yes, this is the business" })
      .click();
    await surface
      .getByRole("button", { name: "Continue to priorities" })
      .click();
    await surface.getByRole("button", { name: /^Get more customers/ }).click();
    await surface
      .getByRole("button", { name: "Review the understanding" })
      .click();
  } else {
    await surface.getByRole("button", { name: /^Operations/ }).click();
    await surface
      .getByRole("button", { name: "Continue to possible directions" })
      .click();
    await surface
      .getByRole("button", { name: /^A service built around my experience/ })
      .click();
    await surface
      .getByRole("button", { name: "Continue to useful priorities" })
      .click();
    await surface
      .getByRole("button", { name: /^Compare a few directions/ })
      .click();
    await surface
      .getByRole("button", { name: "Review the understanding" })
      .click();
  }

  surface = scoutSurface(page);
  await expect(
    surface.getByRole("button", { name: "This looks right" }),
  ).toBeVisible();
  await expect(surface).toContainText(
    "Nothing has been created, staffed, or started.",
  );
  return surface;
}

for (const theme of ["light", "dark"] as const) {
  test(`Scout opening shows all three choices in ${theme} mode`, async ({
    page,
  }, testInfo) => {
    const root = signedRoot(`scout-e2e-opening-${theme}`);
    const surface = await bootScoutRoot(page, root, theme);

    await expect(page.locator("html")).toHaveAttribute(
      "data-buzz-theme",
      theme === "dark" ? "buzz-dark" : "buzz",
    );
    if (theme === "dark") {
      await expect(page.locator("html")).toHaveClass(/dark/);
    } else {
      await expect(page.locator("html")).not.toHaveClass(/dark/);
    }
    await expect(surface.getByTestId("scout-route-new")).toHaveCount(1);
    await expect(surface.getByTestId("scout-route-existing")).toHaveCount(1);
    await expect(surface.getByTestId("scout-route-deciding")).toHaveCount(1);
    await expect(surface).toContainText("Choose where to start");

    await waitForAnimations(page);
    await surface.screenshot({
      path: testInfo.outputPath(`scout-opening-${theme}.png`),
    });

    const surfaces = page.locator(
      'section[aria-label="Scout onboarding conversation"]',
    );
    await expect(surfaces).toHaveCount(2);
    await expect(surfaces.nth(0)).toBeVisible();
    await expect(surfaces.last()).toBeVisible();
    await surfaces.last().getByTestId("scout-route-existing").click();
    await expect(
      surfaces.nth(0).getByText("Is this the business we’re setting up?", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      surfaces.last().getByText("Is this the business we’re setting up?", {
        exact: true,
      }),
    ).toBeVisible();
  });
}

for (const route of ["new", "existing", "deciding"] as const) {
  test(`${route} route reaches an editable summary before setup`, async ({
    page,
  }) => {
    const root = signedRoot(`scout-e2e-route-${route}`);
    await bootScoutRoot(page, root);
    const beforeConfirmation = await commandLog(page);
    const beforePublished = await publishedEventIds(page);
    expect(setupMutationCommands(beforeConfirmation)).toEqual([]);

    await completeRouteToUnderstanding(page, route);
    await page.getByRole("button", { name: "This looks right" }).last().click();

    const setupSurface = scoutSurface(page);
    await expect(
      setupSurface.getByText("Keep the workspace simple."),
    ).toBeVisible();
    await expect(
      setupSurface.getByRole("button", {
        name: "Approve this workspace setup",
      }),
    ).toBeVisible();
    const afterConfirmation = await commandLog(page);
    expect(setupMutationCommands(afterConfirmation)).toEqual([]);
    expect(await publishedEventIds(page)).toEqual(beforePublished);
  });
}

const WEBSITE_CASES = [
  {
    name: "provided website",
    seed: {
      website: DEFAULT_SEED.website,
      websiteState: "provided" as const,
      hasWebsite: true,
    },
    assert(surface: ReturnType<typeof scoutSurface>) {
      return Promise.all([
        expect(
          surface.getByText("Website supplied earlier", { exact: true }),
        ).toBeVisible(),
        expect(
          surface.getByText(DEFAULT_SEED.website!, { exact: true }),
        ).toBeVisible(),
      ]);
    },
  },
  {
    name: "explicitly no website",
    seed: {
      website: "",
      websiteState: "none" as const,
      hasWebsite: false,
    },
    assert(surface: ReturnType<typeof scoutSurface>) {
      return Promise.all([
        expect(
          surface.getByText("No website supplied.", { exact: true }),
        ).toBeVisible(),
        expect(
          surface.getByRole("button", { name: "Add a website" }),
        ).toBeVisible(),
        expect(surface.getByLabel("Website (optional)")).toHaveCount(0),
      ]);
    },
  },
  {
    name: "blank unanswered website",
    seed: {
      website: "",
      websiteState: "unknown" as const,
      hasWebsite: true,
    },
    assert(surface: ReturnType<typeof scoutSurface>) {
      return expect(surface.getByLabel("Website (optional)")).toHaveValue("");
    },
  },
] as const;

for (const websiteCase of WEBSITE_CASES) {
  test(`existing route preserves ${websiteCase.name} across reload`, async ({
    page,
  }) => {
    const root = signedRoot(
      `scout-e2e-website-${websiteCase.name.replaceAll(" ", "-")}`,
      websiteCase.seed,
    );
    let surface = await bootScoutRoot(page, root);
    await surface.getByTestId("scout-route-existing").click();
    await websiteCase.assert(scoutSurface(page));
    await waitForDraftPersistence(page);

    await page.reload();
    await focusWelcome(page);
    await openRootThread(page, root);
    surface = scoutSurface(page);
    await websiteCase.assert(surface);
  });
}

test("Welcome navigation does not start setup before owner approval", async ({
  page,
}) => {
  const root = signedRoot("scout-e2e-navigation");
  await bootScoutRoot(page, root);
  const beforeNavigation = setupMutationCommands(await commandLog(page));
  const beforePublished = await publishedEventIds(page);
  expect(beforeNavigation).toEqual([]);

  await page.getByTestId("channel-random").click();
  await expect(page.getByTestId("chat-title")).toContainText("random");
  await page.waitForFunction(
    ({ channelName, kind }) =>
      Boolean(
        (window as FixtureWindow).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
          channelName,
          kind,
        }),
      ),
    { channelName: "random", kind: ROOT_PROTOCOL.kind },
  );

  await focusWelcome(page);
  await openRootThread(page, root);
  expect(setupMutationCommands(await commandLog(page))).toEqual(
    beforeNavigation,
  );
  expect(await publishedEventIds(page)).toEqual(beforePublished);
  await expect(scoutSurface(page).getByTestId("scout-route-new")).toBeVisible();
});

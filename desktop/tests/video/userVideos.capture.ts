import { hexToBytes } from "@noble/hashes/utils.js";
import { expect, type Page, test } from "@playwright/test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import {
  createScoutOnboardingRootPayload,
  scoutOnboardingRootBody,
  scoutOnboardingRootTags,
  ROOT_PROTOCOL,
} from "../../src/features/onboarding/channelOnboardingRuntime/protocol";
import {
  firstJobSuggestionBody,
  firstJobSuggestionTag,
} from "../../src/features/onboarding/firstJobSuggestion";
import { WELCOME_CHANNEL_DESCRIPTION } from "../../src/features/onboarding/welcome";
import type { RelayEvent } from "../../src/shared/api/types";
import {
  fixtureUuid,
  OWNER_PUBKEY,
  readCoreManifest,
  signBlockAction,
  signBlockInstance,
  signBlockReceipt,
  signCatalog,
  signManifest,
} from "../e2e/blocks-test-helpers";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import {
  continueFounderBusiness,
  seedActiveIdentity,
} from "../helpers/onboarding";
import {
  BUSINESS,
  CAPTIONS_STARTER,
  DRAFTS_REPLY,
  OUTREACH,
  OWNER,
  CREDIT_PACKS,
  WORKER_NAME,
} from "./brightPlumbing";
import { shoot, writeManifest } from "./shots";

/**
 * The real app in its e2e mock mode, walked the way the user videos tell it,
 * with Bright Plumbing's sample data. Each scene starts from the state an
 * existing spec already proves the app reaches (first run, Scout's Welcome,
 * the first job, the outreach card), so a capture failure is a real change.
 */

const IDENTITY = { ...TEST_IDENTITIES.tyler, username: OWNER.name };
/** The seeded "random" channel, renamed Welcome: unlike "general" it has no linked project. */
const WELCOME = "9dae0116-799b-5071-a0a8-fdd30a91a35d";
const SEEDED_NAME = "random";
const RELAY = "ws://localhost:3000";
const SCOUT = getPublicKey(new Uint8Array(32).fill(3));
const WORKER = getPublicKey(new Uint8Array(32).fill(4));

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
  __BUZZ_E2E_QUERY_CLIENT__?: {
    invalidateQueries: (...args: never[]) => Promise<unknown>;
    getQueryState: (key: unknown[]) => { fetchStatus?: string } | undefined;
    setQueryData: (key: unknown[], value: unknown) => void;
  };
};

const ownerSign = (input: Parameters<typeof finalizeEvent>[0]) =>
  finalizeEvent(input, hexToBytes(IDENTITY.privateKey));

test.afterAll(() => writeManifest());

/** Light theme, accent and split threads, as a new owner first sees the app. */
async function seedAppearance(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("buzz-theme", "buzz");
    localStorage.setItem("buzz-follow-system", "false");
    localStorage.setItem("buzz-accent-color", "#895AF6");
    localStorage.setItem("buzz.channels.threadViewMode", "split");
  });
}

/**
 * After the bridge seeds its workspace: name it after the sample business, and
 * answer the payment server with the real packs. Must run after installMockBridge.
 */
async function brightWorkspace(page: Page) {
  await page.addInitScript((name) => {
    const raw = localStorage.getItem("buzz-communities");
    if (!raw) return;
    const communities = JSON.parse(raw) as Array<{ name: string }>;
    localStorage.setItem(
      "buzz-communities",
      JSON.stringify(communities.map((community) => ({ ...community, name }))),
    );
  }, BUSINESS.name);
  // Any host: during sign-up the app asks the business's claimed address.
  await page.route(/\/api\/payments\//, async (route) => {
    const url = route.request().url();
    if (url.endsWith("/packs"))
      await route.fulfill({ json: { currency: "ZAR", packs: CREDIT_PACKS } });
    else if (url.endsWith("/verify"))
      await route.fulfill({ json: { paid: false, usdCents: 0 } });
    else await route.fulfill({ status: 404, json: {} });
  });
}

/** Rename the seeded channel to Welcome, join it, and wait for its live feed. */
async function openWelcome(page: Page, kind?: number) {
  await page.waitForFunction(() =>
    Boolean((window as FixtureWindow).__BUZZ_E2E_INVOKE_MOCK_COMMAND__),
  );
  await page.evaluate(
    async ({ channelId, description }) => {
      const fixture = window as FixtureWindow;
      await fixture.__BUZZ_E2E_INVOKE_MOCK_COMMAND__?.("update_channel", {
        input: {
          channelId,
          name: "Welcome",
          visibility: "private",
          description,
        },
      });
      await fixture.__BUZZ_E2E_INVOKE_MOCK_COMMAND__?.("join_channel", {
        channelId,
      });
      await fixture.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries();
      window.location.hash = `/channels/${channelId}`;
    },
    { channelId: WELCOME, description: WELCOME_CHANNEL_DESCRIPTION },
  );
  await page.waitForFunction(
    (input) =>
      Boolean(
        (window as FixtureWindow).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.(
          input,
        ),
      ),
    { channelName: "Welcome", kind },
  );
}

async function openThread(page: Page, rootId: string) {
  await page.evaluate(
    ({ channel, id }) => {
      window.location.hash = `/channels/${channel}?thread=${id}&threadRootId=${id}`;
    },
    { channel: WELCOME, id: rootId },
  );
  await expect(page.getByTestId("message-thread-panel")).toBeVisible();
}

test("sign-up: account, recovery code, business, power, history", async ({
  page,
}) => {
  await seedActiveIdentity(page, { ...TEST_IDENTITIES.tyler, username: "" });
  await installMockBridge(page, undefined, {
    skipOnboardingSeed: true,
    skipCommunitySeed: true,
  });
  await brightWorkspace(page);
  await page.goto("/");
  const accountHeading = page.getByRole("heading", {
    name: "Create your account",
  });
  await shoot(page, "account-empty", accountHeading, {
    name: page.getByLabel("Your name", { exact: true }),
  });
  await page.getByLabel("Your name", { exact: true }).fill(OWNER.name);
  await page.getByLabel("Email", { exact: true }).fill(OWNER.email);
  await page
    .getByLabel("Password", { exact: true })
    .fill("synthetic strong password");
  await shoot(page, "account", accountHeading, {
    name: page.getByLabel("Your name", { exact: true }),
    email: page.getByLabel("Email", { exact: true }),
    password: page.getByLabel("Password", { exact: true }),
    create: page.getByRole("button", { name: "Create account", exact: true }),
  });
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();

  const code = page.getByTestId("onboarding-recovery-code");
  await shoot(
    page,
    "recovery",
    page.getByRole("heading", { name: "Save your recovery code" }),
    {
      code,
      save: page.getByRole("button", { name: "Save and continue" }),
    },
  );
  await page.getByRole("button", { name: "Save and continue" }).click();

  const businessHeading = page.getByRole("heading", { name: "Your business" });
  const nameField = page.getByLabel("Business name", { exact: true });
  const websiteField = page.getByLabel("Website", { exact: false });
  await shoot(page, "business-empty", businessHeading, {
    name: nameField,
    website: websiteField,
  });
  await nameField.fill(BUSINESS.name);
  await websiteField.fill(BUSINESS.website);
  const read = page.getByRole("button", { name: "Read website", exact: true });
  await shoot(page, "business-filled", businessHeading, {
    name: nameField,
    website: websiteField,
    read,
  });
  await read.click();
  await expect(
    page.getByText(
      "Here is what we found. Edit the summary so it sounds like your business.",
    ),
  ).toBeVisible();
  // Test mode reads a fixed sample site; put the sample business's own summary
  // in the box, as an owner edits it.
  await page
    .getByLabel("Business summary", { exact: true })
    .fill(BUSINESS.summary);
  await shoot(page, "business-read", businessHeading, {
    name: nameField,
    website: websiteField,
    read: page.getByRole("button", { name: /^Read website/ }),
    summary: page.getByLabel("Business summary", { exact: true }),
    continue: page
      .getByTestId("onboarding-business")
      .getByRole("button", { name: "Continue", exact: true }),
  });
  await continueFounderBusiness(page);

  const credits = page.getByRole("button", { name: /^Colony Credits/ });
  const subscriptions = page.getByRole("button", { name: /^Subscriptions/ });
  await credits.click();
  await expect(page.getByText("Loading models…")).toHaveCount(0);
  await expect(page.getByText("Loading current prices…")).toHaveCount(0);
  await shoot(page, "power-credits", credits, {
    subscriptions,
    credits,
    free: page.getByRole("button", { name: /^OpenRouter free models/ }),
  });
  await subscriptions.click();
  await shoot(page, "power-subscriptions", subscriptions, {
    subscriptions,
    list: page.getByLabel("Your subscriptions"),
  });
  await credits.click();
  // Switching back reloads the model list: wait for it before scrolling.
  await expect(page.getByLabel("Default model")).toBeVisible();
  await expect(page.getByText("Loading models…")).toHaveCount(0);
  const testButton = page.getByRole("button", { name: "Test connection" });
  // The panel can still be settling after the switch back: scroll until it holds.
  await expect(async () => {
    await testButton.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await expect(testButton).toBeInViewport({ ratio: 1, timeout: 500 });
  }).toPass();
  await shoot(page, "power-test", testButton, {
    model: page.getByLabel("Default model"),
    test: testButton,
  });
  await testButton.click();
  const replied = page.getByText("Your agent replied", { exact: true }).last();
  await expect(replied).toBeVisible();
  await page
    .getByRole("button", { name: "Continue", exact: true })
    .scrollIntoViewIfNeeded();
  await shoot(page, "power-replied", replied, {
    replied,
    continue: page.getByRole("button", { name: "Continue", exact: true }),
  });
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  const skip = page.getByRole("button", { name: "Skip for now", exact: true });
  await shoot(
    page,
    "history",
    page.getByRole("heading", { name: "Let Colony get to know you" }),
    {
      skip,
      choose: page.getByText(
        "Colony can find previous AI conversations on this computer. You choose what to keep.",
      ),
      dialog: page.getByTestId("onboarding-history-form"),
    },
  );
});

test("Welcome: Scout, the existing business, the setup", async ({ page }) => {
  const payload = createScoutOnboardingRootPayload(
    {
      ownerPubkey: IDENTITY.pubkey,
      relayUrl: RELAY,
      channelId: WELCOME,
      requestId: "user-video-welcome",
    },
    {
      ownerName: OWNER.name,
      ownerNote: "",
      businessName: BUSINESS.name,
      businessDescription: BUSINESS.summary,
      website: `https://${BUSINESS.website}`,
      websiteState: "provided",
      hasWebsite: true,
    },
  );
  const root = ownerSign({
    kind: ROOT_PROTOCOL.kind,
    created_at: Math.floor(Date.now() / 1_000),
    tags: scoutOnboardingRootTags(payload),
    content: scoutOnboardingRootBody(payload),
  });
  await seedActiveIdentity(page, IDENTITY);
  await seedAppearance(page);
  await installMockBridge(page, {
    blockTimelineEvents: [{ channelName: SEEDED_NAME, event: root }],
    relayMembers: true,
    relayRole: "owner",
  });
  await brightWorkspace(page);
  await page.goto("/");
  await openWelcome(page, ROOT_PROTOCOL.kind);
  await expect(
    page.locator(`[data-testid="message-row"][data-message-id="${root.id}"]`),
  ).toBeVisible();
  await openThread(page, root.id);
  const surface = () =>
    page.locator('section[aria-label="Scout onboarding conversation"]').last();

  await shoot(
    page,
    "welcome-routes",
    surface().getByText("Where should we begin?"),
    {
      question: surface().getByText("Where should we begin?"),
      new: surface().getByTestId("scout-route-new"),
      existing: surface().getByTestId("scout-route-existing"),
      deciding: surface().getByTestId("scout-route-deciding"),
    },
  );
  await surface().getByTestId("scout-route-existing").click();
  await shoot(
    page,
    "welcome-confirm",
    surface().getByRole("button", { name: "Yes, this is the business" }),
    {
      details: surface().getByText("Business details supplied earlier").last(),
      yes: surface().getByRole("button", { name: "Yes, this is the business" }),
    },
  );
  await surface()
    .getByRole("button", { name: "Yes, this is the business" })
    .click();
  await surface()
    .getByRole("button", { name: "Continue to priorities" })
    .click();
  const customers = surface().getByRole("button", {
    name: /^Get more customers/,
  });
  await shoot(page, "welcome-priority", customers, {
    customers,
    delivery: surface().getByRole("button", { name: /^Make delivery easier/ }),
    next: surface().getByRole("button", { name: /^Decide what to do next/ }),
    other: surface().getByRole("button", {
      name: /^Something else to discuss/,
    }),
  });
  await customers.click();
  await surface()
    .getByRole("button", { name: "Review the understanding" })
    .click();
  const looksRight = surface().getByRole("button", {
    name: "This looks right",
  });
  await shoot(page, "understanding", looksRight, {
    looksRight,
    nothingYet: surface().getByText(
      "Nothing has been created, staffed, or started.",
    ),
    still: surface().getByText("Still to understand").locator(".."),
  });
  await looksRight.click();
  const approve = page
    .getByRole("button", { name: "Approve this workspace setup" })
    .last();
  await shoot(
    page,
    "setup",
    page.getByText("Keep the workspace simple.").last(),
    {
      keep: surface().getByText("Keep #welcome for talking with Scout.").last(),
      approve,
    },
  );
});

test("first job: starting examples, approve team and start, the thread", async ({
  page,
}) => {
  const head = (pubkey: string, tier: string) =>
    ownerSign({
      kind: 30177,
      created_at: 1780000000,
      tags: [["d", pubkey]],
      content: JSON.stringify({ name: "Fixture teammate", tier }),
    });
  await seedActiveIdentity(page, IDENTITY);
  await seedAppearance(page);
  await page.addInitScript(
    ({ owner, relay }) => {
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
    { owner: IDENTITY.pubkey, relay: RELAY },
  );
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
      balance_nanousd: "5000000000",
      available_balance_nanousd: "5000000000",
      currency: "USD",
      status: "active",
    },
    companyWorkContext: {
      taskId: "bright:first-job",
      owningTeamId: "bright:coordination",
      qaPersonaId: "builtin:fizz",
      costCentreId: "general",
      tradingName: BUSINESS.name,
    },
    managedAgents: [
      {
        pubkey: SCOUT,
        name: "Scout",
        personaId: "builtin:fizz",
        channelIds: [WELCOME],
        status: "stopped",
      },
      {
        pubkey: WORKER,
        name: WORKER_NAME,
        personaId: "sample-writer",
        channelIds: [WELCOME],
        status: "stopped",
      },
    ],
    searchProfiles: [SCOUT, WORKER].map((pubkey) => ({
      pubkey,
      displayName: pubkey === SCOUT ? "Scout" : WORKER_NAME,
      ownerPubkey: IDENTITY.pubkey,
      isAgent: true,
    })),
    activePersonaIds: ["builtin:fizz"],
    personas: [
      {
        id: "sample-writer",
        displayName: WORKER_NAME,
        roleId: "writer",
        roleTitle: "Writer",
        systemPrompt: "Draft for review",
        isActive: true,
      },
    ],
    managedAgentHeadEvents: [head(SCOUT, "executive"), head(WORKER, "worker")],
  });
  await brightWorkspace(page);
  await page.goto("/");
  await openWelcome(page, 9);
  const suggestion = {
    version: 1 as const,
    ownerPubkey: IDENTITY.pubkey,
    relayUrl: RELAY,
    channelId: WELCOME,
    requestId: "user-video-first-job",
    businessName: BUSINESS.name,
    business: BUSINESS.summary,
    website: `https://${BUSINESS.website}`,
    brief: CAPTIONS_STARTER.brief,
  };
  const root = ownerSign({
    kind: 9,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["h", WELCOME], firstJobSuggestionTag(suggestion)],
    content: firstJobSuggestionBody(suggestion),
  });
  await page.evaluate((event) => {
    (window as FixtureWindow).__BUZZ_E2E_EMIT_MOCK_EVENT__?.({
      channelName: "Welcome",
      event,
    });
  }, root);
  const card = page.getByTestId("first-job-suggestion");
  await expect(card).toHaveCount(1);

  const accessKey = [
    "first-job-discovery",
    IDENTITY.pubkey,
    RELAY,
    "e2e-default-community",
  ];
  await page.waitForFunction(
    (key) =>
      (window as FixtureWindow).__BUZZ_E2E_QUERY_CLIENT__?.getQueryState(key)
        ?.fetchStatus === "idle",
    accessKey,
  );
  await page.evaluate((key) => {
    (window as FixtureWindow).__BUZZ_E2E_QUERY_CLIENT__?.setQueryData(
      key,
      true,
    );
  }, accessKey);
  const findClients = card.getByRole("button", {
    name: "Find potential clients",
  });
  await findClients.click();
  const examples = card.getByText(
    "Start with an example, or write your own brief",
  );
  await shoot(page, "find-clients", card.getByText("10 potential clients"), {
    findClients,
    examples,
    brief: card.getByLabel("The brief", { exact: true }),
    outputs: card.getByTestId("first-job-outputs"),
  });
  await card.getByRole("button", { name: "Draft Instagram captions" }).click();
  const start = card.getByRole("button", { name: "Approve team and start" });
  await shoot(page, "first-job", start, {
    examples,
    brief: card.getByLabel("The brief", { exact: true }),
    outputs: card.getByTestId("first-job-outputs"),
    start,
  });
  await start.click();
  const status = card.getByTestId("first-job-status");
  await expect(status).toHaveText("In progress");
  await shoot(page, "first-job-started", status, { status });

  await openThread(page, root.id);
  // Starting the job posts its own messages a moment later: let them land,
  // then the drafts come back a minute after, so they always read last.
  const panel = page.getByTestId("message-thread-panel");
  await expect(
    panel.getByText(/^Coordinate this job in this thread/),
  ).toBeVisible();
  await expect(
    panel.getByText(/^Lerato is ready to work with Scout/),
  ).toBeVisible();
  const reply = await page.evaluate(
    (input) =>
      (
        window as Window & {
          __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (message: {
            channelName: string;
            content: string;
            parentEventId?: string;
            pubkey?: string;
            createdAt?: number;
          }) => RelayEvent;
        }
      ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        ...input,
        createdAt: Math.floor(Date.now() / 1000) + 60,
      }),
    {
      channelName: "Welcome",
      content: DRAFTS_REPLY,
      parentEventId: root.id,
      pubkey: WORKER,
    },
  );
  if (!reply) throw new Error("The drafts reply was not emitted");
  const thread = panel;
  const drafts = thread.locator(`[data-message-id="${reply.id}"]`);
  // The job's own messages share a second, so their order differs run to
  // run; the video points at the job's title instead, always at the top.
  const title = thread.getByTestId("thread-open-task-title");
  // The reply lands while the panel is still scrolling: take it to the
  // bottom, as when you are reading along, until the reply holds still there.
  const latest = thread.getByTestId("thread-scroll-to-latest");
  await expect(async () => {
    if (await latest.isVisible()) await latest.click();
    await drafts.evaluate((el) => {
      let box = el.parentElement;
      while (box && box.scrollHeight <= box.clientHeight + 1)
        box = box.parentElement;
      box?.scrollTo({ top: box.scrollHeight });
    });
    await expect(latest).toHaveCount(0, { timeout: 500 });
    await expect(drafts).toBeInViewport({ ratio: 1, timeout: 500 });
    const before = await drafts.boundingBox();
    await page.waitForTimeout(400);
    expect(await drafts.boundingBox()).toEqual(before);
  }).toPass({ timeout: 10_000 });
  await shoot(page, "job-thread", drafts, { title, drafts });
});

/** Bright Plumbing's email to Thabo as an outreach card, pending or sent. */
async function outreachCard(page: Page, sent: boolean) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await seedActiveIdentity(page, IDENTITY);
  await seedAppearance(page);
  const source = readCoreManifest("outreach-email");
  const manifest = signManifest(source);
  const instanceId = fixtureUuid(940);
  const example = (source.examples[0]?.data ?? {}) as Record<string, unknown>;
  const instance = signBlockInstance({
    channelId: WELCOME,
    content: `Email to ${OUTREACH.business}`,
    data: {
      ...example,
      business_name: OUTREACH.business,
      destination: OUTREACH.to,
      from: OWNER.email,
      content: { subject: OUTREACH.subject, body: OUTREACH.body },
      expires_at: Math.floor(Date.now() / 1_000) + 86_400,
      status: "pending",
    },
    handle: "outreach-email",
    instanceId,
    manifestId: manifest.id,
    processorPubkey: OWNER_PUBKEY,
    requiresAttention: true,
  });
  const events: RelayEvent[] = [instance];
  if (sent) {
    const action = signBlockAction({
      actionId: "outreach.approve",
      channelId: WELCOME,
      idempotencyKey: fixtureUuid(941),
      instanceEventId: instance.id,
      instanceId,
      manifestId: manifest.id,
      processorPubkey: OWNER_PUBKEY,
    });
    events.push(
      action,
      signBlockReceipt({
        action,
        channelId: WELCOME,
        content: {
          outcome: "sent",
          sent_at: Math.floor(Date.now() / 1_000),
          status_label: "sent",
          subject: OUTREACH.subject,
          to: OUTREACH.to,
        },
        instanceEventId: instance.id,
        instanceId,
        resolvesAttention: true,
        status: "succeeded",
      }),
    );
  }
  await installMockBridge(page, {
    blockEvents: [manifest, signCatalog(manifest, source)],
    blockTimelineEvents: events.map((event) => ({
      channelName: SEEDED_NAME,
      event,
    })),
    relaySelf: OWNER_PUBKEY,
  });
  await brightWorkspace(page);
  await page.goto("/");
  await openWelcome(page);
  const block = page
    .locator(`[data-message-id="${instance.id}"]`)
    .locator('[data-block-handle="outreach-email"]');
  await expect(block).toBeVisible();
  // The card arrives unread: jump to it, which also clears the "new message"
  // pill, then let the jump's two-second highlight pass and return to the end.
  const pill = page.getByTestId("message-unread-pill");
  await pill.click();
  await expect(pill).toHaveCount(0);
  const row = page.locator(`[data-message-id="${instance.id}"]`).first();
  await expect(row).not.toHaveClass(/route-target-highlight/, {
    timeout: 5_000,
  });
  const latest = page.getByTestId("message-scroll-to-latest");
  if (await latest.isVisible()) await latest.click();
  await expect(latest).toHaveCount(0);
  await block.scrollIntoViewIfNeeded();
  return block;
}

// Narrower than the other shots, so the email's words are larger in the
// video, and taller, so the whole card sits above the composer.
test.describe("outreach", () => {
  test.use({ viewport: { width: 1080, height: 1200 } });

  test("outreach email waiting for your yes", async ({ page }) => {
    const block = await outreachCard(page, false);
    const approve = block.getByRole("button", { name: "Approve" });
    await shoot(page, "outreach-card", approve, { card: block, approve });
  });

  test("outreach email after your yes", async ({ page }) => {
    const block = await outreachCard(page, true);
    await shoot(page, "outreach-sent", block.getByText("Sent."), {
      card: block,
      from: { words: block.getByText(`${OWNER.email}, your Gmail`) },
      status: block.locator('[data-block-primitive="status"]'),
    });
  });
});

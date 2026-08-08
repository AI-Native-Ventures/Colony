import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity } from "../helpers/onboarding";

// Source of the marketing site's feature imagery (site/public/feature-*.png).
//
// These were previously hand-cropped at 1x and came out 195x111 — small
// enough that one was cut off mid-sentence, and far too low-resolution for
// the full-width sections the site renders them in. Captured here instead so
// they are reproducible, seeded deterministically, and retina-density.
//
// Regenerate:
//   pnpm build:e2e
//   pnpm exec playwright test tests/e2e/site-feature-screenshots.spec.ts
//   cp test-results/site-features/*.png ../site/public/
//
// Each capture is scoped to a locator rather than a pixel clip, so message
// ordering or layout shifts reframe the shot instead of slicing content.
const SHOTS = "test-results/site-features";

// Messages are dropped silently without a live subscription for the channel.
async function waitForMockLiveSubscription(
  page: import("@playwright/test").Page,
  channelName: string,
) {
  await expect
    .poll(() =>
      page.evaluate(
        (name) =>
          (
            window as Window & {
              __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
                channelName: string;
              }) => boolean;
            }
          ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
            channelName: name,
          }) ?? false,
        channelName,
      ),
    )
    .toBe(true);
}

// Retina density: these render up to ~1000 CSS px wide on the site, so a 1x
// capture would be visibly soft.
test.use({ deviceScaleFactor: 2, viewport: { width: 1280, height: 720 } });

// The people and agents in the hero product shot (site/public/product-channel.png).
//
// Real first-and-last names, not the mock's "alice"/"bob" handles: the shot's
// job is to read like a company mid-decision, and handles read like a fixture.
// The two agents carry the starter-team renders the app already ships at
// onboarding (desktop/public/onboarding/starter-team), so the character on the
// marketing page is the same character a new owner meets on day one.
const MAYA = { pubkey: "deadbeef".repeat(8), name: "Maya Chen" };
const DANIEL = {
  pubkey: "d1a9e0c47b53f286a1cb7fd0e9384b52c76a10df85be34cc902741ab6de5f318",
  name: "Daniel Okafor",
};
const AISHA = {
  pubkey: "a15ba0e77c2d4f61b98e30cd5471af26e0b3d8c94f27615aa38b0cd9e4712f83",
  name: "Aisha Bello",
};
const SCOUT = {
  pubkey: "5c07a1d2e3b49f6087cd15be2740af39c81d6e52ab073f94dc218e60b7a3f451",
  name: "Scout",
  avatarUrl: "/onboarding/starter-team/scout.png",
};
const FORAGER = {
  pubkey: "f04a9e21c7b350d68fa4172e93bc05d7e61840af29c3b5d70e18a642cf95b3d0",
  name: "Forager",
  avatarUrl: "/onboarding/starter-team/forager.png",
};

// Fixed ids so reactions have stable targets (a reaction's `e` tag is only
// honoured when it is 64-hex) and so a re-capture reproduces the same thread.
const ID_SWEEP = "1a".repeat(32);
const ID_RANKED = "2b".repeat(32);
const ID_PHONE = "3c".repeat(32);
const ID_DRAFTED = "4d".repeat(32);

// Fixed wall-clock seconds: relative timestamps ("2m ago") would otherwise
// drift between captures and re-order rows emitted in the same second.
const T0 = 1785582000;

const REVIEWER = {
  pubkey: TEST_IDENTITIES.alice.pubkey,
  name: "mira",
  status: "running" as const,
};
const RELEASE_BOT = {
  pubkey: TEST_IDENTITIES.bob.pubkey,
  name: "nadia",
  status: "running" as const,
};

test("capture: channel list", async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("channel-general")).toBeVisible();
  await waitForAnimations(page);

  // The sidebar only: the community chip at its foot carries a bee emoji from
  // an old mock fixture, so the shot stops above it rather than shipping a
  // Buzz-era glyph on a Colony page.
  await page.screenshot({
    path: `${SHOTS}/feature-channels.png`,
    clip: { x: 0, y: 0, width: 290, height: 600 },
  });
});

test("capture: agent teams", async ({ page }) => {
  await installMockBridge(page, {
    managedAgents: [
      { ...REVIEWER, channelNames: ["engineering"] },
      { ...RELEASE_BOT, channelNames: ["engineering"] },
    ],
  });
  // Taller window: the agent cards sit low enough that a 720px viewport
  // clipped their names against the fold.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-agents-view").click();
  await expect(page.getByTestId("unified-agents-groups")).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.getByTestId(`managed-agent-${REVIEWER.pubkey}`),
  ).toBeVisible({ timeout: 10_000 });
  await waitForAnimations(page);

  // The group container leads with a large empty "new agent" placeholder,
  // which would be most of the frame. Scope to the two agent cards instead.
  const first = page.getByTestId(`managed-agent-${REVIEWER.pubkey}`);
  const second = page.getByTestId(`managed-agent-${RELEASE_BOT.pubkey}`);
  const a = await first.boundingBox();
  const b = await second.boundingBox();
  if (!a || !b) throw new Error("could not measure the agent cards");
  // Generous bottom padding: the agent name and model sit below the card's
  // measured box, and a tight crop sheared them off.
  const pad = 20;
  await page.screenshot({
    path: `${SHOTS}/feature-agents.png`,
    clip: {
      x: Math.min(a.x, b.x) - pad,
      y: Math.min(a.y, b.y) - pad,
      width:
        Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x) + pad * 2,
      height:
        Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y) + pad * 4,
    },
  });
});

test("capture: workflow run reported in a channel", async ({ page }) => {
  await installMockBridge(page, {
    managedAgents: [{ ...RELEASE_BOT, channelNames: ["engineering"] }],
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("channel-engineering").click();
  await expect(page.getByTestId("chat-title")).toHaveText("engineering");

  // One message only: two messages emitted in the same second sort
  // unstably, which made a fixed crop land on a different message per run.
  await waitForMockLiveSubscription(page, "engineering");
  await page.evaluate((pubkey) => {
    (
      window as unknown as {
        __BUZZ_E2E_EMIT_MOCK_MESSAGE__: (
          input: Record<string, unknown>,
        ) => void;
      }
    ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__({
      channelName: "engineering",
      content:
        "Workflow `release-sign` triggered on push. Build signed, notarization queued. I'll post the ticket ID here when Apple returns it.",
      pubkey,
    });
  }, RELEASE_BOT.pubkey);

  const row = page.getByTestId("message-row").last();
  await expect(row).toContainText("release-sign");
  await waitForAnimations(page);
  const box = await row.boundingBox();
  if (!box) throw new Error("could not measure the workflow message");
  // Anchor on the message but keep the channel around it: a bare row is a
  // 20:1 sliver on the page and reads as a stray line of text.
  // Frame the message with the composer beneath it, not the empty-channel
  // onboarding cards above it — those belong to a different story.
  await page.screenshot({
    path: `${SHOTS}/feature-workflow.png`,
    clip: {
      x: 290,
      y: Math.max(0, box.y - 30),
      width: 990,
      height: 240,
    },
  });
});

test("capture: the company channel hero shot", async ({ page }) => {
  await installMockBridge(page, {
    searchProfiles: [
      { pubkey: MAYA.pubkey, displayName: MAYA.name },
      { pubkey: DANIEL.pubkey, displayName: DANIEL.name },
      { pubkey: AISHA.pubkey, displayName: AISHA.name },
      {
        pubkey: SCOUT.pubkey,
        displayName: SCOUT.name,
        avatarUrl: SCOUT.avatarUrl,
        isAgent: true,
        ownerPubkey: MAYA.pubkey,
      },
      {
        pubkey: FORAGER.pubkey,
        displayName: FORAGER.name,
        avatarUrl: FORAGER.avatarUrl,
        isAgent: true,
        ownerPubkey: MAYA.pubkey,
      },
    ],
  });
  // Taller than the shared 720: the site renders this shot as the page's
  // largest element, and a short window wastes that space on chrome.
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  // The bridge installs its command seam during app boot, and `goto` resolves
  // on domcontentloaded — one run in three reached the block below first and
  // failed with "invoke is not a function".
  await page.waitForFunction(
    () =>
      typeof (
        window as unknown as { __BUZZ_E2E_INVOKE_MOCK_COMMAND__?: unknown }
      ).__BUZZ_E2E_INVOKE_MOCK_COMMAND__ === "function",
  );

  // The mock's own `sales` channel does not carry the viewer as a member, so
  // it never reaches the sidebar. Build the company's channels through the
  // same commands the app uses instead of adding the viewer to a shared
  // fixture that a dozen other specs assert against, and leave the mock's
  // test-scaffolding channels (all-replies, deep-history, …) so the sidebar
  // reads as a company rather than a fixture.
  await page.evaluate(
    async ({ members }) => {
      const w = window as unknown as {
        __BUZZ_E2E_INVOKE_MOCK_COMMAND__: (
          command: string,
          payload: Record<string, unknown>,
        ) => Promise<unknown>;
        __BUZZ_E2E_INVALIDATE_CHANNELS__: () => void;
      };
      const invoke = w.__BUZZ_E2E_INVOKE_MOCK_COMMAND__;

      for (const [name, description] of [
        ["growth", "Pipeline, outreach, and the agents running both"],
        ["brand", "Voice, launches, and what goes out publicly"],
        ["outreach", "Sequences in flight and what came back"],
      ]) {
        const channel = (await invoke("create_channel", {
          name,
          channelType: "stream",
          visibility: "open",
          description,
        })) as { id: string };
        await invoke("add_channel_members", {
          channelId: channel.id,
          pubkeys: members,
        });
      }

      const channels = (await invoke("get_channels", {})) as Array<{
        id: string;
        name: string;
      }>;
      const scaffolding = new Set([
        "all-replies",
        "deep-history",
        "secret-projects",
        "welcome-everyone",
      ]);
      for (const channel of channels) {
        if (scaffolding.has(channel.name)) {
          await invoke("leave_channel", { channelId: channel.id });
        }
      }
      w.__BUZZ_E2E_INVALIDATE_CHANNELS__();
    },
    {
      members: [DANIEL.pubkey, AISHA.pubkey, SCOUT.pubkey, FORAGER.pubkey],
    },
  );

  // Seeded before the channel is opened, so the app loads them as history.
  // Emitting them while the channel is on screen delivers them live instead,
  // which is a real product behaviour but the wrong shot: it paints a NEW
  // divider through the middle of the thread and floats "3 new messages"
  // jump pills over the header.
  await page.evaluate(
    ({ maya, daniel, aisha, scout, forager, ids, t0 }) => {
      const emit = (
        window as unknown as {
          __BUZZ_E2E_EMIT_MOCK_MESSAGE__: (
            input: Record<string, unknown>,
          ) => void;
        }
      ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__;

      // The two openers are what push the channel's empty-state cards and the
      // sticky day-divider pill above the fold. Without them the timeline is
      // shorter than the window, so a bottom-anchored capture still frames
      // both, and the pill paints through the first message's text.
      emit({
        channelName: "growth",
        pubkey: aisha,
        createdAt: t0 - 900,
        content:
          "The board asked for 40 qualified conversations this quarter. Not 400 names.",
      });
      emit({
        channelName: "growth",
        pubkey: maya,
        createdAt: t0 - 600,
        content:
          "Then we lead with fit instead of volume. Scout has been sweeping the metro all night.",
      });
      emit({
        channelName: "growth",
        pubkey: maya,
        id: ids.sweep,
        createdAt: t0,
        content:
          "Scout finished the Q3 sweep of the Cape metro overnight. 214 companies, 62 with a named decision maker.",
      });
      emit({
        channelName: "growth",
        pubkey: scout,
        id: ids.ranked,
        createdAt: t0 + 180,
        content: [
          "Ranked the top 20 by fit. Hardware retail, 10 to 50 staff, inside the metro.",
          "",
          "| Company | Staff | Decision maker | Fit |",
          "| --- | --- | --- | --- |",
          "| Meridian Hardware | 34 | Thabo Nkosi, Ops | 0.91 |",
          "| Cape Fittings Co. | 22 | Ruth Adams, Owner | 0.88 |",
          "| Harbour Supply | 47 | Sipho Dlamini, GM | 0.84 |",
          "",
          "The full list is on the Leads board.",
        ].join("\n"),
      });
      // Top level, not a thread reply: a reply collapses into a "1 reply"
      // summary line, and the human pushing back on the agent is the moment
      // the shot exists to show.
      emit({
        channelName: "growth",
        pubkey: daniel,
        id: ids.phone,
        createdAt: t0 + 420,
        content:
          "Drop anything without a working phone number. Last batch burned two days on dead lines.",
      });
      emit({
        channelName: "growth",
        pubkey: forager,
        id: ids.drafted,
        createdAt: t0 + 700,
        content:
          "Drafted 20 first-touch emails in your voice. They're queued: nothing sends until one of you approves.",
      });
      emit({
        channelName: "growth",
        pubkey: daniel,
        createdAt: t0 + 820,
        parentEventId: ids.drafted,
        content: "Send window is after 9am their time, not before.",
      });
      for (const [reactor, emoji, offset] of [
        [maya, "👍", 760],
        [daniel, "👍", 780],
        [aisha, "🎯", 800],
      ] as const) {
        emit({
          channelName: "growth",
          pubkey: reactor,
          kind: 7,
          createdAt: t0 + offset,
          content: emoji,
          extraTags: [
            ["e", ids.drafted],
            ["p", forager],
          ],
        });
      }
      emit({
        channelName: "growth",
        pubkey: aisha,
        createdAt: t0 + 900,
        content:
          "Approve the first ten and hold the rest until we see reply rates.",
      });
    },
    {
      maya: MAYA.pubkey,
      daniel: DANIEL.pubkey,
      aisha: AISHA.pubkey,
      scout: SCOUT.pubkey,
      forager: FORAGER.pubkey,
      ids: {
        sweep: ID_SWEEP,
        ranked: ID_RANKED,
        phone: ID_PHONE,
        drafted: ID_DRAFTED,
      },
      t0: T0,
    },
  );

  // Opened twice, via another channel: the first visit is what marks the
  // seeded history read. Capturing it would ship a "NEW" rule across the
  // thread and a "4 new messages" pill floating over the header.
  await page.getByTestId("channel-growth").click();
  await expect(page.getByTestId("chat-title")).toHaveText("growth");
  await expect(page.getByText("Approve the first ten")).toBeVisible();
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await page.getByTestId("channel-growth").click();
  await expect(page.getByTestId("chat-title")).toHaveText("growth");

  // Gate on the avatars themselves, not just the text. The agent characters
  // are the point of the shot and a capture taken before the PNG decodes
  // ships an empty disc; the human initials sit behind Radix's 200ms fallback
  // delay, which is long enough to lose if the wait is only for text.
  await expect(page.getByText("Approve the first ten")).toBeVisible();
  await expect(page.getByText("Meridian Hardware")).toBeVisible();
  for (const avatar of [SCOUT.avatarUrl, FORAGER.avatarUrl]) {
    await expect(page.locator(`img[src="${avatar}"]`).first()).toBeVisible();
  }
  await expect(
    page.getByTestId("message-avatar-fallback").first(),
  ).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({ path: `${SHOTS}/product-channel.png` });
});

test("capture: git built in", async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-projects-view").click();
  await waitForAnimations(page);

  // Stops above the commit feed: its top row is a push to a repo the mock
  // names "buzz", and a Buzz-era repo name has no place in Colony imagery.
  await page.screenshot({
    path: `${SHOTS}/feature-git.png`,
    clip: { x: 290, y: 0, width: 990, height: 350 },
  });
});

// The Discovery pipeline and outreach-approval shots ride the e2e fixture
// data source (FixtureDiscoveryDataSource): MODE === "e2e" swaps it in at
// DiscoveryRouteScreen, so the campaigns below are pre-seeded product
// fixtures, not bridge mocks. Deep links are the seeding mechanism.
test("capture: discovery pipeline", async ({ page }) => {
  await seedActiveIdentity(page, TEST_IDENTITIES.tyler);
  await installMockBridge(page);
  // 1800 wide: at 1600 the lead table still ran past the panel and sliced
  // the STATUS pills mid-word. 1000 tall for a full run of scored rows.
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto(
    "/#/discovery?surface=campaign&industryId=automotive" +
      "&verticalId=auto-repair&campaignId=auto-repair-johannesburg&tab=leads",
    { waitUntil: "domcontentloaded" },
  );
  await expect(page.getByTestId("campaign-lead-table")).toBeVisible();
  await expect(page.getByText("Rosebank Auto Care")).toBeVisible();
  // Grid view, not the list: the list's table scrolls horizontally inside
  // the panel at any viewport width, so its STATUS pills always render
  // sliced mid-word. The card grid keeps every score and status chip
  // inside the frame.
  await page.getByRole("button", { name: "Grid view" }).click();
  await expect(
    page.locator('[data-testid^="lead-card-"]').first(),
  ).toBeVisible();
  await waitForAnimations(page);
  // Clip to the campaign panel content, skipping the app sidebar: it
  // repeats context the hero shot already gives the page, its width varies
  // run to run (a fixed-x clip leaked a lavender sliver), and the mock
  // identity chip at its foot ("E2E Test") has no place in marketing
  // imagery. Anchor on the Back link (panel's left content edge) and the
  // Run Discovery button (its right content edge) instead.
  const back = await page.getByText("Back to Auto Repair").boundingBox();
  const run = await page
    .getByRole("button", { name: "Run Discovery" })
    .boundingBox();
  if (!back || !run) throw new Error("could not measure the campaign panel");
  const left = back.x - 32;
  const top = back.y - 20;
  await page.screenshot({
    path: `${SHOTS}/discovery-pipeline.png`,
    clip: {
      x: left,
      y: top,
      width: run.x + run.width + 32 - left,
      height: 976 - top,
    },
  });
});

test("capture: outreach approval queue", async ({ page }) => {
  await seedActiveIdentity(page, TEST_IDENTITIES.tyler);
  await installMockBridge(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(
    "/#/discovery?surface=campaign&entity=people&fieldId=marketing" +
      "&roleId=marketing-director&campaignId=marketing-directors-united-states" +
      "&tab=outreach",
    { waitUntil: "domcontentloaded" },
  );
  await expect(
    page.getByRole("heading", { name: "Outreach", exact: true }),
  ).toBeVisible();
  // The seeded queue lists Approved and Scheduled cards first, which pushes
  // every card with an Approve button below the fold. The WhatsApp channel
  // filter isolates the one WhatsApp draft, so the frame holds the metric
  // strip ("Drafts Ready / Awaiting approval") and a Draft card with its
  // Approve button together: the whole claim in one screen.
  await page.getByRole("button", { name: "WhatsApp", exact: true }).click();
  const draftCard = page
    .locator('[data-testid^="outreach-draft-"]')
    .filter({ has: page.getByRole("button", { name: "Approve" }) })
    .first();
  await expect(draftCard).toBeVisible();
  await waitForAnimations(page);
  const heading = await page
    .getByRole("heading", { name: "Outreach", exact: true })
    .boundingBox();
  const card = await draftCard.boundingBox();
  // Same anchor trick as the pipeline shot: the sidebar width varies run
  // to run, so derive the left edge from the panel's own content.
  const create = await page
    .getByRole("button", { name: "Create outreach" })
    .boundingBox();
  if (!heading || !card || !create) {
    throw new Error("could not measure the outreach frame");
  }
  const left = heading.x - 32;
  const top = Math.max(0, heading.y - 16);
  await page.screenshot({
    path: `${SHOTS}/outreach-approval.png`,
    clip: {
      x: left,
      y: top,
      width: create.x + create.width + 32 - left,
      height: card.y + card.height + 24 - top,
    },
  });
});

// The delivered-work shot reuses the hero-shot channel machinery: build a
// website channel, seed the finished-work exchange as history, read it once,
// come back, capture the message cluster.
const TENDER = {
  pubkey: "7e19c4a8d2f6503b1e87ac40d5b92f634a01c8e7f52d3b96e0847ad1c5f29b60",
  name: "Tender",
  avatarUrl: "/onboarding/starter-team/tender.png",
};
const ID_DELIVERED = "5e".repeat(32);

test("capture: work delivered in a channel", async ({ page }) => {
  await installMockBridge(page, {
    searchProfiles: [
      { pubkey: MAYA.pubkey, displayName: MAYA.name },
      { pubkey: AISHA.pubkey, displayName: AISHA.name },
      {
        pubkey: TENDER.pubkey,
        displayName: TENDER.name,
        avatarUrl: TENDER.avatarUrl,
        isAgent: true,
        ownerPubkey: MAYA.pubkey,
      },
    ],
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      typeof (
        window as unknown as { __BUZZ_E2E_INVOKE_MOCK_COMMAND__?: unknown }
      ).__BUZZ_E2E_INVOKE_MOCK_COMMAND__ === "function",
  );

  await page.evaluate(
    async ({ members }) => {
      const w = window as unknown as {
        __BUZZ_E2E_INVOKE_MOCK_COMMAND__: (
          command: string,
          payload: Record<string, unknown>,
        ) => Promise<unknown>;
        __BUZZ_E2E_INVALIDATE_CHANNELS__: () => void;
      };
      const channel = (await w.__BUZZ_E2E_INVOKE_MOCK_COMMAND__(
        "create_channel",
        {
          name: "website",
          channelType: "stream",
          visibility: "open",
          description: "The studio site and everything on it",
        },
      )) as { id: string };
      await w.__BUZZ_E2E_INVOKE_MOCK_COMMAND__("add_channel_members", {
        channelId: channel.id,
        pubkeys: members,
      });
      w.__BUZZ_E2E_INVALIDATE_CHANNELS__();
    },
    { members: [AISHA.pubkey, TENDER.pubkey] },
  );

  await page.evaluate(
    ({ maya, aisha, tender, idDelivered, t0 }) => {
      const emit = (
        window as unknown as {
          __BUZZ_E2E_EMIT_MOCK_MESSAGE__: (
            input: Record<string, unknown>,
          ) => void;
        }
      ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__;
      emit({
        channelName: "website",
        pubkey: maya,
        createdAt: t0 - 700,
        content:
          "The services page still says we do consultations on Saturdays. We stopped that in June. Can we get the whole page brought up to date?",
      });
      emit({
        channelName: "website",
        pubkey: tender,
        id: idDelivered,
        createdAt: t0,
        content: [
          "Done. Every page is current again:",
          "",
          "- Services page: Saturday consultations removed, the three packages match the new price list",
          "- Homepage: headline now leads with the 48-hour turnaround, new photo of the workshop floor",
          "- Contact page: the old landline is gone, the booking link goes straight to your calendar",
          "",
          "Preview is live. One look from you and it publishes.",
        ].join("\n"),
      });
      // Top level, not a thread reply: a reply collapses into a "1 reply"
      // summary, and the owner signing off is the moment this shot exists
      // to show.
      emit({
        channelName: "website",
        pubkey: aisha,
        createdAt: t0 + 240,
        content: "Checked all three. Publish it.",
      });
      for (const [reactor, emoji, offset] of [
        [maya, "🎉", 300],
        [aisha, "👍", 320],
      ] as const) {
        emit({
          channelName: "website",
          pubkey: reactor,
          kind: 7,
          createdAt: t0 + offset,
          content: emoji,
          extraTags: [
            ["e", idDelivered],
            ["p", tender],
          ],
        });
      }
    },
    {
      maya: MAYA.pubkey,
      aisha: AISHA.pubkey,
      tender: TENDER.pubkey,
      idDelivered: ID_DELIVERED,
      t0: T0,
    },
  );

  // First visit marks history read; return trip captures without the NEW rule.
  await page.getByTestId("channel-website").click();
  await expect(page.getByTestId("chat-title")).toHaveText("website");
  await expect(page.getByText("Publish it.")).toBeVisible();
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await page.getByTestId("channel-website").click();
  await expect(page.getByTestId("chat-title")).toHaveText("website");
  await expect(page.getByText("Preview is live")).toBeVisible();
  // Gate on the agent PNG and the human initial fallbacks: Radix delays
  // fallbacks ~200ms, and a capture that beats them ships empty avatar
  // discs (the first take of this shot did exactly that).
  await expect(
    page.locator(`img[src="${TENDER.avatarUrl}"]`).first(),
  ).toBeVisible();
  await expect(
    page.getByTestId("message-avatar-fallback").first(),
  ).toBeVisible();
  await waitForAnimations(page);

  // Frame from the owner's request down to the composer floor, minus the
  // sidebar: the story is the delivery, not the channel list. The sticky
  // day-divider pill pins itself to the top of the scroll area, so the
  // clip starts just under its measured bottom edge; padding relative to
  // the opener row kept slicing it (two takes running).
  const pill = await page
    .getByText("Saturday, August 1st", { exact: true })
    .boundingBox();
  if (!pill) throw new Error("could not measure the day-divider pill");
  const top = pill.y + pill.height + 6;
  await page.screenshot({
    path: `${SHOTS}/work-delivered.png`,
    clip: { x: 290, y: top, width: 990, height: 552 },
  });
});

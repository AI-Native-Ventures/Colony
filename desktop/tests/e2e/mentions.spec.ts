import { expect, test } from "@playwright/test";
import { npubEncode } from "nostr-tools/nip19";

import { waitForAnimations } from "../helpers/animations";

import {
  installMockBridge,
  openChannelBrowser,
  TEST_IDENTITIES,
} from "../helpers/bridge";
import { GENERAL_CHANNEL_ID } from "../helpers/factoryAgent";
import {
  GUIDE_NAME,
  mentionPrefix,
  STARTER_PERSONA_IDS,
} from "../helpers/starterTeam";

const MOCK_VIEWER_PUBKEY = "deadbeef".repeat(8);
// Ephemeral huddle channel the mock bridge seeds for huddle-scoped sends.
const HUDDLE_EPHEMERAL_CHANNEL_ID = "3f9f2c4e-8b7a-4b1c-9d2e-5a6f7c8d9e0f";

test.beforeEach(async ({ page }) => {
  await installMockBridge(page);
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach("outgoing-diagnostic", {
      body: JSON.stringify(
        await page.evaluate(() => ({
          events: window.__BUZZ_E2E_SIGNED_EVENTS__,
          commands: window.__BUZZ_E2E_COMMAND_LOG__,
        })),
      ),
      contentType: "application/json",
    });
  }
});

const IN_CHANNEL_MANAGED_AGENT_PUBKEY =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OUT_OF_CHANNEL_MANAGED_AGENT_PUBKEY =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OUT_OF_CHANNEL_PROVIDER_AGENT_PUBKEY =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const REUSABLE_PERSONA_AGENT_PUBKEY =
  "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const ALLOWLIST_RELAY_AGENT_PUBKEY =
  "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const DELAYED_RELAY_AGENT_PUBKEY =
  "9999999999999999999999999999999999999999999999999999999999999999";
const CASEY_PROFILE_PUBKEY =
  "1111111111111111111111111111111111111111111111111111111111111111";
const PROFILE_ONLY_AGENT_PUBKEY =
  "8f83d6b7f3d74f7d933ae3a54dd8c6cc85c7f98e531c16e5a827b953441a8d67";
const OWNED_AGENT_PROFILE_PUBKEY =
  "1212121212121212121212121212121212121212121212121212121212121212";
const ELROND_PUBKEY = "31".repeat(32);
const LEGOLAS_PUBKEY = "32".repeat(32);
const GIMLI_PUBKEY = "33".repeat(32);
const GANDALF_PUBKEY = "34".repeat(32);
const STANDARD_GROUPED_ARRIVAL_ACTOR = {
  pubkey: "10".repeat(32),
  displayName: "Alice Chen",
};
const STANDARD_GROUPED_ARRIVAL_TARGETS = [
  { pubkey: "11".repeat(32), displayName: "Erica Chapman" },
  { pubkey: "12".repeat(32), displayName: "Peter Griffin" },
  { pubkey: "13".repeat(32), displayName: "Marcia Thomas" },
  { pubkey: "14".repeat(32), displayName: "Jordan Lee" },
  { pubkey: "15".repeat(32), displayName: "Olivia Park" },
  { pubkey: "16".repeat(32), displayName: "Sam Rivera" },
];
const JOIN_COLLAPSE_PROFILES = [
  { pubkey: ELROND_PUBKEY, displayName: "Elrond" },
  { pubkey: LEGOLAS_PUBKEY, displayName: "Legolas" },
  { pubkey: GIMLI_PUBKEY, displayName: "Gimli" },
  { pubkey: GANDALF_PUBKEY, displayName: "Gandalf" },
];
const JOIN_COLLAPSE_CHANNEL_NAME = "random";
const SYSTEM_MESSAGE_KIND = 40099;
const DM_THREAD_AGENT_MENTION_ERROR_TEXT =
  "Agents must already be in a DM to be mentioned in its threads. Start a new conversation that includes the agent.";
const DM_THREAD_MEMBERS_LOADING_ERROR_TEXT =
  "Checking conversation members. Try again in a moment.";
const JOIN_COLLAPSE_SPLIT_TEXTS = [
  "Elrond added by you",
  "Legolas added by Elrond, along with Gimli",
  "Gandalf added by you",
];
const JOIN_COLLAPSE_GROUPED_TEXT =
  "Elrond was added along with Legolas, Gimli, and Gandalf";
const JOIN_COLLAPSE_CAPTURE_WIDTH = 560;
const JOIN_COLLAPSE_CAPTURE_HEIGHT = 260;
const JOIN_COLLAPSE_CAPTURE_VERTICAL_PADDING = 24;

/** Locator scoped to the mention autocomplete dropdown inside the composer. */
function autocomplete(page: import("@playwright/test").Page) {
  return page
    .getByTestId("message-composer")
    .getByTestId("mention-autocomplete");
}

async function readCommandLog(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    return (
      (window as Window & { __BUZZ_E2E_COMMANDS__?: string[] })
        .__BUZZ_E2E_COMMANDS__ ?? []
    );
  });
}

async function readCommandPayloadLog(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    return (
      (
        window as Window & {
          __BUZZ_E2E_COMMAND_LOG__?: Array<{
            command: string;
            payload: unknown;
          }>;
        }
      ).__BUZZ_E2E_COMMAND_LOG__ ?? []
    );
  });
}

async function readOutgoingMentionPubkeys(
  page: import("@playwright/test").Page,
  content: string,
) {
  return page.evaluate((expectedContent) => {
    const signedEvent = (
      window as Window & {
        __BUZZ_E2E_SIGNED_EVENTS__?: Array<{
          content?: string;
          tags?: string[][];
        }>;
      }
    ).__BUZZ_E2E_SIGNED_EVENTS__?.find(
      (event) => event.content === expectedContent,
    );
    if (signedEvent) {
      return (signedEvent.tags ?? [])
        .filter((tag) => tag[0] === "p" && tag[1])
        .map((tag) => tag[1]);
    }

    const entries =
      (
        window as Window & {
          __BUZZ_E2E_COMMAND_LOG__?: Array<{
            command: string;
            payload: unknown;
          }>;
        }
      ).__BUZZ_E2E_COMMAND_LOG__ ?? [];

    for (const entry of entries) {
      if (entry.command === "send_channel_message") {
        const payload = entry.payload as
          | { content?: string; mentionPubkeys?: string[] }
          | undefined;
        if (payload?.content === expectedContent) {
          return payload.mentionPubkeys ?? [];
        }
      }

      if (entry.command === "sign_event") {
        const unsignedEvent = entry.payload as
          | { content?: string; tags?: string[][] }
          | undefined;
        if (unsignedEvent?.content !== expectedContent) continue;
        return (unsignedEvent.tags ?? [])
          .filter((tag) => tag[0] === "p" && tag[1])
          .map((tag) => tag[1]);
      }

      if (entry.command !== "plugin:websocket|send") continue;
      const data = (
        entry.payload as { message?: { data?: string } } | undefined
      )?.message?.data;
      if (!data) continue;

      try {
        const frame = JSON.parse(data) as [
          string,
          { content?: string; tags?: string[][] },
        ];
        if (frame[0] !== "EVENT" || frame[1]?.content !== expectedContent) {
          continue;
        }
        return (frame[1].tags ?? [])
          .filter((tag) => tag[0] === "p" && tag[1])
          .map((tag) => tag[1]);
      } catch {}
    }

    return null;
  }, content);
}

function commandCount(commands: string[], command: string) {
  return commands.filter((entry) => entry === command).length;
}

async function emitMockMessage(
  page: import("@playwright/test").Page,
  channelName: string,
  content: string,
  options?: {
    kind?: number;
    mentionPubkeys?: string[];
    parentEventId?: string;
    pubkey?: string;
  },
) {
  const event = await page.evaluate(
    ({ ch, kind, mentionPubkeys, msg, parentEventId, pubkey }) => {
      return (
        window as Window & {
          __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
            channelName: string;
            content: string;
            kind?: number;
            mentionPubkeys?: string[];
            parentEventId?: string | null;
            pubkey?: string;
          }) => { id: string; created_at: number; pubkey: string };
        }
      ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: ch,
        content: msg,
        kind,
        mentionPubkeys,
        parentEventId: parentEventId ?? undefined,
        pubkey: pubkey ?? undefined,
      });
    },
    {
      ch: channelName,
      kind: options?.kind,
      mentionPubkeys: options?.mentionPubkeys,
      msg: content,
      parentEventId: options?.parentEventId ?? null,
      pubkey: options?.pubkey ?? TEST_IDENTITIES.alice.pubkey,
    },
  );
  if (!event) {
    throw new Error("Mock message emitter is not installed");
  }
  return event;
}

async function waitForMockLiveSubscription(
  page: import("@playwright/test").Page,
  channelName: string,
  kind?: number,
) {
  await expect
    .poll(async () => {
      return page.evaluate(
        ({ currentChannelName, kind: expectedKind }) => {
          return (
            (
              window as Window & {
                __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
                  channelName: string;
                  kind?: number;
                }) => boolean;
              }
            ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
              channelName: currentChannelName,
              kind: expectedKind,
            }) ?? false
          );
        },
        { currentChannelName: channelName, kind },
      );
    })
    .toBe(true);
}

// The channel timeline renders off a `useDeferredValue` snapshot that lags the
// latest `messages` by a commit; the list wrapper carries
// `data-render-pending="true"` while that commit is in flight and drops the
// attribute once it settles. Poll for its absence before asserting on
// freshly-sent content so the assertion does not race the deferred commit.
async function waitForTimelineSettled(page: import("@playwright/test").Page) {
  await expect(page.locator("[data-render-pending]")).toHaveCount(0);
}

/**
 * Closes any open tooltip before the pointer travels to the next trigger.
 *
 * Radix arms a "pointer in transit" grace area when the pointer leaves a
 * trigger whose tooltip is open, and `TooltipTrigger.onPointerMove` refuses to
 * open while that flag is set (@radix-ui/react-tooltip: `if
 * (!hasPointerMoveOpenedRef.current && !isPointerInTransitRef.current)`). Only
 * a later document `pointermove` clears it. A real user generates those
 * continuously; `locator.hover()` jumps from one trigger to the next in a
 * single synthetic move, so when the first tooltip is still open at that
 * moment the second trigger's only pointer event is swallowed and its tooltip
 * never appears, with the pointer resting on it.
 *
 * That is what made this file's grouped-tooltip test flaky (6/40 at 4x CPU
 * throttle): whether the first tooltip had already closed decided the outcome.
 * The grace area is only created while the tooltip's content is mounted, so
 * dismissing it first removes the condition entirely. Parking the pointer
 * somewhere neutral is not equivalent: every candidate resting spot in this
 * app is itself a tooltip trigger, which re-arms the same flag. Moving to
 * (4, 4) lands on the sidebar toggle and made this test worse, 9/40, with two
 * tooltips open at once.
 */
async function dismissOpenTooltip(page: import("@playwright/test").Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
}

function normalizeVisibleText(text: string) {
  return text.replace(/\s+,/g, ",").replace(/\s+/g, " ").trim();
}

function findDuplicateFixturePubkeys(
  profiles: Array<{ pubkey: string; displayName: string }>,
) {
  const namesByPubkey = new Map<string, string[]>();

  for (const profile of profiles) {
    const names = namesByPubkey.get(profile.pubkey) ?? [];
    names.push(profile.displayName);
    namesByPubkey.set(profile.pubkey, names);
  }

  return [...namesByPubkey.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([pubkey, displayNames]) => ({ pubkey, displayNames }));
}

async function collectJoinCollapseRows(page: import("@playwright/test").Page) {
  const rows = page.getByTestId("system-message-row").filter({
    hasText: /Elrond|Legolas|Gimli|Gandalf/,
  });
  const texts: string[] = [];
  const count = await rows.count();
  for (let index = 0; index < count; index += 1) {
    texts.push(normalizeVisibleText(await rows.nth(index).innerText()));
  }
  return { rows, texts };
}

async function maybeCaptureJoinCollapseTimeline(
  page: import("@playwright/test").Page,
) {
  const capturePath = process.env.JOIN_COLLAPSE_CAPTURE_PATH;
  if (!capturePath) return;
  await waitForAnimations(page);
  const timeline = page.getByTestId("message-timeline");
  const timelineBox = await timeline.boundingBox();
  const { rows } = await collectJoinCollapseRows(page);
  const rowBoxes = await Promise.all(
    Array.from({ length: await rows.count() }, (_, index) =>
      rows.nth(index).boundingBox(),
    ),
  );
  const visibleRowBoxes = rowBoxes.filter(
    (box): box is NonNullable<typeof box> => box !== null,
  );
  if (!timelineBox || visibleRowBoxes.length === 0) {
    throw new Error("Join-collapse screenshot target is not visible");
  }
  const minRowY = Math.min(...visibleRowBoxes.map((box) => box.y));
  const maxRowY = Math.max(...visibleRowBoxes.map((box) => box.y + box.height));
  const minRowX = Math.min(...visibleRowBoxes.map((box) => box.x));
  const maxRowX = Math.max(...visibleRowBoxes.map((box) => box.x + box.width));
  const desiredTop = minRowY - JOIN_COLLAPSE_CAPTURE_VERTICAL_PADDING;
  const desiredBottom = maxRowY + JOIN_COLLAPSE_CAPTURE_VERTICAL_PADDING;
  const desiredCenter = (desiredTop + desiredBottom) / 2;
  const desiredHorizontalCenter = (minRowX + maxRowX) / 2;
  const viewportHeight = page.viewportSize()?.height ?? 720;
  const clip = {
    x: Math.max(
      Math.round(timelineBox.x),
      Math.min(
        Math.round(desiredHorizontalCenter - JOIN_COLLAPSE_CAPTURE_WIDTH / 2),
        Math.round(
          timelineBox.x + timelineBox.width - JOIN_COLLAPSE_CAPTURE_WIDTH,
        ),
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        Math.round(desiredCenter - JOIN_COLLAPSE_CAPTURE_HEIGHT / 2),
        viewportHeight - JOIN_COLLAPSE_CAPTURE_HEIGHT,
      ),
    ),
    width: JOIN_COLLAPSE_CAPTURE_WIDTH,
    height: JOIN_COLLAPSE_CAPTURE_HEIGHT,
  };
  await page.screenshot({ path: capturePath, clip });
  console.log(`JOIN_COLLAPSE_CAPTURE_PATH=${capturePath}`);
}

async function expectOwnedAgentProfileActions(
  profilePopover: import("@playwright/test").Locator,
  pubkey: string,
) {
  await expect(
    profilePopover.getByTestId(`user-profile-popover-message-${pubkey}`),
  ).toBeVisible();
  await expect(
    profilePopover.getByTestId(`user-profile-popover-wave-${pubkey}`),
  ).toHaveCount(0);
  await expect(
    profilePopover.getByTestId(`user-profile-popover-huddle-${pubkey}`),
  ).toBeVisible();
}

async function expectAgentProfileActionsHidden(
  profilePopover: import("@playwright/test").Locator,
  pubkey: string,
) {
  await expect(
    profilePopover.getByTestId(`user-profile-popover-message-${pubkey}`),
  ).toHaveCount(0);
  await expect(
    profilePopover.getByTestId(`user-profile-popover-wave-${pubkey}`),
  ).toHaveCount(0);
  await expect(
    profilePopover.getByTestId(`user-profile-popover-huddle-${pubkey}`),
  ).toHaveCount(0);
}

test("@ trigger prioritizes channel members before runnable personas and other managed agents", async ({
  page,
}) => {
  await installMockBridge(page, {
    activePersonaIds: [STARTER_PERSONA_IDS.fizz],
    managedAgents: [
      {
        pubkey: TEST_IDENTITIES.charlie.pubkey,
        name: "charlie",
        status: "stopped",
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("@");

  const dropdown = autocomplete(page);
  await expect(dropdown).toBeVisible();
  await expect(dropdown.getByText("alice")).toHaveCount(0);
  await expect(dropdown.getByText("bob")).toBeVisible();
  await expect(dropdown.getByText(GUIDE_NAME)).toBeVisible();
  await expect(dropdown.getByText("charlie")).toBeVisible();
  await expect(dropdown.getByText("outsider")).toHaveCount(0);
  const charlieRow = dropdown.locator("button", { hasText: "charlie" });
  await expect(charlieRow.getByTestId("mention-agent-icon")).toBeVisible();
  await expect(charlieRow.getByText("not in channel")).toBeVisible();
  await expect(
    dropdown
      .locator("button", { hasText: "alice" })
      .getByText("not in channel"),
  ).not.toBeVisible();

  const suggestions = dropdown.locator("button");
  const suggestionText = await suggestions.allInnerTexts();
  const fizzIndex = suggestionText.findIndex((text) =>
    text.includes(GUIDE_NAME),
  );
  const bobIndex = suggestionText.findIndex((text) => text.includes("bob"));
  const charlieIndex = suggestionText.findIndex((text) =>
    text.includes("charlie"),
  );
  const outsiderIndex = suggestionText.findIndex((text) =>
    text.includes("outsider"),
  );
  expect(fizzIndex).toBeGreaterThanOrEqual(0);
  expect(bobIndex).toBeGreaterThanOrEqual(0);
  expect(charlieIndex).toBeGreaterThanOrEqual(0);
  expect(outsiderIndex).toEqual(-1);
  expect(bobIndex).toBeLessThan(fizzIndex);
  expect(fizzIndex).toBeLessThan(charlieIndex);
});

test("duplicate owned agents preserve provenance and exact pubkey selection", async ({
  page,
}) => {
  const managedPubkey = IN_CHANNEL_MANAGED_AGENT_PUBKEY;
  const relayPubkey = ALLOWLIST_RELAY_AGENT_PUBKEY;
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: managedPubkey,
        name: "carl",
        status: "running",
        channelNames: ["general"],
        backend: {
          type: "provider",
          id: "mock",
          config: {},
        },
      },
    ],
    relayAgents: [
      {
        pubkey: relayPubkey,
        ownerPubkey: MOCK_VIEWER_PUBKEY,
        name: "carl",
        respondTo: "owner-only",
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await page.evaluate(
    async ({ channelId, pubkey }) => {
      const invoke = window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__;
      if (!invoke) throw new Error("Mock bridge is not installed.");
      await invoke("add_channel_members", {
        channelId,
        pubkeys: [pubkey],
        role: "bot",
      });
      await window.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({
        queryKey: ["channels"],
      });
    },
    { channelId: GENERAL_CHANNEL_ID, pubkey: relayPubkey },
  );

  const input = page.getByTestId("message-input");
  await input.fill("@carl");
  const dropdown = autocomplete(page);
  const managedRow = dropdown.getByTestId(
    `mention-suggestion-${managedPubkey}`,
  );
  const relayRow = dropdown.getByTestId(`mention-suggestion-${relayPubkey}`);
  // Colony's row labels win: the agent label plus its own owner label,
  // rather than upstream's "managed here" / "managed elsewhere" pair.
  // Both devices here are owned by the viewer, so the distinguishing
  // evidence in Colony's UI is the npub, asserted below.
  await expect(managedRow).toBeVisible();
  await page.waitForTimeout(1500);
  console.log("ROWS", await dropdown.locator("button").allTextContents());
  await expect(managedRow).toContainText("agent");
  await expect(managedRow).toContainText("managed by you");
  await expect(relayRow).toContainText("agent");
  await expect(relayRow).toContainText("managed by you");

  const collisionKeys = dropdown.getByTestId("mention-collision-npub");
  await expect(collisionKeys).toHaveCount(2);
  const fullNpubs = await collisionKeys.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("title")),
  );
  expect(fullNpubs).toHaveLength(2);
  expect(new Set(fullNpubs).size).toBe(2);

  const initialRows = dropdown.locator("button");
  const managedIndex = await initialRows.evaluateAll(
    (buttons, pubkey) =>
      buttons.findIndex(
        (button) =>
          button.getAttribute("data-testid") === `mention-suggestion-${pubkey}`,
      ),
    managedPubkey,
  );
  expect(managedIndex).toBeGreaterThanOrEqual(0);
  for (let index = 0; index < managedIndex; index += 1) {
    await input.press("ArrowDown");
  }
  await input.press("Enter");
  await page.keyboard.type("local");
  await page.getByTestId("send-message").click();
  await expect
    .poll(() => readOutgoingMentionPubkeys(page, "@carl local"))
    .toEqual([managedPubkey]);
  await expect(input).toBeEmpty();

  await input.fill("@carl");
  const reopenedDropdown = autocomplete(page);
  await expect(reopenedDropdown).toBeVisible();
  await reopenedDropdown
    .getByTestId(`mention-suggestion-${relayPubkey}`)
    .click();
  await page.keyboard.type("remote");
  await page.getByTestId("send-message").click();
  const sendWithoutInviting = page.getByRole("button", { name: "Do nothing" });
  try {
    await sendWithoutInviting.waitFor({ state: "visible", timeout: 2_000 });
    await sendWithoutInviting.click();
  } catch {
    // In-channel selections send immediately without opening the prompt.
  }
  await expect
    .poll(() => readOutgoingMentionPubkeys(page, "@carl remote"))
    .toEqual([relayPubkey]);
});

test("relay-only shared agents emit an outbound mention tag when selected", async ({
  page,
}) => {
  // Colony's stock alice fixture is a relay-directory member with
  // respond_to "owner-only" and no owner, so she is not mentionable
  // without explicit directory evidence (#5681). Seed the relay policy
  // the case needs; the behaviour under test is the outbound tag.
  await installMockBridge(page, {
    relayAgents: [
      {
        pubkey: TEST_IDENTITIES.alice.pubkey,
        name: "alice",
        respondTo: "anyone",
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("Ask @alice");

  // Colony's suggestion row is itself the button, not a nested one.
  const aliceRow = autocomplete(page).getByTestId(
    `mention-suggestion-${TEST_IDENTITIES.alice.pubkey}`,
  );
  await expect(aliceRow).toBeVisible();
  await aliceRow.click();
  await page.keyboard.type("please reply");

  const content = "Ask @alice please reply";
  await expect(input).toHaveText(content);
  await page.getByTestId("send-message").click();

  await expect
    .poll(() => readOutgoingMentionPubkeys(page, content))
    .toContain(TEST_IDENTITIES.alice.pubkey);
});

test("typing an exact agent name and Space commits its chip and mention tag", async ({
  page,
}) => {
  // Colony's stock alice fixture is a relay-directory member with respond_to
  // "owner-only" and no owner, so she is not mentionable without explicit
  // directory evidence (#5681). Seed the policy; the behaviour under test is
  // Space resolving an exactly typed name.
  await installMockBridge(page, {
    relayAgents: [
      {
        pubkey: TEST_IDENTITIES.alice.pubkey,
        name: "alice",
        respondTo: "anyone",
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("@alice");
  await expect(
    autocomplete(page).getByTestId(
      `mention-suggestion-${TEST_IDENTITIES.alice.pubkey}`,
    ),
  ).toBeVisible();

  await input.fill("Ask @alice");
  await input.press(" ");
  await page.keyboard.type("please reply");

  const content = "Ask @alice please reply";
  await expect(input).toHaveText(content);
  await expect(
    input.locator(".agent-mention-highlight", { hasText: "alice" }),
  ).toBeVisible();

  await page.getByTestId("send-message").click();
  await expect
    .poll(() => readOutgoingMentionPubkeys(page, content))
    .toContain(TEST_IDENTITIES.alice.pubkey);
});

test("Shift+Space leaves an exact agent name plain and emits no mention tag", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: OUT_OF_CHANNEL_MANAGED_AGENT_PUBKEY,
        name: "quinn",
        status: "stopped",
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  // Plain in-channel member names are intentionally tagged at send time, so
  // use an authorized non-member to isolate selection from text extraction.
  const input = page.getByTestId("message-input");
  await input.fill("@quinn");
  await expect(
    autocomplete(page).getByTestId(
      `mention-suggestion-${OUT_OF_CHANNEL_MANAGED_AGENT_PUBKEY}`,
    ),
  ).toBeVisible();

  await input.fill("Ask @quinn");
  await input.press("Shift+Space");
  await page.keyboard.type("please reply");

  const content = "Ask @quinn please reply";
  await expect(input).toHaveText(content);
  await expect(input.locator(".agent-mention-highlight")).toHaveCount(0);

  await page.getByTestId("send-message").click();
  await expect
    .poll(() => readOutgoingMentionPubkeys(page, content))
    .toEqual([]);
});

// The three tests below pin the code-context gate on the Space commit. They
// key off casing, because a commit rewrites the draft to the candidate's
// canonical display name: a surviving "@ALICE" means the typed text was left
// alone. Chip decorations are deliberately not asserted — they already render
// over known names inside code, which is a separate pre-existing gap.
test("Space inside a code block leaves an exact agent name literal", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.click();
  await page.keyboard.type("```");
  await page.keyboard.press("Enter");
  await expect(input.locator("pre")).toBeVisible();

  await page.keyboard.type("deploy @ALICE");
  await page.keyboard.press(" ");
  await page.keyboard.type("now");

  await expect(input.locator("pre")).toHaveText("deploy @ALICE now");

  await page.getByTestId("send-message").click();
  await expect
    .poll(() => readOutgoingMentionPubkeys(page, "```\ndeploy @ALICE now\n```"))
    .toEqual([]);
});

test("Space inside an inline code span leaves an exact agent name literal", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.click();
  // The closing backtick turns the span into a code mark, which drops the
  // backticks from the text the mention pipeline reads.
  await page.keyboard.type("run `@ALICE`");
  await expect(input.locator("code")).toHaveText("@ALICE");

  await page.keyboard.press(" ");
  await page.keyboard.type("now");

  await expect(input.locator("code")).toHaveText("@ALICE");
  await expect(input).toHaveText("run @ALICE now");

  await page.getByTestId("send-message").click();
  await expect
    .poll(() => readOutgoingMentionPubkeys(page, "run `@ALICE` now"))
    .toEqual([]);
});

test("Space still resolves an exact agent name typed after a code span", async ({
  page,
}) => {
  // Colony's stock alice fixture is a relay-directory member with respond_to
  // "owner-only" and no owner, so she is not mentionable without explicit
  // directory evidence (#5681). Seed the policy; the behaviour under test is
  // Space resolving an exactly typed name.
  await installMockBridge(page, {
    relayAgents: [
      {
        pubkey: TEST_IDENTITIES.alice.pubkey,
        name: "alice",
        respondTo: "anyone",
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.click();
  await page.keyboard.type("run `deploy` @ALICE");
  await page.keyboard.press(" ");
  await page.keyboard.type("now");

  const content = "run `deploy` @alice now";
  await expect(input).toHaveText("run deploy @alice now");

  await page.getByTestId("send-message").click();
  await expect
    .poll(() => readOutgoingMentionPubkeys(page, content))
    .toContain(TEST_IDENTITIES.alice.pubkey);
});

test("thread autocomplete keeps multiple long names readable in a narrow panel", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey:
          "9999999999999999999999999999999999999999999999999999999999999999",
        name: "Brain With A Very Long Name",
        status: "stopped",
      },
      {
        pubkey:
          "9999999999999999999999999999999999999999999999999999999999999998",
        name: "Brainstorming Assistant With A Long Name",
        status: "stopped",
      },
      {
        pubkey:
          "9999999999999999999999999999999999999999999999999999999999999997",
        name: "Brainy Helper With Another Long Name",
        status: "stopped",
      },
    ],
  });
  await page.setViewportSize({ width: 900, height: 640 });
  await page.addInitScript(() => {
    window.sessionStorage.setItem("buzz.desktop.thread-panel-width", "300");
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await page.setViewportSize({ width: 760, height: 640 });

  await emitMockMessage(page, "general", "Reply to open the thread", {
    parentEventId: "mock-general-welcome",
  });
  const threadSummary = page.getByTestId("message-thread-summary").first();
  await expect(threadSummary).toBeVisible();
  await threadSummary.click();

  const threadPanel = page.getByTestId("message-thread-panel");
  await expect(threadPanel).toBeVisible();
  const panelBox = await threadPanel.boundingBox();
  expect(panelBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(320);

  const input = threadPanel.getByTestId("message-input");
  await input.fill("@Brain");

  const dropdown = threadPanel.getByTestId("mention-autocomplete");
  await expect(dropdown).toBeVisible();

  for (const name of [
    "Brain With A Very Long Name",
    "Brainstorming Assistant With A Long Name",
    "Brainy Helper With Another Long Name",
  ]) {
    const row = dropdown.locator("button", { hasText: name });
    await expect(row).toBeVisible();
    await expect(
      row.getByTestId("mention-suggestion-avatar-fallback"),
    ).toBeVisible();
    await expect(row.getByText("agent")).toBeVisible();
    await expect(row.getByText("managed by you")).toBeVisible();

    await expect(row.getByText(name)).not.toHaveCSS(
      "text-overflow",
      "ellipsis",
    );
  }
});

test("blocks non-participant persona mentions in DM threads", async ({
  page,
}) => {
  await installMockBridge(page, {
    activePersonaIds: [STARTER_PERSONA_IDS.fizz],
  });
  await page.goto("/");
  await page.getByTestId("channel-bob-tyler").click();
  await expect(page.getByTestId("chat-title")).toHaveText("bob-tyler");
  await waitForMockLiveSubscription(page, "bob-tyler");

  const threadRoot = await emitMockMessage(
    page,
    "bob-tyler",
    "Thread before adding an agent",
  );
  await emitMockMessage(page, "bob-tyler", "Existing thread reply", {
    parentEventId: threadRoot.id,
  });
  const threadSummary = page.getByTestId("message-thread-summary").first();
  await expect(threadSummary).toBeVisible();
  await threadSummary.click();

  const threadPanel = page.getByTestId("message-thread-panel");
  const input = threadPanel.getByTestId("message-input");
  await input.fill(`Ask ${mentionPrefix(GUIDE_NAME)}`);
  await expect(
    threadPanel
      .getByTestId("mention-autocomplete")
      .locator("button", { hasText: GUIDE_NAME }),
  ).toBeVisible();
  await input.press("Enter");
  await page.keyboard.type(" in this thread");
  const baselineCommands = await readCommandLog(page);

  await threadPanel.getByTestId("send-message").click();

  await expect(
    page.getByText(
      "Agents must already be in a DM to be mentioned in its threads. Start a new conversation that includes the agent.",
    ),
  ).toBeVisible();
  const commands = await readCommandLog(page);
  expect(commandCount(commands, "create_managed_agent")).toBe(
    commandCount(baselineCommands, "create_managed_agent"),
  );
  expect(commandCount(commands, "add_channel_members")).toBe(
    commandCount(baselineCommands, "add_channel_members"),
  );
  await expect(input).toContainText(GUIDE_NAME);
  await expect(page.getByTestId("chat-title")).toHaveText("bob-tyler");
});

test("defers agent mentions until DM members finish loading", async ({
  page,
}) => {
  await installMockBridge(page, {
    channelMembersReadDelayMs: 5_000,
    managedAgents: [
      {
        pubkey: TEST_IDENTITIES.alice.pubkey,
        name: "alice",
        status: "stopped",
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-alice-tyler").click();
  await expect(page.getByTestId("chat-title")).toHaveText("alice-tyler");
  await waitForMockLiveSubscription(page, "alice-tyler");

  const threadRoot = await emitMockMessage(
    page,
    "alice-tyler",
    "Thread while members load",
  );
  await emitMockMessage(page, "alice-tyler", "Existing thread reply", {
    parentEventId: threadRoot.id,
  });
  await page.getByTestId("message-thread-summary").first().click();

  const threadPanel = page.getByTestId("message-thread-panel");
  const input = threadPanel.getByTestId("message-input");
  await input.fill("Ask @ali");
  await expect(
    threadPanel
      .getByTestId("mention-autocomplete")
      .locator("button", { hasText: "alice" }),
  ).toBeVisible();
  await input.press("Enter");
  await page.keyboard.type(" before members resolve");
  const baselineCommands = await readCommandLog(page);
  await threadPanel.getByTestId("send-message").click();

  await expect(
    page.getByText(DM_THREAD_MEMBERS_LOADING_ERROR_TEXT).first(),
  ).toBeVisible();
  await page.mouse.move(0, 0);
  expect(commandCount(await readCommandLog(page), "add_channel_members")).toBe(
    commandCount(baselineCommands, "add_channel_members"),
  );
  await expect(input).toContainText("before members resolve");

  await page.waitForTimeout(5_100);
  await threadPanel.getByTestId("send-message").click();

  await expect(page.getByText(DM_THREAD_AGENT_MENTION_ERROR_TEXT)).toHaveCount(
    0,
  );
  expect(commandCount(await readCommandLog(page), "add_channel_members")).toBe(
    commandCount(baselineCommands, "add_channel_members"),
  );
  await expect(input).toBeEmpty();
  await expect(threadPanel).toContainText("before members resolve");
});

test("autocomplete filters managed-agent suggestions as user types", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: TEST_IDENTITIES.alice.pubkey,
        name: "alice",
        status: "stopped",
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("@ali");

  const dropdown = autocomplete(page);
  await expect(dropdown.getByText("alice")).toBeVisible();
  await expect(dropdown.getByText("bob")).not.toBeVisible();
});

test("autocomplete searches global non-member people from the first typed character", async ({
  page,
}) => {
  await installMockBridge(page, {
    searchProfiles: [
      {
        pubkey: CASEY_PROFILE_PUBKEY,
        displayName: "tessa",
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("@t");

  const dropdown = autocomplete(page);
  const tessaRow = dropdown.locator("button", { hasText: "tessa" });
  await expect(tessaRow).toBeVisible();
  await expect(tessaRow.getByText("not in channel")).toBeVisible();
});

test("mention autocomplete caps global people search at 50 results", async ({
  page,
}) => {
  const searchProfiles = Array.from({ length: 55 }, (_, index) => ({
    pubkey: `${(index + 1).toString(16).padStart(64, "0")}`,
    displayName: `Alex ${String(index + 1).padStart(2, "0")}`,
  }));
  await installMockBridge(page, { searchProfiles });

  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  await page.getByTestId("message-input").fill("@Alex");

  const dropdown = autocomplete(page);
  await expect(dropdown.locator("button")).toHaveCount(50);
  await expect(dropdown.getByText("Alex 50")).toBeVisible();
  await expect(dropdown.getByText("Alex 55")).toHaveCount(0);
  await expect(dropdown.getByText("not in channel").last()).toBeVisible();

  const searchCalls = (await readCommandPayloadLog(page)).filter(
    (entry) => entry.command === "search_users",
  );
  expect(searchCalls).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({ cursor: null, limit: 50 }),
      }),
    ]),
  );
  expect(searchCalls).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({ cursor: "2", limit: 50 }),
      }),
    ]),
  );
});

test("selecting a person mention inserts @Name into input", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("Hey @bo");

  const dropdown = autocomplete(page);
  await dropdown.getByText("bob").click();

  await expect(input).toHaveText("Hey @bob ");
  const mentionChip = input.locator(".human-mention-highlight", {
    hasText: "bob",
  });
  await expect(mentionChip).toBeVisible();
  await expect(mentionChip).toHaveText("bob");
  await expect(mentionChip).not.toHaveClass(/agent-mention-highlight/);
  await expect(mentionChip).toHaveCSS("display", "inline");
  await expect(
    input.locator(".mention-prefix-hidden", { hasText: "@" }),
  ).toHaveCount(1);
  const iconMask = await mentionChip.evaluate((element) =>
    getComputedStyle(element, "::before").getPropertyValue(
      "-webkit-mask-image",
    ),
  );
  expect(iconMask).toContain("data:image/svg+xml");
});

test("immediate ArrowLeft after a person mention is not bounced past the trailing space", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("Hey @bo");
  await autocomplete(page).getByText("bob").click();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("x");
  const text = (await input.innerText()).replace(/\s+$/, "");
  expect(text).toBe("Hey @bobx");
  expect(text).not.toMatch(/@bob x/);
});

test("clicking a person mention chip edge is not treated as after the trailing space", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("Hey @bo");
  await autocomplete(page).getByText("bob").click();
  const chip = input.locator(".human-mention-highlight", { hasText: "bob" });
  await expect(chip).toBeVisible();
  const box = await chip.boundingBox();
  expect(box).toBeTruthy();
  await chip.click({
    position: {
      x: Math.max((box?.width ?? 1) - 2, 0),
      y: (box?.height ?? 2) / 2,
    },
  });
  await page.keyboard.type("x");
  const text = (await input.innerText()).replace(/\s+$/, "");
  expect(text).toBe("Hey @bobx");
  expect(text).not.toMatch(/@bob x/);
});

test("typing a mention before existing text does not interleave spaces", async ({
  page,
}) => {
  // Regression (the reported repro): with a draft already written, place the
  // caret earlier in the message, type a partial mention, pick a suggestion,
  // then keep typing. Caret correction used to fire on every document change
  // and walk the caret across the mention's trailing space, so each keystroke
  // pushed a space further into the rest of the draft.
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("hello world");

  // Click between "hello" and " world", then open autocomplete there.
  await input.focus();
  for (let i = 0; i < " world".length; i++) {
    await page.keyboard.press("ArrowLeft");
  }
  await page.keyboard.type(" @bo");
  await autocomplete(page).getByText("bob").click();
  await page.keyboard.type("abc");

  await expect(input).toHaveText("hello @bob abc world");
});

test("typing an unregistered @token before existing text is left alone", async ({
  page,
}) => {
  // The trailing-space scan is purely textual, so it also fired for tokens
  // that were never registered as mentions.
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("hello world");
  await input.focus();
  for (let i = 0; i < " world".length; i++) {
    await page.keyboard.press("ArrowLeft");
  }
  await page.keyboard.type(" @zzq");

  await expect(input).toHaveText("hello @zzq world");
});

// Upstream's #7242 case for this ("wrapped channel references keep the icon
// on the first composer line") is not ported: it asserts on
// `.inline-chip-icon-channel`, a decoration Colony does not render. Colony
// decorates agent mentions only (mentionHighlightExtension emits
// "mention-chip agent-mention-highlight"); the human and channel chip
// decorations arrive with #5638.

test("channel references keep caret movement through the channel name", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("#general");

  const channelChip = input.locator(".inline-chip-icon-channel", {
    hasText: "general",
  });
  await expect(channelChip).toBeVisible();
  await expect(channelChip).toHaveText("general");
  await expect(
    input.locator(".mention-prefix-hidden", { hasText: "#" }),
  ).toHaveCount(1);
  const iconMask = await channelChip.evaluate((element) =>
    getComputedStyle(element, "::before").getPropertyValue(
      "-webkit-mask-image",
    ),
  );
  expect(iconMask).toContain("data:image/svg+xml");

  await input.focus();
  await input.press("ArrowLeft");
  await input.press("ArrowLeft");
  await input.press("ArrowLeft");
  await page.keyboard.type("X");

  await expect(input).toHaveText("#geneXral");
});

test("selecting a managed agent mention inserts @Name into input", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: TEST_IDENTITIES.alice.pubkey,
        name: "alice",
        status: "stopped",
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("Hey @ali");

  const dropdown = autocomplete(page);
  await dropdown.getByText("alice").click();

  await expect(input).toHaveText("Hey @alice ");
  const agentMentionChip = input.locator(".agent-mention-highlight", {
    hasText: "alice",
  });
  await expect(agentMentionChip).toBeVisible();
  await expect(agentMentionChip).toHaveText("alice");
  // #7242 puts composer chips in the inline flow so wrapped fragments keep
  // their icon on the first line; the agent chip joins that treatment.
  await expect(agentMentionChip).toHaveCSS("display", "inline");
  await expect(agentMentionChip).toHaveCSS("border-top-width", "0px");
});

test("selecting a persona mention creates a channel agent before sending", async ({
  page,
}) => {
  await installMockBridge(page, {
    activePersonaIds: [STARTER_PERSONA_IDS.fizz],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill(`Ask ${mentionPrefix(GUIDE_NAME)}`);

  const dropdown = autocomplete(page);
  const fizzRow = dropdown.locator("button", { hasText: GUIDE_NAME });
  await expect(fizzRow).toBeVisible();
  await expect(fizzRow.getByTestId("mention-agent-icon")).toBeVisible();
  await expect(fizzRow.getByText("agent")).toBeVisible();
  await expect(fizzRow.getByText("not in channel")).toBeVisible();
  await input.press("Enter");
  await page.keyboard.type(" for a hand");

  const composerChip = input.locator(".agent-mention-highlight", {
    hasText: GUIDE_NAME,
  });
  await expect(composerChip).toBeVisible();
  await expect(composerChip).toHaveText(GUIDE_NAME);

  const baselineCommands = await readCommandLog(page);
  const baselineCreateCount = commandCount(
    baselineCommands,
    "create_managed_agent",
  );
  const baselineAddCount = commandCount(
    baselineCommands,
    "add_channel_members",
  );
  const baselineStartCount = commandCount(
    baselineCommands,
    "start_managed_agent",
  );
  await page.getByTestId("send-message").click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  await expect
    .poll(async () =>
      commandCount(await readCommandLog(page), "create_managed_agent"),
    )
    .toBeGreaterThan(baselineCreateCount);
  await expect
    .poll(async () =>
      commandCount(await readCommandLog(page), "add_channel_members"),
    )
    .toBeGreaterThan(baselineAddCount);
  await expect
    .poll(async () =>
      commandCount(await readCommandLog(page), "start_managed_agent"),
    )
    .toBeGreaterThan(baselineStartCount);
  await expect
    .poll(async () => commandCount(await readCommandLog(page), "sign_event"))
    .toBeGreaterThan(commandCount(baselineCommands, "sign_event"));

  // Ordered against the message's own sign_event, found by its payload.
  // The first post-baseline sign_event is not necessarily ours: background
  // work (read state, presence) signs too, and one of those landing before
  // the agent spawn read as "sent before starting" on the 0.16 promotion --
  // startIndex 14 against sendIndex somewhere in the single digits, with the
  // agent provably started first.
  const payloadLog = (await readCommandPayloadLog(page)).slice(
    baselineCommands.length,
  );
  const startIndex = payloadLog.findIndex(
    (entry) => entry.command === "start_managed_agent",
  );
  const sendIndex = payloadLog.findIndex(
    (entry) =>
      entry.command === "sign_event" &&
      JSON.stringify(entry.payload ?? "").includes("for a hand"),
  );
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(sendIndex).toBeGreaterThanOrEqual(0);
  expect(startIndex).toBeLessThan(sendIndex);

  const mentionChip = page
    .getByTestId("message-row")
    .last()
    .locator("[data-mention].agent-mention-highlight", { hasText: GUIDE_NAME });
  await expect(mentionChip).toBeVisible();
  await expect(mentionChip).toHaveText(GUIDE_NAME);
});

test("selecting a persona mention reuses an existing persona agent", async ({
  page,
}) => {
  await installMockBridge(page, {
    activePersonaIds: [STARTER_PERSONA_IDS.fizz],
    managedAgents: [
      {
        pubkey: REUSABLE_PERSONA_AGENT_PUBKEY,
        name: GUIDE_NAME,
        personaId: STARTER_PERSONA_IDS.fizz,
        status: "stopped",
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill(`Ask ${mentionPrefix(GUIDE_NAME)}`);

  const dropdown = autocomplete(page);
  const fizzRow = dropdown.locator("button", { hasText: GUIDE_NAME });
  await expect(fizzRow).toBeVisible();
  await input.press("Enter");
  await page.keyboard.type(" for a hand");

  const baselineCommands = await readCommandLog(page);
  const baselineCreateCount = commandCount(
    baselineCommands,
    "create_managed_agent",
  );
  const baselineAddCount = commandCount(
    baselineCommands,
    "add_channel_members",
  );
  const baselineStartCount = commandCount(
    baselineCommands,
    "start_managed_agent",
  );

  await page.getByTestId("send-message").click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  await expect
    .poll(async () =>
      commandCount(await readCommandLog(page), "add_channel_members"),
    )
    .toBeGreaterThan(baselineAddCount);
  await expect
    .poll(async () =>
      commandCount(await readCommandLog(page), "start_managed_agent"),
    )
    .toBeGreaterThan(baselineStartCount);
  expect(
    commandCount(await readCommandLog(page), "create_managed_agent"),
  ).toEqual(baselineCreateCount);

  const mentionChip = page
    .getByTestId("message-row")
    .last()
    .locator("[data-mention].agent-mention-highlight", { hasText: GUIDE_NAME });
  await expect(mentionChip).toBeVisible();
  await expect(mentionChip).toHaveText(GUIDE_NAME);
});

test("managed relay-profile agents with member roles use the agent composer style", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: TEST_IDENTITIES.charlie.pubkey,
        name: "charlie",
        status: "stopped",
      },
    ],
  });
  await page.goto("/");

  await openChannelBrowser(page);
  await expect(page.getByTestId("channel-browser-dialog")).toBeVisible();
  await page
    .getByTestId("browse-channel-sales")
    .getByRole("button", { name: "Join" })
    .click();
  await expect(page.getByTestId("chat-title")).toHaveText("sales");

  const input = page.getByTestId("message-input");
  await input.fill("@char");

  const dropdown = autocomplete(page);
  await expect(dropdown.getByText("charlie")).toBeVisible();
  await expect(dropdown.getByText("agent")).toBeVisible();
  await input.press("Enter");

  const agentMentionChip = input.locator(".agent-mention-highlight", {
    hasText: "charlie",
  });
  await expect(agentMentionChip).toBeVisible();
  await expect(agentMentionChip).toHaveText("charlie");
});

test("other-owned agents without a shared channel are hidden from mentions", async ({
  page,
}) => {
  await installMockBridge(page, {
    searchProfiles: [
      {
        pubkey: PROFILE_ONLY_AGENT_PUBKEY,
        displayName: "mira",
        ownerPubkey: TEST_IDENTITIES.outsider.pubkey,
        isAgent: true,
      },
    ],
    userSearchDelayMs: 1_000,
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("@mira");

  const dropdown = autocomplete(page);
  await expect(dropdown).not.toBeVisible();
  await expect(input.locator(".mention-chip")).toHaveCount(0);
});

test("own profile-only agents are hidden from channel mentions", async ({
  page,
}) => {
  await installMockBridge(page, { userSearchDelayMs: 1_000 });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("@mira");

  await expect(autocomplete(page)).toHaveCount(0);
});

test("managed relay agents are visible in channel mentions regardless of relay policy", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        name: "quinn",
        status: "stopped",
      },
    ],
    relayAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        name: "quinn",
        respondTo: "allowlist",
        respondToAllowlist: ["deadbeef".repeat(8)],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("@quinn");

  const dropdown = autocomplete(page);
  await expect(dropdown.getByText("quinn")).toBeVisible();
  await expect(dropdown.getByText("agent")).toBeVisible();
});

test("relay-only shared agents stay hidden from DM mentions", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-alice-tyler").click();
  await expect(page.getByTestId("chat-title")).toHaveText("alice-tyler");

  await page.getByTestId("message-input").fill("@alice");

  await expect(autocomplete(page)).toHaveCount(0);
});

test("cached relay-agent suggestions are removed when channel authorization disappears", async ({
  page,
}) => {
  await installMockBridge(page, {
    userSearchDelayMs: 10_000,
    // alice is an agent in the mock roster, and #5681 makes a channel-member
    // agent mentionable only with current directory evidence. The seed gives
    // her that evidence so this case can test what it is named for: a cached
    // suggestion disappearing once channel authorization does.
    relayAgents: [
      {
        pubkey: TEST_IDENTITIES.alice.pubkey,
        name: "alice",
        respondTo: "anyone",
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("@alice");
  const aliceSuggestion = autocomplete(page).getByTestId(
    `mention-suggestion-${TEST_IDENTITIES.alice.pubkey}`,
  );
  await expect(aliceSuggestion).toBeVisible();
  await expect
    .poll(async () =>
      (await readCommandPayloadLog(page)).some(
        (entry) =>
          entry.command === "search_users" &&
          (entry.payload as { query?: string }).query === "alice",
      ),
    )
    .toBe(true);

  await page.evaluate(async (channelId) => {
    const bridge = window as Window & {
      __BUZZ_E2E_INVALIDATE_CHANNELS__?: () => Promise<void>;
      __BUZZ_E2E_MUTATE_CHANNEL__?: (opts: {
        channelId: string;
        channelType: null;
      }) => void;
    };
    bridge.__BUZZ_E2E_MUTATE_CHANNEL__?.({ channelId, channelType: null });
    await bridge.__BUZZ_E2E_INVALIDATE_CHANNELS__?.();
  }, GENERAL_CHANNEL_ID);

  await expect(aliceSuggestion).toHaveCount(0);
});

test("relay-only shared agents appear in forum mentions", async ({ page }) => {
  await installMockBridge(page, {
    relayAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        name: "quinn",
        respondTo: "allowlist",
        respondToAllowlist: [MOCK_VIEWER_PUBKEY],
        channelNames: ["watercooler"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-watercooler").click();
  await expect(page.getByTestId("chat-title")).toHaveText("watercooler");
  await page.getByRole("button", { name: "Start a new post..." }).click();

  await page.getByTestId("message-input").fill("@quinn");

  await expect(
    page.getByTestId("mention-autocomplete").getByText("quinn"),
  ).toBeVisible();
});

test("relay-only agents stay hidden from channel mentions even when allowlisted", async ({
  page,
}) => {
  await installMockBridge(page, {
    relayAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        name: "quinn",
        respondTo: "allowlist",
        respondToAllowlist: [MOCK_VIEWER_PUBKEY],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("@quinn");

  // No channelNames on the seed, so the agent is in no channel: an allowlist
  // entry alone never makes it mentionable here.
  await expect(autocomplete(page)).toHaveCount(0);
});

test("relay-agent directory errors fail closed and recover after a fresh fetch", async ({
  page,
}) => {
  await installMockBridge(page, {
    relayAgentListErrors: ["mock directory unavailable", null],
    relayAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        name: "quinn",
        respondTo: "allowlist",
        respondToAllowlist: [MOCK_VIEWER_PUBKEY],
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  const input = page.getByTestId("message-input");
  await input.fill("@quinn");
  await expect(autocomplete(page)).toHaveCount(0);

  await page.evaluate(async () => {
    await window.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({
      queryKey: ["relay-agents"],
    });
  });
  await expect(autocomplete(page).getByText("quinn")).toBeVisible();

  await page.evaluate(() => {
    window.__BUZZ_E2E__.mock ??= {};
    window.__BUZZ_E2E__.mock.agentListDelayMs = 1_000;
    void window.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({
      queryKey: ["relay-agents"],
    });
  });
  // #7124: a cached directory stays usable through a refetch, so the row must
  // NOT blink out while the next fetch is in flight. Sending still re-fetches
  // and fails closed at its own boundary.
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__BUZZ_E2E_QUERY_CLIENT__?.getQueryState(["relay-agents"])
            ?.fetchStatus,
      ),
    )
    .toBe("fetching");
  await expect(autocomplete(page).getByText("quinn")).toBeVisible({
    timeout: 200,
  });
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__BUZZ_E2E_QUERY_CLIENT__?.getQueryState(["relay-agents"])
            ?.fetchStatus,
      ),
    )
    .toBe("idle");
  await expect(autocomplete(page).getByText("quinn")).toBeVisible();
});

test("relay-only allowlisted agents emit a p tag when sent", async ({
  page,
}) => {
  await installMockBridge(page, {
    relayAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        name: "quinn",
        respondTo: "allowlist",
        respondToAllowlist: [MOCK_VIEWER_PUBKEY],
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await page.evaluate(
    async ({ channelId, pubkey }) => {
      const invoke = window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__;
      if (!invoke) throw new Error("Mock bridge is not installed.");
      await invoke("add_channel_members", {
        channelId,
        pubkeys: [pubkey],
        role: "bot",
      });
      await window.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({
        queryKey: ["channels"],
      });
    },
    {
      channelId: GENERAL_CHANNEL_ID,
      pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
    },
  );

  const input = page.getByTestId("message-input");
  await input.fill("@quinn");
  const quinnRow = autocomplete(page).locator("button", { hasText: "quinn" });
  await expect(quinnRow).toBeVisible();
  await quinnRow.click();
  await page.keyboard.type("hello");
  await expect(input).toHaveText("@quinn hello");
  const baselineCommands = await readCommandLog(page);
  await page.getByTestId("send-message").click();

  await expect
    .poll(() => readOutgoingMentionPubkeys(page, "@quinn hello"))
    .toContain(ALLOWLIST_RELAY_AGENT_PUBKEY);

  const commands = await readCommandLog(page);
  expect(commandCount(commands, "revalidate_relay_agents")).toBe(
    commandCount(baselineCommands, "revalidate_relay_agents") + 2,
  );
  expect(commandCount(commands, "list_relay_agents")).toBe(
    commandCount(baselineCommands, "list_relay_agents"),
  );
});

test("managed agents keep their p tag when relay discovery fails before send", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        name: "quinn",
        status: "running",
      },
    ],
    relayAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        name: "quinn",
        respondTo: "allowlist",
        respondToAllowlist: [MOCK_VIEWER_PUBKEY],
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();

  const input = page.getByTestId("message-input");
  await input.fill("@quinn");
  const quinnRow = autocomplete(page).locator("button", { hasText: "quinn" });
  await expect(quinnRow).toBeVisible();
  await quinnRow.click();
  await expect(input).toHaveText("@quinn ");
  await page.keyboard.type("hello");
  await expect(input).toHaveText("@quinn hello");

  await page.evaluate(() => {
    window.__BUZZ_E2E__.mock ??= {};
    window.__BUZZ_E2E__.mock.relayAgentListErrors = Array(5).fill(
      "mock unrelated relay directory failure",
    );
  });
  await page.getByTestId("send-message").click();

  await expect
    .poll(() => readOutgoingMentionPubkeys(page, "@quinn hello"))
    .toContain(ALLOWLIST_RELAY_AGENT_PUBKEY);
});

test("targeted revocation before send causes no agent side effects", async ({
  page,
}) => {
  await installMockBridge(page, {
    relayAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        name: "quinn",
        respondTo: "allowlist",
        respondToAllowlist: [MOCK_VIEWER_PUBKEY],
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await page.evaluate(
    async ({ channelId, pubkey }) => {
      const invoke = window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__;
      if (!invoke) throw new Error("Mock bridge is not installed.");
      await invoke("add_channel_members", {
        channelId,
        pubkeys: [pubkey],
        role: "bot",
      });
      await window.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({
        queryKey: ["channels"],
      });
    },
    {
      channelId: GENERAL_CHANNEL_ID,
      pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
    },
  );
  const input = page.getByTestId("message-input");
  await input.fill("@quinn");
  const quinnRow = autocomplete(page).locator("button", { hasText: "quinn" });
  await expect(quinnRow).toBeVisible();
  await quinnRow.click();
  await page.keyboard.type("hello");

  await page.evaluate((pubkey) => {
    window.__BUZZ_E2E__.mock ??= {};
    window.__BUZZ_E2E__.mock.relayAgentRevalidationRevokedPubkeys = [pubkey];
  }, ALLOWLIST_RELAY_AGENT_PUBKEY);
  const baselineCommands = await readCommandLog(page);
  await page.getByTestId("send-message").click();

  await expect(
    page.getByText(/Could not authorize a mentioned agent/),
  ).toBeVisible();
  await expect(input).toHaveText("@quinn hello");
  expect(await readOutgoingMentionPubkeys(page, "@quinn hello")).toBeNull();
  const commands = await readCommandLog(page);
  expect(commandCount(commands, "revalidate_relay_agents")).toBe(
    commandCount(baselineCommands, "revalidate_relay_agents") + 1,
  );
  expect(commandCount(commands, "list_relay_agents")).toBe(
    commandCount(baselineCommands, "list_relay_agents"),
  );
  for (const command of [
    "add_channel_members",
    "start_managed_agent",
    "attach_managed_agent",
    "sync_agents_to_active_huddle",
  ]) {
    expect(commandCount(commands, command)).toBe(
      commandCount(baselineCommands, command),
    );
  }
});

test("deferred-upload sends revalidate agent authorization at the publish boundary", async ({
  page,
}) => {
  // A background media upload can hold the publish open for arbitrarily long —
  // authorization revoked during that window must block publication. This
  // pins the publish-boundary revalidation on the deferred path.
  await installMockBridge(page, {
    deferredComposerUploads: true,
    uploadDelayMs: 1_500,
    uploadDescriptors: [
      {
        url: `https://mock.relay/media/${"c".repeat(64)}.mp4`,
        sha256: "c".repeat(64),
        size: 1024 * 1024,
        type: "video/mp4",
        uploaded: Math.floor(Date.now() / 1000),
        filename: "upload-race.mp4",
      },
    ],
    relayAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        name: "quinn",
        respondTo: "allowlist",
        respondToAllowlist: [MOCK_VIEWER_PUBKEY],
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await page.evaluate(
    async ({ channelId, pubkey }) => {
      const invoke = window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__;
      if (!invoke) throw new Error("Mock bridge is not installed.");
      await invoke("add_channel_members", {
        channelId,
        pubkeys: [pubkey],
        role: "bot",
      });
      await window.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({
        queryKey: ["channels"],
      });
    },
    {
      channelId: GENERAL_CHANNEL_ID,
      pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
    },
  );

  const input = page.getByTestId("message-input");
  await input.fill("@quinn");
  const quinnRow = autocomplete(page).locator("button", { hasText: "quinn" });
  await expect(quinnRow).toBeVisible();
  await quinnRow.click();
  await page.keyboard.type("hello");

  // Only video files queue until send; anything else uploads at attach time.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Attach file" }).click(),
  ]);
  await chooser.setFiles({
    buffer: Buffer.alloc(1024 * 1024, 1),
    mimeType: "video/mp4",
    name: "upload-race.mp4",
  });
  await expect(
    page.getByTestId("composer-queued-media-attachment"),
  ).toBeVisible();

  const baselineCommands = await readCommandLog(page);
  await page.getByTestId("send-message").click();

  // Revoke after the pre-side-effect pass has been admitted but while the
  // deferred upload (1.5s mock delay) still holds the publish open.
  await expect
    .poll(async () =>
      commandCount(await readCommandLog(page), "revalidate_relay_agents"),
    )
    .toBe(commandCount(baselineCommands, "revalidate_relay_agents") + 1);
  await page.evaluate(() => {
    window.__BUZZ_E2E__.mock ??= {};
    window.__BUZZ_E2E__.mock.relayAgentListErrors = Array(100).fill(
      "mock directory revoked during deferred upload",
    );
  });

  const outgoingContent = `@quinn hello\n![video](https://mock.relay/media/${"c".repeat(64)}.mp4)`;
  await expect(
    page.getByText("Could not authorize a mentioned agent.", { exact: false }),
  ).toBeVisible();
  expect(await readOutgoingMentionPubkeys(page, outgoingContent)).toBeNull();
  await expect(input).toHaveText("@quinn hello");
  await expect(
    page.getByTestId("composer-queued-media-attachment"),
  ).toBeVisible();
  const commands = await readCommandLog(page);
  expect(commandCount(commands, "revalidate_relay_agents")).toBe(
    commandCount(baselineCommands, "revalidate_relay_agents") + 2,
  );
  expect(commandCount(commands, "start_managed_agent")).toBe(
    commandCount(baselineCommands, "start_managed_agent"),
  );
});

test("sends that attach a mentioned agent revalidate at the publish boundary", async ({
  page,
}) => {
  // The awaited membership write for a non-member managed agent is a relay
  // round-trip between the pre-side-effect authorization pass and the publish
  // — authorization revoked during that window must block publication.
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: OUT_OF_CHANNEL_MANAGED_AGENT_PUBKEY,
        name: "fizz",
        status: "running",
        // Already matching the reusable-agent policy: no update_managed_agent
        // write below, so the attach write alone re-opens the window.
        respondTo: "owner-only",
        respondToAllowlist: [],
      },
    ],
    relayAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        name: "quinn",
        respondTo: "allowlist",
        respondToAllowlist: [MOCK_VIEWER_PUBKEY],
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await page.evaluate(
    async ({ channelId, pubkey }) => {
      const invoke = window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__;
      if (!invoke) throw new Error("Mock bridge is not installed.");
      await invoke("add_channel_members", {
        channelId,
        pubkeys: [pubkey],
        role: "bot",
      });
      await window.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({
        queryKey: ["channels"],
      });
    },
    {
      channelId: GENERAL_CHANNEL_ID,
      pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
    },
  );

  const input = page.getByTestId("message-input");
  await input.fill("@quinn");
  const quinnRow = autocomplete(page).locator("button", { hasText: "quinn" });
  await expect(quinnRow).toBeVisible();
  await quinnRow.click();
  await page.keyboard.type("@fizz");
  const fizzRow = autocomplete(page).locator("button", { hasText: "fizz" });
  await expect(fizzRow).toBeVisible();
  await expect(fizzRow.getByText("not in channel")).toBeVisible();
  await fizzRow.click();
  await page.keyboard.type("hello");
  await expect(input).toHaveText("@quinn @fizz hello");

  // Hold the attach's membership write open so the revocation below lands
  // inside the pass-to-publish window.
  await page.evaluate(() => {
    window.__BUZZ_E2E__.mock ??= {};
    window.__BUZZ_E2E__.mock.addChannelMembersDelayMs = 1_500;
  });
  const baselineCommands = await readCommandLog(page);
  await page.getByTestId("send-message").click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  // Revoke quinn after the pre-side-effect pass has been admitted but while
  // the attach still holds the publish open.
  await expect
    .poll(async () =>
      commandCount(await readCommandLog(page), "revalidate_relay_agents"),
    )
    .toBe(commandCount(baselineCommands, "revalidate_relay_agents") + 1);
  await page.evaluate((pubkey) => {
    window.__BUZZ_E2E__.mock ??= {};
    window.__BUZZ_E2E__.mock.relayAgentRevalidationRevokedPubkeys = [pubkey];
  }, ALLOWLIST_RELAY_AGENT_PUBKEY);

  await expect(
    page.getByText("Could not authorize a mentioned agent.", { exact: false }),
  ).toBeVisible();
  expect(
    await readOutgoingMentionPubkeys(page, "@quinn @fizz hello"),
  ).toBeNull();
  await expect(input).toHaveText("@quinn @fizz hello");
  const commands = await readCommandLog(page);
  expect(commandCount(commands, "revalidate_relay_agents")).toBe(
    commandCount(baselineCommands, "revalidate_relay_agents") + 2,
  );
  // The policy already matched: the attach's membership write was the only
  // relay round-trip holding the publish open for the revocation to land in.
  expect(commandCount(commands, "update_managed_agent")).toBe(
    commandCount(baselineCommands, "update_managed_agent"),
  );
  expect(commandCount(commands, "start_managed_agent")).toBe(
    commandCount(baselineCommands, "start_managed_agent"),
  );
});

test("sends that enroll agents into an active huddle revalidate at the publish boundary", async ({
  page,
}) => {
  // With a huddle live on the channel, the awaited huddle enrollment is a
  // relay round-trip between the authorization pass and the publish; the
  // publish boundary re-validates rather than trusting the earlier pass.
  await installMockBridge(page, {
    huddle: {
      parentChannelId: GENERAL_CHANNEL_ID,
      ephemeralChannelId: HUDDLE_EPHEMERAL_CHANNEL_ID,
      members: [{ pubkey: TEST_IDENTITIES.tyler.pubkey, role: "member" }],
    },
    relayAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        name: "quinn",
        respondTo: "allowlist",
        respondToAllowlist: [MOCK_VIEWER_PUBKEY],
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await page.evaluate(
    async ({ channelId, pubkey }) => {
      const invoke = window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__;
      if (!invoke) throw new Error("Mock bridge is not installed.");
      await invoke("add_channel_members", {
        channelId,
        pubkeys: [pubkey],
        role: "bot",
      });
      await window.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({
        queryKey: ["channels"],
      });
    },
    {
      channelId: GENERAL_CHANNEL_ID,
      pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
    },
  );

  const input = page.getByTestId("message-input");
  await input.fill("@quinn");
  const quinnRow = autocomplete(page).locator("button", { hasText: "quinn" });
  await expect(quinnRow).toBeVisible();
  await quinnRow.click();
  await page.keyboard.type("hello");

  const baselineCommands = await readCommandLog(page);
  await page.getByTestId("send-message").click();

  await expect
    .poll(() => readOutgoingMentionPubkeys(page, "@quinn hello"))
    .toContain(ALLOWLIST_RELAY_AGENT_PUBKEY);
  const commands = await readCommandLog(page);
  expect(commandCount(commands, "sync_agents_to_active_huddle")).toBe(
    commandCount(baselineCommands, "sync_agents_to_active_huddle") + 1,
  );
  expect(commandCount(commands, "revalidate_relay_agents")).toBe(
    commandCount(baselineCommands, "revalidate_relay_agents") + 2,
  );
});

test("a send held open by a no-write step still revalidates at the publish boundary", async ({
  page,
}) => {
  // The publish boundary revalidates unconditionally, however brief the gap:
  // here the only thing separating the authorization pass from the publish is
  // the huddle sync — which with no active huddle writes nothing to the relay
  // — and the revocation is released with zero further hold. A revocation
  // landing in any admission-to-publish gap must block publication; this is the
  // reviewer's sub-threshold probe of the since-removed elapsed-time bound,
  // which deliberately accepted this very staleness.
  await installMockBridge(page, {
    // Released on demand below; long enough that it is never waited out.
    syncAgentsToActiveHuddleDelayMs: 45_000,
    relayAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        name: "quinn",
        respondTo: "allowlist",
        respondToAllowlist: [MOCK_VIEWER_PUBKEY],
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  // Already a member, so readiness short-circuits: no access-policy read, no
  // membership write, no wake.
  await page.evaluate(
    async ({ channelId, pubkey }) => {
      const invoke = window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__;
      if (!invoke) throw new Error("Mock bridge is not installed.");
      await invoke("add_channel_members", {
        channelId,
        pubkeys: [pubkey],
        role: "bot",
      });
      await window.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({
        queryKey: ["channels"],
      });
    },
    {
      channelId: GENERAL_CHANNEL_ID,
      pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
    },
  );

  const input = page.getByTestId("message-input");
  await input.fill("@quinn");
  const quinnRow = autocomplete(page).locator("button", { hasText: "quinn" });
  await expect(quinnRow).toBeVisible();
  await quinnRow.click();
  await page.keyboard.type("hello");
  await expect(input).toHaveText("@quinn hello");

  const baselineCommands = await readCommandLog(page);
  await page.getByTestId("send-message").click();

  // The pre-side-effect pass has admitted quinn; the huddle sync now holds the
  // publish open. Revoke before releasing, so the ordering is deterministic by
  // construction rather than by timing.
  await expect
    .poll(async () =>
      commandCount(await readCommandLog(page), "revalidate_relay_agents"),
    )
    .toBe(commandCount(baselineCommands, "revalidate_relay_agents") + 1);
  await page.evaluate((pubkey) => {
    window.__BUZZ_E2E__.mock ??= {};
    window.__BUZZ_E2E__.mock.relayAgentRevalidationRevokedPubkeys = [pubkey];
  }, ALLOWLIST_RELAY_AGENT_PUBKEY);

  // Release immediately — no post-revocation hold. Any conditional reuse of
  // the admission pass (a trigger enumeration, an elapsed-time bound) would
  // publish quinn's stale p tag here.
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__BUZZ_E2E_RELEASE_HUDDLE_AGENT_SYNCS__?.() ?? 0,
      ),
    )
    .toBeGreaterThan(0);

  await expect(
    page.getByText("Could not authorize a mentioned agent.", { exact: false }),
  ).toBeVisible();
  expect(await readOutgoingMentionPubkeys(page, "@quinn hello")).toBeNull();
  await expect(input).toHaveText("@quinn hello");

  const commands = await readCommandLog(page);
  expect(commandCount(commands, "revalidate_relay_agents")).toBe(
    commandCount(baselineCommands, "revalidate_relay_agents") + 2,
  );
  expect(commandCount(commands, "sync_agents_to_active_huddle")).toBe(
    commandCount(baselineCommands, "sync_agents_to_active_huddle") + 1,
  );
  // Nothing on this leg wrote relay state — the second pass exists only
  // because the publish boundary is unconditional.
  for (const command of [
    "add_channel_members",
    "attach_managed_agent",
    "update_managed_agent",
    "start_managed_agent",
  ]) {
    expect(commandCount(commands, command)).toBe(
      commandCount(baselineCommands, command),
    );
  }
});

test("selected relay agents are invited as bots before sending", async ({
  page,
}) => {
  await installMockBridge(page, {
    relayAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        name: "quinn",
        respondTo: "allowlist",
        respondToAllowlist: [MOCK_VIEWER_PUBKEY],
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();

  const input = page.getByTestId("message-input");
  await input.fill("@quinn");
  const quinnRow = autocomplete(page).locator("button", { hasText: "quinn" });
  await expect(quinnRow).toBeVisible();
  await expect(quinnRow.getByText("not in channel")).toHaveCount(0);
  await quinnRow.click();
  await page.keyboard.type("hello");

  const baselinePayloadCount = (await readCommandPayloadLog(page)).length;
  await page.getByTestId("send-message").click();
  const inviteButton = page.getByRole("button", {
    name: "Invite",
    exact: true,
  });
  await expect(inviteButton).toBeVisible();
  await inviteButton.click();

  await expect
    .poll(() => readOutgoingMentionPubkeys(page, "@quinn hello"))
    .toContain(ALLOWLIST_RELAY_AGENT_PUBKEY);
  const sendCommands = (await readCommandPayloadLog(page)).slice(
    baselinePayloadCount,
  );
  const addCommand = sendCommands.find(
    (entry) => entry.command === "add_channel_members",
  );
  expect(addCommand?.payload).toMatchObject({
    channelId: GENERAL_CHANNEL_ID,
    pubkeys: [ALLOWLIST_RELAY_AGENT_PUBKEY],
    role: "bot",
  });
});

test("selected relay agents revoked after the invite prompt cause no side effects", async ({
  page,
}) => {
  await installMockBridge(page, {
    relayAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        name: "quinn",
        respondTo: "allowlist",
        respondToAllowlist: [MOCK_VIEWER_PUBKEY],
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  const input = page.getByTestId("message-input");
  await input.fill("@quinn");
  const quinnRow = autocomplete(page).locator("button", { hasText: "quinn" });
  await expect(quinnRow).toBeVisible();
  await quinnRow.click();
  await page.keyboard.type("hello");
  await page.getByTestId("send-message").click();
  const inviteButton = page.getByRole("button", {
    name: "Invite",
    exact: true,
  });
  await expect(inviteButton).toBeVisible();

  await page.evaluate(() => {
    window.__BUZZ_E2E__.mock ??= {};
    window.__BUZZ_E2E__.mock.relayAgentListErrors = Array(5).fill(
      "mock directory revoked after invite prompt",
    );
  });
  const baselineCommands = await readCommandLog(page);
  await inviteButton.click();

  await expect(
    page.getByText(/Could not authorize a mentioned agent/),
  ).toBeVisible();
  await expect(input).toHaveText("@quinn hello");
  expect(await readOutgoingMentionPubkeys(page, "@quinn hello")).toBeNull();
  const commands = await readCommandLog(page);
  for (const command of [
    "add_channel_members",
    "start_managed_agent",
    "attach_managed_agent",
    "sync_agents_to_active_huddle",
  ]) {
    expect(commandCount(commands, command)).toBe(
      commandCount(baselineCommands, command),
    );
  }
});

test("selected relay agents revoked during send emit no p tag", async ({
  page,
}) => {
  await installMockBridge(page, {
    relayAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        name: "quinn",
        respondTo: "allowlist",
        respondToAllowlist: [MOCK_VIEWER_PUBKEY],
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  const input = page.getByTestId("message-input");
  await input.fill("@quinn");
  const quinnRow = autocomplete(page).locator("button", { hasText: "quinn" });
  await expect(quinnRow).toBeVisible();
  await quinnRow.click();
  await page.keyboard.type("hello");

  await page.evaluate(() => {
    window.__BUZZ_E2E__.mock ??= {};
    window.__BUZZ_E2E__.mock.agentListDelayMs = 300;
  });
  await page.getByTestId("send-message").click();
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await page.evaluate(() => {
    window.__BUZZ_E2E__.mock ??= {};
    window.__BUZZ_E2E__.mock.relayAgentListErrors = Array(100).fill(
      "mock directory revoked mid-send",
    );
  });

  await expect(
    page.getByText(/Could not authorize a mentioned agent/),
  ).toBeVisible();
  await expect(input).toHaveText("@quinn hello");
  expect(await readOutgoingMentionPubkeys(page, "@quinn hello")).toBeNull();
});

test("owner-only builds admit cross-owner relay agents authorized by allowlist", async ({
  page,
}) => {
  await installMockBridge(page, {
    ownerOnlyAccessBuild: true,
    searchProfiles: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        displayName: "quinn",
        ownerPubkey: TEST_IDENTITIES.outsider.pubkey,
        isAgent: true,
      },
    ],
    relayAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        ownerPubkey: TEST_IDENTITIES.outsider.pubkey,
        name: "quinn",
        respondTo: "allowlist",
        respondToAllowlist: [MOCK_VIEWER_PUBKEY],
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await page.evaluate(
    async ({ channelId, pubkey }) => {
      const invoke = window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__;
      if (!invoke) throw new Error("Mock bridge is not installed.");
      await invoke("add_channel_members", {
        channelId,
        pubkeys: [pubkey],
        role: "bot",
      });
      await window.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({
        queryKey: ["channels"],
      });
    },
    {
      channelId: GENERAL_CHANNEL_ID,
      pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
    },
  );
  const input = page.getByTestId("message-input");
  await input.fill("@quinn");
  const quinnRow = autocomplete(page).locator("button", { hasText: "quinn" });
  await expect(quinnRow).toBeVisible();
  await quinnRow.click();
  await page.keyboard.type("hello");
  await page.getByTestId("send-message").click();

  await expect
    .poll(() => readOutgoingMentionPubkeys(page, "@quinn hello"))
    .toContain(ALLOWLIST_RELAY_AGENT_PUBKEY);
});

test("relay-only allowlisted agents stay hidden outside their channel", async ({
  page,
}) => {
  await installMockBridge(page, {
    relayAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        name: "quinn",
        respondTo: "allowlist",
        respondToAllowlist: [MOCK_VIEWER_PUBKEY],
        channelNames: ["agents"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  await page.getByTestId("message-input").fill("@quinn");

  await expect(autocomplete(page)).toHaveCount(0);
});

test("owner-only builds admit cross-owner relay agents authorized for anyone", async ({
  page,
}) => {
  await installMockBridge(page, {
    ownerOnlyAccessBuild: true,
    searchProfiles: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        displayName: "quinn",
        ownerPubkey: TEST_IDENTITIES.outsider.pubkey,
        isAgent: true,
      },
    ],
    relayAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        ownerPubkey: TEST_IDENTITIES.outsider.pubkey,
        name: "quinn",
        respondTo: "anyone",
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  await page.getByTestId("message-input").fill("@quinn");

  await expect(autocomplete(page).getByText("quinn")).toBeVisible();
});

test("relay-only excluded agents stay hidden from channel mentions", async ({
  page,
}) => {
  await installMockBridge(page, {
    relayAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        name: "quinn",
        respondTo: "allowlist",
        respondToAllowlist: [TEST_IDENTITIES.outsider.pubkey],
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  await page.getByTestId("message-input").fill("@quinn");

  await expect(autocomplete(page)).toHaveCount(0);
});

test("shared agents wait for initial directory authorization", async ({
  page,
}) => {
  await installMockBridge(page, {
    agentListDelayMs: 1_000,
    relayAgents: [
      {
        pubkey: ALLOWLIST_RELAY_AGENT_PUBKEY,
        name: "quinn",
        respondTo: "allowlist",
        respondToAllowlist: [MOCK_VIEWER_PUBKEY],
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  await page.getByTestId("message-input").fill("@quinn");

  await expect(autocomplete(page)).toHaveCount(0);
  await expect(autocomplete(page).getByText("quinn")).toBeVisible({
    timeout: 3_000,
  });
});

test("a second mention while the first wake is in flight does not start the agent twice", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: IN_CHANNEL_MANAGED_AGENT_PUBKEY,
        name: "fizz",
        status: "stopped",
        channelNames: ["general"],
      },
    ],
    // Held open for the whole test. Awaiting the start used to make a
    // duplicate unreachable — the composer refused to send while one was
    // pending, and by the time it lifted the success handler had cached a
    // running record. Detached, the record keeps reading "stopped" for the
    // whole spawn, which is precisely when a second send re-fires.
    startManagedAgentDelayMs: 45_000,
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  const dropdown = autocomplete(page);
  const baselineCommands = await readCommandLog(page);
  const baselineStartCount = commandCount(
    baselineCommands,
    "start_managed_agent",
  );

  await input.fill("Hey @fizz");
  await expect(dropdown.getByText("fizz")).toBeVisible();
  await input.press("Enter");
  await expect(input.locator(".mention-chip")).toHaveText("fizz");
  await page.keyboard.type("do X");
  await expect(input).toHaveText("Hey @fizz do X");
  await page.getByTestId("send-message").click();
  await expect(
    page.getByTestId("message-row").filter({ hasText: "do X" }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      commandCount(await readCommandLog(page), "start_managed_agent"),
    )
    .toBe(baselineStartCount + 1);

  await input.fill("Hey @fizz");
  await expect(dropdown.getByText("fizz")).toBeVisible();
  await input.press("Enter");
  await expect(input.locator(".mention-chip")).toHaveText("fizz");
  await page.keyboard.type("also Y");
  await expect(input).toHaveText("Hey @fizz also Y");
  await page.getByTestId("send-message").click();

  // The second message publishes on its own — suppression is of the wake, not
  // of the send; the composer is never gated on a pending start again.
  await expect(
    page.getByTestId("message-row").filter({ hasText: "also Y" }),
  ).toBeVisible();
  expect(await readOutgoingMentionPubkeys(page, "Hey @fizz do X")).toContain(
    IN_CHANNEL_MANAGED_AGENT_PUBKEY,
  );
  expect(await readOutgoingMentionPubkeys(page, "Hey @fizz also Y")).toContain(
    IN_CHANNEL_MANAGED_AGENT_PUBKEY,
  );
  // One wake serves both messages: its replay floor predates the first
  // message, and the floor is a lower bound, so one harness boot covers both.
  expect(commandCount(await readCommandLog(page), "start_managed_agent")).toBe(
    baselineStartCount + 1,
  );
});

test("mentioning an in-channel provider managed agent deploys it before sending", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: OUT_OF_CHANNEL_PROVIDER_AGENT_PUBKEY,
        name: "portal",
        status: "not_deployed",
        channelNames: ["general"],
        backend: {
          type: "provider",
          id: "portal",
          config: { region: "test" },
        },
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("Hey @portal");

  const dropdown = autocomplete(page);
  await expect(dropdown.getByText("portal")).toBeVisible();
  await expect(dropdown.getByText("agent")).toBeVisible();
  await input.press("Enter");
  await page.keyboard.type(" can you help?");

  const baselineStartCount = commandCount(
    await readCommandLog(page),
    "start_managed_agent",
  );
  await page.getByTestId("send-message").click();

  await expect
    .poll(async () =>
      commandCount(await readCommandLog(page), "start_managed_agent"),
    )
    .toBeGreaterThan(baselineStartCount);

  const mentionChip = page
    .getByTestId("message-row")
    .last()
    .locator("[data-mention].agent-mention-highlight", { hasText: "portal" });
  await expect(mentionChip).toBeVisible();
});

test("mentioning a non-member managed agent adds and starts it before sending", async ({
  page,
}) => {
  await installMockBridge(page, {
    personas: [
      {
        id: "persona-owner",
        displayName: "Fizz",
        systemPrompt: "",
      },
    ],
    managedAgents: [
      {
        pubkey: OUT_OF_CHANNEL_MANAGED_AGENT_PUBKEY,
        name: "fizz",
        personaId: "persona-owner",
        status: "stopped",
        respondTo: "anyone",
        respondToAllowlist: [TEST_IDENTITIES.outsider.pubkey],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("Loop in @fizz");

  const dropdown = autocomplete(page);
  const fizzRow = dropdown.locator("button", { hasText: "fizz" });
  await expect(fizzRow).toBeVisible();
  await expect(fizzRow.getByText("not in channel")).toBeVisible();
  await input.press("Enter");

  const baselineCommands = await readCommandLog(page);
  const baselineAddCount = commandCount(
    baselineCommands,
    "add_channel_members",
  );
  const baselineStartCount = commandCount(
    baselineCommands,
    "start_managed_agent",
  );
  const baselinePayloadCount = (await readCommandPayloadLog(page)).length;

  await page.getByTestId("send-message").click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  await expect
    .poll(async () =>
      commandCount(await readCommandLog(page), "add_channel_members"),
    )
    .toBeGreaterThan(baselineAddCount);
  await expect
    .poll(async () =>
      commandCount(await readCommandLog(page), "start_managed_agent"),
    )
    .toBeGreaterThan(baselineStartCount);

  const sendCommands = (await readCommandPayloadLog(page)).slice(
    baselinePayloadCount,
  );
  const updateIndex = sendCommands.findIndex(
    (entry) => entry.command === "update_managed_agent",
  );
  const addIndex = sendCommands.findIndex(
    (entry) => entry.command === "add_channel_members",
  );
  const startIndex = sendCommands.findIndex(
    (entry) => entry.command === "start_managed_agent",
  );
  expect(updateIndex).toBeGreaterThanOrEqual(0);
  expect(updateIndex).toBeLessThan(addIndex);
  expect(updateIndex).toBeLessThan(startIndex);
  expect(sendCommands[updateIndex]?.payload).toMatchObject({
    input: {
      pubkey: OUT_OF_CHANNEL_MANAGED_AGENT_PUBKEY,
      respondTo: "owner-only",
      respondToAllowlist: [],
    },
  });

  const mentionChip = page
    .getByTestId("message-row")
    .last()
    .locator("[data-mention].agent-mention-highlight", { hasText: "fizz" });
  await expect(mentionChip).toBeVisible();

  const persistedPolicy = await page.evaluate(async (pubkey) => {
    const invoke = window.__BUZZ_E2E_INVOKE_MOCK_COMMAND__;
    if (!invoke) throw new Error("Mock bridge is not installed.");
    const agents = (await invoke("list_managed_agents", {})) as Array<{
      pubkey: string;
      respond_to: string;
      respond_to_allowlist: string[];
    }>;
    const agent = agents.find((candidate) => candidate.pubkey === pubkey);
    return agent
      ? {
          respondTo: agent.respond_to,
          respondToAllowlist: agent.respond_to_allowlist,
        }
      : null;
  }, OUT_OF_CHANNEL_MANAGED_AGENT_PUBKEY);
  expect(persistedPolicy).toEqual({
    respondTo: "owner-only",
    respondToAllowlist: [],
  });
});

test("mentioning a non-member provider managed agent deploys it before sending", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: OUT_OF_CHANNEL_PROVIDER_AGENT_PUBKEY,
        name: "portal",
        status: "not_deployed",
        backend: {
          type: "provider",
          id: "portal",
          config: { region: "test" },
        },
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("Loop in @portal");

  const dropdown = autocomplete(page);
  const portalRow = dropdown.locator("button", { hasText: "portal" });
  await expect(portalRow).toBeVisible();
  await expect(portalRow.getByText("not in channel")).toBeVisible();
  await input.press("Enter");

  const baselineCommands = await readCommandLog(page);
  const baselineAddCount = commandCount(
    baselineCommands,
    "add_channel_members",
  );
  const baselineStartCount = commandCount(
    baselineCommands,
    "start_managed_agent",
  );

  await page.getByTestId("send-message").click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  await expect
    .poll(async () =>
      commandCount(await readCommandLog(page), "add_channel_members"),
    )
    .toBeGreaterThan(baselineAddCount);
  await expect
    .poll(async () =>
      commandCount(await readCommandLog(page), "start_managed_agent"),
    )
    .toBeGreaterThan(baselineStartCount);

  const mentionChip = page
    .getByTestId("message-row")
    .last()
    .locator("[data-mention].agent-mention-highlight", { hasText: "portal" });
  await expect(mentionChip).toBeVisible();
});

test("system add rows use plain names while remove rows retain agent mention styling", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: OUT_OF_CHANNEL_PROVIDER_AGENT_PUBKEY,
        name: "portal",
        status: "deployed",
        backend: {
          type: "provider",
          id: "portal",
          config: { region: "test" },
        },
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-random").click();
  await expect(page.getByTestId("chat-title")).toHaveText("random");
  await waitForMockLiveSubscription(page, "random", SYSTEM_MESSAGE_KIND);

  await page.evaluate(
    ({ actorPubkey, kind, targetPubkey }) => {
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "random",
        content: JSON.stringify({
          type: "member_joined",
          actor: actorPubkey,
          target: targetPubkey,
        }),
        kind,
      });
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "random",
        content: JSON.stringify({
          type: "member_removed",
          actor: actorPubkey,
          target: targetPubkey,
        }),
        kind,
      });
    },
    {
      actorPubkey: TEST_IDENTITIES.tyler.pubkey,
      kind: SYSTEM_MESSAGE_KIND,
      targetPubkey: OUT_OF_CHANNEL_PROVIDER_AGENT_PUBKEY,
    },
  );

  const addedRow = page
    .getByTestId("system-message-row")
    .filter({ hasText: "portal" })
    .filter({ hasText: "was added by" });
  const removedRow = page
    .getByTestId("system-message-row")
    .filter({ hasText: "removed portal from the channel" });

  const addedName = addedRow.getByText("portal", { exact: true });
  await expect(addedName).toBeVisible();
  await expect(addedName).not.toHaveAttribute("data-mention");
  await expect(
    removedRow.locator("[data-mention].agent-mention-highlight", {
      hasText: "portal",
    }),
  ).toHaveText("portal");
});

test("groups contiguous arrival activity with hidden names in the standard tooltip", async ({
  page,
}) => {
  const actor = STANDARD_GROUPED_ARRIVAL_ACTOR;
  const targets = STANDARD_GROUPED_ARRIVAL_TARGETS;
  await installMockBridge(page, {
    searchProfiles: [actor, ...targets],
  });
  await page.goto("/");
  await page.getByTestId("channel-random").click();
  await expect(page.getByTestId("chat-title")).toHaveText("random");
  await waitForMockLiveSubscription(page, "random", SYSTEM_MESSAGE_KIND);

  await page.evaluate(
    ({ actorPubkey, addedTargets, kind }) => {
      const createdAt = Math.floor(Date.now() / 1_000);
      for (const [index, target] of addedTargets.entries()) {
        window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
          channelName: "random",
          content: JSON.stringify({
            type: "member_joined",
            actor: actorPubkey,
            target: target.pubkey,
          }),
          createdAt: createdAt + index,
          kind,
        });
      }
    },
    {
      actorPubkey: actor.pubkey,
      addedTargets: targets,
      kind: SYSTEM_MESSAGE_KIND,
    },
  );
  await waitForTimelineSettled(page);

  const groupedRow = page
    .getByTestId("system-message-row")
    .filter({ hasText: "added by Alice Chen, along with" });
  for (const visibleName of [
    "Erica Chapman",
    "Peter Griffin",
    "Marcia Thomas",
  ]) {
    await expect(groupedRow).toContainText(visibleName);
  }
  await expect(
    groupedRow.locator("p").filter({ hasText: "added by Alice Chen" }),
  ).toContainText(
    // Colony still says "was added by": upstream dropped the auxiliary in
    // #4582, which is not ported here.
    "Erica Chapman was added by Alice Chen, along with Peter Griffin, Marcia Thomas, Jordan Lee, and 2 others",
  );
  const avatarStack = groupedRow.getByTestId("system-message-avatar-stack");
  await expect(avatarStack).toHaveCount(1);
  await expect(avatarStack.getByTestId("system-message-avatar")).toHaveCount(5);
  await expect(
    groupedRow.locator("p").filter({ hasText: "added by Alice Chen" }),
  ).toHaveCSS("text-align", "left");
  await expect(groupedRow.locator("[data-mention]")).toHaveCount(0);

  const visibleName = groupedRow.getByText("Peter Griffin", { exact: true });
  await expect(visibleName).toHaveCSS("text-decoration-line", "none");
  await visibleName.hover();
  await expect(visibleName).toHaveCSS("text-decoration-line", "underline");

  const othersTrigger = groupedRow.getByRole("button", { name: "2 others" });
  // Park the pointer off-target first: the previous hover leaves the mouse at a
  // fixed viewport point, and any later reflow (new rows, scroll-to-bottom, a
  // different text wrap) can slide this button under it. Without this the
  // assertion measures where the mouse happens to be, not the resting style.
  await page.mouse.move(0, 0);
  await dismissOpenTooltip(page);
  await expect(othersTrigger).toHaveCSS("text-decoration-line", "none");
  await othersTrigger.hover();
  await expect(othersTrigger).toHaveCSS("text-decoration-line", "underline");

  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText("Olivia Park");
  await expect(tooltip).toContainText("Sam Rivera");

  await expect(avatarStack.locator("..")).toHaveCSS("align-items", "center");
});

test("keeps deterministic grouped-arrival fixture pubkeys unique", () => {
  expect(
    findDuplicateFixturePubkeys([
      STANDARD_GROUPED_ARRIVAL_ACTOR,
      ...STANDARD_GROUPED_ARRIVAL_TARGETS,
      ...JOIN_COLLAPSE_PROFILES,
    ]),
  ).toEqual([]);
});

test("collapses contiguous mixed join arrivals into one actor-neutral cohort", async ({
  page,
}) => {
  await installMockBridge(page, {
    searchProfiles: JOIN_COLLAPSE_PROFILES,
  });
  await page.goto("/");
  await page.getByTestId("channel-random").click();
  await expect(page.getByTestId("chat-title")).toHaveText(
    JOIN_COLLAPSE_CHANNEL_NAME,
  );
  await waitForMockLiveSubscription(
    page,
    JOIN_COLLAPSE_CHANNEL_NAME,
    SYSTEM_MESSAGE_KIND,
  );

  await page.evaluate(
    ({ channelName, currentUser, elrond, legolas, gimli, gandalf, kind }) => {
      const createdAt = Math.floor(Date.now() / 1_000);
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName,
        content: JSON.stringify({
          type: "member_joined",
          actor: currentUser,
          target: elrond,
        }),
        createdAt,
        kind,
        pubkey: currentUser,
      });
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName,
        content: JSON.stringify({
          type: "member_joined",
          actor: elrond,
          target: legolas,
        }),
        createdAt: createdAt + 1,
        kind,
        pubkey: elrond,
      });
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName,
        content: JSON.stringify({
          type: "member_joined",
          actor: elrond,
          target: gimli,
        }),
        createdAt: createdAt + 2,
        kind,
        pubkey: elrond,
      });
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName,
        content: JSON.stringify({
          type: "member_joined",
          actor: currentUser,
          target: gandalf,
        }),
        createdAt: createdAt + 3,
        kind,
        pubkey: currentUser,
      });
    },
    {
      channelName: JOIN_COLLAPSE_CHANNEL_NAME,
      currentUser: MOCK_VIEWER_PUBKEY,
      elrond: ELROND_PUBKEY,
      legolas: LEGOLAS_PUBKEY,
      gimli: GIMLI_PUBKEY,
      gandalf: GANDALF_PUBKEY,
      kind: SYSTEM_MESSAGE_KIND,
    },
  );
  await waitForTimelineSettled(page);
  await page.getByTestId("message-timeline").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await waitForAnimations(page);

  const { rows, texts } = await collectJoinCollapseRows(page);
  console.log(`JOIN_COLLAPSE_VISIBLE_TEXTS=${JSON.stringify(texts)}`);
  if (process.env.JOIN_COLLAPSE_EXPECT_SPLIT === "1") {
    expect(texts).toEqual(JOIN_COLLAPSE_SPLIT_TEXTS);
  }
  await maybeCaptureJoinCollapseTimeline(page);

  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(JOIN_COLLAPSE_GROUPED_TEXT);
});

test("system agent profile exposes owned agent actions", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("channel-random").click();
  await expect(page.getByTestId("chat-title")).toHaveText("random");
  await waitForMockLiveSubscription(page, "random", SYSTEM_MESSAGE_KIND);

  await page.evaluate(
    ({ actorPubkey, kind, targetPubkey }) => {
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "random",
        content: JSON.stringify({
          type: "member_joined",
          actor: actorPubkey,
          target: targetPubkey,
        }),
        kind,
      });
    },
    {
      actorPubkey: TEST_IDENTITIES.tyler.pubkey,
      kind: SYSTEM_MESSAGE_KIND,
      targetPubkey: PROFILE_ONLY_AGENT_PUBKEY,
    },
  );
  await waitForTimelineSettled(page);

  const joinedRow = page
    .getByTestId("system-message-row")
    .filter({ hasText: "mira" })
    .filter({ hasText: "was added by" });
  const agentName = joinedRow.getByText("mira", { exact: true });
  await expect(agentName).toHaveText("mira");
  await expect(agentName).not.toHaveAttribute("data-mention");
  await agentName.hover();

  const profilePopover = page.locator(
    '[data-testid="user-profile-popover"][data-state="open"]',
  );
  await expect(profilePopover).toBeVisible();
  await expectOwnedAgentProfileActions(
    profilePopover,
    PROFILE_ONLY_AGENT_PUBKEY,
  );
});

test("system agent avatar exposes owned agent actions", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("channel-random").click();
  await expect(page.getByTestId("chat-title")).toHaveText("random");
  await waitForMockLiveSubscription(page, "random", SYSTEM_MESSAGE_KIND);

  await page.evaluate(
    ({ kind, targetPubkey }) => {
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "random",
        content: JSON.stringify({
          type: "member_joined",
          actor: targetPubkey,
          target: targetPubkey,
        }),
        kind,
      });
    },
    {
      kind: SYSTEM_MESSAGE_KIND,
      targetPubkey: PROFILE_ONLY_AGENT_PUBKEY,
    },
  );
  await waitForTimelineSettled(page);

  const joinedRow = page
    .getByTestId("system-message-row")
    .filter({ hasText: "mira" })
    .filter({ hasText: "joined the channel" });
  await joinedRow.getByTestId("system-message-avatar").hover();

  const profilePopover = page.locator(
    '[data-testid="user-profile-popover"][data-state="open"]',
  );
  await expect(profilePopover).toBeVisible();
  await expectOwnedAgentProfileActions(
    profilePopover,
    PROFILE_ONLY_AGENT_PUBKEY,
  );
});

// Upstream turns the membership avatar stack into a decorative image (#7262).
// Colony keeps a profile popover on each stacked avatar, so the assertion that
// survives here is the markup one: no <button> inside the stack.
test("system agent activity avatar stack renders one non-button avatar", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-random").click();
  await expect(page.getByTestId("chat-title")).toHaveText("random");
  await waitForMockLiveSubscription(page, "random", SYSTEM_MESSAGE_KIND);

  await page.evaluate(
    ({ kind, targetPubkey }) => {
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "random",
        content: JSON.stringify({
          type: "member_joined",
          actor: targetPubkey,
          target: targetPubkey,
        }),
        kind,
      });
    },
    {
      kind: SYSTEM_MESSAGE_KIND,
      targetPubkey: PROFILE_ONLY_AGENT_PUBKEY,
    },
  );
  await waitForTimelineSettled(page);

  const joinedRow = page
    .getByTestId("system-message-row")
    .filter({ has: page.getByText("mira", { exact: true }) });
  const avatarStack = joinedRow.getByTestId("system-message-avatar-stack");
  await expect(avatarStack.getByTestId("system-message-avatar")).toHaveCount(1);
  await expect(avatarStack.locator("button")).toHaveCount(0);
});

test("membership activity folds duplicate self-joins then leaving into one row", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-random").click();
  await expect(page.getByTestId("chat-title")).toHaveText("random");
  await waitForMockLiveSubscription(page, "random", SYSTEM_MESSAGE_KIND);

  // The relay re-emits `member_joined` on each PUT_USER, so a member can arrive
  // twice before leaving. Both arrivals group with the departure; describing
  // only a 2-event pair dropped the departure and left the member rendered as
  // still present.
  await page.evaluate(
    ({ alicePubkey, kind }) => {
      const createdAt = Math.floor(Date.now() / 1_000);
      const join = {
        type: "member_joined",
        actor: alicePubkey,
        target: alicePubkey,
      };
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "random",
        content: JSON.stringify(join),
        createdAt,
        kind,
      });
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "random",
        content: JSON.stringify(join),
        createdAt: createdAt + 1,
        kind,
      });
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "random",
        content: JSON.stringify({ type: "member_left", actor: alicePubkey }),
        createdAt: createdAt + 2,
        kind,
      });
    },
    { alicePubkey: TEST_IDENTITIES.alice.pubkey, kind: SYSTEM_MESSAGE_KIND },
  );
  await waitForTimelineSettled(page);

  const aliceRows = page
    .getByTestId("system-message-row")
    .filter({ hasText: "alice" });
  await expect(aliceRows).toHaveCount(1);
  await expect(aliceRows).toHaveText(/joined, then left the channel/);
  await expect(aliceRows.getByTestId("system-message-avatar")).toHaveCount(1);
});

test("profile-only agent author hides actions without agent access", async ({
  page,
}) => {
  await installMockBridge(page, {
    searchProfiles: [
      {
        pubkey: PROFILE_ONLY_AGENT_PUBKEY,
        displayName: "mira",
        isAgent: true,
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");

  await emitMockMessage(page, "general", "Mira status update.", {
    pubkey: PROFILE_ONLY_AGENT_PUBKEY,
  });
  await waitForTimelineSettled(page);

  const messageRow = page
    .getByTestId("message-row")
    .filter({ hasText: "Mira status update." })
    .first();
  await messageRow.locator("button").first().hover();

  const profilePopover = page.locator(
    '[data-testid="user-profile-popover"][data-state="open"]',
  );
  await expect(profilePopover).toBeVisible();
  await expectAgentProfileActionsHidden(
    profilePopover,
    PROFILE_ONLY_AGENT_PUBKEY,
  );
});

test("system member-joined rows render the joined person as a plain profile name", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general", SYSTEM_MESSAGE_KIND);

  await page.evaluate(
    ({ kind, pubkey }) => {
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content: JSON.stringify({
          type: "member_joined",
          actor: pubkey,
          target: pubkey,
        }),
        kind,
      });
    },
    { kind: SYSTEM_MESSAGE_KIND, pubkey: TEST_IDENTITIES.bob.pubkey },
  );
  await waitForTimelineSettled(page);

  const joinedRow = page
    .getByTestId("system-message-row")
    .filter({ has: page.getByText("bob", { exact: true }) });
  const joinedPersonName = joinedRow.getByText("bob", { exact: true });

  await expect(joinedPersonName).toBeVisible();
  await expect(joinedPersonName).not.toHaveAttribute("data-mention");
});

test("selecting a managed non-member agent from a DM inserts @Name into input", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: TEST_IDENTITIES.charlie.pubkey,
        name: "charlie",
        status: "stopped",
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-bob-tyler").click();
  await expect(page.getByTestId("chat-title")).toHaveText("bob-tyler");

  const input = page.getByTestId("message-input");
  await input.fill("@char");

  const dropdown = autocomplete(page);
  await expect(dropdown.getByText("charlie")).toBeVisible();
  await expect(autocomplete(page)).toHaveCount(1);
  await expect(input.locator(".mention-chip")).toHaveCount(0);
  await input.press("Enter");

  await expect(input).toHaveText("@charlie ");
  await expect(input.locator(".mention-chip")).toBeVisible();
});

test("global non-member people can be selected from channel mentions", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("Loop in @out");

  const dropdown = autocomplete(page);
  await expect(dropdown.getByText("outsider")).toBeVisible();
  await expect(dropdown.getByText("not in channel")).toBeVisible();
});

test("duplicate global people with the same visible identity collapse in channel mentions", async ({
  page,
}) => {
  await installMockBridge(page, {
    searchProfiles: [
      {
        pubkey: CASEY_PROFILE_PUBKEY,
        displayName: "Pip",
      },
      {
        pubkey:
          "2222222222222222222222222222222222222222222222222222222222222222",
        displayName: "Pip",
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("@pip");

  const dropdown = autocomplete(page);
  await expect(dropdown.locator("button", { hasText: "Pip" })).toHaveCount(1);
});

test("sent non-member person mention uses the normal mention style", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-bob-tyler").click();
  await expect(page.getByTestId("chat-title")).toHaveText("bob-tyler");

  const input = page.getByTestId("message-input");
  await input.fill("Loop in @out");

  const dropdown = autocomplete(page);
  await expect(dropdown.getByText("outsider")).toBeVisible();
  await input.press("Enter");
  await page.keyboard.type(" please");
  await page.getByTestId("send-message").click();

  const mentionChip = page
    .getByTestId("message-row")
    .last()
    .locator("[data-mention]", { hasText: "outsider" });
  await expect(mentionChip).toBeVisible();
  await expect(mentionChip).toHaveClass(/inline-chip-icon-human/);
});

test("sent managed non-member agent mention uses the agent mention style", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: TEST_IDENTITIES.charlie.pubkey,
        name: "charlie",
        status: "stopped",
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-bob-tyler").click();
  await expect(page.getByTestId("chat-title")).toHaveText("bob-tyler");

  const input = page.getByTestId("message-input");
  await input.fill("Loop in @char");

  const dropdown = autocomplete(page);
  await expect(dropdown.getByText("charlie")).toBeVisible();
  await input.press("Enter");
  await page.keyboard.type(" too");
  await page.getByTestId("send-message").click();

  const mentionChip = page
    .getByTestId("message-row")
    .last()
    .locator("[data-mention]", { hasText: "charlie" });
  await expect(mentionChip).toBeVisible();
  await expect(mentionChip).toHaveText("charlie");
  await expect(mentionChip).toHaveClass(/agent-mention-highlight/);
});

test("mention button opens autocomplete and inserts a selected member", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("Hey ");
  await page.getByTestId("message-insert-mention").click();

  const dropdown = autocomplete(page);
  await expect(dropdown).toBeVisible();
  await dropdown.getByText("bob").click();

  await expect(input).toHaveText("Hey @bob ");
});

test("inserting a mention preserves Shift+Enter newlines (regression: bug #2)", async ({
  page,
}) => {
  // Before PR #618, mention insertion round-tripped through
  // `setContent(markdown)`, which collapsed every Shift+Enter hard
  // break to a single space. After the fix, autocomplete uses a
  // native ProseMirror `tr.insertText` transaction and the line
  // breaks survive.
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.click();
  await page.keyboard.type("line one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two @bo");

  const dropdown = autocomplete(page);
  await expect(dropdown.getByText("bob")).toBeVisible();
  await dropdown.getByText("bob").click();

  // Both lines must still be present, separated by a real line break
  // (rendered as a `<br>` by Tiptap; the projection sees `\n`).
  await expect(input).toHaveText(/line one[\s\S]*line two @bob/);
  await expect(input.locator("br")).toHaveCount(1);
});

test("keyboard navigation selects mention with Enter", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("@bo");

  const dropdown = autocomplete(page);
  await expect(dropdown.getByText("bob")).toBeVisible();

  // Press Enter to select the first (and only) suggestion
  await input.press("Enter");

  // Should insert @bob and NOT send the message
  await expect(input).toHaveText("@bob ");
});

test("Escape dismisses autocomplete dropdown", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("@");

  const dropdown = autocomplete(page);
  await expect(dropdown).toBeVisible();

  await input.press("Escape");

  await expect(dropdown).not.toBeVisible();
});

test("mention text is highlighted in sent messages", async ({ page }) => {
  const suffix = ` check this out ${Date.now()}`;

  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("Hey @bo");
  await autocomplete(page).getByText("bob").click();
  await expect(input).toHaveText("Hey @bob ");
  await page.keyboard.type(suffix);
  await page.getByTestId("send-message").click();

  await waitForTimelineSettled(page);

  const mentionChip = page
    .getByTestId("message-row")
    .last()
    .locator("[data-mention].mention-chip", { hasText: "bob" });
  await expect(mentionChip).toBeVisible();
  await expect(mentionChip).toHaveText("bob");
  await expect(mentionChip).toHaveClass(/inline-chip-icon-human/);
});

test("clicking author name opens user profile panel", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  // The seed message belongs to the active identity, which has no real name.
  const firstMessage = page.getByTestId("message-row").first();
  const author = firstMessage.getByTestId("message-author");
  await expect(author).toHaveText("You");
  await author.click();

  // Click now opens the full profile panel instead of the popover
  const panel = page.getByTestId("user-profile-panel");
  await expect(panel).toBeVisible();
  // The panel's public key row renders through the shared <PubKey> widget,
  // which displays the canonical npub form — assert the npub prefix.
  await expect(panel).toContainText(npubEncode(MOCK_VIEWER_PUBKEY).slice(0, 8));
});

test("a named owner's author keeps the real name and opens the same profile", async ({
  page,
}) => {
  await installMockBridge(page, {
    searchProfiles: [
      { pubkey: MOCK_VIEWER_PUBKEY, displayName: "Aisha Bello" },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const author = page
    .getByTestId("message-row")
    .first()
    .getByTestId("message-author");
  await expect(author).toHaveText("Aisha Bello");
  await author.click();
  const panel = page.getByTestId("user-profile-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Aisha Bello");
  // Same as the case above: the public key row renders through <PubKey>, so
  // assert the canonical npub prefix rather than the hex.
  await expect(panel).toContainText(npubEncode(MOCK_VIEWER_PUBKEY).slice(0, 8));
});

test("hovering avatar opens popover, clicking opens profile panel", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const firstMessage = page.getByTestId("message-row").first();
  const avatarButton = firstMessage.locator("button").first();

  // Hover should open the popover
  await avatarButton.hover();
  const profilePopover = page.locator(
    '[data-testid="user-profile-popover"][data-state="open"]',
  );
  await expect(profilePopover).toBeVisible();

  // Click should close the popover and open the profile panel
  await avatarButton.click();
  await expect(profilePopover).toHaveCount(0);
  await expect(page.getByTestId("user-profile-panel")).toBeVisible();
});

test("clicking a mention chip in the timeline opens the profile panel", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");

  await emitMockMessage(page, "general", "Ping @bob about the launch", {
    mentionPubkeys: [TEST_IDENTITIES.bob.pubkey],
  });
  await waitForTimelineSettled(page);

  const mentionChip = page
    .getByTestId("message-row")
    .filter({ hasText: "Ping bob about the launch" })
    .locator("[data-mention]", { hasText: "bob" });
  await expect(mentionChip).toBeVisible();
  await mentionChip.click();

  const panel = page.getByTestId("user-profile-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("bob");
});

test("mention text matching the kind-0 name alias resolves and opens the profile panel", async ({
  page,
}) => {
  // bob's mock profile has display_name "bob" and kind-0 name "bobby". A
  // message that says "@bobby" (how agents/CLI resolve mentions at send time)
  // must still render a clickable chip bound to bob's pubkey.
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");

  await emitMockMessage(page, "general", "Ask @bobby to review the doc", {
    mentionPubkeys: [TEST_IDENTITIES.bob.pubkey],
  });
  await waitForTimelineSettled(page);

  const mentionChip = page
    .getByTestId("message-row")
    .filter({ hasText: "Ask bobby to review the doc" })
    .locator("[data-mention]", { hasText: "bobby" });
  await expect(mentionChip).toBeVisible();
  await mentionChip.click();

  const panel = page.getByTestId("user-profile-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("bob");
});

test("clicking a mention chip in a forum post opens the profile panel", async ({
  page,
}) => {
  await page.goto("/");
  // Seed the forum post before entering the channel — forum views load from
  // the mock store on fetch, so no live subscription is needed.
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await emitMockMessage(page, "watercooler", "Welcome aboard @bob!", {
    kind: 45001,
    mentionPubkeys: [TEST_IDENTITIES.bob.pubkey],
  });

  await page.getByTestId("channel-watercooler").click();
  await expect(page.getByTestId("chat-title")).toHaveText("watercooler");

  const mentionChip = page.locator("[data-mention]", { hasText: "bob" });
  await expect(mentionChip).toBeVisible();
  await mentionChip.click();

  const panel = page.getByTestId("user-profile-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("bob");
  // The chip click must not bubble into the card and open the thread view.
  await expect(page.getByRole("button", { name: "Back to posts" })).toHaveCount(
    0,
  );
});

test("agent profile popover shows its owner", async ({ page }) => {
  await installMockBridge(page, {
    searchProfiles: [
      {
        pubkey: OWNED_AGENT_PROFILE_PUBKEY,
        displayName: "Bumble",
        ownerPubkey: TEST_IDENTITIES.bob.pubkey,
        isAgent: true,
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");

  await emitMockMessage(page, "general", "Bumble checking in.", {
    pubkey: OWNED_AGENT_PROFILE_PUBKEY,
  });
  await waitForTimelineSettled(page);

  const bumbleMessage = page
    .getByTestId("message-row")
    .filter({ hasText: "Bumble checking in." })
    .first();
  await bumbleMessage.locator("button").first().hover();

  const profilePopover = page.locator(
    '[data-testid="user-profile-popover"][data-state="open"]',
  );
  await expect(profilePopover).toBeVisible();
  await expect(
    profilePopover.getByTestId(
      `user-profile-popover-owner-${OWNED_AGENT_PROFILE_PUBKEY}`,
    ),
  ).toHaveText("managed by bob");
});

test("agent profile popover labels an agent owned by the viewer as you", async ({
  page,
}) => {
  await installMockBridge(page, {
    searchProfiles: [
      {
        pubkey: OWNED_AGENT_PROFILE_PUBKEY,
        displayName: "Bumble",
        ownerPubkey: MOCK_VIEWER_PUBKEY,
        isAgent: true,
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");

  await emitMockMessage(page, "general", "Bumble checking in.", {
    pubkey: OWNED_AGENT_PROFILE_PUBKEY,
  });
  await waitForTimelineSettled(page);

  const bumbleMessage = page
    .getByTestId("message-row")
    .filter({ hasText: "Bumble checking in." })
    .first();
  await bumbleMessage.locator("button").first().hover();

  const profilePopover = page.locator(
    '[data-testid="user-profile-popover"][data-state="open"]',
  );
  await expect(profilePopover).toBeVisible();
  await expect(
    profilePopover.getByTestId(
      `user-profile-popover-owner-${OWNED_AGENT_PROFILE_PUBKEY}`,
    ),
  ).toHaveText("managed by you");
});

test("agent profile popover falls back to the owner's pubkey", async ({
  page,
}) => {
  await installMockBridge(page, {
    searchProfiles: [
      {
        pubkey: OWNED_AGENT_PROFILE_PUBKEY,
        displayName: "Bumble",
        ownerPubkey: CASEY_PROFILE_PUBKEY,
        isAgent: true,
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");

  await emitMockMessage(page, "general", "Bumble checking in.", {
    pubkey: OWNED_AGENT_PROFILE_PUBKEY,
  });
  await waitForTimelineSettled(page);

  const bumbleMessage = page
    .getByTestId("message-row")
    .filter({ hasText: "Bumble checking in." })
    .first();
  await bumbleMessage.locator("button").first().hover();

  const profilePopover = page.locator(
    '[data-testid="user-profile-popover"][data-state="open"]',
  );
  await expect(profilePopover).toBeVisible();
  await expect(
    profilePopover.getByTestId(
      `user-profile-popover-owner-${OWNED_AGENT_PROFILE_PUBKEY}`,
    ),
  ).toHaveText("managed by 11111111…1111");
});

test("human profile popover does not show an owner", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");

  await emitMockMessage(page, "general", "Bob checking in.", {
    pubkey: TEST_IDENTITIES.bob.pubkey,
  });
  await waitForTimelineSettled(page);

  const bobMessage = page
    .getByTestId("message-row")
    .filter({ hasText: "Bob checking in." })
    .first();
  await bobMessage.locator("button").first().hover();

  const profilePopover = page.locator(
    '[data-testid="user-profile-popover"][data-state="open"]',
  );
  await expect(profilePopover).toBeVisible();
  await expect(
    profilePopover.locator('[data-testid^="user-profile-popover-owner-"]'),
  ).toHaveCount(0);
});

test("owned bot profile exposes message and huddle actions", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: TEST_IDENTITIES.charlie.pubkey,
        name: "charlie",
        status: "online",
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-agents").click();
  await expect(page.getByTestId("chat-title")).toHaveText("agents");

  const charlieMessage = page
    .getByTestId("message-row")
    .filter({ hasText: "Indexing the channel catalog now." })
    .first();
  await charlieMessage.locator("button").first().hover();

  const profilePopover = page.locator(
    '[data-testid="user-profile-popover"][data-state="open"]',
  );
  await expect(profilePopover).toBeVisible();
  await expectOwnedAgentProfileActions(
    profilePopover,
    TEST_IDENTITIES.charlie.pubkey,
  );

  await profilePopover
    .getByTestId(
      `user-profile-popover-huddle-${TEST_IDENTITIES.charlie.pubkey}`,
    )
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.__BUZZ_E2E_COMMAND_LOG__ ?? []).find(
            (entry) => entry.command === "start_huddle",
          )?.payload,
      ),
    )
    .toMatchObject({ memberPubkeys: [TEST_IDENTITIES.charlie.pubkey] });
});

test("owned agent mention profile exposes message and huddle actions", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: TEST_IDENTITIES.charlie.pubkey,
        name: "charlie",
        status: "online",
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");

  await emitMockMessage(page, "general", "Can @charlie take this?", {
    mentionPubkeys: [TEST_IDENTITIES.charlie.pubkey],
  });
  await waitForTimelineSettled(page);

  const mentionChip = page
    .getByTestId("message-row")
    .filter({ hasText: "Can charlie take this?" })
    .locator("[data-mention].agent-mention-highlight", { hasText: "charlie" });
  await expect(mentionChip).toBeVisible();
  await mentionChip.hover();

  const profilePopover = page.locator(
    '[data-testid="user-profile-popover"][data-state="open"]',
  );
  await expect(profilePopover).toBeVisible();
  await expectOwnedAgentProfileActions(
    profilePopover,
    TEST_IDENTITIES.charlie.pubkey,
  );
});

test("profile popover wave sends a direct message for a human profile", async ({
  page,
}) => {
  await installMockBridge(page, { sendMessageDelayMs: 2_500 });

  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");

  await emitMockMessage(page, "general", "Bob says hello.", {
    pubkey: TEST_IDENTITIES.bob.pubkey,
  });
  await waitForTimelineSettled(page);

  const bobMessage = page
    .getByTestId("message-row")
    .filter({ hasText: "Bob says hello." })
    .first();
  await bobMessage.locator("button").first().hover();

  const profilePopover = page.locator(
    '[data-testid="user-profile-popover"][data-state="open"]',
  );
  await expect(profilePopover).toBeVisible();
  await expect(
    profilePopover.getByTestId(
      `user-profile-popover-message-${TEST_IDENTITIES.bob.pubkey}`,
    ),
  ).toBeVisible();
  await expect(
    profilePopover.getByTestId(
      `user-profile-popover-huddle-${TEST_IDENTITIES.bob.pubkey}`,
    ),
  ).toBeVisible();
  await expect(
    profilePopover.getByTestId(
      `user-profile-popover-wave-${TEST_IDENTITIES.bob.pubkey}`,
    ),
  ).toBeVisible();
  await profilePopover
    .getByTestId(`user-profile-popover-wave-${TEST_IDENTITIES.bob.pubkey}`)
    .click();

  await expect(page.getByTestId("chat-title")).toHaveText("bob-tyler");
  const waveAttachment = page.getByTestId("message-wave-attachment");
  await expect(waveAttachment).toBeVisible({ timeout: 1_500 });
  await expect(page.getByText("Sending")).toHaveCount(0, { timeout: 4_000 });
  await waitForTimelineSettled(page);
  await expect(waveAttachment).toContainText("👋");
  await expect(waveAttachment).toContainText("npub1mock... waved at you.");
  await expect(waveAttachment).toContainText("Start a huddle to talk to them.");
  await expect(
    waveAttachment.getByRole("button", { name: "Start huddle" }),
  ).toBeVisible();

  const commandLog = await readCommandPayloadLog(page);
  expect(commandLog).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        command: "send_channel_message",
        payload: expect.objectContaining({
          content: expect.stringContaining("npub1mock... waved at you."),
        }),
      }),
    ]),
  );
  expect(commandLog).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        command: "send_channel_message",
        payload: expect.objectContaining({
          content: expect.stringContaining("<!-- buzz:wave:v1 -->"),
        }),
      }),
    ]),
  );
});

test("delayed inaccessible agent profile keeps all actions hidden", async ({
  page,
}) => {
  await installMockBridge(page, {
    agentListDelayMs: 5_000,
    relayAgents: [
      {
        pubkey: DELAYED_RELAY_AGENT_PUBKEY,
        name: "orbit",
        channelNames: ["general"],
      },
    ],
    searchProfiles: [
      {
        pubkey: DELAYED_RELAY_AGENT_PUBKEY,
        displayName: "orbit",
      },
    ],
  });

  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");

  await emitMockMessage(page, "general", "Orbit checking in.", {
    pubkey: DELAYED_RELAY_AGENT_PUBKEY,
  });
  await waitForTimelineSettled(page);

  const orbitMessage = page
    .getByTestId("message-row")
    .filter({ hasText: "Orbit checking in." })
    .first();
  await orbitMessage.locator("button").first().hover();

  const profilePopover = page.locator(
    '[data-testid="user-profile-popover"][data-state="open"]',
  );
  await expect(profilePopover).toBeVisible();
  await expect(
    profilePopover.getByTestId(
      `user-profile-popover-message-${DELAYED_RELAY_AGENT_PUBKEY}`,
    ),
  ).toHaveCount(0);
  await expect(
    profilePopover.getByTestId(
      `user-profile-popover-wave-${DELAYED_RELAY_AGENT_PUBKEY}`,
    ),
  ).toHaveCount(0);
  await expect(
    profilePopover.getByTestId(
      `user-profile-popover-huddle-${DELAYED_RELAY_AGENT_PUBKEY}`,
    ),
  ).toHaveCount(0);
});

const ROLE_AGENT_PUBKEY =
  "7777777777777777777777777777777777777777777777777777777777777777";

/** One deployed employee: personal name Jason, stable role cto / CTO. */
const ROLE_AGENT_SEED = {
  personas: [
    {
      id: "persona-cto",
      displayName: "Jason",
      systemPrompt: "You are the CTO.",
      roleId: "cto",
      roleTitle: "CTO",
    },
  ],
  managedAgents: [
    {
      pubkey: ROLE_AGENT_PUBKEY,
      name: "Jason",
      personaId: "persona-cto",
      status: "stopped" as const,
      channelNames: ["general"],
    },
  ],
};

test("role mention: typing @cto offers the agent by role and personal name", async ({
  page,
}) => {
  await installMockBridge(page, ROLE_AGENT_SEED);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("Ping @cto");

  const dropdown = autocomplete(page);
  const roleRow = dropdown.locator("button", { hasText: "CTO" });
  await expect(roleRow).toBeVisible();
  // Both aliases stay visible, so a name/role collision is never resolved by
  // the typed text alone.
  await expect(roleRow.getByTestId("mention-alias-label")).toHaveText("Jason");
  await expect(roleRow.getByTestId("mention-agent-icon")).toBeVisible();
});

test("role mention: selecting @cto inserts the role title and targets the same agent", async ({
  page,
}) => {
  await installMockBridge(page, ROLE_AGENT_SEED);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("Ping @cto");

  const dropdown = autocomplete(page);
  await expect(dropdown.locator("button", { hasText: "CTO" })).toBeVisible();
  await input.press("Enter");
  await page.keyboard.type(" please review this");

  // The visible token is the role title, not the personal name.
  await expect(input).toHaveText("Ping @CTO  please review this");

  const baseline = await readCommandLog(page);
  const baselineStartCount = commandCount(baseline, "start_managed_agent");
  const baselineCreateCount = commandCount(baseline, "create_managed_agent");

  await page.getByTestId("send-message").click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  // The role-keyed mention still resolves to the existing agent: it is started
  // exactly once and no second agent is provisioned. If the authoritative
  // mention map were keyed by "Jason" while the draft said "@CTO", the send
  // would silently lose the target and neither would happen.
  await expect
    .poll(async () =>
      commandCount(await readCommandLog(page), "start_managed_agent"),
    )
    .toBe(baselineStartCount + 1);
  expect(commandCount(await readCommandLog(page), "create_managed_agent")).toBe(
    baselineCreateCount,
  );

  // The sent message keeps the role token the user chose.
  await expect(page.getByTestId("message-row").last()).toContainText("@CTO");

  // KNOWN GAP: the history chip does NOT render for a role token.
  // `resolveMentionProps` builds chips from the mentioned pubkey's relay
  // profile aliases (displayName / name / NIP-05 local part), and the role
  // lives on the local Persona, so `@CTO` renders as plain text even though
  // its `p` tag resolved correctly and started the right agent. Targeting and
  // notification are unaffected; only the visual chip is missing. Fixing it
  // means feeding persona role aliases into the renderer, which is a
  // perf-sensitive hot path (see MessageRow memoization notes), so it is
  // deliberately out of scope here.
  // Deliberately not asserted either way: pinning `toHaveCount(0)` would make
  // this test fail the day someone fixes the renderer.
});

test("role mention: the personal name still inserts the personal name", async ({
  page,
}) => {
  await installMockBridge(page, ROLE_AGENT_SEED);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("Ping @jas");

  const dropdown = autocomplete(page);
  const nameRow = dropdown.locator("button", { hasText: "Jason" });
  await expect(nameRow).toBeVisible();
  // The role is the alias here, so it is what the row surfaces.
  await expect(nameRow.getByTestId("mention-alias-label")).toHaveText("CTO");
  await input.press("Enter");

  await expect(input).toHaveText("Ping @Jason ");
});

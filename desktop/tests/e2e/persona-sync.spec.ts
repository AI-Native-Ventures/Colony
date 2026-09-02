import { expect, test } from "@playwright/test";
import { hexToBytes } from "@noble/hashes/utils.js";
import { finalizeEvent } from "nostr-tools/pure";

import { installMockBridge } from "../helpers/bridge";
import type { RelayEvent } from "../../src/shared/api/types";

// Tyler's test identity — from TEST_IDENTITIES.tyler in tests/helpers/bridge.ts
const TYLER_PRIVATE_KEY = hexToBytes(
  "3dbaebadb5dfd777ff25149ee230d907a15a9e1294b40b830661e65bb42f6c03",
);
const TYLER_PUBKEY =
  "e5ebc6cdb579be112e336cc319b5989b4bb6af11786ea90dbe52b5f08d741b34";

const D_TAG = "sync-test-persona";
const KIND_PERSONA = 30175;
const KIND_DELETION = 5;
// The command scopes an inbound event to the community it arrived on. Under the
// mock bridge the app subscribes on e2eBridge's DEFAULT_RELAY_WS_URL, so that is
// the arrival relay these direct invocations stand in for.
const ARRIVAL_RELAY_URL = "ws://localhost:3000";

// A persona head that is already on the relay when the app boots. It can only
// reach the local store through the sync backfill's one-shot REQ, so it also
// guards the mock relay's filter routing: the backfill asks for
// 30175/30176/30177/5 in a single filter, and a branch matching on any one of
// those kinds swallows it whole and answers an empty EOSE.
const BACKFILL_D_TAG = "sync-backfill-persona";
const BACKFILL_PERSONA: RelayEvent = {
  id: "mock-backfill-persona".padEnd(64, "0"),
  // The mock identity, which is who the backfill filter names as the author.
  pubkey: "deadbeef".repeat(8),
  created_at: 1_800_000_000,
  kind: KIND_PERSONA,
  tags: [["d", BACKFILL_D_TAG]],
  content: JSON.stringify({
    display_name: "Backfill Persona",
    system_prompt: "You arrived through the backfill.",
  }),
  sig: "mocksig".repeat(20).slice(0, 128),
};

test.beforeEach(async ({ page }) => {
  await installMockBridge(page, { personaCatalogEvents: [BACKFILL_PERSONA] });
});

async function gotoApp(page: import("@playwright/test").Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForInvokeBridge(page);
  await expect(page.getByTestId("open-agents-view")).toBeVisible({
    timeout: 10_000,
  });
}

async function waitForInvokeBridge(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () => {
      const w = window as Window & {
        __BUZZ_E2E_INVOKE_MOCK_COMMAND__?: unknown;
      };
      return typeof w.__BUZZ_E2E_INVOKE_MOCK_COMMAND__ === "function";
    },
    null,
    { timeout: 5_000 },
  );
}

async function invokeTauri<T>(
  page: import("@playwright/test").Page,
  command: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  await waitForInvokeBridge(page);
  return page.evaluate(
    async ({ command: c, payload: p }) => {
      const w = window as Window & {
        __BUZZ_E2E_INVOKE_MOCK_COMMAND__?: (
          c: string,
          p?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
      const invoke = w.__BUZZ_E2E_INVOKE_MOCK_COMMAND__;
      if (!invoke) throw new Error("Mock invoke bridge is unavailable.");
      return (await invoke(c, p)) as T;
    },
    { command, payload },
  );
}

/**
 * Register a one-shot `agents-data-changed` listener BEFORE the reconcile call
 * and wait up to 500 ms for it to fire (covers the 200 ms debounce coalesce).
 * Returns true if the event fired, false on timeout.
 *
 * Must be called before the invokeTauri that triggers the emit so the listener
 * is registered before the event fires — no race.
 */
async function listenForAgentsDataChanged(
  page: import("@playwright/test").Page,
): Promise<() => Promise<boolean>> {
  // Inject a Promise into the page that resolves when the event fires.
  await page.evaluate(() => {
    (
      window as Window & { __agentsDataChangedFired?: Promise<boolean> }
    ).__agentsDataChangedFired = new Promise<boolean>((resolve) => {
      const listenNativeEvent = (
        window as Window & {
          __BUZZ_E2E_LISTEN_NATIVE_EVENT__?: (
            event: string,
            cb: () => void,
          ) => Promise<() => void>;
        }
      ).__BUZZ_E2E_LISTEN_NATIVE_EVENT__;
      if (!listenNativeEvent) {
        resolve(false);
        return;
      }
      void listenNativeEvent("agents-data-changed", () => resolve(true));
      // Timeout guard: 500 ms covers the 200 ms debounce coalesce with margin.
      setTimeout(() => resolve(false), 500);
    });
  });

  // Return a thunk the caller invokes after the reconcile to await the result.
  return () =>
    page.evaluate(
      () =>
        (window as Window & { __agentsDataChangedFired?: Promise<boolean> })
          .__agentsDataChangedFired ?? Promise.resolve(false),
    );
}

test("upsert round-trip: reconcile_inbound_persona_event writes record and emits agents-data-changed", async ({
  page,
}) => {
  await gotoApp(page);

  const createdAt = Math.floor(Date.now() / 1000);

  // Build + sign the kind:30175 persona event using nostr-tools.
  const personaEvent = finalizeEvent(
    {
      kind: KIND_PERSONA,
      content: JSON.stringify({
        display_name: "Sync Test Persona",
        system_prompt: "You are a sync test.",
      }),
      tags: [["d", D_TAG]],
      created_at: createdAt,
    },
    TYLER_PRIVATE_KEY,
  );

  // Register the listener BEFORE the reconcile call — no race.
  const awaitFired = await listenForAgentsDataChanged(page);

  // Drive the inbound reconcile path.
  await invokeTauri(page, "reconcile_inbound_persona_event", {
    eventJson: JSON.stringify(personaEvent),
    arrivalRelayUrl: ARRIVAL_RELAY_URL,
  });

  // Assert the record landed on disk.
  const personas = await invokeTauri<
    Array<{ id: string; display_name: string }>
  >(page, "list_personas");
  const record = personas.find((p) => p.id === D_TAG);
  expect(record?.display_name).toBe("Sync Test Persona");

  // Assert the emit fired (debounce settles within 500 ms timeout guard).
  const fired = await awaitFired();
  expect(fired).toBe(true);
});

test("tombstone round-trip: reconcile_inbound_persona_event removes record and emits agents-data-changed", async ({
  page,
}) => {
  await gotoApp(page);

  const upsertCreatedAt = Math.floor(Date.now() / 1000);

  // Step 1: upsert the persona first.
  const personaEvent = finalizeEvent(
    {
      kind: KIND_PERSONA,
      content: JSON.stringify({
        display_name: "Sync Test Persona",
        system_prompt: "You are a sync test.",
      }),
      tags: [["d", D_TAG]],
      created_at: upsertCreatedAt,
    },
    TYLER_PRIVATE_KEY,
  );

  await invokeTauri(page, "reconcile_inbound_persona_event", {
    eventJson: JSON.stringify(personaEvent),
    arrivalRelayUrl: ARRIVAL_RELAY_URL,
  });

  // Step 2: confirm it landed.
  const afterUpsert = await invokeTauri<Array<{ id: string }>>(
    page,
    "list_personas",
  );
  expect(afterUpsert.some((p) => p.id === D_TAG)).toBe(true);

  // Step 3: build + sign a kind:5 deletion event. created_at must be strictly
  // after the upsert so the retention db does not skip it.
  const tombstoneEvent = finalizeEvent(
    {
      kind: KIND_DELETION,
      content: "",
      tags: [["a", `${KIND_PERSONA}:${TYLER_PUBKEY}:${D_TAG}`]],
      created_at: upsertCreatedAt + 1,
    },
    TYLER_PRIVATE_KEY,
  );

  // Register the listener BEFORE the tombstone reconcile call — no race.
  const awaitFired = await listenForAgentsDataChanged(page);

  await invokeTauri(page, "reconcile_inbound_persona_event", {
    eventJson: JSON.stringify(tombstoneEvent),
    arrivalRelayUrl: ARRIVAL_RELAY_URL,
  });

  // Step 4: assert the record is gone.
  const afterTombstone = await invokeTauri<Array<{ id: string }>>(
    page,
    "list_personas",
  );
  expect(afterTombstone.some((p) => p.id === D_TAG)).toBe(false);

  // Step 5: assert the emit fired for the tombstone path too.
  const fired = await awaitFired();
  expect(fired).toBe(true);
});

test("backfill round-trip: a persona head already on the relay lands locally on boot", async ({
  page,
}) => {
  await gotoApp(page);

  await expect
    .poll(
      async () => {
        const personas = await invokeTauri<
          Array<{ id: string; display_name: string }>
        >(page, "list_personas");
        return personas.find((p) => p.id === BACKFILL_D_TAG)?.display_name;
      },
      { timeout: 10_000 },
    )
    .toBe("Backfill Persona");
});

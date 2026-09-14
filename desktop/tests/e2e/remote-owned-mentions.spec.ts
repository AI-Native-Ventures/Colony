import { expect, test, type Page } from "@playwright/test";
import {
  installMockBridge,
  openNewMessagePage,
  TEST_IDENTITIES,
} from "../helpers/bridge";

const OWNER = "deadbeef".repeat(8);
const REMOTE = "ed".repeat(32);
const _GENERAL = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";

async function install(page: Page) {
  await installMockBridge(page, {
    ownerOnlyAccessBuild: true,
    managedAgents: [],
    searchProfiles: [
      {
        pubkey: REMOTE,
        displayName: "RemoteScout",
        ownerPubkey: OWNER,
        isAgent: true,
      },
    ],
    relayAgents: [
      {
        pubkey: REMOTE,
        name: "RemoteScout",
        ownerPubkey: OWNER,
        respondTo: "allowlist",
        respondToAllowlist: [],
        channelNames: [],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
}
async function select(page: Page) {
  await page.getByTestId("message-input").fill("@Remote");
  const row = page.getByTestId(`mention-suggestion-${REMOTE}`);
  await expect(row).toContainText("RemoteScout");
  await row.click();
  await page.keyboard.type("hello");
}
async function sent(page: Page) {
  return page.evaluate(() => {
    const signed = (window.__BUZZ_E2E_SIGNED_EVENTS__ ?? [])
      .filter((event) => event.content === "@RemoteScout hello")
      .map((event) =>
        event.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1]),
      );
    if (signed.length) return signed;
    // New DMs deliberately use the acknowledged native HTTP command rather
    // than JS sign_event. Assert its exact outgoing recipients, not fake crypto.
    return (window.__BUZZ_E2E_COMMAND_LOG__ ?? []).flatMap((call) => {
      const payload = call.payload as {
        content?: string;
        mentionPubkeys?: string[];
      };
      return call.command === "send_channel_message" &&
        payload.content === "@RemoteScout hello"
        ? [payload.mentionPubkeys ?? []]
        : [];
    });
  });
}
async function assertNoLocalLifecycle(page: Page) {
  const commands = await page.evaluate(
    () => window.__BUZZ_E2E_COMMANDS__ ?? [],
  );
  for (const command of [
    "start_managed_agent",
    "create_managed_agent",
    "attach_managed_agent",
  ]) {
    expect(commands).not.toContain(command);
  }
}
test("selected owned agent revoked before add keeps draft and sends nothing", async ({
  page,
}) => {
  await install(page);
  await select(page);
  await page.getByTestId("send-message").click();
  await page.evaluate((pubkey) => {
    window.__BUZZ_E2E__.mock ??= {};
    window.__BUZZ_E2E__.mock.relayAgentRevalidationRevokedPubkeys = [pubkey];
  }, REMOTE);
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(
    page.getByText(/Could not authorize a mentioned agent/),
  ).toBeVisible();
  await expect(page.getByTestId("message-input")).toHaveText(
    "@RemoteScout hello",
  );
  expect(await sent(page)).toEqual([]);
});

for (const mode of ["existing", "new"] as const) {
  test(`${mode} DM prepares actual destination for owned relay mention`, async ({
    page,
  }) => {
    await install(page);
    if (mode === "existing") {
      await page.getByTestId("channel-bob-tyler").click();
      await expect(page.getByTestId("chat-title")).toHaveText("bob-tyler");
    } else {
      await openNewMessagePage(page);
      await page.getByTestId("new-dm-search").fill("bob");
      await page
        .getByTestId(`new-dm-result-${TEST_IDENTITIES.bob.pubkey}`)
        .click();
      await page.getByTestId("new-dm-search").press("Escape");
    }
    await select(page);
    await page.getByTestId("send-message").click();
    await expect
      .poll(() => sent(page))
      .toEqual([[REMOTE, TEST_IDENTITIES.bob.pubkey]]);
    const calls = await page.evaluate(
      () => window.__BUZZ_E2E_COMMAND_LOG__ ?? [],
    );
    const checks = calls.filter(
      (call) => call.command === "revalidate_relay_agents",
    );
    const event = await page.evaluate(() =>
      (window.__BUZZ_E2E_SIGNED_EVENTS__ ?? []).find(
        (event) => event.content === "@RemoteScout hello",
      ),
    );
    expect(checks.at(-1)?.payload).toMatchObject({
      channelId:
        event?.tags.find((tag) => tag[0] === "h")?.[1] ??
        (
          calls.find((call) => call.command === "send_channel_message")
            ?.payload as { channelId?: string }
        )?.channelId,
      pubkeys: [REMOTE],
    });
    await assertNoLocalLifecycle(page);
  });
}

test("membership revoked at final publish keeps draft and emits no message", async ({
  page,
}) => {
  await install(page);
  await select(page);
  await page.getByTestId("send-message").click();
  // Let preparation succeed, but make the fresh final directory read fail.
  await page.evaluate(() => {
    window.__BUZZ_E2E__.mock ??= {};
    window.__BUZZ_E2E__.mock.relayAgentListErrors = [
      null,
      null,
      "revoked at publication",
    ];
  });
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(
    page.getByText(/Could not authorize a mentioned agent/),
  ).toBeVisible();
  await expect(page.getByTestId("message-input")).toHaveText(
    "@RemoteScout hello",
  );
  expect(await sent(page)).toEqual([]);
});

// Deferred IPC seam: hold the exact next preparation/add response, not a timer.
// This lets the browser exercise Escape/navigation before the continuation runs.
type InviteGateWindow = Window & {
  __TAURI_INTERNALS__: {
    invoke: (command: string, payload?: unknown) => Promise<unknown>;
  };
  inviteGateEntered?: boolean;
  releaseInviteGate?: () => void;
};
async function _holdInviteCommand(page: Page, command: string, skip = 0) {
  await page.evaluate(
    ({ heldCommand, skip }) => {
      const state = window as unknown as InviteGateWindow;
      const invoke = state.__TAURI_INTERNALS__.invoke;
      const gate = new Promise<void>((resolve) => {
        state.releaseInviteGate = resolve;
      });
      state.__TAURI_INTERNALS__.invoke = async (command, payload) => {
        if (command !== heldCommand || skip-- > 0)
          return invoke(command, payload);
        state.__TAURI_INTERNALS__.invoke = invoke;
        state.inviteGateEntered = true;
        await gate;
        return invoke(command, payload);
      };
    },
    { heldCommand: command, skip },
  );
}
async function _releaseInviteCommand(page: Page) {
  await page.evaluate(() => {
    (window as unknown as InviteGateWindow).releaseInviteGate?.();
  });
}
async function _waitForInviteGate(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as InviteGateWindow).inviteGateEntered,
      ),
    )
    .toBe(true);
}
async function _remoteAdds(page: Page) {
  return page.evaluate(() =>
    (window.__BUZZ_E2E_COMMAND_LOG__ ?? []).filter(
      (call) => call.command === "add_channel_members",
    ),
  );
}

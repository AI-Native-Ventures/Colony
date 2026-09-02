import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

/**
 * What a paid agent turn is charged to, proven at the seam the desktop owns.
 *
 * Which team owns chat work, who reviews it, and where its cost lands are
 * decided in `buzz-sdk::implicit_task` and proven there. What only the desktop
 * can prove is the ordering around that decision, and it is the part that
 * actually costs money if it is wrong:
 *
 * - no agent-directed message goes out until the relay has confirmed a Task;
 * - the message carries exactly three references and no accounting;
 * - a Task the relay did not confirm stops the send instead of buying an
 *   unattributed turn.
 */

const TASK_ID = "horizonlabs:chat:0001";
const INITIATIVE_ID = "horizonlabs:launch-outbound";
const COORDINATION_TEAM = "company-team:abc:horizonlabs:company-coordination";
const FIZZ_PERSONA = "company-role:abc:horizonlabs:chief-of-staff";

const COMPANY_WORK_CONTEXT = {
  initiativeId: INITIATIVE_ID,
  taskId: TASK_ID,
  // Jason sits in Engineering and in Company Coordination, so the work is
  // genuinely ambiguous and coordination is what holds it.
  owningTeamId: COORDINATION_TEAM,
  qaPersonaId: FIZZ_PERSONA,
  costCentreId: "cc-coordination",
};

const JASON = {
  pubkey: TEST_IDENTITIES.charlie.pubkey,
  name: "Jason",
  status: "running" as const,
};

type PublishedEvent = {
  kind: number;
  content: string;
  tags: string[][];
};

async function readPublishedEvents(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __BUZZ_E2E_PUBLISHED_EVENTS__?: PublishedEvent[];
        }
      ).__BUZZ_E2E_PUBLISHED_EVENTS__ ?? [],
  );
}

async function readBrokerLog(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __BUZZ_E2E_MOCK_COMPANY_BROKER__?: () => {
            actionEventIds: string[];
            receiptOutcomes: string[];
            headKinds: number[];
          };
        }
      ).__BUZZ_E2E_MOCK_COMPANY_BROKER__?.() ?? {
        actionEventIds: [],
        receiptOutcomes: [],
        headKinds: [],
      },
  );
}

async function readCommands(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      (window as Window & { __BUZZ_E2E_COMMANDS__?: string[] })
        .__BUZZ_E2E_COMMANDS__ ?? [],
  );
}

/** The arguments of the last `send_channel_message` the app invoked. */
async function readLastSendArgs(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const payloads =
      (
        window as Window & {
          __BUZZ_E2E_COMMAND_PAYLOADS__?: {
            command: string;
            payload: unknown;
          }[];
        }
      ).__BUZZ_E2E_COMMAND_PAYLOADS__ ?? [];
    for (let index = payloads.length - 1; index >= 0; index -= 1) {
      if (payloads[index].command === "send_channel_message") {
        return payloads[index].payload as {
          mediaTags?: string[][] | null;
          workTags?: string[][] | null;
        };
      }
    }
    return null;
  });
}

async function mentionJasonAndSend(
  page: import("@playwright/test").Page,
  instruction: string,
) {
  const input = page.getByTestId("message-input");
  await input.fill("@Jason");
  const dropdown = page
    .getByTestId("message-composer")
    .getByTestId("mention-autocomplete");
  await expect(dropdown).toBeVisible();
  await dropdown.locator("button", { hasText: "Jason" }).first().click();
  await input.pressSequentially(` ${instruction}`);
  await input.press("Enter");
}

test("an agent-directed message is charged to a Task the relay confirmed first", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [JASON],
    companyWorkContext: COMPANY_WORK_CONTEXT,
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  await mentionJasonAndSend(page, "look at the failing deploy");

  // The message lands only after the Task does, so waiting for the message is
  // also waiting for the whole ordering to have happened.
  await expect
    .poll(async () => {
      const events = await readPublishedEvents(page);
      return events.filter((event) =>
        event.tags.some((tag) => tag[0] === "task"),
      ).length;
    })
    .toBeGreaterThan(0);

  const commands = await readCommands(page);
  const taskIndex = commands.indexOf("ensure_chat_task");
  const sendIndex = commands.indexOf("send_channel_message");
  expect(taskIndex).toBeGreaterThanOrEqual(0);
  expect(sendIndex).toBeGreaterThanOrEqual(0);
  // The Task is asked for before the message it pays for is sent. Reversing
  // these two is the whole failure this flow exists to prevent.
  expect(taskIndex).toBeLessThan(sendIndex);

  // The relay received one owner-signed action, answered it, and wrote the
  // Task head. That head is what the message then points at.
  const broker = await readBrokerLog(page);
  expect(broker.actionEventIds).toHaveLength(1);
  expect(broker.receiptOutcomes).toEqual(["applied"]);
  expect(broker.headKinds).toContain(30181);

  const events = await readPublishedEvents(page);
  const messageIndex = events.findIndex(
    (event) =>
      event.tags.some((tag) => tag[0] === "task") &&
      (event.kind === 9 || event.kind === 40002),
  );
  expect(messageIndex).toBeGreaterThanOrEqual(0);
  const message = events[messageIndex] as PublishedEvent;
  const reference = (name: string) =>
    message.tags.filter((tag) => tag[0] === name).map((tag) => tag[1]);

  expect(reference("task")).toEqual([TASK_ID]);
  expect(reference("initiative")).toEqual([INITIATIVE_ID]);
  expect(reference("team")).toEqual([COORDINATION_TEAM]);

  // The three references reach the native command on the work-context arg,
  // never the imeta-only media one. They rode `mediaTags` for the life of the
  // feature, where the native `imeta_tags` guard rejected the first of them
  // and failed the send after the Task had already been created and paid for.
  const sendArgs = await readLastSendArgs(page);
  expect(sendArgs?.workTags).toEqual(
    expect.arrayContaining([["task", TASK_ID]]),
  );
  expect(sendArgs?.mediaTags ?? []).toEqual([]);

  // Cost centre, client, purpose, and classification are properties of the
  // Task. A message that carried them would be a message that could lie.
  for (const forbidden of [
    "cost-centre",
    "client",
    "commercial-purpose",
    "cost-classification",
  ]) {
    expect(reference(forbidden)).toEqual([]);
  }
});

test("a message with no agent in it is not charged to anything", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [JASON],
    companyWorkContext: COMPANY_WORK_CONTEXT,
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const input = page.getByTestId("message-input");
  await input.fill("just thinking out loud");
  await input.press("Enter");
  await expect(input).toBeEmpty();

  expect((await readBrokerLog(page)).actionEventIds).toEqual([]);
  const events = await readPublishedEvents(page);
  for (const event of events) {
    expect(event.tags.some((tag) => tag[0] === "task")).toBe(false);
  }
  expect(await readCommands(page)).not.toContain("ensure_chat_task");
});

// A turn nobody can account for is worse than a turn that did not happen: the
// money is gone either way and only one of them can be explained afterwards.
test("a Task the relay never confirmed stops the send and keeps the draft", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [JASON],
    companyWorkContext: {
      ...COMPANY_WORK_CONTEXT,
      refuseWith: "rejected",
    },
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  await mentionJasonAndSend(page, "look at the failing deploy");

  await expect
    .poll(async () => (await readBrokerLog(page)).receiptOutcomes.length)
    .toBeGreaterThan(0);

  // The relay refused, so no Task head exists and nothing may be sent on it.
  const broker = await readBrokerLog(page);
  expect(broker.receiptOutcomes).toEqual(["rejected"]);
  expect(broker.headKinds).not.toContain(30181);

  const events = await readPublishedEvents(page);
  const sent = events.filter(
    (event) =>
      (event.kind === 9 || event.kind === 40002) &&
      event.content.includes("failing deploy"),
  );
  expect(sent).toEqual([]);

  // The instruction is still where the owner left it.
  await expect(page.getByTestId("message-input")).toContainText(
    "failing deploy",
  );
});

import { expect, test, type Page } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

/**
 * One open task per thread, as the thread surface presents it.
 *
 * The relay decides which task a send is charged to, and that decision is
 * proven in `thread_task_broker.rs`. What only the desktop can prove is what
 * a member sees and can do about it: the thread names the work that is open
 * in it, the owner can close that work without leaving the conversation, and
 * the composer's switch is how one conversation carries a second task.
 */

const TASK_ID = "thread-task:0001";
const TEAM_ID = "company-team:abc:horizonlabs:company-coordination";

const COMPANY_WORK_CONTEXT = {
  taskId: TASK_ID,
  owningTeamId: TEAM_ID,
  qaPersonaId: "company-role:abc:horizonlabs:chief-of-staff",
  costCentreId: "cc-coordination",
};

const JASON = {
  pubkey: TEST_IDENTITIES.charlie.pubkey,
  name: "Jason",
  status: "running" as const,
};

type PublishedEvent = {
  id: string;
  kind: number;
  content: string;
  tags: string[][];
};

async function readPublishedEvents(page: Page): Promise<PublishedEvent[]> {
  return page.evaluate(
    () =>
      (
        window as Window & {
          __BUZZ_E2E_PUBLISHED_EVENTS__?: PublishedEvent[];
        }
      ).__BUZZ_E2E_PUBLISHED_EVENTS__ ?? [],
  );
}

/** The `mode` of every thread attach the app has asked for, in order. */
async function readAttachModes(page: Page): Promise<string[]> {
  const events = await readPublishedEvents(page);
  return events
    .filter((event) => event.kind === 40013)
    .map((event) => {
      const parsed = JSON.parse(event.content) as {
        payload?: { record?: { mode?: string } };
      };
      return parsed.payload?.record?.mode ?? "";
    });
}

async function mentionJasonAndSend(page: Page, instruction: string) {
  const composer = page.getByTestId("message-thread-panel");
  const input = composer.getByTestId("message-input");
  await input.fill("@Jason");
  const dropdown = composer.getByTestId("mention-autocomplete");
  await expect(dropdown).toBeVisible();
  await dropdown.locator("button", { hasText: "Jason" }).first().click();
  await input.pressSequentially(` ${instruction}`);
  await input.press("Enter");
}

/** Open a thread on the newest message in `general` and instruct an agent. */
async function openThreadWithWork(page: Page, instruction: string) {
  await installMockBridge(page, {
    managedAgents: [JASON],
    companyWorkContext: COMPANY_WORK_CONTEXT,
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const row = page.getByTestId("message-row").last();
  await row.hover();
  await row.getByRole("button", { name: "Reply" }).click();
  const panel = page.getByTestId("message-thread-panel");
  await expect(panel).toBeVisible();
  await waitForAnimations(page);

  await mentionJasonAndSend(page, instruction);

  // The instruction lands only once the relay has answered which task it is
  // charged to, so waiting for the tagged message waits for the whole
  // ordering to have happened.
  await expect
    .poll(async () => {
      const events = await readPublishedEvents(page);
      return events.filter((event) =>
        event.tags.some((tag) => tag[0] === "task" && tag[1] === TASK_ID),
      ).length;
    })
    .toBeGreaterThan(0);
  return panel;
}

test("the thread header names the work open in it and can close it", async ({
  page,
}) => {
  const instruction = "cut the release video";
  const panel = await openThreadWithWork(page, instruction);

  await expect(panel.getByTestId("thread-open-task-title")).toHaveText(
    instruction,
  );

  // Closing the thread's work from the thread: the alternative is leaving the
  // conversation the work is about to end it somewhere else.
  const markDone = panel.getByTestId("thread-mark-done");
  await expect(markDone).toBeVisible();
  await markDone.click();
  await expect
    .poll(async () => {
      const events = await readPublishedEvents(page);
      return events.filter((event) => event.kind === 40013).length;
    })
    .toBeGreaterThan(1);
});

test("the composer's switch asks for a second task in the same thread", async ({
  page,
}) => {
  const panel = await openThreadWithWork(page, "cut the release video");

  // The switch only appears where it means something: a thread that already
  // holds work is the only place a second task can be started beside one.
  const toggle = panel.getByTestId("composer-new-task");
  await expect(toggle).toBeVisible();
  expect(await readAttachModes(page)).toEqual(["open"]);

  await toggle.click();
  await expect(toggle).toHaveAttribute("data-state", "checked");
  await mentionJasonAndSend(page, "and book the studio");

  await expect.poll(async () => readAttachModes(page)).toEqual(["open", "new"]);

  // Per-send, not a mode. Leaving it on would open a task per message, which
  // is the behaviour thread-scoped tasks exist to end.
  await expect(toggle).toHaveAttribute("data-state", "unchecked");
});

test("a channel timeline offers no new-task switch", async ({ page }) => {
  await installMockBridge(page, {
    managedAgents: [JASON],
    companyWorkContext: COMPANY_WORK_CONTEXT,
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await expect(page.getByTestId("composer-new-task")).toHaveCount(0);
});

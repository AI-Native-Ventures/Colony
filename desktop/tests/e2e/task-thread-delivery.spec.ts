import { expect, test, type Page } from "@playwright/test";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const TASK_ID = "horizonlabs:chat:delivery-surface";
const TEAM_ID = "company-team:abc:horizonlabs:company-coordination";
const QA_ID = "company-role:abc:horizonlabs:chief-of-staff";
const RUN_SECRET = generateSecretKey();
const RUN_EMPLOYEE = getPublicKey(RUN_SECRET);

const CONTEXT = {
  companyId: "horizonlabs",
  taskId: TASK_ID,
  owningTeamId: TEAM_ID,
  qaPersonaId: QA_ID,
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

async function createCanonicalTaskThread(page: Page, instruction: string) {
  await installMockBridge(page, {
    managedAgents: [JASON],
    companyWorkContext: CONTEXT,
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  const input = page.getByTestId("message-input");
  await input.fill("@Jason");
  const dropdown = page
    .getByTestId("message-composer")
    .getByTestId("mention-autocomplete");
  await dropdown.locator("button", { hasText: "Jason" }).first().click();
  await input.pressSequentially(` ${instruction}`);
  await input.press("Enter");

  const message = await expect
    .poll(async () =>
      page.evaluate(
        ({ taskId, text }) =>
          (
            window as Window & {
              __BUZZ_E2E_PUBLISHED_EVENTS__?: PublishedEvent[];
            }
          ).__BUZZ_E2E_PUBLISHED_EVENTS__?.find(
            (event) =>
              event.content.includes(text) &&
              event.tags.some((tag) => tag[0] === "task" && tag[1] === taskId),
          ) ?? null,
        { taskId: TASK_ID, text: instruction },
      ),
    )
    .not.toBeNull()
    .then(async () =>
      page.evaluate(
        ({ taskId, text }) =>
          (
            window as Window & {
              __BUZZ_E2E_PUBLISHED_EVENTS__?: PublishedEvent[];
            }
          ).__BUZZ_E2E_PUBLISHED_EVENTS__?.find(
            (event) =>
              event.content.includes(text) &&
              event.tags.some((tag) => tag[0] === "task" && tag[1] === taskId),
          ) as PublishedEvent,
        { taskId: TASK_ID, text: instruction },
      ),
    );
  const channelId = message.tags.find((tag) => tag[0] === "h")?.[1];
  if (!channelId) throw new Error("Task thread message has no channel tag");
  return { message, channelId };
}

async function seedTaskRun(
  page: Page,
  input: {
    channelId: string;
    threadId: string;
    mode: "expired" | "delivered" | "delivered-path";
  },
) {
  const delivered = input.mode !== "expired";
  const now = Math.floor(Date.now() / 1_000);
  const tags: string[][] = [
    ["d", "a".repeat(64)],
    ["employee", RUN_EMPLOYEE],
    ["originator", TEST_IDENTITIES.alice.pubkey],
    ["filed-by", TEST_IDENTITIES.alice.pubkey],
    ["status", delivered ? "done" : "leased"],
    ["attempts", "1"],
    ["p", TEST_IDENTITIES.alice.pubkey],
    ["h", input.channelId],
    ["e", input.threadId],
    ["task", TASK_ID],
    ["run-status", delivered ? "delivered" : "executing"],
  ];
  if (delivered) {
    tags.push(
      ["checkpoint-seq", "2"],
      ["checkpoint-event", "c".repeat(64)],
      ["outcome-event", "d".repeat(64)],
    );
  } else {
    tags.push(
      ["lease-holder", RUN_EMPLOYEE],
      ["lease-expires", String(now - 30)],
    );
  }
  const event = finalizeEvent(
    {
      kind: 30191,
      created_at: now,
      tags,
      content: JSON.stringify({
        instruction: "Deliver the reviewed launch memo",
        ...(delivered
          ? {
              checkpoint: {
                summary: "Draft complete and review comments incorporated.",
                resumeToken: null,
                progress: 90,
              },
              artifacts: [
                input.mode === "delivered-path"
                  ? {
                      kind: "path",
                      ref: "/worker/output/final.md",
                      label: "Worker-local result",
                    }
                  : {
                      kind: "text",
                      ref: "# Launch memo\n\nThe reviewed launch plan is ready.",
                      label: "Reviewed launch memo",
                    },
                {
                  kind: "path",
                  ref: "/worker/output/source-notes.md",
                  label: "Source notes",
                },
              ],
            }
          : {}),
      }),
    },
    RUN_SECRET,
  );
  await page.evaluate(
    ({ storedEvent }) => {
      const bridge = (
        window as Window & {
          __BUZZ_E2E_EMIT_MOCK_EVENT__?: (input: {
            channelName: string;
            event: typeof storedEvent;
          }) => unknown;
        }
      ).__BUZZ_E2E_EMIT_MOCK_EVENT__;
      if (!bridge) throw new Error("Mock event bridge unavailable");
      bridge({ channelName: "general", event: storedEvent });
    },
    { storedEvent: event },
  );
}

async function openTaskThread(page: Page, text: string) {
  const row = page.getByTestId("message-row").filter({ hasText: text }).last();
  await row.hover();
  await row.getByRole("button", { name: "Reply" }).click();
  await expect(page.getByTestId("message-thread-panel")).toBeVisible();
}

test("expired durable lease renders recovery without chat inference", async ({
  page,
}) => {
  const instruction = "prepare the recovery brief";
  const { message, channelId } = await createCanonicalTaskThread(
    page,
    instruction,
  );
  await seedTaskRun(page, {
    channelId,
    threadId: message.id,
    mode: "expired",
  });
  await openTaskThread(page, instruction);
  await expect(page.getByTestId("task-thread-context")).toBeVisible();
  await expect(page.getByTestId("task-execution-state")).toHaveText(
    "Recovery pending",
  );
});

test("accepted checkpoint and delivery open a read-only workspace artifact", async ({
  page,
}) => {
  const instruction = "prepare the delivery brief";
  const { message, channelId } = await createCanonicalTaskThread(
    page,
    instruction,
  );
  await seedTaskRun(page, {
    channelId,
    threadId: message.id,
    mode: "delivered",
  });
  await openTaskThread(page, instruction);

  await expect(page.getByTestId("task-execution-state")).toHaveText(
    "Delivered",
  );
  await expect(page.getByTestId("task-checkpoint-row")).toContainText(
    "Draft complete and review comments incorporated.",
  );
  const deliverable = page.getByTestId("task-primary-deliverable");
  await expect(deliverable).toContainText("Reviewed launch memo");

  await page.getByTestId("task-detail-open").click();
  await expect(page.getByRole("dialog")).toContainText(TEAM_ID);
  await expect(page.getByRole("dialog")).toContainText(
    "Deliver the reviewed launch memo",
  );
  await expect(page.getByRole("dialog")).toContainText("Source notes");
  await page.keyboard.press("Escape");

  await deliverable.getByRole("button", { name: "Open in workspace" }).click();
  const workspace = page.getByTestId("channel-workspace");
  await expect(workspace).toBeVisible();
  await expect(workspace).toContainText("Read-only task evidence");
  await expect(workspace).toContainText("The reviewed launch plan is ready.");
});

test("worker-local primary evidence stays visible but cannot open on this device", async ({
  page,
}) => {
  const instruction = "prepare the local-path brief";
  const { message, channelId } = await createCanonicalTaskThread(
    page,
    instruction,
  );
  await seedTaskRun(page, {
    channelId,
    threadId: message.id,
    mode: "delivered-path",
  });
  await openTaskThread(page, instruction);

  const deliverable = page.getByTestId("task-primary-deliverable");
  await expect(deliverable).toContainText("Worker-local result");
  await expect(
    deliverable.getByRole("button", { name: "Open in workspace" }),
  ).toBeDisabled();
  await expect(page.getByTestId("task-artifact-fallback")).toContainText(
    "belongs to the worker workspace",
  );
});

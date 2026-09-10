import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";
import { STARTER_PERSONA_IDS } from "../helpers/starterTeam";

/**
 * The tickets board tile.
 *
 * What a unit test cannot prove: that the board opens from the Factory
 * toolbar into a pane, that it shows this project channel's tasks in three
 * columns rather than every task the community holds, that a card opens the
 * ticket in the right pane, and that "+ Ticket" writes a task the board then
 * lists. The scoping and column rules themselves are proven in
 * `boardModel.test.mjs`.
 */

const SHOTS = "test-results/workspace-factory-board";

/** The mock `general` channel, which is also the mock project's channel. */
const PROJECT_CHANNEL_ID = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";

const COMPANY_WORK_CONTEXT = {
  initiativeId: "horizonlabs:ship-the-board",
  taskId: "horizonlabs:chat:0001",
  owningTeamId: "company-team:abc:horizonlabs:engineering",
  qaPersonaId: "company-role:abc:horizonlabs:chief-of-staff",
  costCentreId: "cc-engineering",
  tasks: [
    {
      id: "horizonlabs:task:0100",
      title: "Wire the board tile",
      initiativeId: "horizonlabs:ship-the-board",
      status: "inProgress",
      sourceChannelId: PROJECT_CHANNEL_ID,
      assigneePersonaIds: [STARTER_PERSONA_IDS.fizz],
    },
    {
      id: "horizonlabs:task:0101",
      title: "Draft the column rules",
      initiativeId: "horizonlabs:ship-the-board",
      status: "ready",
      sourceChannelId: PROJECT_CHANNEL_ID,
    },
    // Another channel's work, to prove the board narrows rather than listing
    // every task the community holds.
    {
      id: "horizonlabs:task:0102",
      title: "Somebody else's task",
      status: "ready",
      sourceChannelId: "some-other-channel",
    },
  ],
};

const ASSIGNABLE_TEAM = {
  id: "team-board-spec",
  name: "Board spec team",
  personaIds: [STARTER_PERSONA_IDS.fizz],
};

/** Open the channel workspace, whatever surface mode the channel was left in. */
async function openWorkspace(page: Page, channelTestId: string): Promise<void> {
  const back = page.getByTestId("workspace-back-to-conversation");
  if ((await back.count()) > 0) {
    await back.first().click();
  }
  await page.getByTestId(channelTestId).click();
  const toggle = page.getByTestId("channel-workspace-toggle");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
  }
  await expect(page.getByTestId("channel-workspace")).toBeVisible();
}

async function openBoard(page: Page): Promise<void> {
  await openWorkspace(page, "channel-general");
  await page.getByTestId("workspace-create-factory").click();
  await expect(page.getByTestId("factory-canvas")).toBeVisible();
  await page.getByTestId("factory-open-board-btn").click();
  await expect(page.getByTestId("factory-board-tile")).toBeVisible();
}

test.describe("factory tickets board", () => {
  test("lists this project's tickets in three columns and opens one", async ({
    page,
  }) => {
    await installMockBridge(page, {
      companyWorkContext: COMPANY_WORK_CONTEXT,
      teams: [ASSIGNABLE_TEAM],
    });
    await page.goto("/");
    await openBoard(page);

    for (const key of ["todo", "in-progress", "done"]) {
      await expect(
        page.getByTestId(`factory-board-column-${key}`),
      ).toBeVisible();
    }

    const cards = page.getByTestId("factory-board-card");
    // The two tasks opened in this channel, and not the third.
    await expect(cards).toHaveCount(2);
    await expect(cards.filter({ hasText: "Somebody else's task" })).toHaveCount(
      0,
    );
    await expect(
      page.getByTestId("factory-board-column-in-progress"),
    ).toContainText("Wire the board tile");
    await expect(page.getByTestId("factory-board-column-todo")).toContainText(
      "Draft the column rules",
    );
    await expect(page.getByTestId("factory-board-progress-label")).toHaveText(
      "0/2 done",
    );
    // The story header names the initiative these tickets belong to.
    await expect(page.getByTestId("factory-board-story")).toHaveText(
      "Launch outbound",
    );

    // A card opens the ticket in the right pane.
    await expect(page.getByTestId("factory-board-detail")).toHaveCount(0);
    await cards.filter({ hasText: "Wire the board tile" }).click();
    const detail = page.getByTestId("factory-board-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("Wire the board tile");
    await expect(detail).toContainText("horizonlabs:task:0100");

    await waitForAnimations(page);
    await page
      .getByTestId("channel-workspace")
      .screenshot({ path: `${SHOTS}/01-board.png` });

    await page.getByTestId("factory-board-detail-close").click();
    await expect(detail).toHaveCount(0);

    // A second press focuses the board that is already open rather than
    // opening a second copy of the same tickets.
    await page.getByRole("tab", { name: "Factory" }).click();
    await page.getByTestId("factory-open-board-btn").click();
    await expect(page.getByTestId("factory-board-tile")).toHaveCount(1);
  });

  test("creating a ticket puts a card in todo", async ({ page }) => {
    await installMockBridge(page, {
      companyWorkContext: COMPANY_WORK_CONTEXT,
      teams: [ASSIGNABLE_TEAM],
    });
    await page.goto("/");
    await openBoard(page);
    await expect(page.getByTestId("factory-board-card")).toHaveCount(2);

    await page.getByTestId("factory-board-new-ticket").click();
    const dialog = page.getByTestId("new-task-dialog");
    await expect(dialog).toBeVisible();
    await page.getByTestId("new-task-title").fill("Ship the ticket pane");
    await page
      .getByTestId("new-task-assignee")
      .selectOption(STARTER_PERSONA_IDS.fizz);
    await page.getByTestId("new-task-submit").click();
    await expect(dialog).toHaveCount(0);

    await expect(page.getByTestId("factory-board-column-todo")).toContainText(
      "Ship the ticket pane",
    );
    await expect(page.getByTestId("factory-board-progress-label")).toHaveText(
      "0/3 done",
    );
  });
});

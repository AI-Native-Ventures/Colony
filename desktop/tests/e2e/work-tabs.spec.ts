import { expect, test, type Page } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

/**
 * The Tasks page and its four panes.
 *
 * Board, All tasks, and My queue were already one route behind a `view`
 * search param that only the sidebar could set, and initiatives had no
 * surface at all. What this proves is the part a unit test cannot: that each
 * tab is a real URL, that the Initiatives tab lists what the relay holds with
 * the task count charged to each one, and that creating an initiative reaches
 * the backend and comes back into the list rather than reporting success over
 * a write nobody can read.
 */

const INITIATIVE_ID = "horizonlabs:launch-outbound";
const SECOND_INITIATIVE_ID = "horizonlabs:hire-an-engineer";
const COST_CENTRE_ID = "cc-coordination";

const COMPANY_WORK_CONTEXT = {
  initiativeId: INITIATIVE_ID,
  taskId: "horizonlabs:chat:0001",
  owningTeamId: "company-team:abc:horizonlabs:company-coordination",
  qaPersonaId: "company-role:abc:horizonlabs:chief-of-staff",
  costCentreId: COST_CENTRE_ID,
};

/**
 * Two initiatives with different statuses and different task counts, so the
 * list has an order to get wrong and a count that is not the same number
 * twice.
 */
const SEEDED_LIST = {
  ...COMPANY_WORK_CONTEXT,
  initiatives: [
    {
      id: SECOND_INITIATIVE_ID,
      title: "Hire a second engineer",
      status: "proposed",
      summary: "Two people cannot cover a pager.",
    },
  ],
  tasks: [
    {
      id: "horizonlabs:task:0002",
      title: "Draft the outbound list",
      initiativeId: INITIATIVE_ID,
    },
    {
      id: "horizonlabs:task:0003",
      title: "Pick a sequencer",
      initiativeId: INITIATIVE_ID,
    },
  ],
};

type CommandPayload = { command: string; payload: unknown };

type BrokerLog = {
  actionEventIds: string[];
  receiptOutcomes: string[];
  headKinds: number[];
};

type BridgeWindow = Window & {
  __BUZZ_E2E_COMMAND_PAYLOADS__?: CommandPayload[];
  __BUZZ_E2E_MOCK_COMPANY_BROKER__?: () => BrokerLog;
};

/**
 * The bridge installs its `__BUZZ_E2E_*` globals from a lazily loaded chunk,
 * so a read taken at first paint can land before they exist. Waiting for the
 * seam here keeps that out of the polls below, which must never throw.
 */
async function waitForBridgeSeams(page: Page) {
  await page.waitForFunction(() => {
    const bridge = window as BridgeWindow;
    return (
      Array.isArray(bridge.__BUZZ_E2E_COMMAND_PAYLOADS__) &&
      typeof bridge.__BUZZ_E2E_MOCK_COMPANY_BROKER__ === "function"
    );
  });
}

async function readCommandPayloads(page: Page): Promise<CommandPayload[]> {
  return page.evaluate(
    () => (window as BridgeWindow).__BUZZ_E2E_COMMAND_PAYLOADS__ ?? [],
  );
}

async function readBrokerLog(page: Page): Promise<BrokerLog> {
  return page.evaluate(
    () =>
      (window as BridgeWindow).__BUZZ_E2E_MOCK_COMPANY_BROKER__?.() ?? {
        actionEventIds: [],
        receiptOutcomes: [],
        headKinds: [],
      },
  );
}

test("tabs switch views and update the url", async ({ page }) => {
  await installMockBridge(page, { companyWorkContext: COMPANY_WORK_CONTEXT });
  await page.goto("/#/work");

  const tabs = page.getByTestId("work-top-tabs");
  await expect(tabs).toBeVisible();
  // A bare `/work` carries no param at all, and it must still land on the
  // same pane an explicit `?view=list` does.
  await expect(page.getByTestId("work-top-tab-list")).toHaveAttribute(
    "data-state",
    "active",
  );
  await expect(page.getByTestId("task-list-page")).toBeVisible();

  await page.getByTestId("work-top-tab-board").click();
  await expect(page).toHaveURL(/view=board/);
  await expect(page.getByTestId("task-board-page")).toBeVisible();
  await expect(page.getByTestId("work-top-tab-board")).toHaveAttribute(
    "data-state",
    "active",
  );

  await page.getByTestId("work-top-tab-queue").click();
  await expect(page).toHaveURL(/view=queue/);
  await expect(page.getByTestId("task-queue-page")).toBeVisible();

  await page.getByTestId("work-top-tab-initiatives").click();
  await expect(page).toHaveURL(/view=initiatives/);
  await expect(page.getByTestId("initiatives-page")).toBeVisible();

  await page.getByTestId("work-top-tab-list").click();
  await expect(page).toHaveURL(/view=list/);
  await expect(page.getByTestId("task-list-page")).toBeVisible();
});

test("switching tabs and back keeps the board scoped to its initiative", async ({
  page,
}) => {
  await installMockBridge(page, { companyWorkContext: SEEDED_LIST });
  const scoped = new RegExp(
    `initiativeId=${encodeURIComponent(INITIATIVE_ID)}`,
  );
  await page.goto(
    `/#/work?view=board&initiativeId=${encodeURIComponent(INITIATIVE_ID)}`,
  );
  await expect(page.getByTestId("task-board-page")).toBeVisible();
  // The board titles itself with the initiative it resolved and drops the
  // "pick one" prompt, which is what proves the scope is live rather than
  // merely present in the URL.
  await expect(
    page.getByRole("heading", { name: "Launch outbound" }),
  ).toBeVisible();
  await expect(page.getByTestId("board-open-initiatives")).toHaveCount(0);

  // Every tab carries the scope, so it survives an arbitrary detour rather
  // than only a single hop out and back.
  await page.getByTestId("work-top-tab-list").click();
  await expect(page).toHaveURL(scoped);
  await page.getByTestId("work-top-tab-queue").click();
  await expect(page).toHaveURL(scoped);
  await page.getByTestId("work-top-tab-initiatives").click();
  await expect(page).toHaveURL(scoped);

  await page.getByTestId("work-top-tab-board").click();
  await expect(page).toHaveURL(scoped);
  await expect(page.getByTestId("task-board-page")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Launch outbound" }),
  ).toBeVisible();
  await expect(page.getByTestId("board-open-initiatives")).toHaveCount(0);
});

test("the board's empty prompt sends people to the Initiatives tab", async ({
  page,
}) => {
  await installMockBridge(page, { companyWorkContext: COMPANY_WORK_CONTEXT });
  // No `initiativeId`, so the board has nothing to draw and shows the prompt
  // that used to point at a sidebar list nobody could create into.
  await page.goto("/#/work?view=board");

  await expect(page.getByTestId("task-board-page")).toBeVisible();
  await page.getByTestId("board-open-initiatives").click();

  await expect(page).toHaveURL(/view=initiatives/);
  await expect(page.getByTestId("initiatives-page")).toBeVisible();
});

test("the initiatives tab lists what the relay holds, live work first", async ({
  page,
}) => {
  await installMockBridge(page, { companyWorkContext: SEEDED_LIST });
  await page.goto("/#/work?view=initiatives");

  const rows = page.getByTestId("initiative-row");
  await expect(rows).toHaveCount(2);

  // Active before proposed. Sorting on the status string would put the
  // proposed one first, which reads as an arbitrary order to anyone scanning
  // for what is running now.
  await expect(rows.nth(0).getByTestId("initiative-row-title")).toHaveText(
    "Launch outbound",
  );
  await expect(rows.nth(0).getByTestId("initiative-row-status")).toHaveText(
    "active",
  );
  await expect(rows.nth(0).getByTestId("initiative-row-task-count")).toHaveText(
    "2 tasks",
  );

  await expect(rows.nth(1).getByTestId("initiative-row-title")).toHaveText(
    "Hire a second engineer",
  );
  await expect(rows.nth(1).getByTestId("initiative-row-status")).toHaveText(
    "proposed",
  );
  await expect(rows.nth(1).getByTestId("initiative-row-task-count")).toHaveText(
    "0 tasks",
  );

  await rows.nth(0).click();
  // The router percent-encodes the colon these identifiers carry, so the
  // expectation is written against the encoded form the address bar holds.
  await expect(page).toHaveURL(
    new RegExp(`initiativeId=${encodeURIComponent(INITIATIVE_ID)}`),
  );
  await expect(page).toHaveURL(/view=board/);
  await expect(page.getByTestId("task-board-page")).toBeVisible();
});

test("an initiative with no rows offers the create affordance", async ({
  page,
}) => {
  await installMockBridge(page, {
    companyWorkContext: {
      // No `initiativeId` and no extras, so the relay holds none.
      taskId: "horizonlabs:chat:0001",
      owningTeamId: "company-team:abc:horizonlabs:company-coordination",
      qaPersonaId: "company-role:abc:horizonlabs:chief-of-staff",
      costCentreId: COST_CENTRE_ID,
    },
  });
  await page.goto("/#/work?view=initiatives");

  await expect(page.getByTestId("initiatives-empty")).toBeVisible();
  await page.getByTestId("initiatives-empty-new").click();
  await expect(page.getByTestId("new-initiative-dialog")).toBeVisible();
});

test("creating an initiative reaches the backend and lands in the list", async ({
  page,
}) => {
  await installMockBridge(page, { companyWorkContext: SEEDED_LIST });
  await page.goto("/#/work?view=initiatives");
  await waitForBridgeSeams(page);

  await expect(page.getByTestId("initiative-row")).toHaveCount(2);
  await page.getByTestId("initiatives-new").click();

  const dialog = page.getByTestId("new-initiative-dialog");
  await expect(dialog).toBeVisible();
  // The dialog focuses its title field on a 50ms timer. Filling before that
  // lands lets the timer move the caret between Playwright's focus and its
  // insert, so the next field's text is inserted into the title instead:
  // seen once in three as a title of "Open a Cape Town deskSomewhere for the
  // two of them to sit." Waiting for the focus makes the timer fire first.
  await expect(dialog.getByTestId("new-initiative-title")).toBeFocused();

  await dialog
    .getByTestId("new-initiative-title")
    .fill("Open a Cape Town desk");
  await dialog
    .getByTestId("new-initiative-summary")
    .fill("Somewhere for the two of them to sit.");

  // Both are native selects. The channel list is whatever this identity is a
  // member of, so index 1 is the first real option after the placeholder.
  const channelSelect = dialog.getByTestId("new-initiative-channel");
  await expect(channelSelect.locator("option")).not.toHaveCount(1);
  await channelSelect.selectOption({ index: 1 });
  await dialog
    .getByTestId("new-initiative-cost-centre")
    .selectOption(COST_CENTRE_ID);

  await expect(page.getByTestId("new-initiative-error")).toHaveCount(0);
  // The seeded heads are in this log too, so what the create adds is only
  // visible as a delta. Asserting the log merely contains an initiative head
  // would pass on a bridge that wrote none.
  const seededHeadKinds = (await readBrokerLog(page)).headKinds;
  const countKind = (kinds: number[], kind: number) =>
    kinds.filter((entry) => entry === kind).length;

  await dialog.getByTestId("new-initiative-submit").click();

  // The command the desktop asked the backend for, with the title a person
  // typed. Nothing downstream is evidence of this on its own: the row could
  // come from a stale cache and the dialog could close on a failure.
  await expect
    .poll(async () => {
      const payloads = await readCommandPayloads(page);
      return payloads
        .filter((entry) => entry.command === "create_initiative")
        .map((entry) => (entry.payload as { title?: string })?.title);
    })
    .toEqual(["Open a Cape Town desk"]);

  // The relay answered the owner's action and wrote one more initiative
  // head. A task head here would mean the same envelope was answered as a
  // task create, which is what left every created initiative unreadable.
  await expect
    .poll(async () => countKind((await readBrokerLog(page)).headKinds, 30180))
    .toBe(countKind(seededHeadKinds, 30180) + 1);
  const broker = await readBrokerLog(page);
  expect(countKind(broker.headKinds, 30181)).toBe(
    countKind(seededHeadKinds, 30181),
  );
  expect(broker.receiptOutcomes).toEqual(["applied"]);

  // `toBeVisible` ignores occlusion, so the dialog being gone is asserted on
  // the count rather than on anything behind it.
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const rows = page.getByTestId("initiative-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "Open a Cape Town desk" })).toHaveCount(
    1,
  );
  await expect(
    rows
      .filter({ hasText: "Open a Cape Town desk" })
      .getByTestId("initiative-row-status"),
  ).toHaveText("proposed");
});

test("a create the relay refuses keeps the dialog open and says so", async ({
  page,
}) => {
  await installMockBridge(page, {
    companyWorkContext: { ...SEEDED_LIST, refuseWith: "rejected" },
  });
  await page.goto("/#/work?view=initiatives");
  await waitForBridgeSeams(page);

  await page.getByTestId("initiatives-new").click();
  const dialog = page.getByTestId("new-initiative-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("new-initiative-title")).toBeFocused();

  await dialog.getByTestId("new-initiative-title").fill("Buy a second pager");
  await dialog.getByTestId("new-initiative-channel").selectOption({ index: 1 });
  await dialog
    .getByTestId("new-initiative-cost-centre")
    .selectOption(COST_CENTRE_ID);
  await dialog.getByTestId("new-initiative-submit").click();

  // A refusal is a durable answer, not a timeout: the dialog stays open with
  // what was typed still in it, and the list does not grow.
  await expect(page.getByTestId("new-initiative-error")).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("new-initiative-title")).toHaveValue(
    "Buy a second pager",
  );
  await expect(page.getByTestId("initiative-row")).toHaveCount(2);
});

test("an initiative read the relay refuses is shown as an error, not as an empty list", async ({
  page,
}) => {
  await installMockBridge(page, {
    // Tasks still answer. Only the kind 30180 read is refused, which is the
    // asymmetry that made this invisible: the tab was handed the tasks
    // query's state, so a refused initiative read rendered as "none yet".
    companyWorkContext: { ...SEEDED_LIST, refuseInitiativeRead: true },
  });
  await page.goto("/#/work?view=initiatives");

  await expect(page.getByTestId("initiatives-error")).toBeVisible();
  await expect(page.getByTestId("initiatives-empty")).toHaveCount(0);
  await expect(page.getByTestId("initiative-row")).toHaveCount(0);
  // The create affordance lives in the header, not in the empty state, so it
  // is still reachable when the list itself could not be read.
  await expect(page.getByTestId("initiatives-new")).toBeVisible();
});

test("the sidebar has a single Tasks row that opens the list view", async ({
  page,
}) => {
  await installMockBridge(page, { companyWorkContext: COMPANY_WORK_CONTEXT });
  await page.goto("/#/");

  const tasksRow = page.getByTestId("open-work-view");
  await expect(tasksRow).toHaveCount(1);
  await expect(tasksRow).toHaveText("Tasks");

  // The three rows and the per-initiative list the section used to carry are
  // tabs on the page now. Asserting they are gone is what stops the sidebar
  // quietly regrowing a second route into the same page.
  await expect(page.getByTestId("open-work-board")).toHaveCount(0);
  await expect(page.getByTestId("open-work-queue")).toHaveCount(0);
  await expect(page.getByTestId("open-work-board-initiative")).toHaveCount(0);
  await expect(page.getByTestId("queue-sidebar-count")).toHaveCount(0);

  await tasksRow.click();

  await expect(page.getByTestId("task-list-page")).toBeVisible();
  await expect(page.getByTestId("work-top-tab-list")).toHaveAttribute(
    "data-state",
    "active",
  );
  await expect(tasksRow).toHaveAttribute("data-active", "true");
});

import { expect, test, type Page } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

const SHOTS = "test-results/workspace-factory-delegate";

/** #general in the mock relay — the project channel the Factory tab needs. */
const GENERAL_CHANNEL_ID = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";

/** The delegate: already hired, but with no tile until Avery hands it work. */
const VERA_PUBKEY = "b".repeat(64);

const PERSONAS = [
  {
    id: "custom:avery",
    displayName: "Avery",
    roleId: "engineering-lead",
    roleTitle: "Engineering lead",
    systemPrompt: "Lead the build.",
  },
];

const MANAGED_AGENTS = [
  { pubkey: VERA_PUBKEY, name: "Vera", status: "running" as const },
];

type PublishedEvent = { id: string; content: string; tags: string[][] };

type DelegateWindow = Window & {
  __BUZZ_E2E_PUBLISHED_EVENTS__?: PublishedEvent[];
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

/**
 * Pick an option out of one of the launcher's dropdowns.
 *
 * A searchable dropdown renders its options as a listbox and a plain one as a
 * radio menu, so match either rather than guessing per field.
 */
async function chooseOption(
  page: Page,
  triggerId: string,
  optionName: string | RegExp,
): Promise<void> {
  await page.locator(`#${triggerId}`).click();
  const option = page
    .getByRole("option", { name: optionName })
    .or(page.getByRole("menuitemradio", { name: optionName }));
  await option.first().click();
  await expect(option).toHaveCount(0);
}

async function publishedEvents(page: Page): Promise<PublishedEvent[]> {
  return await page.evaluate(
    () => (window as DelegateWindow).__BUZZ_E2E_PUBLISHED_EVENTS__ ?? [],
  );
}

test.describe("factory delegation", () => {
  test("launches into its own worktree, then hands work to a second agent", async ({
    page,
  }) => {
    await installMockBridge(page, {
      personas: PERSONAS,
      managedAgents: MANAGED_AGENTS,
    });
    await page.goto("/");
    await openWorkspace(page, "channel-general");

    await page.getByTestId("workspace-create-factory").click();
    await expect(page.getByTestId("factory-canvas")).toBeVisible();

    // ── Launch Avery into a worktree of its own ──────────────────────────
    await page.getByTestId("factory-add-agent-btn").click();
    const launcher = page.getByTestId("launch-agent-dialog");
    await expect(launcher).toBeVisible();

    await chooseOption(
      page,
      "launch-agent-employee",
      "Avery · Engineering lead",
    );
    await page
      .getByTestId("launch-agent-brief-input")
      .fill("Add CSV export to the ledger.");

    // The worktree radio is the default, and the branch follows the brief
    // until someone types over it.
    const worktreeNew = page.getByTestId("launch-agent-worktree-new");
    await expect(worktreeNew).toBeChecked();
    await expect(page.getByTestId("launch-agent-worktree-branch")).toHaveValue(
      "feat/add-csv-export-to-the-ledger",
    );

    await page.getByTestId("launch-agent-submit").click();
    await expect(launcher).toHaveCount(0);

    const avery = page.getByTestId("factory-agent-tile").first();
    await expect(avery).toBeVisible();
    await expect(avery.getByTestId("agent-tile-name")).toHaveText("Avery");
    // The worktree the Rust command handed back, shown as the branch chip.
    await expect(avery.getByTestId("agent-tile-worktree-chip")).toHaveText(
      /feat-add-csv-export-to-the-ledger/,
    );

    const averyPubkey = await avery.getAttribute("data-agent-pubkey");
    expect(averyPubkey).toMatch(/^[0-9a-f]{64}$/);
    const brief = (await publishedEvents(page)).find(
      (event) => event.content === "Add CSV export to the ledger.",
    );
    expect(brief).toBeTruthy();

    // ── Delegate to Vera ─────────────────────────────────────────────────
    await avery.getByTestId("agent-tile-menu").click();
    await page.getByTestId("agent-tile-delegate-trigger").click();
    await page.getByTestId(`agent-tile-delegate-${VERA_PUBKEY}`).click();

    const delegate = page.getByTestId("delegate-agent-dialog");
    await expect(delegate).toBeVisible();
    await expect(
      page.getByTestId("delegate-agent-reply-expected"),
    ).toBeChecked();
    await page
      .getByTestId("delegate-agent-body")
      .fill("Review #684 for CSV escaping and filter parity.");
    await page.getByTestId("delegate-agent-send").click();
    await expect(delegate).toHaveCount(0);

    // ── Two panes, two tiles, one thread ─────────────────────────────────
    await expect(page.getByTestId("factory-pane")).toHaveCount(2);
    const tiles = page.getByTestId("factory-agent-tile");
    await expect(tiles).toHaveCount(2);
    const vera = page.locator(
      `[data-testid="factory-agent-tile"][data-agent-pubkey="${VERA_PUBKEY}"]`,
    );
    await expect(vera).toBeVisible();
    await expect(vera.getByTestId("agent-tile-name")).toHaveText("Vera");

    // Both cards, one per side of the same delegation.
    await expect(
      avery.getByTestId("agent-tile-delegation-card"),
    ).toHaveAttribute("data-direction", "outgoing");
    await expect(avery.getByTestId("agent-tile-delegation-card")).toContainText(
      "Delegated to Vera · reply expected",
    );
    await expect(
      vera.getByTestId("agent-tile-delegation-card"),
    ).toHaveAttribute("data-direction", "incoming");
    await expect(vera.getByTestId("agent-tile-delegation-card")).toContainText(
      "From Avery · reply expected",
    );

    // The wire: a threaded mention of Vera carrying the delegation marker.
    const delegation = (await publishedEvents(page)).find((event) =>
      event.content.startsWith("Review #684 for CSV escaping"),
    );
    expect(delegation).toBeTruthy();
    expect(delegation?.content).toContain("A reply is expected.");
    expect(
      delegation?.tags.some((tag) => tag[0] === "p" && tag[1] === VERA_PUBKEY),
    ).toBe(true);
    expect(
      delegation?.tags.some((tag) => tag[0] === "e" && tag[1] === brief?.id),
    ).toBe(true);
    expect(
      delegation?.tags.some(
        (tag) => tag[0] === "h" && tag[1] === GENERAL_CHANNEL_ID,
      ),
    ).toBe(true);
    const marker = delegation?.tags.find(
      (tag) => tag[0] === "client" && tag[1] === "colony-delegation",
    );
    expect(marker).toBeTruthy();
    expect(JSON.parse(marker?.[2] ?? "{}")).toEqual({
      from: averyPubkey,
      to: VERA_PUBKEY,
      replyExpected: true,
    });

    await waitForAnimations(page);
    await page.getByTestId("channel-workspace").screenshot({
      path: `${SHOTS}/01-delegate.png`,
    });
  });
});

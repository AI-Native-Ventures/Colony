import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

test.beforeEach(async ({ page }) => {
  await installMockBridge(page);
});

const DENTISTS_ROW_ID = "discovery-vertical-healthcare/dentists";

function autocomplete(page: import("@playwright/test").Page) {
  return page
    .getByTestId("message-composer")
    .getByTestId("mention-autocomplete");
}

async function composerText(
  page: import("@playwright/test").Page,
): Promise<string> {
  const input = page.getByTestId("message-input");
  return input.evaluate((element) => element.textContent ?? "");
}

function dentistsRow(scope: ReturnType<typeof autocomplete>) {
  return scope.getByTestId(`mention-suggestion-${DENTISTS_ROW_ID}`);
}

async function lastSendMessagePayload(
  page: import("@playwright/test").Page,
): Promise<{
  content?: string;
  referenceTags?: string[][] | null;
  mentionPubkeys?: string[] | null;
}> {
  return page.evaluate(() => {
    const log =
      (
        window as Window & {
          __BUZZ_E2E_COMMAND_PAYLOADS__?: Array<{
            command: string;
            payload: unknown;
          }>;
        }
      ).__BUZZ_E2E_COMMAND_PAYLOADS__ ?? [];
    const sends = log.filter(
      (entry) => entry.command === "send_channel_message",
    );
    const last = sends.at(-1);
    if (!last) throw new Error("no send_channel_message payload captured");
    return last.payload as {
      content?: string;
      referenceTags?: string[][] | null;
      mentionPubkeys?: string[] | null;
    };
  });
}

test("composer suggests Discovery entities and sends one structured reference", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  const input = page.getByTestId("message-input");
  await expect(input).toBeVisible();

  // Taxonomy rows come from the canonical fixture search, deterministic in
  // the e2e build with no relay.
  await input.fill("@Den");
  const dropdown = autocomplete(page);
  await expect(dropdown).toBeVisible();
  await expect(dentistsRow(dropdown)).toBeVisible();
  // The kind is disclosed so people can tell entity rows from people.
  await expect(dentistsRow(dropdown)).toContainText("Vertical");

  // Selecting inserts the readable label exactly once and closes the picker.
  await page.keyboard.press("Enter");
  await expect(dropdown).toBeHidden();
  await expect.poll(() => composerText(page)).toMatch(/@Dental Practices $/);

  await input.pressSequentially("status this week", { delay: 10 });
  await input.press("Enter");

  const payload = await lastSendMessagePayload(page);
  expect(payload.content).toContain("@Dental Practices status this week");
  const discoveryTags = (payload.referenceTags ?? []).filter(
    (tag) => tag[0] === "discovery",
  );
  expect(discoveryTags).toEqual([
    ["discovery", "vertical", "healthcare/dentists", "Dental Practices"],
  ]);
  // The entity token never becomes a notifiable recipient.
  for (const tag of payload.mentionTags ?? []) {
    void tag;
  }
  expect(payload.mentionPubkeys ?? []).toEqual([]);
});

test("discovery references survive draft reload as structured refs", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  const input = page.getByTestId("message-input");
  await input.fill("@Den");
  const dropdown = autocomplete(page);
  await expect(dropdown).toBeVisible();
  await dentistsRow(dropdown).click();
  await expect.poll(() => composerText(page)).toMatch(/@Dental Practices $/);

  // Switch away (draft saved) and back (draft restored). The visible token
  // persists AND still resolves to a structured reference on send.
  await page.getByTestId("channel-engineering").click();
  await page.getByTestId("channel-general").click();
  const restored = page.getByTestId("message-input");
  await expect(restored).toBeVisible();
  await expect.poll(() => composerText(page)).toMatch(/^@Dental Practices$/);

  await restored.pressSequentially(", status update", { delay: 10 });
  await restored.press("Enter");

  const payload = await lastSendMessagePayload(page);
  const discoveryTags = (payload.referenceTags ?? []).filter(
    (tag) => tag[0] === "discovery",
  );
  expect(discoveryTags).toEqual([
    ["discovery", "vertical", "healthcare/dentists", "Dental Practices"],
  ]);
});

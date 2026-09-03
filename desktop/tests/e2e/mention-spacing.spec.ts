import { expect, test } from "@playwright/test";
import { waitForAnimations } from "../helpers/animations";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

// An ordinary existing channel member: no discovery, invitation or runtime
// needed. Upstream uses alice; in Colony's fixture alice is a relay-directory
// agent with respond_to "owner-only" and no owner, so she is not mentionable
// without explicit directory evidence (#5681). bob is the plain human member,
// and the multi-word display name is what this case is about.
test.beforeEach(async ({ page }) => {
  await installMockBridge(page, {
    searchProfiles: [
      { pubkey: TEST_IDENTITIES.bob.pubkey, displayName: "Bob Chen" },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
});

for (const deliberateMove of [false, true]) {
  test(`multi-word mention ${deliberateMove ? "respects intentional ArrowLeft" : "preserves separator when typing immediately"}`, async ({
    page,
  }) => {
    const input = page.getByTestId("message-input");
    await input.fill("Hey @Bob");
    await page
      .getByTestId("message-composer")
      .getByTestId("mention-autocomplete")
      .getByText("Bob Chen", { exact: true })
      .click();
    if (deliberateMove) await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("hello");
    expect((await input.innerText()).trimEnd()).toBe(
      deliberateMove ? "Hey @Bob Chenhello" : "Hey @Bob Chen hello",
    );
    await waitForAnimations(page);
    await page.getByTestId("message-composer").screenshot({
      path: `test-results/mention-spacing/${deliberateMove ? "intentional-caret" : "separator"}.png`,
    });
  });
}

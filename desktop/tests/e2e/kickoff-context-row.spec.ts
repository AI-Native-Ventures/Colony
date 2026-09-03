import { expect, test } from "@playwright/test";

import { TEST_IDENTITIES, installMockBridge } from "../helpers/bridge";

// First run posts the founder's signup context, then Scout replies to it. The
// context is a handoff between two machines that happens to be addressed to a
// person, and as a full message row it put a wall of labels the founder typed
// two screens earlier above the reply written for them to read. It carries
// `["client", "colony-kickoff:context"]` from the moment it is sent, and the
// timeline renders that as one line they can open.
const KICKOFF_CONTEXT_TAG = ["client", "colony-kickoff:context"];
const CONTEXT_BODY =
  "Scout, here is the company context I confirmed during onboarding.\n\nFounder: Aisha Bello\n\nBusiness:\nIndependent workshop servicing German cars.";

async function waitForMockLiveSubscription(
  page: import("@playwright/test").Page,
  channelName: string,
) {
  await expect
    .poll(() =>
      page.evaluate(
        ({ ch }) =>
          (
            window as Window & {
              __BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?: (input: {
                channelName: string;
              }) => boolean;
            }
          ).__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({ channelName: ch }) ??
          false,
        { ch: channelName },
      ),
    )
    .toBe(true);
}

function emit(
  page: import("@playwright/test").Page,
  input: { content: string; extraTags?: string[][]; pubkey: string },
) {
  return page.evaluate((message) => {
    (
      window as Window & {
        __BUZZ_E2E_EMIT_MOCK_MESSAGE__?: (input: {
          channelName: string;
          content: string;
          extraTags?: string[][];
          pubkey: string;
        }) => unknown;
      }
    ).__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName: "engineering",
      ...message,
    });
  }, input);
}

test.describe("the founder's signup context", () => {
  test("renders as one quiet line that opens", async ({ page }) => {
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("channel-engineering").click();
    await expect(page.getByTestId("chat-title")).toHaveText("engineering");
    await waitForMockLiveSubscription(page, "engineering");

    await emit(page, {
      content: CONTEXT_BODY,
      extraTags: [KICKOFF_CONTEXT_TAG],
      pubkey: TEST_IDENTITIES.alice.pubkey,
    });

    const toggle = page.getByTestId("kickoff-context-toggle");
    await expect(toggle).toHaveText("Your signup details, sent to Scout");
    // Collapsed by design: the wall of labels is one click away, not on screen.
    await expect(page.getByTestId("kickoff-context-body")).toHaveCount(0);
    await expect(page.getByText("Independent workshop servicing")).toHaveCount(
      0,
    );

    await toggle.click();
    await expect(page.getByTestId("kickoff-context-body")).toContainText(
      "Independent workshop servicing German cars.",
    );
  });

  test("leaves an untagged message rendering as a message", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("channel-engineering").click();
    await expect(page.getByTestId("chat-title")).toHaveText("engineering");
    await waitForMockLiveSubscription(page, "engineering");

    await emit(page, {
      content: CONTEXT_BODY,
      pubkey: TEST_IDENTITIES.alice.pubkey,
    });

    await expect(
      page.getByText("Independent workshop servicing German cars."),
    ).toBeVisible();
    await expect(page.getByTestId("kickoff-context-toggle")).toHaveCount(0);
  });
});

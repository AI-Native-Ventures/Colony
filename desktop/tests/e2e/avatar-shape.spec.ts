import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

/**
 * Shape is the agent-versus-human signal: an agent's avatar is a squircle, a
 * person's stays round. It has to hold without reading a label, and it has to
 * hold at every type size, because the clip path is normalized to the box
 * rather than a radius that drifts with it (#7106, #7307).
 */
const SQUIRCLE_CLIP = 'url("#rounded-squircle-clip")';

async function readShapes(page: import("@playwright/test").Page) {
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await page.getByTestId("channel-members-trigger").click();
  await expect(page.getByTestId("members-sidebar")).toBeVisible();

  const read = async (pubkey: string) =>
    page
      .getByTestId(`sidebar-member-${pubkey}`)
      .locator("[data-avatar-shape]")
      .first()
      .evaluate((element) => {
        const styles = getComputedStyle(element);
        return {
          borderRadius: styles.borderRadius,
          clipPath: styles.clipPath,
          height: element.getBoundingClientRect().height,
        };
      });

  return {
    agent: await read(TEST_IDENTITIES.alice.pubkey),
    human: await read(TEST_IDENTITIES.bob.pubkey),
  };
}

test("an agent's message row and a person's differ in shape", async ({
  page,
}) => {
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");

  const shapes = await page
    .getByTestId("message-avatar")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.avatarShape),
    );
  // The seeded channel carries both, and the timeline is the surface a reader
  // spends their day on, so both shapes have to appear there.
  expect(shapes).toContain("squircle");
  expect(shapes).toContain("circle");
});

for (const fontSize of ["default", "larger"] as const) {
  test(`an agent row and a human row differ in shape at the ${fontSize} font size`, async ({
    page,
  }) => {
    if (fontSize === "larger") {
      await page.addInitScript(() => {
        window.localStorage.setItem("buzz.appearance.fontSize", "larger");
      });
    }
    await installMockBridge(page);
    await page.goto("/");

    const { agent, human } = await readShapes(page);

    // The agent is clipped by the shared squircle path; the human is a circle.
    expect(agent.clipPath).toBe(SQUIRCLE_CLIP);
    expect(human.clipPath).toBe("none");
    expect(human.borderRadius).not.toBe("0px");
    // Both rows still render at the same size, so the shape is the only
    // difference a reader sees.
    expect(Math.abs(agent.height - human.height)).toBeLessThanOrEqual(1);
  });
}

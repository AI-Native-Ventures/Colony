import { hexToBytes } from "@noble/hashes/utils.js";
import { expect, test } from "@playwright/test";
import { nsecEncode } from "nostr-tools/nip19";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

async function invokedCommands(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      (window as Window & { __BUZZ_E2E_COMMANDS__?: string[] })
        .__BUZZ_E2E_COMMANDS__ ?? [],
  );
}

async function openFreshMachineEntry(page: import("@playwright/test").Page) {
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");
}

test("fresh account entry defers backup and reaches community onboarding", async ({
  page,
}) => {
  await openFreshMachineEntry(page);

  await expect(
    page.getByRole("button", { name: "Start with Colony" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in to an existing account" }),
  ).toBeVisible();
  await expect(page.getByTestId("onboarding-page-backup")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create a new identity key" }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Start with Colony" }).click();

  await expect(page.getByTestId("community-choice-create")).toBeVisible();
  await expect(page.getByTestId("machine-onboarding-gate")).toHaveCount(0);
  const reminderEntries = await page.evaluate(() =>
    Object.entries(window.localStorage).filter(([key]) =>
      key.startsWith("buzz-identity-backup-reminder.v1:"),
    ),
  );
  expect(reminderEntries).toHaveLength(1);
  expect(reminderEntries[0]?.[1]).toBe("pending");

  const commands = await invokedCommands(page);
  expect(commands).toContain("get_identity");
  expect(commands).not.toContain("persist_current_identity");
  expect(commands).not.toContain("get_nsec");
  expect(commands).not.toContain("create_ncryptsec_backup");
});

test("existing-account recovery returns to community onboarding without setup screens", async ({
  page,
}) => {
  await openFreshMachineEntry(page);

  await page
    .getByRole("button", { name: "Sign in to an existing account" })
    .click();
  // The sign-in door now opens the email sign-in page first; key import sits
  // behind its private-key detour.
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await page.getByTestId("signin-use-private-key").click();
  await expect(
    page.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();
  await page
    .getByTestId("nostr-import-nsec-input")
    .fill(nsecEncode(hexToBytes(TEST_IDENTITIES.alice.privateKey)));
  await page.getByTestId("nostr-import-submit").click();

  await expect(page.getByTestId("community-choice-create")).toBeVisible();
  await expect(page.getByTestId("onboarding-page-2")).toHaveCount(0);
  await expect(page.getByTestId("onboarding-page-backup")).toHaveCount(0);
  expect(await invokedCommands(page)).toContain("import_identity");
});

import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";
import { openSettings } from "../helpers/settings";

const OUTDIR = "test-results/invites-settings";
const DIRECT_ADD_HEX =
  "ea9b4d7a7a78a3e3729e5568b14d764d4962be0e1f20f749bcf8d9dbbf9a9328";
const DIRECT_ADD_NPUB =
  "npub1a2d567n60z37xu57245tzntkf4yk90swrus0wjdulrvah0u6jv5qusyp60";

test.beforeEach(async ({ page }, testInfo) => {
  await installMockBridge(page, {
    relayRequiresMembership: true,
    relayRole: testInfo.title.includes("admin can add members")
      ? "admin"
      : "owner",
  });
  await page.route("**/api/invites", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        code: "community-email-test",
        expires_at: Math.floor(Date.now() / 1000) + 3 * 86_400,
        url: "https://alpha.example.com/invite/community-email-test",
      },
      status: 200,
    });
  });
  await page.goto("/");
  await openSettings(page, "community-members");
});

test("capture: consolidated invites settings", async ({ page }) => {
  const panel = page.getByTestId("settings-panel-community-members");

  await expect(
    page.getByTestId("settings-nav-community-members"),
  ).toContainText("Invites");
  await expect(
    page.getByRole("heading", { name: "Invites", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("community-icon-settings")).toHaveCount(0);
  await expect(
    page.getByTestId("community-invite-dialog-trigger"),
  ).toBeVisible();
  await expect(page.getByTestId("community-invite-email-field")).toHaveCount(0);
  await expect(page.getByTestId("copy-invite-link")).toHaveCount(0);
  await expect(page.getByText("alice", { exact: true })).toBeVisible();
  await expect(page.getByText("bob", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Manage roles or remove access.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("People who use the link join as members."),
  ).toHaveCount(0);
  await expect(page.getByTestId("community-icon-save")).toHaveCount(0);

  const aliceName = page.getByText("alice", { exact: true });
  const aliceRow = page
    .locator('[data-testid^="relay-member-row-"]')
    .filter({ has: aliceName });
  const aliceNpub = aliceRow.locator('[data-testid^="relay-member-npub-"]');
  await expect(aliceName).toHaveCSS("opacity", "1");
  await expect(aliceNpub).toHaveCSS("opacity", "0");
  await aliceRow.hover();
  await expect(aliceName).toHaveCSS("opacity", "0");
  await expect(aliceNpub).toHaveCSS("opacity", "1");
  await page.mouse.move(0, 0);

  await waitForAnimations(page);
  await panel.screenshot({ path: `${OUTDIR}/01-invites-settings.png` });
});

test("capture: share-style community invite dialog", async ({ page }) => {
  await page.getByTestId("community-invite-dialog-trigger").click();

  const dialog = page.getByTestId("community-invite-dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Invite to community" }),
  ).toBeVisible();
  await expect(page.getByTestId("community-invite-email-field")).toHaveCount(0);
  await expect(page.getByPlaceholder("Type an email address")).toHaveCount(0);
  await expect(
    dialog.getByText("Add someone now or create a link they can use to join."),
  ).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Add directly", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Share an invite link", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("member-pubkey-input")).toBeVisible();
  await expect(page.getByTestId("member-role-member")).toBeVisible();
  await expect(page.getByTestId("member-role-admin")).toBeVisible();
  await expect(page.getByTestId("confirm-add-member")).toBeDisabled();
  await expect(dialog.getByText("Expires after")).toBeVisible();
  await expect(dialog.getByText("Limit number of uses")).toBeVisible();
  await expect(page.getByTestId("invite-link-max-uses-trigger")).toHaveText(
    "No limit",
  );
  await expect(page.getByTestId("copy-invite-link")).toHaveText("Copy link");
  await expect(page.getByTestId("invite-link-qr-code")).toHaveCount(0);
  await expect(page.getByTestId("invite-link-url")).toHaveCount(0);

  const expiryTrigger = page.getByTestId("invite-link-ttl-trigger");
  await expect(expiryTrigger).toHaveText("3 days");
  await expect(expiryTrigger).toHaveCSS("font-size", "14px");
  await expect(
    dialog.getByText("Limit number of uses", { exact: true }),
  ).toHaveCSS("font-size", "14px");
  await expiryTrigger.click();
  await expect(page.getByRole("menu")).not.toContainText("Expires after");
  await expect(
    page.getByRole("menuitemradio", { name: "1 day" }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitemradio", { name: "30 days" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await dialog
    .getByTestId("community-invite-dialog-body")
    .evaluate((element) => element.scrollTo({ top: 0 }));
  await waitForAnimations(page);
  await dialog.screenshot({ path: `${OUTDIR}/02-invite-dialog.png` });
});

test("admin can add members but cannot assign the admin role", async ({
  page,
}) => {
  await page.getByTestId("community-invite-dialog-trigger").click();

  await expect(page.getByTestId("member-role-member")).toBeVisible();
  await expect(page.getByTestId("member-role-admin")).toHaveCount(0);
});

test("owner can add an admin directly by npub from live Invites UI", async ({
  page,
}) => {
  await page.getByTestId("community-invite-dialog-trigger").click();
  await page.getByTestId("member-pubkey-input").fill(DIRECT_ADD_NPUB);
  await page.getByTestId("member-role-admin").click();
  await page.getByTestId("confirm-add-member").click();

  await expect
    .poll(async () =>
      page.evaluate(
        ({ targetPubkey, role }) =>
          (window.__BUZZ_E2E_COMMAND_PAYLOADS__ ?? []).some((entry) => {
            if (entry.command !== "plugin:websocket|send") return false;
            const wireMessage = (
              entry.payload as {
                message?: { data?: unknown };
              }
            )?.message?.data;
            if (typeof wireMessage !== "string") return false;
            const message = JSON.parse(wireMessage) as unknown[];
            if (message[0] !== "EVENT") return false;
            const event = message[1] as
              | { kind?: number; tags?: string[][] }
              | undefined;
            return (
              event?.kind === 9030 &&
              event.tags?.some(
                (tag) => tag[0] === "p" && tag[1] === targetPubkey,
              ) &&
              event.tags.some((tag) => tag[0] === "role" && tag[1] === role)
            );
          }),
        { targetPubkey: DIRECT_ADD_HEX, role: "admin" },
      ),
    )
    .toBe(true);
});

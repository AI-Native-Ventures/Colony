import { expect, type Page } from "@playwright/test";
import { continueFounderBusiness } from "./onboarding";

/** Walk the public account form without introducing any legacy setup questions. */
export async function createFounderAccount(page: Page, email: string) {
  await expect(
    page.getByRole("heading", { name: "Create your account", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Your name", { exact: true }).fill("Horizon Owner");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill("colonyprototype");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Save your recovery code" }),
  ).toBeVisible();
  await expect(page.getByTestId("onboarding-recovery-code")).not.toBeEmpty();
}

/** The E2E auth service simulates a successful native save, never a real export. */
export async function saveFounderRecovery(page: Page) {
  await page
    .getByRole("button", { name: "Save and continue", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your business" }),
  ).toBeVisible();
}

export async function fillFounderBusiness(
  page: Page,
  businessName: string,
  description: string,
) {
  await expect(page.getByTestId("onboarding-business")).toBeVisible();
  await page.getByLabel("Business name", { exact: true }).fill(businessName);
  await page
    .getByLabel("What does your business do?", { exact: true })
    .fill(description);
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeEnabled();
}

export async function openFounderBusiness(page: Page) {
  await continueFounderBusiness(page);
  await expect(
    page.getByRole("button", { name: "Open my Colony", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Open my Colony", exact: true })
    .click();
  await expect(page.locator(".onb-canvas")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("app-top-chrome")).toBeVisible();
}

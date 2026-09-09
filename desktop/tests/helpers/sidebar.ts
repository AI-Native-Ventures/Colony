import { expect, type Page } from "@playwright/test";

/** Reach a sidebar destination through More when its secondary group is closed. */
export async function openSidebarDestination(page: Page, testId: string) {
  await expect(page.getByTestId("app-sidebar")).toBeVisible();
  const destination = page.getByTestId(testId);
  if (!(await destination.isVisible())) {
    const more = page.getByTestId("sidebar-more-nav-label");
    await expect(more).toBeVisible();
    if ((await more.getAttribute("aria-expanded")) !== "true") {
      await more.click();
    }
  }
  await destination.click();
}

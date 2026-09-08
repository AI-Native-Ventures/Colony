import type { Page } from "@playwright/test";

/** Resolve a semantic colour in Chromium, including inherited HSL tokens. */
export async function readThemeColor(
  page: Page,
  cssColor: string,
): Promise<string> {
  return page.evaluate((value) => {
    const probe = document.createElement("span");
    probe.style.color = value;
    document.documentElement.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, cssColor);
}

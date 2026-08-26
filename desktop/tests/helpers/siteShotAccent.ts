import type { Page } from "@playwright/test";

/**
 * The marketing site rolls one of five brand hues per page load, and the app
 * screenshots on it sit directly on that colour. A violet workspace on a green
 * page reads as a screenshot of some other product, so the shots are captured
 * once per hue with the accent set to that hue. The chrome follows the accent
 * (applyChromeTint in src/shared/theme/ThemeProvider.tsx), so this tints the
 * whole window, not just the selected row.
 *
 * Both are opt-in through the environment, so a normal run still produces the
 * default violet set under the original filenames:
 *
 *   SITE_SHOT_ACCENT="#2EB88A" SITE_SHOT_SUFFIX="-green" pnpm exec playwright \
 *     test tests/e2e/site-feature-screenshots.spec.ts --project=smoke
 *
 * The accent is the app's own stored preference (ACCENT_STORAGE_KEY in
 * ThemeProvider), written before the bundle boots so the workspace paints in
 * that accent from the first frame.
 */
const ACCENT_STORAGE_KEY = "buzz-accent-color";

export async function applySiteShotAccent(page: Page): Promise<void> {
  const accent = process.env.SITE_SHOT_ACCENT;
  if (!accent) return;
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [ACCENT_STORAGE_KEY, accent] as const,
  );
}

/** Filename suffix for the current accent, empty for the default set. */
export function siteShotSuffix(): string {
  return process.env.SITE_SHOT_SUFFIX ?? "";
}

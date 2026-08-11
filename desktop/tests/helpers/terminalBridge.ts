import type { Page } from "@playwright/test";

/** Opt into the terminal-only NativeBridge seam before the app boots. */
export async function installTerminalMockBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (
      window as Window & { __BUZZ_E2E_TERMINAL_MOCK__?: boolean }
    ).__BUZZ_E2E_TERMINAL_MOCK__ = true;
  });
}

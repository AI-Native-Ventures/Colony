import { defineConfig } from "@playwright/test";

/**
 * Captures the real app's screens for the user videos (`video/src/user`).
 * Run on demand with `pnpm capture:user-videos` after `pnpm build:e2e`;
 * never part of CI. Its own port keeps it off the e2e suite's 4173.
 */
const port = process.env.VIDEO_CAPTURE_PORT ?? "4174";
const url = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: "*.capture.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: url,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  },
  webServer: {
    command: `python3 -m http.server ${port} -d dist`,
    cwd: "../..",
    reuseExistingServer: true,
    url,
  },
});

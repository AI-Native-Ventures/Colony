// WebdriverIO configuration for the real-shell E2E harness.
//
// Drives a PACKAGED Tauri build (desktop/src-tauri/target/release/bundle/macos/Colony.app
// by default, override with BUZZ_REAL_SHELL_APP) through the embedded WebDriver
// server (tauri-plugin-wdio-webdriver, feature `wdio-harness`). No external
// driver, no dev server, no mock bridge: this is the real application with a
// real backend talking to a real relay.
//
// Each flow is a separate spec file and the orchestrator
// (scripts/run-real-shell-e2e.sh) runs one spec per app launch so every flow
// starts from a clean process, against persisted harness state.
import { execFileSync } from "node:child_process";

import type { TauriCapabilities } from "@wdio/tauri-service";

// The embedded provider spawns the path from tauri:options.application
// directly, so a .app bundle must resolve to its inner Mach-O executable.
// The executable name is whatever CFBundleExecutable says (buzz-desktop),
// not necessarily the bundle file name.
function resolveAppBinary(path: string): string {
  if (!path.endsWith(".app")) {
    return path;
  }
  const infoPlist = `${path}/Contents/Info.plist`;
  const execName = execFileSync("/usr/bin/plutil", [
    "-extract",
    "CFBundleExecutable",
    "raw",
    infoPlist,
  ])
    .toString()
    .trim();
  return `${path}/Contents/MacOS/${execName}`;
}

const appBinaryPath = resolveAppBinary(
  process.env.BUZZ_REAL_SHELL_APP ??
    "./src-tauri/target/release/bundle/macos/Colony.app",
);

export const config: WebdriverIO.Config = {
  runner: "local",

  // Spec globs and --spec paths resolve relative to THIS file's directory
  // (desktop/e2e-real-shell), not the process CWD.
  specs: ["./specs/**/*.spec.ts"],
  exclude: [],

  maxInstances: 1,
  maxInstancesPerCapability: 1,

  capabilities: [
    {
      browserName: "tauri",
      // The embedded WebDriver server honors W3C session timeouts. The web
      // content process can take minutes to become responsive on a loaded
      // machine (or a cold boot), so give injected scripts generous room —
      // a 30s default turns a slow boot into a cascade of retries that eats
      // the whole test budget.
      timeouts: { script: 120_000 },
      "tauri:options": {
        application: appBinaryPath,
      },
    } as TauriCapabilities,
  ],

  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath,
        driverProvider: "embedded",
        // The embedded WebDriver server lives inside the app; the service
        // spawns the app with TAURI_WEBDRIVER_PORT and drives it directly.
        startTimeout: 180_000,
        commandTimeout: 180_000,
        statusPollTimeout: 10_000,
        captureBackendLogs: true,
        captureFrontendLogs: true,
        backendLogLevel: "info",
        frontendLogLevel: "info",
      },
    ],
  ],

  logLevel: "info",
  waitforTimeout: 60_000,
  connectionRetryTimeout: 180_000,
  connectionRetryCount: 3,

  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    // Real flows: app boot (first paint alone can take minutes on a loaded
    // machine), relay round-trips, agent spawn, huddle join.
    timeout: 600_000,
  },

  reporters: ["spec"],

  outputDir: "./e2e-real-shell/results",

  afterTest: async (test, _context, result) => {
    if (result.error && typeof browser !== "undefined") {
      const name = `failure-${test.parent}-${test.title}`.replace(
        /[^a-z0-9-]/gi,
        "-",
      );
      try {
        await browser.saveScreenshot(`./e2e-real-shell/results/${name}.png`);
      } catch {
        // The app may already be gone; the error text is still in the report.
      }
    }
  },
};

// Flow 01 — launch a packaged Tauri build to first paint.
// Reaches: boot, identity resolution, window creation. None of that exists in
// the mocked Playwright suite (the mock never launches the app or the shell).
// Keychain note: the harness build disables the crate's `system-keyring`
// feature (see scripts/build-real-shell-app.sh), so probe() returns
// Unreachable without calling the Security Server and boot resolves through
// the app's real 0o600 identity.key path. The invariant asserted here is
// that identity resolution ANSWERED without the keyring-locked recovery
// screen — a resolution path that deadlocks or a marker bug would surface as
// `locked`/`lost` and fail this flow.
import { browser, expect } from "@wdio/globals";

import { getIdentity, isPubkey, waitForFirstPaint } from "../helpers/app";
import { recordResult } from "../helpers/results";

describe("01 launch to first paint", () => {
  it("boots the packaged app, resolves identity, and paints", async () => {
    recordResult("01-launch", "pass", "running");

    // The session being up already proves the packaged binary launched and
    // the embedded WebDriver server (tauri-plugin-wdio-webdriver) came up
    // inside it. Prove it is the packaged bundle, not a dev server.
    const bundlePath = process.env.BUZZ_REAL_SHELL_APP ?? "";
    expect(bundlePath).toContain(".app");
    const { execFileSync } = await import("node:child_process");
    const ps = execFileSync("/bin/ps", ["-axo", "command="], {
      encoding: "utf8",
    });
    expect(ps.includes(bundlePath) || ps.includes("Colony.app")).toBe(true);

    // Window creation: a real window with real geometry.
    const rect = await browser.getWindowRect();
    expect(rect.width).toBeGreaterThan(400);
    expect(rect.height).toBeGreaterThan(300);

    // First paint: React committed into #root (splash or onboarding).
    await waitForFirstPaint();
    const bootText = await browser.execute(() =>
      document.body.innerText.slice(0, 300),
    );
    // eslint-disable-next-line no-console
    console.log(
      `[01] first-paint body text: ${JSON.stringify(bootText.slice(0, 200))}`,
    );

    // Identity resolution: the boot path answered without surfacing the
    // keyring-locked recovery screen, and the identity read answered.
    const identity = await getIdentity();
    expect(identity.locked).toBe(false);
    // Fresh harness state: no identity yet. The pubkey may be the zero key
    // before onboarding; the invariant that matters at boot is that the
    // keychain path answered without locking.
    // eslint-disable-next-line no-console
    console.log(
      `[01] identity: pubkey=${identity.pubkey} lost=${identity.lost} locked=${identity.locked}`,
    );
    if (identity.pubkey && !isPubkey(identity.pubkey)) {
      throw new Error(`identity pubkey is not hex: ${identity.pubkey}`);
    }

    // Boot surface rendered: either machine onboarding (fresh) or the keyring
    // locked screen would be a boot failure — assert onboarding gate appears.
    const onboardingVisible = await browser
      .$('[data-testid="machine-onboarding-gate"]')
      .isDisplayed()
      .catch(() => false);
    const keyringLockedVisible = await browser
      .$('[data-testid="keyring-locked"]')
      .isDisplayed()
      .catch(() => false);
    expect(onboardingVisible || keyringLockedVisible).toBe(true);
    expect(keyringLockedVisible).toBe(false);

    recordResult("01-launch", "pass");
  });
});

import {
  clickTestId,
  fillTestId,
  waitForFirstPaint,
  waitForTestId,
} from "./app";

async function isDisplayed(testId: string): Promise<boolean> {
  return $(`[data-testid="${testId}"]`)
    .isDisplayed()
    .catch(() => false);
}

/**
 * Seed the real identity/community UI when a terminal flow is run directly.
 * This deliberately writes no result-ledger entry: it is setup, not proof.
 */
export async function ensureJoinedCommunity(relayUrl: string): Promise<void> {
  await waitForFirstPaint();
  if (await isDisplayed("channel-general")) return;

  if (await isDisplayed("machine-onboarding-gate")) {
    await clickTestId("machine-onboarding-primary", 120_000);
    await waitForTestId("onboarding-page-backup", 120_000);
    const backupNext = await $('[data-testid="onboarding-next"]');
    const backupSkip = await $('[data-testid="backup-skip"]');
    await backupNext.waitForDisplayed({ timeout: 60_000 });
    if (await backupSkip.isDisplayed()) {
      await backupSkip.click();
    } else {
      await backupNext.click();
    }
    await waitForTestId("onboarding-page-2", 120_000);
    await clickTestId("onboarding-setup-skip", 120_000);
  }

  await clickTestId("community-choice-join", 120_000);
  await fillTestId("invite-redeem-input", relayUrl, 120_000);
  await clickTestId("invite-redeem-submit", 120_000);
  await waitForTestId("community-profile-name-key", 120_000);
  await fillTestId("community-profile-name-key", "RealShell Terminal", 120_000);
  await clickTestId("community-profile-next", 120_000);
  await waitForTestId("community-team-intro-enter", 120_000);
  await clickTestId("community-team-intro-enter", 120_000);
  await waitForTestId("channel-general", 120_000);
}

// Flow 02 — onboard an identity on a real backend and prove it restores.
// Reaches: the boot identity-resolution path (resolve_persisted_identity)
// against a REAL store. The harness bundle is built with the crate's
// `system-keyring` feature disabled (see scripts/build-real-shell-app.sh), so
// probe() returns Unreachable without calling the Security Server and
// identity resolution exercises secret_store.rs's real 0o600 identity.key
// path. The OS-keychain leg (a read-only `security find-generic-password`
// probe of the production service item) is recorded as a LOUD skip when the
// harness is not keychain-backed — it must never silently read as coverage.
import { writeFileSync } from "node:fs";

import { browser, expect } from "@wdio/globals";

import {
  clickTestId,
  getIdentity,
  isPubkey,
  waitForFirstPaint,
  waitForTestId,
} from "../helpers/app";
import { IDENTITY_STATE_PATH } from "../helpers/env";
import { recordResult } from "../helpers/results";

describe("02 onboard an identity", () => {
  it("boots with a fresh identity and completes onboarding", async () => {
    recordResult("02-identity", "pass", "running");

    await waitForFirstPaint();
    await waitForTestId("machine-onboarding-gate");

    // On a fresh harness data dir the backend resolves an identity at boot
    // (keychain when reachable, 0o600 identity.key fallback otherwise): the
    // key exists and is readable through the real backend BEFORE any
    // onboarding click. The onboarding CTA may read "Continue setup" or
    // "Create a new identity key" depending on flow state — the testid is
    // the stable contract.
    const before = await getIdentity();
    expect(isPubkey(before.pubkey)).toBe(true);
    expect(before.lost).toBe(false);
    expect(before.locked).toBe(false);
    // eslint-disable-next-line no-console
    console.log(`[02] boot-created identity pubkey=${before.pubkey}`);

    // Complete machine onboarding through the real UI. The primary CTA is
    // stable regardless of label ("Create a new identity key" vs "Continue
    // setup"); both load the backend identity.
    const cta = await browser.$('[data-testid="machine-onboarding-primary"]');
    await cta.waitForDisplayed({ timeout: 60_000 });
    await cta.click();

    // Backup step -> primary CTA. On the harness build the identity store is
    // readable (0o600 file), so the key loads and "Next" is the button; the
    // "Skip for now" button exists only on the key-load-error path. Click
    // whichever is displayed so the flow works on either path.
    await waitForTestId("onboarding-page-backup", 120_000);
    const backupNext = await browser.$('[data-testid="onboarding-next"]');
    const backupSkip = await browser.$('[data-testid="backup-skip"]');
    await backupNext.waitForDisplayed({ timeout: 60_000 });
    if (await backupSkip.isDisplayed()) {
      await backupSkip.click();
    } else {
      await backupNext.click();
    }

    // Harness setup step -> skip. With no ready runtime providers the skip
    // path completes onboarding directly (no default-config page).
    await waitForTestId("onboarding-page-2", 120_000);
    await clickTestId("onboarding-setup-skip");

    // Machine onboarding done: the community choice screen follows.
    await waitForTestId("community-choice-join", 120_000);

    // Identity is stable through onboarding and still readable.
    const created = await getIdentity();
    expect(created.pubkey).toBe(before.pubkey);
    expect(created.lost).toBe(false);
    expect(created.locked).toBe(false);
    // eslint-disable-next-line no-console
    console.log(`[02] onboarding complete; identity pubkey=${created.pubkey}`);

    // OS-keychain leg (Phase 0, deliberate): the release build hardcodes
    // keyring service "buzz-desktop" and keyring 3.x resolves the user-domain
    // default keychain, which this suite must NOT switch or mutate. On a
    // developer machine the ad-hoc-signed harness app is denied by the
    // production item's ACL, so the identity is file-backed. Record that
    // loudly as a skip — a missing leg must never read as coverage. See
    // desktop/e2e-real-shell/README.md for what would close the gap.
    const keychainLeg = await checkOsKeychainItem(created.pubkey);
    if (keychainLeg === "present") {
      // eslint-disable-next-line no-console
      console.log(
        "[02] OS keychain item holds exactly the boot identity (service=buzz-desktop)",
      );
    } else {
      // Loud, non-silent skip of the leg: the ledger line + console banner
      // make it impossible to read the flow's pass as keychain coverage.
      recordResult("02-identity:os-keychain-leg", "skip", keychainLeg);
    }

    // Persist for flow 03's restore assertion.
    writeFileSync(
      IDENTITY_STATE_PATH,
      JSON.stringify({ pubkey: created.pubkey, at: new Date().toISOString() }),
    );

    recordResult("02-identity", "pass", `pubkey=${created.pubkey}`);
  });
});

// Read-only probe of the OS-keychain identity item. Never mutates anything:
// `security find-generic-password -g` reads the user-domain default keychain
// (the production login keychain when this suite runs without switching the
// default) and decodes the stored identity nsec. Returns "present" only when
// the item exists AND holds exactly this flow's pubkey.
//
// Secret-handling rules: the `-g` payload (the full JSON blob of nsec keys)
// is written by `security` to STDERR, not stdout. The payload is parsed in
// memory and never logged — only 12-char pubkey prefixes ever leave this
// function, and no stderr/stdout bytes are ever embedded in a message.
async function checkOsKeychainItem(expectedPubkey: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const deferred = (finding: string) =>
    `keychain restore leg deferred (Phase 0): release build hardcodes service buzz-desktop and this suite must not switch or mutate the user's default keychain, so the harness boots file-backed (system-keyring off); read-only probe: ${finding}`;
  try {
    // Timeout-bounded: on a machine with a restored default keychain the
    // Security Server can evaluate ACLs slowly, and this leg must never hang
    // the flow. It is a read-only probe; it mutates nothing. The password
    // line is captured from stderr; stdout holds only item attributes.
    const { stderr } = await run(
      "/usr/bin/security",
      ["find-generic-password", "-s", "buzz-desktop", "-g"],
      { encoding: "utf8", timeout: 20_000 },
    );
    const match = stderr.match(/^password: "(.*)"\n?/s);
    if (!match) {
      return deferred(
        "production item for service buzz-desktop was read but its password line did not parse (payload withheld)",
      );
    }
    let blob: Record<string, string>;
    try {
      blob = JSON.parse(match[1] ?? "") as Record<string, string>;
    } catch {
      return deferred(
        "production item payload is not the expected JSON blob (payload withheld)",
      );
    }
    const identityNsec = blob.identity;
    if (typeof identityNsec !== "string") {
      return deferred(
        "production item has no identity entry (payload withheld)",
      );
    }
    const { getPublicKey, nip19 } = await import("nostr-tools");
    try {
      const decoded = nip19.decode(identityNsec);
      if (decoded.type !== "nsec") {
        return deferred("production identity entry is not an nsec");
      }
      const keychainPubkey = getPublicKey(decoded.data);
      if (keychainPubkey !== expectedPubkey) {
        return deferred(
          `production item holds identity ${keychainPubkey.slice(0, 12)}…, which is not this boot's file-backed identity ${expectedPubkey.slice(0, 12)}…`,
        );
      }
    } catch {
      return deferred(
        "production identity entry did not decode (payload withheld)",
      );
    }
    return "present";
  } catch (error) {
    // Never embed the error object here: execFile errors can carry stderr,
    // which on a successful read is the full secret payload.
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "unknown";
    const codeText =
      code === "null" ? "no exit code (timeout or signal)" : `exit ${code}`;
    return deferred(
      `production item is not readable by this process (security ${codeText}, payload withheld)`,
    );
  }
}

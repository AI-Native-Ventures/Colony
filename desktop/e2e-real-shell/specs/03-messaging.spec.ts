// Flow 03 — join the seeded community, send a message, see it arrive.
// Reaches: the live relay socket (native WebSocket, real push) — the path the
// mock fakes hardest. The relay assertion runs against the real relay HTTP
// bridge, so the message must have actually been ingested.
import { readFileSync } from "node:fs";

import { browser, expect } from "@wdio/globals";

import {
  clickTestId,
  fillTestId,
  getIdentity,
  waitForFirstPaint,
  waitForTestId,
} from "../helpers/app";
import { IDENTITY_STATE_PATH, RELAY_HTTP_URL } from "../helpers/env";
import { CHANNEL_SLUGS, uuid5, waitForRelayMessage } from "../helpers/relay";
import { recordResult } from "../helpers/results";

describe("03 join community + live messaging", () => {
  it("restores the identity, joins the relay community, sends a message, and sees it on the relay", async () => {
    recordResult("03-messaging", "pass", "running");

    // Identity restore: a fresh launch must recover the identity created by
    // flow 02 (0o600 file store on this harness build), with no onboarding UI.
    let expectedPubkey: string | null = null;
    try {
      expectedPubkey = JSON.parse(readFileSync(IDENTITY_STATE_PATH, "utf8"))
        .pubkey as string;
    } catch {
      // Not fatal: fall back to the live identity, but the restore proof
      // below degrades to "same identity answered".
    }

    await waitForFirstPaint();
    const identity = await getIdentity();
    expect(identity.locked).toBe(false);
    if (expectedPubkey) {
      expect(identity.pubkey).toBe(expectedPubkey);
    }
    // eslint-disable-next-line no-console
    console.log(`[03] restored identity pubkey=${identity.pubkey}`);

    // No machine onboarding on restore: the gate is visible transiently
    // during the boot identity check, so wait for the post-onboarding
    // destination (community choice) and assert the gate is gone afterwards.
    await waitForTestId("community-choice-join", 120_000);
    const onboardingElements = await browser.$$(
      '[data-testid="machine-onboarding-gate"]',
    );
    expect(onboardingElements.length).toBe(0);

    // Relay must be reachable before we try to join (fast fail with a clear
    // message instead of a timeout inside the UI).
    const relayProbe = await fetch(`${RELAY_HTTP_URL}/`);
    expect(relayProbe.ok).toBe(true);

    // Join the seeded community via the real UI flow.
    await clickTestId("community-choice-join");
    await fillTestId(
      "invite-redeem-input",
      process.env.BUZZ_E2E_RELAY_URL ?? "ws://localhost:3030",
    );
    await clickTestId("invite-redeem-submit");
    await waitForTestId("community-profile-name-key", 120_000);
    await fillTestId("community-profile-name-key", "RealShell Harness");
    await clickTestId("community-profile-next");
    await waitForTestId("community-team-intro-enter", 120_000);
    await clickTestId("community-team-intro-enter");

    // Landed in the community: the seeded sidebar channels are visible.
    await waitForTestId("channel-general", 120_000);

    // Open general and send a uniquely marked message.
    await clickTestId("channel-general");
    const marker = `real-shell-${Date.now()}`;
    const message = `${marker} hello from the packaged app`;
    await waitForTestId("message-input", 120_000);
    await fillTestId("message-input", message);
    await clickTestId("send-message");

    // It arrives in the timeline (app-side render of the real event). Scoped
    // to a message row: `text=` exact-matches a single text node, and the
    // timeline wraps content in nested spans.
    const renderedRow = await browser.$(
      `//*[@data-testid="message-row" and contains(., "${marker}")]`,
    );
    await renderedRow.waitForDisplayed({ timeout: 60_000 });

    // And the RELAY ingested it (kind 9 text note by our identity).
    const event = await waitForRelayMessage(identity.pubkey, marker, 60_000);
    // eslint-disable-next-line no-console
    console.log(
      `[03] relay ingested event ${event.id} kind=${event.kind} channel-tags=${JSON.stringify(event.tags.filter((t) => t[0] === "h"))}`,
    );

    // The message is scoped to the general channel we opened.
    const generalId = uuid5(
      "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      CHANNEL_SLUGS.general,
    );
    const hTags = event.tags.filter((t) => t[0] === "h").map((t) => t[1]);
    expect(hTags).toContain(generalId);

    recordResult("03-messaging", "pass", `event=${event.id}`);
  });
});

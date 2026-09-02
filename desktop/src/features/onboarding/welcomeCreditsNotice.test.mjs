import assert from "node:assert/strict";
import test from "node:test";

import { WELCOME_KICKOFF_PROVIDER_MARKER } from "./welcomeKickoff.ts";
import {
  postZeroCreditsNoticeIfNeeded,
  WELCOME_KICKOFF_ZERO_CREDITS_MARKER,
  WELCOME_KICKOFF_ZERO_CREDITS_MESSAGE,
  welcomeKickoffNeedsCredits,
} from "./welcomeCreditsNotice.ts";

test("a zero balance on Colony Credits is spoken, never left silent", () => {
  // The credits screen has a real "Later" and there is no signup grant, so a
  // founder can land on the hosted agent with nothing in the tin. The opener
  // still posts: the desktop authors it and no model is involved. Their first
  // reply is where it breaks, because the turn reaches the relay gateway and
  // comes back 402 insufficient_credits, and the only surface that carries
  // that denial is the agent's lastError in Settings. In the channel it is
  // silence, which reads as a product that does not work.
  assert.equal(welcomeKickoffNeedsCredits("colony_credits", "0"), true);
  assert.equal(
    welcomeKickoffNeedsCredits("colony_credits", "500000000"),
    false,
  );

  // Someone paying for their own tool is not short of Colony Credits: the
  // gateway is not in their path at all.
  assert.equal(welcomeKickoffNeedsCredits("byok", "0"), false);

  // An unreadable balance says nothing. Telling a founder who has paid that
  // they have not is worse than saying nothing at all.
  assert.equal(welcomeKickoffNeedsCredits("colony_credits", null), false);
});

test("the zero-credit row names the thing to do and where to do it", () => {
  assert.match(WELCOME_KICKOFF_ZERO_CREDITS_MESSAGE, /^Scout is ready\./);
  assert.match(WELCOME_KICKOFF_ZERO_CREDITS_MESSAGE, /Billing/);
  // Its own marker, so it is posted once however many times Welcome is
  // revisited, and never confused with the provider errand.
  assert.notEqual(
    WELCOME_KICKOFF_ZERO_CREDITS_MARKER,
    WELCOME_KICKOFF_PROVIDER_MARKER,
  );
});

/** A stub io that records what the notice tried to do. */
function io({ balance = "0", markerSeen = false } = {}) {
  const sent = [];
  return {
    sent,
    readAccount: async () => ({ balance_nanousd: balance }),
    readMarker: async () => markerSeen,
    send: async (input) => {
      sent.push(input);
      return { eventId: "e".repeat(64) };
    },
  };
}

test("the row is posted once, to the channel, as the lead agent", async () => {
  const stub = io();
  await postZeroCreditsNoticeIfNeeded({
    agentPubkey: "a".repeat(64),
    channelId: "welcome",
    credentialMode: "colony_credits",
    ...stub,
  });
  assert.equal(stub.sent.length, 1);
  assert.equal(stub.sent[0].channelId, "welcome");
  assert.equal(stub.sent[0].agentPubkey, "a".repeat(64));
  assert.equal(stub.sent[0].content, WELCOME_KICKOFF_ZERO_CREDITS_MESSAGE);
  // Channel scope, so revisiting Welcome does not stack copies of it.
  assert.equal(stub.sent[0].markerScope, "channel");
});

test("nothing is posted twice, on a funded account, or on a failed read", async () => {
  const alreadyPosted = io({ markerSeen: true });
  await postZeroCreditsNoticeIfNeeded({
    agentPubkey: "a".repeat(64),
    channelId: "welcome",
    credentialMode: "colony_credits",
    ...alreadyPosted,
  });
  assert.equal(alreadyPosted.sent.length, 0);

  const funded = io({ balance: "5000000000" });
  await postZeroCreditsNoticeIfNeeded({
    agentPubkey: "a".repeat(64),
    channelId: "welcome",
    credentialMode: "colony_credits",
    ...funded,
  });
  assert.equal(funded.sent.length, 0);

  // A balance the app cannot read is not a zero balance.
  const unreadable = io();
  unreadable.readAccount = async () => {
    throw new Error("relay unreachable");
  };
  await postZeroCreditsNoticeIfNeeded({
    agentPubkey: "a".repeat(64),
    channelId: "welcome",
    credentialMode: "colony_credits",
    ...unreadable,
  });
  assert.equal(unreadable.sent.length, 0);

  // Own-tool founders never see it: the gateway is not in their path.
  const byok = io();
  await postZeroCreditsNoticeIfNeeded({
    agentPubkey: "a".repeat(64),
    channelId: "welcome",
    credentialMode: "byok",
    ...byok,
  });
  assert.equal(byok.sent.length, 0);
});

import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import {
  createScoutOnboardingRootPayload,
  scoutOnboardingRootBody,
  scoutOnboardingRootTags,
} from "./protocol.ts";
import {
  scoutSetupAcknowledgementBody,
  scoutSetupAcknowledgementTag,
} from "../channelOnboardingSetup.ts";

export const ownerSecret = new Uint8Array(32).fill(7);
export const scoutSecret = new Uint8Array(32).fill(8);
export const relaySecret = new Uint8Array(32).fill(9);
export const ownerPubkey = getPublicKey(ownerSecret);
export const scoutPubkey = getPublicKey(scoutSecret);
export const relayPubkey = getPublicKey(relaySecret);
export const approvalRequestId = "11111111-1111-4111-8111-111111111111";
export const secondApprovalRequestId = "22222222-2222-4222-8222-222222222222";
export const channelId = "welcome";
export const relayUrl = "wss://example.test";
export const signupRequestId = "signup-1";
export const expectedHeadEventId = "b".repeat(64);

const rootScope = {
  ownerPubkey,
  relayUrl,
  channelId,
  requestId: signupRequestId,
  threadRootId: "0".repeat(64),
};

export const rootPayload = createScoutOnboardingRootPayload(rootScope, {
  ownerName: "Ari",
  ownerNote: "Keep the first conversation practical.",
  businessName: "Acme Repairs",
  businessDescription: "A local repair service.",
  website: "",
  websiteState: "none",
});

export const rootEvent = finalizeEvent(
  {
    kind: 9,
    content: scoutOnboardingRootBody(rootPayload),
    tags: scoutOnboardingRootTags(rootPayload),
    created_at: 1_700_000_000,
  },
  ownerSecret,
);

export const scope = Object.freeze({
  ...rootScope,
  threadRootId: rootEvent.id,
});

export const setupInput = Object.freeze({
  route: "existing",
  summary: Object.freeze({
    route: "existing",
    person: "Ari",
    businessOrIdea: "Acme Repairs",
    priority: "Serve existing customers",
    priorityId: "customers",
    unknowns: Object.freeze(["What source or access Scout may use"]),
    website: null,
    websiteState: "none",
    location: "Johannesburg",
  }),
  setupName: "Acme Repairs",
  setupDescription: "A local repair service for existing customers.",
});

export const currentProfile = Object.freeze({
  schema: "colony.company/v1",
  tradingName: "Old Acme",
  legalName: "Acme Repairs Proprietary Limited",
  website: "https://old-acme.example",
  summary: "Old profile context",
  businessType: "service",
  services: [{ id: "repairs", name: "Repairs", description: "Repair work" }],
  customerSegments: ["local customers"],
  costCentres: [
    { id: "repairs", name: "Repairs", kind: "service", serviceId: "repairs" },
  ],
  sourceReportEventId: null,
  createdAt: 1_699_000_000,
  updatedAt: 1_699_000_001,
});

export const profileTarget = `30179:${relayPubkey}:profile`;
export const idempotencyKey = "33333333-3333-4333-8333-333333333333";

export function signCompanyAction(profile, requestId = approvalRequestId) {
  const content = JSON.stringify({
    schema: "colony.company-action/v1",
    operation: "update",
    expectedHead: expectedHeadEventId,
    expectedReferences: [],
    payload: { kind: "company", record: profile },
  });
  return finalizeEvent(
    {
      kind: 40013,
      content,
      tags: [
        ["p", relayPubkey],
        ["a", profileTarget],
        ["company-action", "1", "update", requestId, idempotencyKey],
      ],
      created_at: 1_700_000_100,
    },
    ownerSecret,
  );
}

export function signedAcknowledgement(
  input = setupInput,
  requestId = approvalRequestId,
) {
  return finalizeEvent(
    {
      kind: 9,
      content: scoutSetupAcknowledgementBody(input),
      tags: [
        ["h", channelId],
        ["p", scoutPubkey],
        ["e", rootEvent.id, "", "reply"],
        scoutSetupAcknowledgementTag(input, requestId),
      ],
      created_at: 1_700_000_200,
    },
    ownerSecret,
  );
}

export function signedReply(acknowledgementEventId, secret = scoutSecret) {
  return finalizeEvent(
    {
      kind: 9,
      content: "Scout confirms the approved context is ready in Welcome.",
      tags: [
        ["h", channelId],
        ["e", rootEvent.id, "", "root"],
        ["e", acknowledgementEventId, "", "reply"],
      ],
      created_at: 1_700_000_400,
    },
    secret,
  );
}

export function runtimeStatus() {
  return {
    pubkey: scoutPubkey,
    relayUrl,
    localSetup: true,
    lifecycle: "ready",
    pid: null,
    error: null,
    logPath: null,
  };
}

export function appliedReceipt(actionEventId, requestId = approvalRequestId) {
  return {
    receiptEventId: "d".repeat(64),
    actionEventId,
    requestId,
    headEventId: "e".repeat(64),
    target: profileTarget,
  };
}

export function clone(value) {
  return structuredClone(value);
}

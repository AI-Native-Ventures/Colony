import type { RelayEvent } from "@/shared/api/types";

/** Synthetic transport proof for mock-mode onboarding; never used by native runs. */
export function emitOnboardingResponse(
  input: {
    channelId: string;
    content: string;
    mentionPubkeys?: string[];
    clientTags?: string[][] | null;
  },
  requestId: string,
  ownerPubkey: string,
  emit: (channelId: string, event: RelayEvent) => void,
) {
  if (
    !input.clientTags?.some((t) => t[1] === "colony:onboarding-response-test")
  )
    return;
  const pubkey = input.mentionPubkeys?.[0];
  const nonce = input.content.match(/verification code: ([a-f0-9-]+)/)?.[1];
  if (!pubkey || !nonce) return;
  const turnId = crypto.randomUUID();
  const event = (
    kind: number,
    content: string,
    tags: string[][],
  ): RelayEvent => ({
    id: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
    pubkey,
    kind,
    content,
    tags,
    created_at: Math.floor(Date.now() / 1000),
    sig: "0".repeat(128),
  });
  for (const [kind, payload] of [
    ["turn_started", { triggeringEventIds: [requestId] }],
    ["acp_read", { result: { stopReason: "end_turn" } }],
    ["turn_completed", {}],
  ])
    emit(
      input.channelId,
      event(
        24200,
        JSON.stringify({ kind, payload, channelId: input.channelId, turnId }),
        [
          ["agent", pubkey],
          ["p", ownerPubkey],
          ["h", input.channelId],
        ],
      ),
    );
  emit(
    input.channelId,
    event(9, `Hello! I'm ready to help. ${nonce}`, [
      ["h", input.channelId],
      ["e", requestId],
    ]),
  );
}

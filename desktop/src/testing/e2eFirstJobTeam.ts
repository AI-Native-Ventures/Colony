import type { AgentProposalSafeAction } from "@/features/blocks/agentProposal";
import type { RelayEvent } from "@/shared/api/types";

/** UI fixture for native staffing. This does not run a process or prove native isolation. */
export async function prepareFirstJobTeamFixture(
  payload: { action: AgentProposalSafeAction; communityRelayUrl: string },
  deps: {
    owner: string;
    find(definitionId: string): { pubkey: string } | undefined;
    create(action: AgentProposalSafeAction): Promise<{ pubkey: string }>;
    addMembers(channelId: string, pubkeys: string[]): Promise<unknown>;
    sign(template: {
      kind: number;
      content: string;
      tags: string[][];
    }): Promise<RelayEvent>;
    publishHead(event: RelayEvent): void;
  },
) {
  const { action } = payload;
  const p = action.preparation;
  if (
    !p ||
    p.ownerPubkey !== deps.owner ||
    p.communityRelayUrl !== payload.communityRelayUrl
  )
    throw Error(
      "The first-job fixture received a different owner or business.",
    );
  const existing = deps.find(action.requestId);
  const worker = existing ?? (await deps.create(action));
  await deps.addMembers(p.channelId, [p.leaderPubkey, worker.pubkey]);
  for (const [pubkey, tier] of [
    [p.leaderPubkey, "executive"],
    [worker.pubkey, "worker"],
  ]) {
    const event = await deps.sign({
      kind: 30177,
      content: JSON.stringify({
        name:
          pubkey === worker.pubkey ? action.definition.displayName : "Scout",
        tier,
      }),
      tags: [
        ["d", pubkey],
        ...(tier === "worker" ? [["manager", p.leaderPubkey]] : []),
      ],
    });
    deps.publishHead(event);
  }
  return {
    status: "applied",
    definition_id: action.requestId,
    agent_pubkey: worker.pubkey,
    recovered: !!existing,
  };
}

import type { AcpRuntime, ManagedAgent } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import {
  getErrorMessage,
  isManagedAgentRunning,
  isProviderBackedAgent,
  uniqueNormalizedPubkeys,
} from "./useMentionSendFlow.helpers";

type AsyncMutation<TInput> = {
  mutateAsync: (input: TInput) => Promise<unknown>;
};

export async function loadManagedAgentsByPubkey(
  data: ManagedAgent[] | undefined,
  refetch: () => Promise<{ data?: ManagedAgent[] }>,
): Promise<Map<string, ManagedAgent>> {
  const agents = data ?? (await refetch()).data ?? [];
  return new Map(
    agents.map((agent) => [normalizePubkey(agent.pubkey), agent]),
  );
}

export type ManagedMentionReadinessInput = {
  mentionPubkeys: readonly string[];
  capturedChannelId: string;
  preparedParticipantPubkeys?: readonly string[];
  preparedManagedAgents?: readonly ManagedAgent[];
  memberPubkeys: readonly string[];
  getManagedAgentsByPubkey: () => Promise<Map<string, ManagedAgent>>;
  attachAgentMutation: AsyncMutation<{
    channelId: string;
    agent: ManagedAgent;
    role: "bot";
  }>;
  startAgentMutation: AsyncMutation<string>;
};

export async function loadAvailableMentionRuntimes(
  data: AcpRuntime[] | undefined,
  isLoading: boolean,
  refetch: () => Promise<{ data?: AcpRuntime[] }>,
): Promise<AcpRuntime[]> {
  const cached = data ?? [];
  if (cached.length > 0 || !isLoading) return cached;
  const refetched = await refetch();
  return (refetched.data ?? []).filter(
    (runtime): runtime is AcpRuntime =>
      runtime.availability === "available" &&
      runtime.command !== null &&
      runtime.binaryPath !== null,
  );
}

/** Ensure known managed mentions are joined and running before send. */
export async function ensureManagedAgentMentionsReady({
  mentionPubkeys,
  capturedChannelId,
  preparedParticipantPubkeys = [],
  preparedManagedAgents = [],
  memberPubkeys,
  getManagedAgentsByPubkey,
  attachAgentMutation,
  startAgentMutation,
}: ManagedMentionReadinessInput): Promise<{
  errors: string[];
  pubkeys: string[];
}> {
  if (!capturedChannelId || mentionPubkeys.length === 0) {
    return { errors: [], pubkeys: [] };
  }
  const managedAgentsByPubkey = await getManagedAgentsByPubkey();
  for (const agent of preparedManagedAgents) {
    managedAgentsByPubkey.set(agent.pubkey.trim().toLowerCase(), agent);
  }
  const participantPubkeys = new Set([
    ...memberPubkeys,
    ...preparedParticipantPubkeys.map((pubkey) => pubkey.trim().toLowerCase()),
  ]);
  const errors: string[] = [];
  const pubkeys: string[] = [];
  for (const pubkey of uniqueNormalizedPubkeys([...mentionPubkeys])) {
    const agent = managedAgentsByPubkey.get(pubkey);
    if (!agent) continue;
    try {
      if (participantPubkeys.has(pubkey)) {
        if (isProviderBackedAgent(agent)) {
          if (agent.status !== "deployed") {
            await startAgentMutation.mutateAsync(agent.pubkey);
          }
        } else if (!isManagedAgentRunning(agent)) {
          await startAgentMutation.mutateAsync(agent.pubkey);
        }
      } else {
        await attachAgentMutation.mutateAsync({
          channelId: capturedChannelId,
          agent,
          role: "bot",
        });
      }
      pubkeys.push(pubkey);
    } catch (error) {
      errors.push(
        `${agent.name}: ${getErrorMessage(error, "Could not prepare agent.")}`,
      );
    }
  }
  return { errors, pubkeys: uniqueNormalizedPubkeys(pubkeys) };
}

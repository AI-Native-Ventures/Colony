import { resolvePersonaRuntime } from "@/features/agents/lib/resolvePersonaRuntime";
import type { CreateChannelManagedAgentInput } from "@/features/agents/hooks";
import type { AcpRuntime, ChannelType, ManagedAgent } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import type { PersonaMentionTarget } from "@/features/messages/lib/mentionHelpers";
import {
  getErrorMessage,
  uniqueNormalizedPubkeys,
} from "./useMentionSendFlow.helpers";

type PersonaAgentMutation = {
  mutateAsync: (
    input: CreateChannelManagedAgentInput & { channelId: string },
  ) => Promise<{ agent: ManagedAgent }>;
};

export type CreateMentionedPersonaAgentsResult = {
  agents: ManagedAgent[];
  errors: string[];
  pubkeys: string[];
};

/**
 * Create (or provision, in a DM) one managed agent per distinct persona
 * mentioned in the draft, registering each new pubkey against the display name
 * that named it.
 *
 * Split out of `useMentionSendFlow` for the desktop file-size ratchet; the hook
 * keeps the callback and its dependency list.
 */
export async function createMentionedPersonaAgentsWith(
  trimmed: string,
  capturedChannelId: string,
  deps: {
    channelType: ChannelType | null | undefined;
    createPersonaAgentMutation: PersonaAgentMutation;
    extractMentionPersonas: (text: string) => PersonaMentionTarget[];
    getAvailableRuntimes: () => Promise<AcpRuntime[]>;
    onPrepareSendChannel?: unknown;
    provisionPersonaAgentMutation: PersonaAgentMutation;
    registerMentionPubkey: (
      displayName: string,
      pubkey: string,
      options?: { isAgent?: boolean },
    ) => void;
  },
): Promise<CreateMentionedPersonaAgentsResult> {
  const {
    channelType,
    createPersonaAgentMutation,
    extractMentionPersonas,
    getAvailableRuntimes,
    onPrepareSendChannel,
    provisionPersonaAgentMutation,
    registerMentionPubkey,
  } = deps;
  const personaMentions = extractMentionPersonas(trimmed);
  if (!capturedChannelId || personaMentions.length === 0) {
    return {
      errors: [] as string[],
      agents: [] as ManagedAgent[],
      pubkeys: [] as string[],
    };
  }
  const runtimes = await getAvailableRuntimes();
  const defaultRuntime = runtimes[0] ?? null;
  const errors: string[] = [];
  const agents: ManagedAgent[] = [];
  const pubkeys: string[] = [];
  const seenPersonaIds = new Set<string>();
  const shouldProvisionForDm =
    channelType === "dm" && Boolean(onPrepareSendChannel);
  for (const { displayName, persona } of personaMentions) {
    if (seenPersonaIds.has(persona.id)) {
      continue;
    }
    seenPersonaIds.add(persona.id);
    const { runtime } = resolvePersonaRuntime(
      persona.runtime,
      runtimes,
      defaultRuntime,
    );
    if (!runtime) {
      errors.push(`${displayName}: No agent runtime available.`);
      continue;
    }
    try {
      const input: CreateChannelManagedAgentInput & {
        channelId: string;
      } = {
        channelId: capturedChannelId,
        runtime,
        name: persona.displayName,
        personaId: persona.id,
        systemPrompt: persona.systemPrompt,
        avatarUrl: persona.avatarUrl ?? undefined,
        model: persona.model ?? undefined,
        role: "bot",
        ensureRunning: true,
      };
      const result = shouldProvisionForDm
        ? await provisionPersonaAgentMutation.mutateAsync(input)
        : await createPersonaAgentMutation.mutateAsync(input);
      const pubkey = normalizePubkey(result.agent.pubkey);
      agents.push(result.agent);
      pubkeys.push(pubkey);
      registerMentionPubkey(displayName, pubkey, {
        isAgent: true,
      });
    } catch (error) {
      errors.push(
        `${displayName}: ${getErrorMessage(error, "Could not create agent.")}`,
      );
    }
  }
  return {
    agents,
    errors,
    pubkeys: uniqueNormalizedPubkeys(pubkeys),
  };
}

import type { AgentProposalSafeAction } from "@/features/blocks/agentProposal";
import { invokeTauri } from "@/shared/api/tauri";

type RawAgentProposalExecutionOutcome =
  | {
      status: "applied";
      definition_id: string;
      agent_pubkey: string;
      recovered: boolean;
    }
  | {
      status: "failed";
      safe_message: string;
    };

export type AgentProposalExecutionOutcome =
  | {
      status: "applied";
      definitionId: string;
      agentPubkey: string;
      recovered: boolean;
    }
  | { status: "failed"; safeMessage: string };

/**
 * Execute an already-accepted Agent Proposal action.
 *
 * Provider credentials travel only in `backendConfig`, the trusted local IPC
 * argument. They are never added to the signed action or returned result.
 */
export async function executeAgentProposal(
  action: AgentProposalSafeAction,
  communityRelayUrl: string,
  backendConfig?: Record<string, unknown>,
): Promise<AgentProposalExecutionOutcome> {
  const result = await invokeTauri<RawAgentProposalExecutionOutcome>(
    "execute_agent_proposal",
    {
      action,
      backendConfig: backendConfig ?? null,
      communityRelayUrl,
    },
  );
  return result.status === "applied"
    ? {
        status: "applied",
        definitionId: result.definition_id,
        agentPubkey: result.agent_pubkey,
        recovered: result.recovered,
      }
    : { status: "failed", safeMessage: result.safe_message };
}

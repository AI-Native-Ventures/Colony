import { getChannelMembers, listManagedAgents } from "@/shared/api/tauri";
import { listManagedAgentRuntimes } from "@/shared/api/tauriManagedAgents";
import type {
  ManagedAgent,
  ManagedAgentRuntimeStatus,
} from "@/shared/api/types";

import { WELCOME_GUIDE_PERSONA_ID, WELCOME_TEAM_ID } from "../welcomeGuide";
import { runtimeIsUsable } from "./attempt";

/** Current local identity and lifecycle evidence for the approved Scout. */
export type ScoutLiveRuntime = {
  agent: Pick<ManagedAgent, "pubkey" | "relayUrl" | "teamId" | "personaId">;
  status: ManagedAgentRuntimeStatus;
};

/** Read current managed Scout identity, membership, and runtime lifecycle. */
export async function defaultReadScoutRuntime(
  scoutPubkey: string,
  relayUrl: string,
  welcomeChannelId: string,
): Promise<ScoutLiveRuntime | null> {
  const [agents, runtimes, members] = await Promise.all([
    listManagedAgents(),
    listManagedAgentRuntimes(),
    getChannelMembers(welcomeChannelId),
  ]);
  const normalizedScoutPubkey = scoutPubkey.toLowerCase();
  const matchingAgents = agents.filter(
    (agent) =>
      agent.pubkey.toLowerCase() === normalizedScoutPubkey &&
      agent.relayUrl === relayUrl &&
      agent.teamId === WELCOME_TEAM_ID &&
      agent.personaId === WELCOME_GUIDE_PERSONA_ID,
  );
  if (matchingAgents.length !== 1) return null;
  const [agent] = matchingAgents;
  if (
    !agent ||
    !members.some(
      (member) => member.pubkey.toLowerCase() === normalizedScoutPubkey,
    )
  ) {
    return null;
  }
  const matchingRuntimes = runtimes.filter(
    (runtime) =>
      runtime.pubkey.toLowerCase() === normalizedScoutPubkey &&
      runtime.relayUrl === relayUrl,
  );
  if (matchingRuntimes.length !== 1) return null;
  const [status] = matchingRuntimes;
  if (!status?.localSetup) return null;
  if (!runtimeIsUsable(status, scoutPubkey, relayUrl)) return null;
  return { agent, status };
}

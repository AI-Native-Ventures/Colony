/**
 * Display-only stage team fallback.
 *
 * The canonical record names an agent for a stage only once evidence does
 * (`deriveWebsiteStageAgents`: coordinator, `builtBy`, `qa.reviewer`). Until
 * then the job surface shows the installed website team member whose persona
 * carries the stage's role id, resolved through the same managed-agent and
 * persona join message rows use. This module never writes those identities
 * into the record and never overrides a canonical pubkey; callers use it only
 * when `deriveWebsiteStageAgents` has no entry for the stage.
 */

import * as React from "react";

import {
  useManagedAgentsQuery,
  usePersonasQuery,
} from "@/features/agents/hooks";
import {
  buildPersonaNameByPubkey,
  buildPersonaRoleById,
  buildPersonaRoleByPubkey,
} from "@/features/messages/lib/mentionPersonaLookups";
import type { AgentPersona, ManagedAgent } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

/** Stable persona role ids owned by the bundled website team recipe. */
const STAGE_ROLE_IDS: ReadonlyArray<{ stageId: string; roleId: string }> = [
  { stageId: "research", roleId: "website-researcher" },
  { stageId: "design-build", roleId: "website-designer-builder" },
  { stageId: "independent-review", roleId: "website-reviewer" },
];

export type WebsiteStageTeam = {
  /** Stage definition id to pubkey, for display fallback only. */
  stageAgents: Readonly<Record<string, string>>;
  /** Personal names for team members that may lack a kind-0 profile. */
  namesByPubkey: ReadonlyMap<string, string>;
};

export function deriveWebsiteStageTeam(input: {
  agents: readonly ManagedAgent[] | undefined;
  personas: readonly AgentPersona[] | undefined;
}): WebsiteStageTeam {
  const personaRoleById = buildPersonaRoleById(input.personas);
  const roleByPubkey = buildPersonaRoleByPubkey(input.agents, personaRoleById);
  const personaNameByPubkey = buildPersonaNameByPubkey(
    input.agents,
    input.personas,
  );
  const namesByPubkey = new Map<string, string>();
  for (const agent of input.agents ?? []) {
    const pubkey = normalizePubkey(agent.pubkey);
    const name = personaNameByPubkey.get(pubkey) ?? agent.name.trim();
    if (name) namesByPubkey.set(pubkey, name);
  }
  const byRoleId = new Map<string, string>();
  for (const [pubkey, role] of roleByPubkey) {
    if (!byRoleId.has(role.roleId)) byRoleId.set(role.roleId, pubkey);
  }
  const stageAgents: Record<string, string> = {};
  for (const { stageId, roleId } of STAGE_ROLE_IDS) {
    const pubkey = byRoleId.get(roleId);
    if (pubkey) stageAgents[stageId] = pubkey;
  }
  return { stageAgents, namesByPubkey };
}

/** Community-scoped installed team, keyed by the stage it can cover. */
export function useWebsiteStageTeam(): WebsiteStageTeam {
  const agents = useManagedAgentsQuery().data;
  const personas = usePersonasQuery().data;
  return React.useMemo(
    () => deriveWebsiteStageTeam({ agents, personas }),
    [agents, personas],
  );
}

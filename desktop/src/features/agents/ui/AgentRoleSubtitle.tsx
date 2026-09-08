import { agentRoleLabel } from "../agentIdentityPresentation";
import { useAgentRoleTitles } from "../useKnownAgentPubkeys";
import { normalizePubkey } from "@/shared/lib/pubkey";

/** A compact job label beneath an authenticated agent's personal name. */
export function AgentRoleSubtitle({ pubkey }: { pubkey?: string }) {
  const roles = useAgentRoleTitles();
  return (
    <span
      className="basis-full text-xs font-normal leading-5 text-muted-foreground"
      data-testid="message-agent-role"
    >
      {agentRoleLabel(roles.get(normalizePubkey(pubkey ?? "")))}
    </span>
  );
}

import { toast } from "sonner";

import { isManagedAgentActive } from "@/features/agents/lib/managedAgentControlActions";
import type { ManagedAgent } from "@/shared/api/types";

/** Start one agent, reporting both outcomes as a toast. */
type StartAgent = (
  pubkey: string,
  options: { onSuccess: () => void; onError: (error: unknown) => void },
) => void;

/**
 * Offer to start an agent that was saved while it was not running.
 *
 * The auto-restart policy deliberately never fires for a stopped or failing
 * agent (a broken agent must not auto-loop), so an edit meant to FIX one
 * silently waits for a manual start. Offer that start explicitly instead of
 * relying on the user to know the policy.
 */
export function offerStartAfterSave(agent: ManagedAgent, start: StartAgent) {
  if (isManagedAgentActive(agent)) return;
  const startedName = agent.name;
  toast(`${startedName} saved while stopped.`, {
    action: {
      label: "Start now",
      onClick: () => {
        start(agent.pubkey, {
          onSuccess: () => toast.success(`${startedName} started.`),
          onError: (error) =>
            toast.error(
              error instanceof Error
                ? `${startedName} failed to start: ${error.message}`
                : `${startedName} failed to start.`,
            ),
        });
      },
    },
  });
}

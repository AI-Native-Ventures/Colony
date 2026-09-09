import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { getAgentModels } from "@/shared/api/tauri";
import { useRelayOrigin } from "@/shared/lib/useRelayOrigin";
import {
  replyModelOptions,
  replyModelTag,
  type ReplyModelSelection,
} from "../lib/replyModelSelection";

/** Local draft setting for the next reply from one explicitly selected teammate. */
export function useReplyModelSelection(input: {
  scope: string | null | undefined;
  enabled: boolean;
  recipientPubkeys: readonly string[];
}) {
  const relayUrl = useRelayOrigin();
  const agents = useManagedAgentsQuery({ enabled: input.enabled });
  const targets = (agents.data ?? []).filter((agent) =>
    input.recipientPubkeys.includes(agent.pubkey),
  );
  const [chosenTarget, setChosenTarget] = React.useState("");
  const target =
    targets.find((agent) => agent.pubkey === chosenTarget) ??
    (targets.length === 1 ? targets[0] : undefined);
  const [opened, setOpened] = React.useState(false);
  const [selection, setSelection] = React.useState<ReplyModelSelection | null>(
    null,
  );
  const scopeKey = `${relayUrl}:${input.scope ?? ""}:${target?.pubkey ?? ""}`;
  const previousScope = React.useRef(scopeKey);
  // Clear only a local unsent choice when the actual conversation/recipient changes.
  if (previousScope.current !== scopeKey) {
    previousScope.current = scopeKey;
    setSelection(null);
  }
  const discovery = useQuery({
    queryKey: ["reply-models", relayUrl, input.scope, target?.pubkey],
    queryFn: () => getAgentModels(target?.pubkey ?? "", true),
    enabled: input.enabled && opened && !!target,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 0,
    gcTime: 0,
  });
  const models = replyModelOptions(discovery.data?.models ?? []);
  const modelIds = models.map((model) => model.id);
  const capture = React.useCallback((): string[] | undefined | null => {
    try {
      return replyModelTag(
        selection,
        input.recipientPubkeys,
        discovery.data?.models.map((model) => model.id) ?? [],
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return null;
    }
  }, [selection, input.recipientPubkeys, discovery.data]);
  const afterSend = React.useCallback((tag: string[]) => {
    setSelection((current) =>
      current?.targetPubkey === tag[2] && current.modelId === tag[3]
        ? null
        : current,
    );
  }, []);
  return {
    visible: input.enabled && targets.length > 0,
    targets,
    target,
    selectTarget: setChosenTarget,
    open: () => setOpened(true),
    opened,
    loading: discovery.isFetching,
    error: discovery.isError
      ? `Model choices could not be loaded. ${discovery.error instanceof Error ? discovery.error.message : "Try again."}`
      : null,
    retry: () => void discovery.refetch(),
    supported: discovery.data?.supportsSwitching === true && models.length > 0,
    models,
    modelIds,
    selection,
    choose: (modelId: string) =>
      setSelection(
        target && modelId ? { targetPubkey: target.pubkey, modelId } : null,
      ),
    capture,
    afterSend,
  };
}
export type ReplyModelSelectionControl = ReturnType<
  typeof useReplyModelSelection
>;

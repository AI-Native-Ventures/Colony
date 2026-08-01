import * as React from "react";

import { useCommunities } from "@/features/communities/useCommunities";
import type { TimelineMessage } from "@/features/messages/types";
import {
  isAuthorizedBlockReceipt,
  parseBlockAction,
  parseBlockInstance,
  parseBlockReceipt,
} from "@/features/blocks/blockTags";
import type { BlockNode } from "@/features/blocks/contracts";
import { replayQueuedQuestionActions } from "@/features/blocks/blockActionQueue";
import { submitBlockAction } from "@/features/blocks/blockActions";
import { useBlockData, useBlockManifest } from "@/features/blocks/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import { useRelayConnection } from "@/shared/api/useRelayConnection";
import type { RelayEvent } from "@/shared/api/types";

import { BlockFallback, type BlockFallbackState } from "./BlockFallback";
import { BlockRenderer } from "./BlockRenderer";

export type BlockActionViewState = {
  completedActionIds: ReadonlySet<string>;
  pendingActionId?: string;
  latestStatus?: "pending" | "succeeded" | "denied" | "failed" | "timed-out";
  latestAttentionStatus?: "succeeded" | "denied";
};

function compareRelayEvents(left: RelayEvent, right: RelayEvent): number {
  return left.created_at - right.created_at || left.id.localeCompare(right.id);
}

export function deriveBlockActionViewState(
  message: Pick<TimelineMessage, "id" | "blockEvent" | "blockState">,
  instanceId: string,
  manifestId: string,
): BlockActionViewState {
  const actions = (message.blockState?.actions ?? [])
    .map((event) => ({ event, parsed: parseBlockAction(event.tags) }))
    .filter(
      (
        item,
      ): item is {
        event: RelayEvent;
        parsed: Extract<ReturnType<typeof parseBlockAction>, { ok: true }>;
      } =>
        item.parsed.ok &&
        item.parsed.value.instanceEventId === message.id &&
        item.parsed.value.instanceId === instanceId &&
        item.parsed.value.manifestId === manifestId,
    )
    .sort((left, right) => compareRelayEvents(left.event, right.event));
  const actionsById = new Map(actions.map((item) => [item.event.id, item]));

  const receipts = (message.blockState?.receipts ?? [])
    .map((event) => ({ event, parsed: parseBlockReceipt(event.tags) }))
    .filter(
      (
        item,
      ): item is {
        event: RelayEvent;
        parsed: Extract<ReturnType<typeof parseBlockReceipt>, { ok: true }>;
      } =>
        item.parsed.ok &&
        item.parsed.value.instanceEventId === message.id &&
        item.parsed.value.instanceId === instanceId &&
        actionsById.has(item.parsed.value.actionEventId) &&
        isAuthorizedBlockReceipt(
          actionsById.get(item.parsed.value.actionEventId)?.event,
          item.event,
          message.blockEvent,
        ),
    )
    .sort((left, right) => compareRelayEvents(left.event, right.event));

  const receiptsByAction = new Map(
    receipts.map((receipt) => [receipt.parsed.value.actionEventId, receipt]),
  );
  const completedActionIds = new Set<string>();
  for (const action of actions) {
    const receipt = receiptsByAction.get(action.event.id);
    if (
      receipt?.parsed.value.status === "succeeded" ||
      receipt?.parsed.value.status === "denied"
    ) {
      completedActionIds.add(action.parsed.value.actionId);
    }
  }

  const pending = [...actions]
    .reverse()
    .find((action) => !receiptsByAction.has(action.event.id));
  const latestReceipt = receipts.at(-1);
  const attentionStatuses: Array<"succeeded" | "denied"> = [];
  for (const receipt of receipts) {
    const { resolvesAttention, status } = receipt.parsed.value;
    if (resolvesAttention && (status === "succeeded" || status === "denied")) {
      attentionStatuses.push(status);
    }
  }
  const latestAttentionStatus = attentionStatuses.at(-1);
  const pendingIsNewest =
    pending &&
    (!latestReceipt ||
      compareRelayEvents(latestReceipt.event, pending.event) < 0);
  return {
    completedActionIds,
    ...(latestAttentionStatus ? { latestAttentionStatus } : {}),
    ...(pending ? { pendingActionId: pending.parsed.value.actionId } : {}),
    ...(pendingIsNewest
      ? { latestStatus: "pending" as const }
      : latestReceipt
        ? { latestStatus: latestReceipt.parsed.value.status }
        : {}),
  };
}

function failureState(code: string): BlockFallbackState {
  if (code === "missing-manifest") return "missing";
  if (code === "integrity-failed") return "integrity-failed";
  if (code === "unavailable") return "missing";
  return "invalid";
}

export function collectQuestionActionIds(root: BlockNode): ReadonlySet<string> {
  const ids = new Set<string>();
  const visit = (node: BlockNode) => {
    if (node.type === "question") {
      ids.add(node.submit_action);
    }
    if (node.type === "stack" || node.type === "grid") {
      node.children.forEach(visit);
    } else if (node.type === "card") {
      node.children.forEach(visit);
    } else if (node.type === "card-list") {
      visit(node.card);
    }
  };
  visit(root);
  return ids;
}

export function BlockMessage({ message }: { message: TimelineMessage }) {
  const { activeCommunity } = useCommunities();
  const identityQuery = useIdentityQuery();
  const connectionState = useRelayConnection();
  const instance = React.useMemo(
    () => parseBlockInstance(message.tags ?? []),
    [message.tags],
  );
  const manifestRequest =
    instance.ok && activeCommunity
      ? {
          communityId: activeCommunity.id,
          manifestId: instance.value.manifestId,
        }
      : null;
  const manifestQuery = useBlockManifest(manifestRequest);
  const manifestResult = manifestQuery.data;
  const dataRequest =
    activeCommunity && instance.ok && manifestResult?.ok === true
      ? {
          communityId: activeCommunity.id,
          manifestId: manifestResult.value.event.id,
          manifest: manifestResult.value.manifest,
          data: instance.value.data,
        }
      : null;
  const dataQuery = useBlockData(dataRequest);
  const queueScope = React.useMemo(
    () =>
      activeCommunity && identityQuery.data
        ? {
            relayUrl: activeCommunity.relayUrl,
            identityPubkey: identityQuery.data.pubkey,
          }
        : null,
    [activeCommunity, identityQuery.data],
  );

  React.useEffect(() => {
    if (connectionState !== "connected" || !queueScope) return;
    void replayQueuedQuestionActions(queueScope, (action) =>
      submitBlockAction({
        actionId: action.actionId,
        channelId: action.channelId,
        data: action.data,
        idempotencyKey: action.idempotencyKey,
        instanceEventId: action.instanceEventId,
        instanceId: action.instanceId,
        manifestId: action.manifestId,
        processorPubkey: action.processorPubkey,
      }),
    );
  }, [connectionState, queueScope]);

  if (!instance.ok) {
    return (
      <BlockFallback
        explanation={instance.message}
        state="invalid"
        text={message.body}
      />
    );
  }
  if (!activeCommunity) {
    return <BlockFallback state="missing" text={message.body} />;
  }
  if (manifestQuery.isPending) {
    return <BlockFallback state="loading" text={message.body} />;
  }
  if (manifestQuery.isError || !manifestResult) {
    return <BlockFallback state="missing" text={message.body} />;
  }
  if (!manifestResult.ok) {
    return (
      <BlockFallback
        explanation={manifestResult.message}
        state={failureState(manifestResult.code)}
        text={message.body}
      />
    );
  }
  if (manifestResult.value.manifest.handle !== instance.value.handle) {
    return (
      <BlockFallback
        explanation="The pinned manifest does not match this inline view."
        state="invalid"
        text={message.body}
      />
    );
  }
  if (manifestResult.value.trust === "untrusted") {
    return <BlockFallback state="untrusted" text={message.body} />;
  }
  if (!manifestResult.value.manifest.supported_clients.includes("desktop")) {
    return <BlockFallback state="unsupported" text={message.body} />;
  }
  if (dataQuery.isPending) {
    return <BlockFallback state="loading" text={message.body} />;
  }
  if (dataQuery.isError || !dataQuery.data) {
    return <BlockFallback state="missing" text={message.body} />;
  }
  if (!dataQuery.data.ok) {
    return (
      <BlockFallback
        explanation={dataQuery.data.message}
        state={failureState(dataQuery.data.code)}
        text={message.body}
      />
    );
  }

  const actionState = deriveBlockActionViewState(
    message,
    instance.value.instanceId,
    instance.value.manifestId,
  );
  const questionActionIds = collectQuestionActionIds(
    manifestResult.value.manifest.tree,
  );
  return (
    <BlockRenderer
      completedActionIds={actionState.completedActionIds}
      data={dataQuery.data.value}
      instance={instance.value}
      latestAttentionStatus={actionState.latestAttentionStatus}
      latestStatus={actionState.latestStatus}
      manifest={manifestResult.value.manifest}
      message={message}
      pendingActionId={actionState.pendingActionId}
      questionActionIds={questionActionIds}
      queueScope={queueScope}
      trust={manifestResult.value.trust}
    />
  );
}

export default BlockMessage;

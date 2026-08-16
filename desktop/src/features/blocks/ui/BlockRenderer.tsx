// Baseline probe: runs the Blocks live gate against develop with no behaviour change.
import type { TimelineMessage } from "@/features/messages/types";
import type {
  BlockInstanceRef,
  BlockManifest,
  BlockTrust,
} from "@/features/blocks/contracts";

import {
  BlockRenderProvider,
  useBlockRenderContext,
} from "./BlockRenderContext";
import { BlockPrimitive, type BlockPrimitiveNode } from "./primitives";

function BlockTree({
  data,
  manifest,
}: {
  data: unknown;
  manifest: BlockManifest;
}) {
  const { actionEnvironment, actionError, actionNotice, attentionResolution } =
    useBlockRenderContext();
  return (
    <>
      <BlockPrimitive
        context={{
          actionEnvironment,
          attentionResolution,
          data,
          rootData: data,
        }}
        node={manifest.tree as BlockPrimitiveNode}
      />
      {actionError ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {actionError}
        </p>
      ) : null}
      {actionNotice ? (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          {actionNotice}
        </p>
      ) : null}
    </>
  );
}

export function resolveAttentionResolution(
  requiresAttention: boolean,
  latestStatus: "succeeded" | "denied" | undefined,
): "succeeded" | "denied" | undefined {
  if (!requiresAttention) return undefined;
  return latestStatus === "succeeded" || latestStatus === "denied"
    ? latestStatus
    : undefined;
}

export function BlockRenderer({
  completedActionIds,
  data,
  instance,
  latestAttentionStatus,
  latestStatus,
  manifest,
  message,
  pendingActionId,
  queueScope,
  questionActionIds,
  trust,
}: {
  completedActionIds: ReadonlySet<string>;
  data: unknown;
  instance: BlockInstanceRef;
  latestAttentionStatus?: "succeeded" | "denied";
  latestStatus?: "pending" | "succeeded" | "denied" | "failed" | "timed-out";
  manifest: BlockManifest;
  message: TimelineMessage;
  pendingActionId?: string;
  queueScope?: {
    relayUrl: string;
    identityPubkey: string;
  } | null;
  questionActionIds: ReadonlySet<string>;
  trust: BlockTrust;
}) {
  const attentionResolution = resolveAttentionResolution(
    manifest.validation.requires_attention,
    latestAttentionStatus,
  );
  return (
    <BlockRenderProvider
      attentionResolution={attentionResolution}
      completedActionIds={completedActionIds}
      data={data}
      instance={instance}
      manifest={manifest}
      message={message}
      pendingActionId={pendingActionId}
      queueScope={queueScope}
      questionActionIds={questionActionIds}
      trust={trust}
    >
      <div
        className="my-1 max-w-2xl overflow-hidden rounded-xl border border-border/70 bg-card/70 p-4 shadow-sm"
        data-block-handle={manifest.handle}
        data-block-trust={trust}
      >
        <BlockTree data={data} manifest={manifest} />
        {latestStatus ? (
          <p
            className="mt-3 border-t border-border/60 pt-2 text-xs text-muted-foreground"
            role="status"
          >
            {latestStatus === "pending"
              ? "Action submitted — waiting for the responsible agent."
              : latestStatus === "succeeded"
                ? "Completed."
                : latestStatus === "denied"
                  ? "Declined."
                  : latestStatus === "timed-out"
                    ? "The action timed out. You can try again."
                    : "The action failed. You can try again."}
          </p>
        ) : null}
      </div>
    </BlockRenderProvider>
  );
}

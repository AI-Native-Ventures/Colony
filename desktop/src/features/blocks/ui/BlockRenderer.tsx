import { websiteDesignDecision } from "../websiteDesign";
import type { TimelineMessage } from "@/features/messages/types";
import type {
  BlockInstanceRef,
  BlockManifest,
  BlockTrust,
} from "@/features/blocks/contracts";

import { WebsiteBundlePreview } from "./WebsiteBundlePreview";
import { ArtifactHtmlPreview } from "./ArtifactHtmlPreview";

import { blockShellTier } from "@/features/blocks/blockShellTier";
import {
  BlockRenderProvider,
  useBlockRenderContext,
} from "./BlockRenderContext";
import { BlockPrimitive, type BlockPrimitiveNode } from "./primitives";

function BlockTree({
  trust,
  data,
  manifest,
  message,
  instance,
}: {
  instance: BlockInstanceRef;
  message: TimelineMessage;
  data: unknown;
  trust: BlockTrust;
  manifest: BlockManifest;
}) {
  const {
    actionEnvironment,
    actionError,
    actionNotice,
    attentionResolution,
    attentionStatusLabel,
  } = useBlockRenderContext();
  const fields =
    data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const bundle = fields.website_bundle as
    | { url?: unknown; sha256?: unknown }
    | undefined;
  const website = trust === "core" && manifest.handle === "artifact" && bundle;
  const designDecision = website
    ? websiteDesignDecision(message, instance, data)
    : null;
  const displayData = website
    ? {
        ...fields,
        status: designDecision
          ? "approved"
          : fields.status === "approved"
            ? "ready-for-review"
            : fields.status,
      }
    : data;
  return (
    <>
      {designDecision ? (
        <p className="text-sm font-medium">
          Design approved for this version. Not published.
        </p>
      ) : null}
      <BlockPrimitive
        context={{
          actionEnvironment: designDecision
            ? {
                ...actionEnvironment,
                completedActionIds: new Set([
                  ...(actionEnvironment.completedActionIds ?? []),
                  "artifact.approve-design",
                ]),
              }
            : actionEnvironment,
          attentionResolution: website ? undefined : attentionResolution,
          attentionStatusLabel,
          data: displayData,
          rootData: displayData,
        }}
        node={manifest.tree as BlockPrimitiveNode}
      />
      {trust === "core" && manifest.handle === "artifact" ? (
        bundle &&
        typeof bundle.url === "string" &&
        typeof bundle.sha256 === "string" ? (
          <WebsiteBundlePreview
            bundle={{ url: bundle.url, sha256: bundle.sha256 }}
            artifactId={message.id}
            threadRoot={message.rootId ?? message.id}
            revision={typeof fields.revision === "number" ? fields.revision : 1}
          />
        ) : (
          <ArtifactHtmlPreview data={data} />
        )
      ) : null}
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
  latestAttentionStatusLabel,
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
  latestAttentionStatusLabel?: string;
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
  // A processor that named its own outcome says it once, in both places.
  const resolvedStatusSentence =
    attentionResolution && latestAttentionStatusLabel
      ? `${latestAttentionStatusLabel.charAt(0).toUpperCase()}${latestAttentionStatusLabel.slice(1)}.`
      : undefined;
  const shellTier = blockShellTier(manifest.tree);
  return (
    <BlockRenderProvider
      attentionResolution={attentionResolution}
      {...(attentionResolution && latestAttentionStatusLabel
        ? { attentionStatusLabel: latestAttentionStatusLabel }
        : {})}
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
        className={
          shellTier === "framed"
            ? "@container my-2 w-full min-w-0"
            : "@container my-1 w-full min-w-0"
        }
        data-block-handle={manifest.handle}
        data-block-trust={trust}
      >
        <BlockTree
          data={data}
          manifest={manifest}
          trust={trust}
          message={message}
          instance={instance}
        />
        {latestStatus ? (
          <p
            className={
              shellTier === "inline"
                ? "mt-2 text-xs text-muted-foreground"
                : "mt-3 border-t border-border/60 pt-2 text-xs text-muted-foreground"
            }
            role="status"
          >
            {latestStatus === "pending"
              ? "Action submitted. Waiting for the responsible agent."
              : latestStatus === "succeeded"
                ? (resolvedStatusSentence ?? "Completed.")
                : latestStatus === "denied"
                  ? (resolvedStatusSentence ?? "Declined.")
                  : latestStatus === "timed-out"
                    ? "The action timed out. You can try again."
                    : "The action failed. You can try again."}
          </p>
        ) : null}
      </div>
    </BlockRenderProvider>
  );
}

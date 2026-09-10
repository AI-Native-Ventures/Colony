import * as React from "react";
import { Check, Download, FileArchive, Globe2, Loader2 } from "lucide-react";

import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { PubKey } from "@/shared/ui/PubKey";

import {
  websiteAgentColorClass,
  websiteAgentInitial,
} from "./agentPresentation";
import {
  beginHandoverDownload,
  beginHandoverDraftRequest,
  clearHandoverDraftCopied,
  completeHandoverDownload,
  createHandoverLocalState,
  failHandoverDownload,
  failHandoverDraftRequest,
  handoverScopeKey,
  markHandoverDraftCopied,
  resolveHandoverDraftResponse,
  type WebsiteHandoverDownloadState,
} from "./handoverState";
import { isScopeCurrent, scopedKey } from "./scopedAsync";
import { useScopedState } from "./useScopedState";
import { resolveHandoverView, type WebsiteHandoverResource } from "./viewLogic";
import type {
  WebsiteAgentDirectory,
  WebsiteArtifactDownloadAdapter,
  WebsiteHandoverDraftAdapter,
  WebsiteHandoverDraftScope,
  WebsiteHandoverRecord,
  WebsiteReviewRecord,
} from "./types";

export type WebsiteHandoverProps = {
  record: WebsiteReviewRecord;
  agents: WebsiteAgentDirectory;
  /** Verified download path for approved artifacts. Never a plain URL. */
  downloadAdapter?: WebsiteArtifactDownloadAdapter;
  /** Team-prepared domain access request adapter. */
  draftAdapter?: WebsiteHandoverDraftAdapter;
  /** Open the exact approved revision in the review preview. */
  onViewRevision?: (revision: number) => void;
  className?: string;
};

function TeamIdentity({
  agents,
  pubkey,
  label,
}: {
  agents: WebsiteAgentDirectory;
  pubkey: string;
  label: string;
}) {
  const agent = agents.get(pubkey);
  if (!agent) {
    return (
      <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        {label}
        <PubKey className="text-2xs" interactive={false} pubkey={pubkey} />
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
      <span
        aria-hidden="true"
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-full text-3xs font-medium",
          websiteAgentColorClass(agent.color),
        )}
      >
        {websiteAgentInitial(agent.name)}
      </span>
      <span className="truncate">
        {label} {agent.name} · {agent.role}
      </span>
    </span>
  );
}

function ResourceRow({
  resource,
  downloadState,
  onDownload,
}: {
  resource: WebsiteHandoverResource;
  downloadState?: WebsiteHandoverDownloadState;
  onDownload?: () => void;
}) {
  const isArtifact = resource.kind === "artifact";
  const status =
    downloadState?.resourceId === resource.id ? downloadState.status : null;
  return (
    <li className="flex items-center justify-between gap-3 border-t border-border/60 py-2 first:border-t-0 first:pt-0">
      <span className="flex min-w-0 items-center gap-2">
        {resource.kind === "page" ? (
          <Globe2
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
        ) : (
          <FileArchive
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
        )}
        <span className="min-w-0 text-xs text-foreground">
          {resource.label}
        </span>
      </span>
      {isArtifact ? (
        onDownload ? (
          <Button
            disabled={status === "downloading"}
            onClick={onDownload}
            size="xs"
            type="button"
            variant="outline"
          >
            {status === "downloading" ? (
              <Loader2 aria-hidden="true" className="size-3 animate-spin" />
            ) : status === "done" ? (
              <Check aria-hidden="true" className="size-3 text-emerald-600" />
            ) : (
              <Download aria-hidden="true" className="size-3" />
            )}
            {status === "done" ? "Saved" : "Download"}
          </Button>
        ) : (
          <span className="shrink-0 text-3xs text-muted-foreground">
            Download not available in this build
          </span>
        )
      ) : (
        <span className="shrink-0 text-3xs text-muted-foreground">
          Reference only
        </span>
      )}
    </li>
  );
}

function HandoverHistory({
  handovers,
  agents,
}: {
  handovers: readonly WebsiteHandoverRecord[];
  agents: WebsiteAgentDirectory;
}) {
  if (handovers.length === 0) return null;
  return (
    <details className="mt-2 text-2xs text-muted-foreground">
      <summary className="cursor-pointer hover:text-foreground">
        Previous handovers ({handovers.length})
      </summary>
      <ul className="mt-1 flex flex-col gap-1">
        {handovers.map((handover) => {
          const agent = agents.get(handover.acceptedBy);
          return (
            <li key={`${handover.jobId}:${handover.approvedRevision}`}>
              Version {handover.approvedRevision} · {handover.assets.length}{" "}
              asset
              {handover.assets.length === 1 ? "" : "s"} ·{" "}
              {agent ? agent.name : "accepting agent"}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/**
 * The handover state: confirmed resources for a handed-over job, or the
 * approved revision that would transfer next. The original website reference
 * is labelled as the original site, never as the approved redesign; approved
 * source means the verified archive. Downloads go through the verified
 * adapter, and the domain access request is a team-prepared draft that is
 * never sent from here.
 *
 * Draft and download work are bound to the exact job/task/channel plus
 * approved revision and manifest hash: switching scope resets them, a response
 * for another scope is rejected, and late callbacks cannot write across
 * scopes.
 */
export function WebsiteHandover({
  record,
  agents,
  downloadAdapter,
  draftAdapter,
  onViewRevision,
  className,
}: WebsiteHandoverProps) {
  const view = resolveHandoverView(record);
  const draftScope: WebsiteHandoverDraftScope | null =
    view.kind === "approved"
      ? {
          jobId: record.jobId,
          taskId: record.taskId,
          channel: record.channel,
          approvedRevision: view.revision.revision,
          approvedManifestSha256: view.revision.preview.sha256,
        }
      : view.kind === "handedOver"
        ? {
            jobId: record.jobId,
            taskId: record.taskId,
            channel: record.channel,
            approvedRevision: view.handover.approvedRevision,
            approvedManifestSha256: view.handover.approvedManifestSha256,
          }
        : null;
  const scopeKey = draftScope
    ? handoverScopeKey(draftScope)
    : scopedKey(record.channel, record.jobId, record.taskId, "no-handover");
  const scopeRef = React.useRef(scopeKey);
  scopeRef.current = scopeKey;
  const [local, setLocal] = useScopedState(scopeKey, createHandoverLocalState);
  const copyTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const resources = view.kind === "blocked" ? [] : view.resources;
  const technicalResources =
    view.kind === "blocked" ? [] : view.technicalResources;
  const history = view.kind === "handedOver" ? view.previous : view.history;
  const approvedRevision =
    view.kind === "handedOver" ? view.revision : undefined;
  const canonicalAccessRequest =
    view.kind === "handedOver" ? view.accessRequest : undefined;

  const requestDraft = () => {
    if (!draftAdapter || !draftScope) return;
    const dispatchScope = scopeKey;
    const requestedScope = draftScope;
    setLocal(beginHandoverDraftRequest);
    Promise.resolve(draftAdapter.request(requestedScope))
      .then((response) => {
        if (!isScopeCurrent(dispatchScope, scopeRef.current)) return;
        setLocal((previous) =>
          resolveHandoverDraftResponse(previous, {
            requestedScope,
            response,
          }),
        );
      })
      .catch((cause: unknown) => {
        if (!isScopeCurrent(dispatchScope, scopeRef.current)) return;
        setLocal((previous) =>
          failHandoverDraftRequest(
            previous,
            cause instanceof Error
              ? cause.message
              : "The access request could not be prepared.",
          ),
        );
      });
  };

  const startDownload = (resource: WebsiteHandoverResource) => {
    if (!downloadAdapter || !resource.sha256 || !resource.path) return;
    const dispatchScope = scopeKey;
    setLocal((previous) => beginHandoverDownload(previous, resource.id));
    Promise.resolve(
      downloadAdapter.download(
        { url: resource.url, sha256: resource.sha256 },
        { path: resource.path },
      ),
    )
      .then(() => {
        if (!isScopeCurrent(dispatchScope, scopeRef.current)) return;
        setLocal((previous) => completeHandoverDownload(previous, resource.id));
      })
      .catch((cause: unknown) => {
        if (!isScopeCurrent(dispatchScope, scopeRef.current)) return;
        setLocal((previous) =>
          failHandoverDownload(
            previous,
            resource.id,
            cause instanceof Error
              ? cause.message
              : "The verified download failed.",
          ),
        );
      });
  };

  const copyAccessRequest = (text: string) => {
    copyTextToClipboard(text, "Request copied");
    setLocal(markHandoverDraftCopied);
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    const timerScope = scopeKey;
    copyTimerRef.current = setTimeout(() => {
      if (!isScopeCurrent(timerScope, scopeRef.current)) return;
      setLocal(clearHandoverDraftCopied);
    }, 1500);
  };

  const copyDraft = () => {
    const returned = local.draft;
    if (returned.status !== "returned") return;
    const text = [
      returned.view.domain ? `Domain: ${returned.view.domain}` : "",
      returned.view.accessRequest ?? "",
    ]
      .filter(Boolean)
      .join("\n\n");
    copyAccessRequest(text);
  };

  return (
    <section
      aria-label="Handover"
      className={cn("border-t border-border px-3.5 py-3", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          {view.kind === "handedOver" ? (
            <>
              <Check aria-hidden="true" className="size-3.5 text-emerald-600" />
              Handover prepared
            </>
          ) : view.kind === "approved" ? (
            "Design approved"
          ) : (
            "Handover not available yet"
          )}
        </span>
        {view.kind === "handedOver" ? (
          <TeamIdentity
            agents={agents}
            label="Accepted by"
            pubkey={view.handover.acceptedBy}
          />
        ) : null}
      </div>

      {view.kind === "blocked" ? (
        <ul className="mt-2 flex flex-col gap-0.5">
          {view.reasons.map((reason) => (
            <li className="text-2xs text-muted-foreground" key={reason.code}>
              {reason.message}
            </li>
          ))}
        </ul>
      ) : null}

      {view.kind === "approved" ? (
        <p className="mt-1 text-2xs text-muted-foreground">
          Handover is not confirmed yet. These are the resources that would
          transfer.
        </p>
      ) : null}

      {resources.length > 0 ? (
        <ul className="mt-2 flex flex-col">
          {resources.map((resource) => (
            <ResourceRow
              downloadState={local.download}
              key={resource.id}
              onDownload={
                downloadAdapter && resource.sha256
                  ? () => startDownload(resource)
                  : undefined
              }
              resource={resource}
            />
          ))}
        </ul>
      ) : null}

      {local.download?.status === "failed" && local.download.message ? (
        <p className="mt-1 text-2xs text-destructive" role="alert">
          {local.download.message}
        </p>
      ) : null}

      {technicalResources.length > 0 || resources.some((r) => r.sha256) ? (
        <details className="mt-2 text-2xs text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">
            Technical details
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {[...resources, ...technicalResources]
              .filter((resource) => resource.sha256)
              .map((resource) => (
                <li className="break-all font-mono text-3xs" key={resource.id}>
                  {resource.label}: {resource.sha256}
                </li>
              ))}
          </ul>
        </details>
      ) : null}

      {view.kind === "handedOver" && approvedRevision && onViewRevision ? (
        <button
          className="mt-2 text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => onViewRevision(approvedRevision.revision)}
          type="button"
        >
          View approved design (Version {approvedRevision.revision})
        </button>
      ) : null}

      <HandoverHistory agents={agents} handovers={history} />

      {view.kind !== "blocked" ? (
        <div className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-3">
          {canonicalAccessRequest ? (
            <div className="flex flex-col gap-1">
              <TeamIdentity
                agents={agents}
                label="Prepared by"
                pubkey={canonicalAccessRequest.authoredBy}
              />
              <p className="whitespace-pre-line rounded-md border border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-foreground">
                {canonicalAccessRequest.text}
              </p>
              <span className="flex items-center gap-2 text-2xs text-muted-foreground">
                <button
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={() => copyAccessRequest(canonicalAccessRequest.text)}
                  type="button"
                >
                  {local.copied ? "Copied" : "Copy request"}
                </button>
                Nothing has been sent. This is a draft.
              </span>
            </div>
          ) : (
            <>
              {local.draft.status === "idle" ? (
                <Button
                  className="self-start"
                  disabled={!draftAdapter}
                  onClick={requestDraft}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Prepare domain access request
                </Button>
              ) : null}
              {!draftAdapter ? (
                <p className="text-2xs text-muted-foreground">
                  Preparing a domain access request is not available in this
                  build.
                </p>
              ) : null}
              {local.draft.status === "requesting" ? (
                <p
                  aria-live="polite"
                  className="flex items-center gap-1.5 text-2xs text-muted-foreground"
                >
                  <Loader2 aria-hidden="true" className="size-3 animate-spin" />
                  Waiting for the team to prepare the request.
                </p>
              ) : null}
              {local.draft.status === "failed" ? (
                <span
                  className="flex flex-wrap items-center gap-2 text-2xs text-destructive"
                  role="alert"
                >
                  <span>{local.draft.message}</span>
                  <button
                    className="underline underline-offset-2 hover:text-foreground"
                    onClick={requestDraft}
                    type="button"
                  >
                    Try again
                  </button>
                </span>
              ) : null}
              {local.draft.status === "returned" ? (
                <div className="flex flex-col gap-1">
                  {local.draft.view.domain ? (
                    <p className="text-2xs text-muted-foreground">
                      Domain:{" "}
                      <span className="text-foreground">
                        {local.draft.view.domain}
                      </span>
                    </p>
                  ) : null}
                  {local.draft.view.accessRequest ? (
                    <p className="whitespace-pre-line rounded-md border border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-foreground">
                      {local.draft.view.accessRequest}
                    </p>
                  ) : null}
                  <span className="flex items-center gap-2 text-2xs text-muted-foreground">
                    <button
                      className="underline underline-offset-2 hover:text-foreground"
                      onClick={copyDraft}
                      type="button"
                    >
                      {local.copied ? "Copied" : "Copy draft"}
                    </button>
                    Nothing has been sent. This is a draft.
                  </span>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

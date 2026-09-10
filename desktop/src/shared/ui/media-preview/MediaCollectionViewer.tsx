import * as React from "react";
import { useWorkspaceAttachmentOpener } from "@/features/workspace/ui/WorkspaceLinkContext";
import {
  InlineFilePreview,
  supportsInlineFilePreview,
  type FilePreviewViewState,
} from "../file-preview/InlineFilePreview";
import { FileCard } from "../markdown/FileCard";
import { VideoPlayer, type VideoReviewContext } from "../VideoPlayer";
import { AudioPlayer } from "./AudioPlayer";
import { ImagePreview } from "./ImagePreview";
import {
  mediaCollectionLabel,
  type MediaCollectionItem,
} from "./mediaCollectionModel";

/** Only navigation state survives a file switch; parsed documents and players do not. */
export type MediaCollectionViewState = {
  document?: FilePreviewViewState;
  seconds?: number;
};

/** Mount one selected file and release its media resources before replacement. */
export function MediaCollectionViewer({
  item,
  state,
  reviewKey,
  reviewContext,
}: {
  item: MediaCollectionItem;
  state: MediaCollectionViewState;
  reviewKey: string;
  reviewContext?: VideoReviewContext;
}) {
  const holder = React.useRef<HTMLDivElement>(null);
  const openInWorkspace = useWorkspaceAttachmentOpener();
  const media = React.useRef(new Set<HTMLMediaElement>());
  const latestMedia = React.useRef<HTMLMediaElement | null>(null);
  const restored = React.useRef(new WeakSet<HTMLMediaElement>());
  const disposed = React.useRef(false);
  React.useLayoutEffect(() => {
    disposed.current = false;
    const players = media.current;
    holder.current
      ?.querySelectorAll<HTMLMediaElement>("video,audio")
      .forEach((player) => {
        players.add(player);
        // React Strict Mode replays cleanup while preserving these DOM nodes.
        if (!player.getAttribute("src")) {
          player.setAttribute("src", item.src);
          restored.current.delete(player);
        }
      });
    return () => {
      disposed.current = true;
      const latest = latestMedia.current ?? players.values().next().value;
      if (
        latest &&
        latest.readyState >= 1 &&
        Number.isFinite(latest.currentTime)
      )
        state.seconds = latest.currentTime;
      for (const player of players) {
        player.pause();
        player.removeAttribute("src");
        player.load();
      }
      players.clear();
    };
  }, [item.src, state]);
  const remember = (event: React.SyntheticEvent) => {
    if (disposed.current) return;
    const player = event.target;
    if (!(player instanceof HTMLMediaElement)) return;
    media.current.add(player);
    latestMedia.current = player;
    if (player.readyState >= 1 && Number.isFinite(player.currentTime))
      state.seconds = player.currentTime;
  };
  const filename = mediaCollectionLabel(item);
  let viewer: React.ReactNode;
  if (item.kind === "image") {
    viewer = <ImagePreview items={[{ ...item, alt: item.alt ?? filename }]} />;
  } else if (item.kind === "video") {
    viewer = (
      <VideoPlayer
        src={item.src}
        poster={item.poster}
        aspectRatio={
          item.width && item.height ? item.width / item.height : undefined
        }
        durationSeconds={item.durationSeconds}
        filename={filename}
        downloadUrl={item.downloadUrl}
        reviewKey={reviewKey}
        reviewContext={
          reviewContext ? { ...reviewContext, title: filename } : undefined
        }
      />
    );
  } else if (item.kind === "audio") {
    viewer = (
      <AudioPlayer
        src={item.src}
        filename={filename}
        downloadUrl={item.downloadUrl}
        durationSeconds={item.durationSeconds}
      />
    );
  } else if (supportsInlineFilePreview(filename, item.mime)) {
    viewer = (
      <InlineFilePreview
        href={item.originalUrl}
        filename={filename}
        mime={item.mime}
        size={item.size}
        initialViewState={state.document}
        onOpenInWorkspace={
          openInWorkspace
            ? () =>
                openInWorkspace({
                  url: item.originalUrl,
                  filename,
                  mime: item.mime ?? "",
                })
            : undefined
        }
        onViewStateChange={(value) => {
          state.document = value;
        }}
      />
    );
  } else {
    viewer = (
      <FileCard
        href={item.originalUrl}
        filename={filename}
        mime={item.mime ?? ""}
        size={item.size}
      />
    );
  }
  return (
    <div
      ref={holder}
      data-testid="media-collection-viewer"
      onTimeUpdate={remember}
      onSeeked={remember}
      onLoadedMetadata={(event) => {
        if (disposed.current) return;
        const player = event.target;
        if (!(player instanceof HTMLMediaElement)) return;
        media.current.add(player);
        if (!restored.current.has(player)) {
          restored.current.add(player);
          if (state.seconds != null && Number.isFinite(state.seconds))
            player.currentTime = Math.min(
              state.seconds,
              Number.isFinite(player.duration)
                ? player.duration
                : state.seconds,
            );
        }
      }}
      onPlayCapture={(event) => {
        if (disposed.current) return;
        const active = event.target;
        if (!(active instanceof HTMLMediaElement)) return;
        media.current.add(active);
        latestMedia.current = active;
        for (const player of media.current) {
          if (player !== active && !player.paused) player.pause();
        }
      }}
    >
      {viewer}
    </div>
  );
}

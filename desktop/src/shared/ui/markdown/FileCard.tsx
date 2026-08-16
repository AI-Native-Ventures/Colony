import * as React from "react";
import { Download, FileText } from "lucide-react";
import { toast } from "sonner";

import { useWorkspaceAttachmentOpener } from "@/features/workspace/ui/WorkspaceLinkContext";
import { invokeTauri } from "@/shared/api/tauri";
import { cn } from "@/shared/lib/cn";
import { useSmoothCorners } from "@/shared/ui/smoothCorners";

/** Human-readable byte size: "820 B", "12.4 KB", "3.1 MB". */
function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i += 1;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[i]}`;
}

const CARD_CLASS =
  "my-1 inline-flex max-w-sm items-center gap-3 rounded-2xl border border-border/70 bg-muted/40 px-3 py-2 text-left no-underline transition-colors hover:bg-muted/70";

/**
 * File card for a generic (non-image, non-video) attachment: icon, filename,
 * size, and a download action.
 *
 * Clicking the card opens the attachment as a workspace tab, so a file a
 * teammate or an agent sent can be read without leaving the app. Downloading
 * is its own button beside it, because saving a file and reading it are
 * different intentions and this card used to offer only the first.
 *
 * Downloads go through the native `download_file` Tauri command (HTTP inside
 * the app's tunnel + a save dialog), not a plain `<a download>` link. A bare
 * link navigates the webview to the blob URL, which escapes to the OS browser
 * and gets bounced to a corporate CDN interstitial ("browser not supported").
 * The native command mirrors the image-download path.
 *
 * Surfaces with no channel workspace (project readmes, the agent screens) have
 * no opener, so there the whole card stays the download control it has been.
 */
export function FileCard({
  href,
  filename,
  mime,
  size,
}: {
  href: string;
  filename: string;
  mime: string;
  size?: number;
}) {
  const openInWorkspace = useWorkspaceAttachmentOpener();
  const sizeLabel = size != null ? formatFileSize(size) : "";
  // One ref per shape of the card. Only one is mounted at a time, and the
  // hook no-ops on the ref that is null.
  const downloadOnlyRef = React.useRef<HTMLButtonElement>(null);
  const openableRef = React.useRef<HTMLSpanElement>(null);
  useSmoothCorners(downloadOnlyRef);
  useSmoothCorners(openableRef);

  const download = React.useCallback(() => {
    invokeTauri("download_file", { url: href, filename }).catch(
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Download failed";
        toast.error(msg);
      },
    );
  }, [filename, href]);

  const body = (
    <>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground">
        <FileText className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {filename}
        </span>
        {sizeLabel ? (
          <span className="block text-xs text-muted-foreground">
            {sizeLabel}
          </span>
        ) : null}
      </span>
    </>
  );

  if (!openInWorkspace) {
    return (
      <button
        ref={downloadOnlyRef}
        type="button"
        onClick={download}
        data-testid="file-card"
        className={CARD_CLASS}
        style={{ borderRadius: "1rem" }}
      >
        {body}
        <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
    );
  }

  return (
    <span
      ref={openableRef}
      className={cn(CARD_CLASS, "pr-2")}
      data-testid="file-card"
      style={{ borderRadius: "1rem" }}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        data-testid="file-card-open"
        onClick={() => openInWorkspace({ url: href, filename, mime })}
        title={`Open ${filename} in the workspace`}
        type="button"
      >
        {body}
      </button>
      <button
        className="ml-1 shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
        data-testid="file-card-download"
        onClick={download}
        title={`Download ${filename}`}
        type="button"
      >
        <Download className="h-4 w-4" />
      </button>
    </span>
  );
}

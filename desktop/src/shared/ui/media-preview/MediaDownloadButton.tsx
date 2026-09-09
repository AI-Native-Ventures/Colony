import * as React from "react";
import { Download, Link } from "lucide-react";
import { toast } from "sonner";

import { invokeTauri } from "@/shared/api/tauri";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { Button } from "@/shared/ui/button";
import { isBundledPreviewDownload } from "./mediaPreviewModel";

/** Preserve the native save dialog and relay validation used by file downloads. */
export function MediaDownloadButton({
  downloadUrl,
  filename,
  sourceUrl,
}: {
  downloadUrl?: string;
  filename: string;
  sourceUrl?: string;
}) {
  const [pending, setPending] = React.useState(false);
  if (!downloadUrl && !sourceUrl) return null;
  if (downloadUrl && isBundledPreviewDownload(downloadUrl)) {
    return (
      <Button asChild size="sm" variant="ghost">
        <a download={filename} href={downloadUrl}>
          <Download aria-hidden="true" className="size-3.5" />
          Download
        </a>
      </Button>
    );
  }
  return (
    <Button
      aria-label={downloadUrl ? `Download ${filename}` : "Copy media link"}
      disabled={pending}
      onClick={() => {
        if (!downloadUrl) {
          if (sourceUrl) void copyTextToClipboard(sourceUrl, "Link copied");
          return;
        }
        setPending(true);
        void invokeTauri("download_file", { url: downloadUrl, filename })
          .catch((cause: unknown) =>
            toast.error(
              cause instanceof Error ? cause.message : "Download failed",
            ),
          )
          .finally(() => setPending(false));
      }}
      size="sm"
      type="button"
      variant="ghost"
    >
      {downloadUrl ? (
        <Download aria-hidden="true" className="size-4" />
      ) : (
        <Link aria-hidden="true" className="size-4" />
      )}
      <span>
        {downloadUrl ? (pending ? "Saving…" : "Download") : "Copy link"}
      </span>
    </Button>
  );
}

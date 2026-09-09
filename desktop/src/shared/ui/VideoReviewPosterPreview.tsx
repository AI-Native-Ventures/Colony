import { Film } from "lucide-react";
import * as React from "react";

// Only inspect an already-loaded, readable thumbnail. Cross-origin posters remain
// usable when canvas readback is unavailable; the upload pipeline does the scan.
function isBlankReadablePoster(image: HTMLImageElement): boolean {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 54;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let visible = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      if (
        data[offset] * 2126 + data[offset + 1] * 7152 + data[offset + 2] * 722 >
        240_000
      ) {
        visible += 1;
      }
    }
    return visible * 100 < canvas.width * canvas.height * 2;
  } catch {
    return false;
  }
}

/** Keep an informative cover visible until the user starts or seeks the video. */
export function VideoReviewPosterPreview({
  poster,
  visible,
  filename = "Video",
}: {
  poster?: string;
  visible: boolean;
  filename?: string;
}) {
  const [failedPoster, setFailedPoster] = React.useState<string | null>(null);
  if (!visible) return null;

  return (
    <div
      className="pointer-events-none absolute inset-0 bg-muted text-muted-foreground"
      data-testid="video-poster-surface"
    >
      <div className="absolute inset-0 flex flex-col justify-end gap-2 px-4 pb-14">
        <Film aria-hidden="true" className="size-6 text-primary" />
        <span className="truncate text-sm font-medium">{filename}</span>
        <span className="text-xs">Play to view video</span>
      </div>
      {poster && failedPoster !== poster ? (
        <img
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-contain"
          data-testid="video-review-poster-preview"
          decoding="async"
          draggable={false}
          loading="lazy"
          onError={() => setFailedPoster(poster)}
          onLoad={(event) => {
            if (isBlankReadablePoster(event.currentTarget))
              setFailedPoster(poster);
          }}
          src={poster}
        />
      ) : null}
    </div>
  );
}

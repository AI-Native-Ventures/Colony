import * as React from "react";
import { AudioLines, Pause, Play } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { MediaDownloadButton } from "./MediaDownloadButton";
import { formatMediaTime } from "./mediaPreviewModel";

/** Compact playback of the original audio; no waveform or transcript is invented. */
export function AudioPlayer({
  src,
  filename = "Audio",
  downloadUrl,
  durationSeconds = 0,
  className,
}: {
  src: string;
  filename?: string;
  downloadUrl?: string;
  durationSeconds?: number;
  className?: string;
}) {
  const audio = React.useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const [duration, setDuration] = React.useState(durationSeconds);
  const [error, setError] = React.useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a replacement source resets playback even if its supplied duration is identical
  React.useEffect(() => {
    setPlaying(false);
    setElapsed(0);
    setDuration(durationSeconds);
    setError(false);
  }, [src, durationSeconds]);
  const knownDuration =
    Number.isFinite(duration) && duration > 0 ? duration : 0;
  return (
    // biome-ignore lint/a11y/useSemanticElements: phrasing content is required when an audio link appears inside a Markdown paragraph
    <span
      role="group"
      aria-label={filename}
      className={cn(
        "my-2 block w-full min-w-0 rounded-xl border border-border/60 bg-card p-3 text-card-foreground",
        className,
      )}
      data-testid="media-audio-preview"
    >
      <span className="mb-3 flex min-w-0 items-center gap-2">
        <AudioLines
          aria-hidden="true"
          className="size-4 shrink-0 text-primary"
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {filename}
        </span>
        <MediaDownloadButton
          downloadUrl={downloadUrl}
          filename={filename === "Audio" ? "audio" : filename}
          sourceUrl={src}
        />
      </span>
      {/* biome-ignore lint/a11y/useMediaCaption: this is an original audio attachment; no transcript supplied */}
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => setElapsed(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => {
          setError(true);
          setPlaying(false);
        }}
      />
      <span className="flex items-center gap-3">
        <Button
          aria-label={playing ? "Pause audio" : "Play audio"}
          disabled={error}
          onClick={() => {
            if (playing) audio.current?.pause();
            else
              void audio.current?.play().catch(() => {
                setError(true);
                setPlaying(false);
              });
          }}
          size="icon"
          type="button"
        >
          {playing ? (
            <Pause aria-hidden="true" className="size-4" />
          ) : (
            <Play aria-hidden="true" className="size-4" />
          )}
        </Button>
        <input
          aria-label="Seek audio"
          className="min-w-0 flex-1 accent-primary"
          disabled={!knownDuration || error}
          type="range"
          min={0}
          max={knownDuration || 1}
          step={0.1}
          value={Math.min(elapsed, knownDuration || 0)}
          onChange={(event) => {
            const value = Number(event.currentTarget.value);
            if (audio.current) audio.current.currentTime = value;
            setElapsed(value);
          }}
        />
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatMediaTime(elapsed)} /{" "}
          {knownDuration ? formatMediaTime(knownDuration) : "—"}
        </span>
      </span>
      {error ? (
        <span
          className="mt-2 block text-sm text-muted-foreground"
          role="status"
        >
          Audio could not be played.{" "}
          {downloadUrl ? "Download the original" : "Open the source link"} to
          listen in another app.
        </span>
      ) : null}
    </span>
  );
}

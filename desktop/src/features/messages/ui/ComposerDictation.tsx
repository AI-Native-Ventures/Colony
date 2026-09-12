import { useEffect, useRef } from "react";
import { LoaderCircle, Mic, X } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import type { ComposerDictationControl } from "../lib/useComposerDictation";

/** Mic affordance uses the selected theme, just like the adjacent Send button. */
export function DictationButton({
  control,
  disabled,
}: {
  control: ComposerDictationControl;
  disabled: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label="Dictate message"
          data-testid="dictate-message"
          className="rounded-full"
          size="icon"
          variant="ghost"
          type="button"
          disabled={disabled || control.active}
          onMouseDown={(event) => event.preventDefault()}
          onClick={control.start}
        >
          <Mic aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Dictate message · English · on-device</TooltipContent>
    </Tooltip>
  );
}

/** In-composer recording state; Stop creates a draft and never submits it. */
export function ComposerDictation({
  control,
}: {
  control: ComposerDictationControl;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (control.active) cancelRef.current?.focus();
  }, [control.active]);
  if (!control.active) {
    if (control.error)
      return (
        <div
          role="alert"
          className="mb-2 flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <span className="flex-1">{control.error}</span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Dismiss dictation error"
            onClick={control.cancel}
          >
            <X aria-hidden />
          </Button>
        </div>
      );
    return control.reviewed ? (
      <p role="status" className="mb-2 text-xs text-muted-foreground">
        Edit anything before sending.
      </p>
    ) : null;
  }
  const recording = control.phase === "recording";
  const label = recording
    ? "Listening"
    : control.phase === "preparing"
      ? "Getting microphone ready…"
      : "Turning speech into text…";
  return (
    <fieldset
      aria-label="Voice dictation"
      data-testid="dictation-recording"
      className="rounded-xl border border-primary/20 bg-primary/5 p-3"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          control.cancel();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-sm">
          {recording ? (
            <span aria-hidden className="h-2 w-2 rounded-full bg-primary" />
          ) : (
            <LoaderCircle
              aria-hidden
              className="h-4 w-4 text-primary motion-safe:animate-spin"
            />
          )}
          <span role="status">{label}</span>
          {recording && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {Math.floor(control.seconds / 60)}:
              {String(control.seconds % 60).padStart(2, "0")}
            </span>
          )}
        </div>
        <div
          aria-hidden
          className="flex h-8 min-w-16 flex-1 items-center justify-center gap-1 overflow-hidden text-primary"
        >
          {control.levels.map((level, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed waveform slots, never reordered.
              key={`bar-${index}`}
              className="w-1 shrink-0 rounded-full bg-current"
              style={{
                height: `${3 + level * 25}px`,
                opacity: 0.35 + level * 0.65,
              }}
            />
          ))}
        </div>
        <Button
          ref={cancelRef}
          aria-label="Cancel dictation"
          type="button"
          variant="ghost"
          size="icon"
          className="rounded-full"
          onClick={control.cancel}
        >
          <X aria-hidden />
        </Button>
        {recording && (
          <Button
            type="button"
            onClick={control.stop}
            className="rounded-full shadow-none"
          >
            Stop
          </Button>
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {recording
          ? "Stop to turn your words into a draft · 60 seconds max"
          : "Your message will stay a draft until you send it."}
      </p>
    </fieldset>
  );
}

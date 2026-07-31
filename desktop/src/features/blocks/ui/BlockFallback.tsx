import { AlertTriangle, LoaderCircle } from "lucide-react";

import { cn } from "@/shared/lib/cn";

export type BlockFallbackState =
  | "loading"
  | "missing"
  | "invalid"
  | "untrusted"
  | "unsupported"
  | "integrity-failed";

const STATE_COPY: Record<BlockFallbackState, string> = {
  loading: "Loading this inline view…",
  missing: "The inline view is no longer available.",
  invalid: "This inline view could not be verified.",
  untrusted: "This inline view comes from an untrusted publisher.",
  unsupported: "This version of the app cannot display the inline view.",
  "integrity-failed": "The inline view data failed its integrity check.",
};

export function blockFallbackExplanation(state: BlockFallbackState): string {
  return STATE_COPY[state];
}

export function BlockFallback({
  className,
  explanation,
  state,
  text,
}: {
  className?: string;
  explanation?: string;
  state: BlockFallbackState;
  text: string;
}) {
  const loading = state === "loading";

  return (
    <div
      className={cn(
        "my-1 max-w-2xl rounded-xl border border-border/70 bg-muted/20 px-3.5 py-3",
        className,
      )}
      data-block-fallback={state}
    >
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {text}
      </p>
      <div
        aria-live={loading ? "polite" : undefined}
        className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"
        role={loading ? "status" : "note"}
      >
        {loading ? (
          <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
        ) : (
          <AlertTriangle aria-hidden="true" className="size-3.5" />
        )}
        <span>{explanation ?? blockFallbackExplanation(state)}</span>
      </div>
    </div>
  );
}

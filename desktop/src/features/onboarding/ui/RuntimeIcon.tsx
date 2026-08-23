import * as React from "react";
import { TerminalSquare } from "lucide-react";

import type { AcpRuntimeCatalogEntry } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { AntMark } from "@/shared/ui/colony-logo/AntMark";
import claudeLogoUrl from "../assets/harness-logos/claude.png?inline";
import { RUNTIME_MARKS } from "./HarnessMarks";

// Bundled logos for compiled-in runtimes (inline base64, no network fetch).
// Monochrome marks live in RUNTIME_MARKS instead — inline SVGs that follow
// `currentColor`, so they adapt to dark/light without bitmap filters.
const RUNTIME_LOGOS: Record<string, string> = {
  claude: claudeLogoUrl,
};

// Public-path logos for bundled harnesses. Served from /harness-logos/ at
// runtime. Keys match `id` values the backend emits, from either tier: the
// tier-2 `PRESET_HARNESSES` list or the compiled-in `KNOWN_ACP_RUNTIMES` table.
// OpenCode lives in the latter since its promotion to a first-class runtime,
// and keeps its bundled mark; a logo does not follow a harness's tier.
export const HARNESS_LOGOS: Record<string, string> = {
  devin: "/harness-logos/devin.svg",
  omp: "/harness-logos/omp.svg",
  grok: "/harness-logos/grok.svg",
  opencode: "/harness-logos/opencode.svg",
  kimi: "/harness-logos/kimi.png",
  amp: "/harness-logos/amp.png",
  hermes: "/harness-logos/hermes.png",
  openclaw: "/harness-logos/openclaw.svg",
  "prime-agent": "/harness-logos/prime-agent.svg",
};

function isBuzzRuntime(runtime: AcpRuntimeCatalogEntry): boolean {
  return runtime.id.trim().toLowerCase() === "buzz-agent";
}

export function getRuntimeDisplayLabel(
  runtime: AcpRuntimeCatalogEntry,
): string {
  return runtime.label;
}

function getRuntimeLogoUrl(runtime: AcpRuntimeCatalogEntry): string | null {
  const id = runtime.id.trim().toLowerCase();
  return RUNTIME_LOGOS[id] ?? HARNESS_LOGOS[id] ?? null;
}

export function RuntimeIcon({
  className = "h-8 w-8",
  runtime,
}: {
  className?: string;
  runtime: AcpRuntimeCatalogEntry;
}) {
  const [imageFailed, setImageFailed] = React.useState(false);
  // Only use bundled logo maps — never render user-supplied avatar URLs for
  // custom/preset entries (tracking pixel / spoofing vector, security line).
  const id = runtime.id.trim().toLowerCase();
  const imageUrl = getRuntimeLogoUrl(runtime);
  const Mark = RUNTIME_MARKS[id];

  if (isBuzzRuntime(runtime)) {
    // The mark's wide viewBox letterboxes inside a square box, so honoring
    // the caller's size keeps it optically in line with the square logos.
    return <AntMark className={cn(className, "text-foreground")} />;
  }

  if (Mark) {
    return <Mark className={cn(className, "p-0.5 text-foreground")} />;
  }

  if (imageUrl && !imageFailed) {
    return (
      <img
        alt=""
        className={cn(
          "rounded-md object-contain",
          className,
          id === "omp" && "bg-[#0d0d0d] p-1",
        )}
        onError={() => setImageFailed(true)}
        src={imageUrl}
      />
    );
  }

  return (
    <TerminalSquare
      className={cn(className, "text-foreground")}
      strokeWidth={1.25}
    />
  );
}

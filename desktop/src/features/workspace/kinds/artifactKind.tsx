import type * as React from "react";

import type { TabKindDefinition } from "@/features/workspace/lib/tabKindRegistry";
import type { TabBodyProps } from "@/features/workspace/kinds/scratchpadKind";
import { Markdown } from "@/shared/ui/markdown";

type ArtifactPayload = {
  content: string;
  reference: string;
  sourceEventId: string | null;
  sourceKind: "event" | "text";
};

function readArtifactPayload(payload: unknown): ArtifactPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (
    typeof value.content !== "string" ||
    typeof value.reference !== "string" ||
    (value.sourceEventId !== null && typeof value.sourceEventId !== "string") ||
    (value.sourceKind !== "event" && value.sourceKind !== "text")
  ) {
    return null;
  }
  return value as ArtifactPayload;
}

export const artifactKindDefinition: TabKindDefinition = {
  kind: "artifact",
  label: "Task artifact",
  createTitle: () => "Task artifact",
  createPayload: () => ({
    content: "",
    reference: "",
    sourceEventId: null,
    sourceKind: "text",
  }),
  canCreateFromNewTabPage: false,
};

/** Read-only presentation of accepted relay evidence. */
export function ArtifactBody({ tab }: TabBodyProps): React.JSX.Element {
  const payload = readArtifactPayload(tab.payload);
  if (!payload) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        This artifact payload is not readable by this version of Colony.
      </div>
    );
  }
  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
        Read-only task evidence ·{" "}
        {payload.sourceKind === "event" ? "relay event" : "accepted text"}
        {payload.sourceEventId ? ` · ${payload.sourceEventId}` : ""}
      </div>
      <Markdown
        className="min-h-0 flex-1 overflow-auto p-4 text-sm"
        content={payload.content}
        interactive={false}
      />
    </div>
  );
}

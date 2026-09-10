import type * as React from "react";

import { listCreatableTabKinds } from "@/features/workspace/lib/tabKindRegistry";
import { useProjectsQuery } from "@/features/projects/hooks";

type NewTabPageProps = {
  channelId: string;
  onCreate: (kind: string) => void;
};

/** Empty state: the kinds this build can create, filtered by availability. */
export function NewTabPage({
  channelId,
  onCreate,
}: NewTabPageProps): React.JSX.Element {
  const projects = useProjectsQuery();
  const kinds = listCreatableTabKinds({
    channelId,
    projects: projects.data,
  });
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-4 p-8"
      data-testid="workspace-new-tab-page"
    >
      <p className="text-sm text-muted-foreground">
        Open something in this channel&apos;s workspace.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {kinds.map((definition) => (
          <button
            className="rounded-md border border-border px-3 py-2 text-sm text-foreground hover:bg-muted"
            data-testid={`workspace-create-${definition.kind}`}
            key={definition.kind}
            onClick={() => onCreate(definition.kind)}
            type="button"
          >
            {definition.label}
          </button>
        ))}
      </div>
    </div>
  );
}

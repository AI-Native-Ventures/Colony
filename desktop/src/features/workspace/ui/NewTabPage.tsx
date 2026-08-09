import type * as React from "react";

import { listCreatableTabKinds } from "@/features/workspace/lib/tabKindRegistry";

type NewTabPageProps = {
  onCreate: (kind: string) => void;
};

/** Empty state: the kinds this build can create. */
export function NewTabPage({ onCreate }: NewTabPageProps): React.JSX.Element {
  const kinds = listCreatableTabKinds();
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

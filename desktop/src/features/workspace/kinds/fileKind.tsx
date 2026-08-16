import * as React from "react";
import { invoke } from "@/shared/api/nativeBridge";

import type { TabKindDefinition } from "@/features/workspace/lib/tabKindRegistry";
import {
  readFileSource,
  titleForPath,
} from "@/features/workspace/lib/filePayload";
import {
  loadWorkspaceFile,
  type LoadedWorkspaceFile,
} from "@/features/workspace/lib/workspaceFileContent";
import {
  renameTab,
  updateTabPayload,
} from "@/features/workspace/lib/workspaceTabs";
import type { TabBodyProps } from "@/features/workspace/kinds/scratchpadKind";

export const fileKindDefinition: TabKindDefinition = {
  kind: "file",
  label: "File",
  createTitle: () => "Open a file",
  createPayload: () => ({ path: null }),
  canCreateFromNewTabPage: true,
};

function decodeText(bytesBase64: string): string {
  const binary = globalThis.atob(bytesBase64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Read-only file viewer. Editing and saving land in a later phase.
 *
 * The file is either one on disk or a message attachment, which has no local
 * copy until someone downloads it; `loadWorkspaceFile` hides which.
 */
export function FileBody({ channelId, tab }: TabBodyProps): React.JSX.Element {
  // Memoized on the stored payload so the load effect runs once per file, not
  // once per render.
  const source = React.useMemo(
    () => readFileSource(tab.payload),
    [tab.payload],
  );
  const [file, setFile] = React.useState<LoadedWorkspaceFile | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!source) {
      setFile(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setError(null);
    setFile(null);
    loadWorkspaceFile(source)
      .then((result) => {
        if (!cancelled) setFile(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  const handlePick = React.useCallback(async () => {
    const picked = await invoke<string | null>("pick_workspace_file", {
      imagesOnly: false,
    });
    if (typeof picked !== "string") return;
    updateTabPayload(channelId, tab.id, { path: picked });
    renameTab(channelId, tab.id, titleForPath(picked));
  }, [channelId, tab.id]);

  if (!source) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <button
          className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
          data-testid="workspace-file-pick"
          onClick={() => void handlePick()}
          type="button"
        >
          Choose a file
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="p-4 text-sm text-destructive"
        data-testid="workspace-file-error"
      >
        {error}
      </div>
    );
  }

  if (!file) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Loading {source.kind === "path" ? source.path : source.name}…
      </div>
    );
  }

  if (!file.isText) {
    return (
      <div
        className="p-4 text-sm text-muted-foreground"
        data-testid="workspace-file-binary"
      >
        {file.name} is not a text file ({file.mime})
      </div>
    );
  }

  return (
    <pre
      className="h-full overflow-auto p-4 font-mono text-xs text-foreground"
      data-testid="workspace-file-body"
    >
      {decodeText(file.bytesBase64)}
    </pre>
  );
}

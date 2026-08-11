import * as React from "react";
import { invoke } from "@/shared/api/nativeBridge";

import type { TabKindDefinition } from "@/features/workspace/lib/tabKindRegistry";
import {
  readFilePath,
  titleForPath,
} from "@/features/workspace/lib/filePayload";
import {
  renameTab,
  updateTabPayload,
} from "@/features/workspace/lib/workspaceTabs";
import type { TabBodyProps } from "@/features/workspace/kinds/scratchpadKind";

type WorkspaceFile = {
  path: string;
  name: string;
  mime: string;
  bytes_base64: string;
  size: number;
  is_text: boolean;
};

export const imageKindDefinition: TabKindDefinition = {
  kind: "image",
  label: "Image",
  createTitle: () => "Open an image",
  createPayload: () => ({ path: null }),
  canCreateFromNewTabPage: true,
};

/** Image viewer. Bytes arrive over IPC as a data URL: no asset protocol
 * configuration and no file:// exposure. */
export function ImageBody({ channelId, tab }: TabBodyProps): React.JSX.Element {
  const path = readFilePath(tab.payload);
  const [source, setSource] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!path) {
      setSource(null);
      return;
    }
    let cancelled = false;
    setError(null);
    invoke<WorkspaceFile>("read_workspace_file", { path })
      .then((file) => {
        if (cancelled) return;
        if (!file.mime.startsWith("image/")) {
          setError(`${file.name} is not an image (${file.mime})`);
          return;
        }
        setSource(`data:${file.mime};base64,${file.bytes_base64}`);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const handlePick = React.useCallback(async () => {
    const picked = await invoke<string | null>("pick_workspace_file", {
      imagesOnly: true,
    });
    if (typeof picked !== "string") return;
    updateTabPayload(channelId, tab.id, { path: picked });
    renameTab(channelId, tab.id, titleForPath(picked));
  }, [channelId, tab.id]);

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <button
          className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
          data-testid="workspace-image-pick"
          onClick={() => void handlePick()}
          type="button"
        >
          Choose an image
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="p-4 text-sm text-destructive"
        data-testid="workspace-image-error"
      >
        {error}
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      {source ? (
        <img
          alt={tab.title}
          className="max-h-full max-w-full object-contain"
          data-testid="workspace-image-body"
          src={source}
        />
      ) : (
        <span className="text-sm text-muted-foreground">Loading…</span>
      )}
    </div>
  );
}

import { invoke } from "@/shared/api/nativeBridge";

import { setChannelSurfaceMode } from "./channelSurfaceMode";
import { titleForPath } from "./filePayload";
import { getTabKind } from "./tabKindRegistry";
import { openTab } from "./workspaceTabs";

/** A message path the native side resolved to a real file. */
export type ResolvedWorkspacePath = {
  path: string;
  mime: string;
  is_text: boolean;
};

/** Result of opening a message file path in the current channel workspace. */
export type OpenPathInWorkspaceResult =
  | { ok: true; tabId: string; kind: string; path: string }
  | { ok: false; message: string };

type OpenPathDependencies = {
  getKind: (kind: string) => unknown;
  openTab: typeof openTab;
  resolvePath: (path: string) => Promise<ResolvedWorkspacePath>;
  setSurfaceMode: typeof setChannelSurfaceMode;
};

const DEFAULT_DEPENDENCIES: OpenPathDependencies = {
  getKind: getTabKind,
  openTab,
  resolvePath: (path) =>
    invoke<ResolvedWorkspacePath>("resolve_workspace_path", { path }),
  setSurfaceMode: setChannelSurfaceMode,
};

/**
 * The tab kind that can show this file.
 *
 * Anything that is not an image goes to the `file` kind, including binaries:
 * that viewer already says "this is not a text file" for one, which is a
 * better answer than refusing to open the tab at all.
 */
export function tabKindForResolvedPath(file: ResolvedWorkspacePath): string {
  return file.mime.startsWith("image/") ? "image" : "file";
}

/**
 * Open a file path written in a message as a tab in `channelId`'s workspace.
 *
 * Resolution is native and deliberately narrow (see `resolve_workspace_path`):
 * a path only opens when it names a real file inside the Buzz workspace or the
 * configured repos folder, so a message cannot steer a reader into opening
 * something else on their disk. Anything that does not resolve comes back as a
 * message for the caller to show rather than a silently dead click.
 */
export async function openPathInWorkspace(
  input: { channelId: string; path: string },
  dependencies: OpenPathDependencies = DEFAULT_DEPENDENCIES,
): Promise<OpenPathInWorkspaceResult> {
  let file: ResolvedWorkspacePath;
  try {
    file = await dependencies.resolvePath(input.path);
  } catch (error) {
    return { ok: false, message: String(error) };
  }

  const kind = tabKindForResolvedPath(file);
  if (dependencies.getKind(kind) === undefined) {
    return {
      ok: false,
      message: `This build cannot open ${file.path} in the workspace.`,
    };
  }

  try {
    const tabId = dependencies.openTab(input.channelId, {
      kind,
      title: titleForPath(file.path),
      createdBy: "local",
      payload: { path: file.path },
    });
    dependencies.setSurfaceMode(input.channelId, "workspace");
    return { ok: true, kind, path: file.path, tabId };
  } catch (error) {
    return {
      ok: false,
      message: `This file could not be opened in the workspace: ${String(error)}`,
    };
  }
}

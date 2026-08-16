import { setChannelSurfaceMode } from "./channelSurfaceMode";
import { getTabKind } from "./tabKindRegistry";
import { openTab } from "./workspaceTabs";

/** A message attachment as the timeline knows it. */
export type WorkspaceAttachment = {
  url: string;
  filename: string;
  mime: string;
};

/** Result of opening a message attachment in the current channel workspace. */
export type OpenAttachmentResult =
  | { ok: true; tabId: string; title: string }
  | { ok: false; message: string };

type OpenAttachmentDependencies = {
  getKind: (kind: string) => unknown;
  openTab: typeof openTab;
  setSurfaceMode: typeof setChannelSurfaceMode;
};

const DEFAULT_DEPENDENCIES: OpenAttachmentDependencies = {
  getKind: getTabKind,
  openTab,
  setSurfaceMode: setChannelSurfaceMode,
};

/**
 * The tab kind that shows an attachment card's file.
 *
 * Always the `file` kind: images and video never reach a file card (they
 * render inline with their own lightbox), and a binary is better answered by
 * that viewer's "this is not a text file" than by refusing to open a tab.
 */
const ATTACHMENT_TAB_KIND = "file";

/**
 * Open a message attachment as a tab in `channelId`'s workspace.
 *
 * The attachment has no local copy: the tab carries the relay URL and the
 * viewer fetches the bytes over the same validated media path the download
 * action uses. Download stays on the card, because saving a file and reading
 * it are different intentions.
 */
export function openAttachmentInWorkspace(
  input: { channelId: string; attachment: WorkspaceAttachment },
  dependencies: OpenAttachmentDependencies = DEFAULT_DEPENDENCIES,
): OpenAttachmentResult {
  const { attachment } = input;
  const kind = ATTACHMENT_TAB_KIND;
  if (dependencies.getKind(kind) === undefined) {
    return {
      ok: false,
      message: `This build cannot open ${attachment.filename} in the workspace.`,
    };
  }

  try {
    const tabId = dependencies.openTab(input.channelId, {
      kind,
      title: attachment.filename,
      createdBy: "local",
      payload: {
        url: attachment.url,
        name: attachment.filename,
        mime: attachment.mime,
      },
    });
    dependencies.setSurfaceMode(input.channelId, "workspace");
    return { ok: true, tabId, title: attachment.filename };
  } catch (error) {
    return {
      ok: false,
      message: `This attachment could not be opened in the workspace: ${String(error)}`,
    };
  }
}

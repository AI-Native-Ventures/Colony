import { setChannelSurfaceMode } from "./channelSurfaceMode";
import { getTabKind } from "./tabKindRegistry";
import { openTab } from "./workspaceTabs";

type WorkspaceUrlDecision =
  | { supported: true; title: string; url: string }
  | { supported: false; message: string };

/** Result of opening a message URL in the current channel workspace. */
export type OpenUrlInWorkspaceResult =
  | { ok: true; tabId: string; title: string; url: string }
  | { ok: false; message: string };

type OpenUrlDependencies = {
  getKind: (kind: string) => unknown;
  openTab: typeof openTab;
  setSurfaceMode: typeof setChannelSurfaceMode;
};

const DEFAULT_DEPENDENCIES: OpenUrlDependencies = {
  getKind: getTabKind,
  openTab,
  setSurfaceMode: setChannelSurfaceMode,
};

const URL_PATTERN = /https?:\/\/[^\s<>[\]{}"']+/gi;
const TRAILING_PUNCTUATION = /[.,!?;:]+$/;

function trimUrlCandidate(candidate: string): string {
  let value = candidate.replace(TRAILING_PUNCTUATION, "");
  while (
    /[)]$/.test(value) &&
    (value.match(/\(/g)?.length ?? 0) < (value.match(/\)/g)?.length ?? 0)
  ) {
    value = value.slice(0, -1);
  }
  return value;
}

/** Parse a URL accepted by the workspace browser's external-navigation policy. */
export function parseWorkspaceUrl(candidate: string): URL | null {
  const trimmed = trimUrlCandidate(candidate.trim());
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      !url.hostname
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/** Extract the first HTTP(S) URL from message text, preserving its path/query. */
export function extractFirstHttpUrl(text: string): string | null {
  const firstMatch = text.match(URL_PATTERN)?.[0];
  const url = firstMatch ? parseWorkspaceUrl(firstMatch) : null;
  return url?.href ?? null;
}

function titleForUrl(url: URL): string {
  return url.hostname || "Web";
}

/** Decide whether a message has an in-app web action without mutating state. */
export function decideWorkspaceUrlOpening(
  body: string,
  hasWebKind: (kind: string) => boolean,
): WorkspaceUrlDecision {
  const urlText = extractFirstHttpUrl(body);
  const url = urlText ? parseWorkspaceUrl(urlText) : null;
  if (!url) {
    return {
      supported: false,
      message: "This message does not contain a safe HTTP or HTTPS link.",
    };
  }
  if (!hasWebKind("web")) {
    return {
      supported: false,
      message:
        "This build cannot open web links in the workspace. Enable the workspace web tab to use this action.",
    };
  }
  return { supported: true, title: titleForUrl(url), url: url.href };
}

/** Open the first safe message URL in the current channel's web workspace tab. */
export function openUrlInWorkspace(
  input: { body: string; channelId: string },
  dependencies: OpenUrlDependencies = DEFAULT_DEPENDENCIES,
): OpenUrlInWorkspaceResult {
  const decision = decideWorkspaceUrlOpening(
    input.body,
    (kind) => dependencies.getKind(kind) !== undefined,
  );
  if (!decision.supported) return { ok: false, message: decision.message };

  try {
    const tabId = dependencies.openTab(input.channelId, {
      kind: "web",
      title: decision.title,
      createdBy: "local",
      payload: {
        endpoint: null,
        targetId: null,
        url: decision.url,
      },
    });
    dependencies.setSurfaceMode(input.channelId, "workspace");
    return { ok: true, tabId, title: decision.title, url: decision.url };
  } catch (error) {
    return {
      ok: false,
      message: `This link could not be opened in the workspace: ${String(error)}`,
    };
  }
}

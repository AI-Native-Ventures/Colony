import { setChannelSurfaceMode } from "./channelSurfaceMode";
import { getTabKind } from "./tabKindRegistry";
import { getWorkspace, openTab, setActiveTab } from "./workspaceTabs";

type WorkspaceUrlDecision =
  | { supported: true; title: string; url: string }
  | { supported: false; message: string };

/** Result of opening a message URL in the current channel workspace. */
export type OpenUrlInWorkspaceResult =
  | { ok: true; reused: boolean; tabId: string; title: string; url: string }
  | { ok: false; message: string };

type OpenUrlDependencies = {
  getKind: (kind: string) => unknown;
  getWorkspace: typeof getWorkspace;
  openTab: typeof openTab;
  setActiveTab: typeof setActiveTab;
  setSurfaceMode: typeof setChannelSurfaceMode;
};

const DEFAULT_DEPENDENCIES: OpenUrlDependencies = {
  getKind: getTabKind,
  getWorkspace,
  openTab,
  setActiveTab,
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
  const trimmed = candidate.trim();
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
  const url = firstMatch
    ? parseWorkspaceUrl(trimUrlCandidate(firstMatch))
    : null;
  return url?.href ?? null;
}

function titleForUrl(url: URL): string {
  return url.hostname || "Web";
}

function webTabUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>).url;
  return typeof value === "string"
    ? (parseWorkspaceUrl(value)?.href ?? null)
    : null;
}

const UNSUPPORTED_WEB_KIND_MESSAGE =
  "This build cannot open web links in the workspace. Enable the workspace web tab to use this action.";

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
    return { supported: false, message: UNSUPPORTED_WEB_KIND_MESSAGE };
  }
  return { supported: true, title: titleForUrl(url), url: url.href };
}

/** Decide whether one already-known link can open in the workspace. */
export function decideWorkspaceLinkOpening(
  href: string,
  hasWebKind: (kind: string) => boolean,
): WorkspaceUrlDecision {
  const url = parseWorkspaceUrl(href);
  if (!url) {
    return {
      supported: false,
      message: "This is not a safe HTTP or HTTPS link.",
    };
  }
  if (!hasWebKind("web")) {
    return { supported: false, message: UNSUPPORTED_WEB_KIND_MESSAGE };
  }
  return { supported: true, title: titleForUrl(url), url: url.href };
}

function openDecidedUrl(
  decision: WorkspaceUrlDecision,
  channelId: string,
  dependencies: OpenUrlDependencies,
): OpenUrlInWorkspaceResult {
  if (!decision.supported) return { ok: false, message: decision.message };

  try {
    const existing = dependencies
      .getWorkspace(channelId)
      .tabs.find(
        (tab) => tab.kind === "web" && webTabUrl(tab.payload) === decision.url,
      );
    if (existing) {
      dependencies.setActiveTab(channelId, existing.id);
      dependencies.setSurfaceMode(channelId, "workspace");
      return {
        ok: true,
        reused: true,
        tabId: existing.id,
        title: existing.title,
        url: decision.url,
      };
    }

    const tabId = dependencies.openTab(channelId, {
      kind: "web",
      title: decision.title,
      createdBy: "local",
      payload: {
        endpoint: null,
        targetId: null,
        url: decision.url,
      },
    });
    dependencies.setSurfaceMode(channelId, "workspace");
    return {
      ok: true,
      reused: false,
      tabId,
      title: decision.title,
      url: decision.url,
    };
  } catch (error) {
    return {
      ok: false,
      message: `This link could not be opened in the workspace: ${String(error)}`,
    };
  }
}

/**
 * Open one clicked link in the current channel's web workspace tab.
 *
 * Unlike `openUrlInWorkspace`, the caller already knows which link was
 * chosen, so no URL is extracted from message text.
 */
export function openLinkInWorkspace(
  input: { href: string; channelId: string },
  dependencies: OpenUrlDependencies = DEFAULT_DEPENDENCIES,
): OpenUrlInWorkspaceResult {
  return openDecidedUrl(
    decideWorkspaceLinkOpening(
      input.href,
      (kind) => dependencies.getKind(kind) !== undefined,
    ),
    input.channelId,
    dependencies,
  );
}

/** Open the first safe message URL in the current channel's web workspace tab. */
export function openUrlInWorkspace(
  input: { body: string; channelId: string },
  dependencies: OpenUrlDependencies = DEFAULT_DEPENDENCIES,
): OpenUrlInWorkspaceResult {
  return openDecidedUrl(
    decideWorkspaceUrlOpening(
      input.body,
      (kind) => dependencies.getKind(kind) !== undefined,
    ),
    input.channelId,
    dependencies,
  );
}

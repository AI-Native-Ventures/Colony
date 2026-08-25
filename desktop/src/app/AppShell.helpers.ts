import { isThreadReply } from "@/features/messages/lib/threading";
import type { DesktopNotificationTarget } from "@/features/notifications/lib/desktop";
import type { SearchHit } from "@/shared/api/types";

export type AppView =
  | "home"
  | "action-center"
  | "channel"
  | "messages"
  | "agents"
  | "people"
  | "discovery"
  | "workflows"
  | "pulse"
  | "projects"
  | "spend"
  | "content";

const WINDOW_DRAG_HANDLE_HEIGHT = 44;
const TAURI_DRAG_REGION_ATTR = "data-tauri-drag-region";
const WINDOW_DRAG_INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

const CLICKABLE_TAGS = new Set([
  "A",
  "BUTTON",
  "INPUT",
  "SELECT",
  "TEXTAREA",
  "LABEL",
  "SUMMARY",
]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "option",
]);

function isClickableElement(element: HTMLElement) {
  return (
    CLICKABLE_TAGS.has(element.tagName) ||
    (element.hasAttribute("contenteditable") &&
      element.getAttribute("contenteditable") !== "false") ||
    (element.hasAttribute("tabindex") &&
      element.getAttribute("tabindex") !== "-1") ||
    INTERACTIVE_ROLES.has(element.getAttribute("role") ?? "")
  );
}

function isTauriDragRegionEvent(event: MouseEvent | PointerEvent) {
  const path = event.composedPath();
  const directTarget = path[0];

  for (const item of path) {
    if (!(item instanceof HTMLElement)) continue;

    const attr = item.getAttribute(TAURI_DRAG_REGION_ATTR);

    if (isClickableElement(item) && attr === null) return false;
    if (attr === null) continue;
    if (attr === "false") return false;
    if (attr === "deep") return true;
    if (attr === "" || attr === "true") return item === directTarget;
  }

  return false;
}

export function isWindowDragHandleEvent(event: MouseEvent | PointerEvent) {
  if (isTauriDragRegionEvent(event)) {
    return true;
  }

  if (event.clientY > WINDOW_DRAG_HANDLE_HEIGHT) {
    return false;
  }

  const target = event.target;
  return !(
    target instanceof Element &&
    target.closest(WINDOW_DRAG_INTERACTIVE_SELECTOR)
  );
}

export function shouldBounceForChannelNotification(tags: string[][]): boolean {
  return !isThreadReply(tags);
}

export function markAllReadSources({
  activeChannelId,
  channelActivityItems,
  markAllChannelReadMarkers,
  markActiveChannelRead,
  undoUnreadFeedItem,
  unreadFeedItemIds,
}: {
  activeChannelId: string | null;
  channelActivityItems: ReadonlyArray<{
    channelId: string | null;
    createdAt: number;
  }>;
  markAllChannelReadMarkers: () => void;
  markActiveChannelRead: (channelId: string, createdAt: number) => void;
  undoUnreadFeedItem: (itemId: string) => void;
  unreadFeedItemIds: ReadonlySet<string>;
}) {
  for (const itemId of unreadFeedItemIds) {
    undoUnreadFeedItem(itemId);
  }
  markAllChannelReadMarkers();

  if (!activeChannelId) return;

  let latestActivityAt: number | null = null;
  for (const item of channelActivityItems) {
    if (item.channelId !== activeChannelId) continue;
    latestActivityAt = Math.max(latestActivityAt ?? 0, item.createdAt);
  }
  if (latestActivityAt !== null) {
    markActiveChannelRead(activeChannelId, latestActivityAt);
  }
}

export function toSearchHit(
  target: DesktopNotificationTarget,
): SearchHit | null {
  if (!target.eventId) {
    return null;
  }

  return {
    eventId: target.eventId,
    content: target.content ?? "",
    kind: target.kind ?? 9,
    pubkey: target.pubkey ?? "",
    channelId: target.channelId,
    channelName: target.channelName ?? null,
    createdAt: target.createdAt ?? Math.floor(Date.now() / 1_000),
    score: 0,
    threadRootId: target.threadRootId ?? null,
  };
}

/**
 * The Agents view hosts addressable sections (`?section=...`); only `people`
 * exists today. The validated search object wins when provided; raw-href
 * callers (tests, history helpers) keep the query in the pathname itself.
 */
function isAgentsPeopleSection(
  search: Record<string, unknown> | undefined,
  query: string,
): boolean {
  if (search?.section !== undefined) {
    return search.section === "people";
  }
  return new URLSearchParams(query).get("section") === "people";
}

export function deriveShellRoute(
  pathname: string,
  search?: Record<string, unknown>,
): {
  selectedChannelId: string | null;
  selectedView: AppView;
} {
  const queryIndex = pathname.indexOf("?");
  const path = queryIndex === -1 ? pathname : pathname.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : pathname.slice(queryIndex + 1);

  if (path.startsWith("/channels/")) {
    const [, , rawChannelId] = path.split("/");
    return {
      selectedChannelId: rawChannelId ? decodeURIComponent(rawChannelId) : null,
      selectedView: "channel",
    };
  }

  if (path === "/messages/new") {
    return {
      selectedChannelId: null,
      selectedView: "messages",
    };
  }

  if (path === "/action-center") {
    return {
      selectedChannelId: null,
      selectedView: "action-center",
    };
  }

  if (path === "/agents") {
    return {
      selectedChannelId: null,
      selectedView: isAgentsPeopleSection(search, query) ? "people" : "agents",
    };
  }

  if (path === "/discovery") {
    return {
      selectedChannelId: null,
      selectedView: "discovery",
    };
  }

  if (path === "/workflows" || path.startsWith("/workflows/")) {
    return {
      selectedChannelId: null,
      selectedView: "workflows",
    };
  }

  if (path === "/projects" || path.startsWith("/projects/")) {
    return {
      selectedChannelId: null,
      selectedView: "projects",
    };
  }

  if (path === "/pulse") {
    return {
      selectedChannelId: null,
      selectedView: "pulse",
    };
  }

  if (path === "/spend") {
    return {
      selectedChannelId: null,
      selectedView: "spend",
    };
  }

  if (path === "/content") {
    return {
      selectedChannelId: null,
      selectedView: "content",
    };
  }

  return {
    selectedChannelId: null,
    selectedView: "home",
  };
}

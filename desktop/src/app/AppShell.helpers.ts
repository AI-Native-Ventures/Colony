import { isThreadReply } from "@/features/messages/lib/threading";
import type { DesktopNotificationTarget } from "@/features/notifications/lib/desktop";
import type { SearchHit } from "@/shared/api/types";

export type AppView =
  | "home"
  | "channel"
  | "messages"
  | "agents"
  | "discovery"
  | "workflows"
  | "pulse"
  | "projects"
  | "spend"
  | "credits"
  | "content"
  | "work";

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

export function deriveShellRoute(pathname: string): {
  selectedChannelId: string | null;
  selectedView: AppView;
} {
  const queryIndex = pathname.indexOf("?");
  const path = queryIndex === -1 ? pathname : pathname.slice(0, queryIndex);

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

  if (path === "/agents") {
    return {
      selectedChannelId: null,
      selectedView: "agents",
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

  // Credits sits beside Spend on purpose: Spend is where the money went,
  // Credits is where more comes from. Until this route existed the only way
  // to buy Credits was the first-run onboarding wizard, so anyone who
  // finished onboarding and ran out had no way to pay.
  if (path === "/credits") {
    return {
      selectedChannelId: null,
      selectedView: "credits",
    };
  }

  if (path === "/work") {
    return {
      selectedChannelId: null,
      selectedView: "work",
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

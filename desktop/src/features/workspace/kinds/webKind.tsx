import * as React from "react";

import type { TabKindDefinition } from "@/features/workspace/lib/tabKindRegistry";
import {
  disposeWebSession,
  ensureWebSession,
  getWebSession,
  navigateWeb,
  sendWebKey,
  sendWebMouse,
  sendWebText,
  sendWebWheel,
  subscribeWebSession,
} from "@/features/workspace/lib/webSessions";
import {
  updateTabPayload,
  type WorkspaceTab,
} from "@/features/workspace/lib/workspaceTabs";
import type { TabBodyProps } from "@/features/workspace/kinds/scratchpadKind";

type WebPayload = {
  endpoint: string | null;
  targetId: string | null;
  url: string;
};

export const webKindDefinition: TabKindDefinition = {
  kind: "web",
  label: "Web",
  createTitle: () => "Web",
  createPayload: () => ({
    endpoint: null,
    targetId: null,
    url: "about:blank",
  }),
  canCreateFromNewTabPage: true,
  dispose: (tab) => disposeWebSession(tab.id),
};

function readWebPayload(payload: unknown): WebPayload {
  if (!payload || typeof payload !== "object") {
    return { endpoint: null, targetId: null, url: "about:blank" };
  }
  const value = payload as Record<string, unknown>;
  return {
    endpoint: typeof value.endpoint === "string" ? value.endpoint : null,
    targetId: typeof value.targetId === "string" ? value.targetId : null,
    url: typeof value.url === "string" && value.url ? value.url : "about:blank",
  };
}

function modifiersForEvent(event: React.KeyboardEvent): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

function buttonForEvent(button: number): string {
  switch (button) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    case 3:
      return "back";
    case 4:
      return "forward";
    default:
      return "none";
  }
}

function frameCoordinates(
  element: HTMLElement,
  event: { clientX: number; clientY: number },
  frame: { width: number; height: number },
): { x: number; y: number } | null {
  const bounds = element.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  return {
    x: Math.max(
      0,
      Math.min(
        frame.width,
        ((event.clientX - bounds.left) / bounds.width) * frame.width,
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        frame.height,
        ((event.clientY - bounds.top) / bounds.height) * frame.height,
      ),
    ),
  };
}

function useWebRuntime(tabId: string) {
  return React.useSyncExternalStore(
    React.useCallback(
      (listener) => subscribeWebSession(tabId, listener),
      [tabId],
    ),
    React.useCallback(() => getWebSession(tabId), [tabId]),
    React.useCallback(() => getWebSession(tabId), [tabId]),
  );
}

/** A Tauri-hosted live CDP screencast with pointer and keyboard forwarding. */
export function WebBody({ channelId, tab }: TabBodyProps): React.JSX.Element {
  const payload = React.useMemo(
    () => readWebPayload(tab.payload),
    [tab.payload],
  );
  const session = useWebRuntime(tab.id);
  const [endpoint, setEndpoint] = React.useState(payload.endpoint ?? "");
  const [targetId, setTargetId] = React.useState(payload.targetId ?? "");
  const [url, setUrl] = React.useState(payload.url);
  const frameRef = React.useRef<HTMLImageElement>(null);

  React.useEffect(() => {
    setEndpoint(payload.endpoint ?? "");
    setTargetId(payload.targetId ?? "");
    setUrl(payload.url);
  }, [payload.endpoint, payload.targetId, payload.url]);

  const persistPayload = React.useCallback(() => {
    updateTabPayload(channelId, tab.id, {
      ...payload,
      endpoint: endpoint.trim() || null,
      targetId: targetId.trim() || null,
      url: url.trim() || "about:blank",
    });
  }, [channelId, endpoint, payload, tab.id, targetId, url]);

  const connect = React.useCallback(() => {
    const request = {
      endpoint: endpoint.trim() || null,
      targetId: targetId.trim() || null,
      url: url.trim() || "about:blank",
    };
    persistPayload();
    void ensureWebSession(tab.id, request);
  }, [endpoint, persistPayload, tab.id, targetId, url]);

  const navigate = React.useCallback(() => {
    persistPayload();
    if (session.status === "running") {
      void navigateWeb(tab.id, url.trim() || "about:blank");
      return;
    }
    connect();
  }, [connect, persistPayload, session.status, tab.id, url]);

  const pointerEvent = React.useCallback(
    (
      eventType: "mouseMoved" | "mousePressed" | "mouseReleased",
      event: React.MouseEvent<HTMLImageElement>,
    ) => {
      const frame = session.frame;
      const image = frameRef.current;
      if (!frame || !image) return;
      const coordinates = frameCoordinates(image, event, frame);
      if (!coordinates) return;
      void sendWebMouse(tab.id, {
        eventType,
        ...coordinates,
        button:
          eventType === "mouseMoved" ? "none" : buttonForEvent(event.button),
        clickCount: eventType === "mouseMoved" ? undefined : event.detail,
      });
    },
    [session.frame, tab.id],
  );

  const wheelEvent = React.useCallback(
    (event: React.WheelEvent<HTMLImageElement>) => {
      const frame = session.frame;
      const image = frameRef.current;
      if (!frame || !image) return;
      event.preventDefault();
      const coordinates = frameCoordinates(image, event, frame);
      if (!coordinates) return;
      void sendWebWheel(tab.id, {
        ...coordinates,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      });
    },
    [session.frame, tab.id],
  );

  const keyEvent = React.useCallback(
    (
      eventType: "keyDown" | "keyUp",
      event: React.KeyboardEvent<HTMLDivElement>,
    ) => {
      event.preventDefault();
      void sendWebKey(tab.id, {
        eventType,
        key: event.key,
        code: event.code,
        text:
          eventType === "keyDown" &&
          event.key.length === 1 &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey
            ? event.key
            : undefined,
        modifiers: modifiersForEvent(event),
        windowsVirtualKeyCode:
          event.key.length === 1 ? event.key.charCodeAt(0) : undefined,
      });
    },
    [tab.id],
  );

  const textEvent = React.useCallback(
    (event: React.FormEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      const input = event.nativeEvent as InputEvent;
      if (input.data) void sendWebText(tab.id, input.data);
    },
    [tab.id],
  );

  const isRunning = session.status === "running";
  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-browser-pid={session.browserPid ?? undefined}
      data-status={session.status}
      data-testid="workspace-web-body"
      onBeforeInput={textEvent}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget) keyEvent("keyDown", event);
      }}
      onKeyUp={(event) => {
        if (event.target === event.currentTarget) keyEvent("keyUp", event);
      }}
      role="application"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The browser surface is a keyboard target for forwarded CDP input.
      tabIndex={0}
    >
      <div className="flex flex-wrap items-end gap-2 border-b border-border p-2">
        <label className="min-w-48 flex-1 text-xs text-muted-foreground">
          DevTools endpoint (optional)
          <input
            aria-label="DevTools endpoint"
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
            data-testid="workspace-web-endpoint"
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder="9222 or 127.0.0.1:9222"
            value={endpoint}
          />
        </label>
        <label className="min-w-48 flex-1 text-xs text-muted-foreground">
          Page URL
          <input
            aria-label="Page URL"
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
            data-testid="workspace-web-url"
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") navigate();
            }}
            placeholder="https://example.test"
            value={url}
          />
        </label>
        <label className="min-w-32 text-xs text-muted-foreground">
          Target ID (optional)
          <input
            aria-label="Target ID"
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
            data-testid="workspace-web-target"
            onChange={(event) => setTargetId(event.target.value)}
            placeholder="first page"
            value={targetId}
          />
        </label>
        <button
          className="rounded border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="workspace-web-connect"
          disabled={session.status === "connecting"}
          onClick={connect}
          type="button"
        >
          {session.status === "connecting"
            ? "Connecting…"
            : endpoint.trim()
              ? "Attach"
              : "Launch Chromium"}
        </button>
        <button
          className="rounded border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="workspace-web-navigate"
          disabled={!isRunning}
          onClick={navigate}
          type="button"
        >
          Navigate
        </button>
      </div>
      {session.error ? (
        <div
          className="border-b border-destructive/30 px-3 py-2 text-sm text-destructive"
          data-testid="workspace-web-error"
        >
          {session.error}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/10 p-2">
        {session.frame ? (
          <img
            alt={`Live browser page${session.url ? `: ${session.url}` : ""}`}
            className="block max-h-full max-w-full select-none shadow-lg"
            data-testid="workspace-web-frame"
            draggable={false}
            height={session.frame.height}
            onMouseDown={(event) => pointerEvent("mousePressed", event)}
            onMouseMove={(event) => pointerEvent("mouseMoved", event)}
            onMouseUp={(event) => pointerEvent("mouseReleased", event)}
            onWheel={wheelEvent}
            ref={frameRef}
            src={`data:image/jpeg;base64,${session.frame.data}`}
            width={session.frame.width}
          />
        ) : (
          <div
            className="max-w-md p-8 text-center text-sm text-muted-foreground"
            data-testid="workspace-web-placeholder"
          >
            Connect to a local Chromium DevTools endpoint or launch a headless
            browser to see the live page here.
          </div>
        )}
      </div>
    </div>
  );
}

export function readWebPayloadForTest(payload: unknown): WebPayload {
  return readWebPayload(payload);
}

export function frameCoordinatesForTest(
  element: HTMLElement,
  event: { clientX: number; clientY: number },
  frame: { width: number; height: number },
): { x: number; y: number } | null {
  return frameCoordinates(element, event, frame);
}

export type { WorkspaceTab };

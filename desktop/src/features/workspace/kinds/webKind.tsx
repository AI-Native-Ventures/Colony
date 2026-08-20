import * as React from "react";
import {
  ArrowLeft,
  ArrowRight,
  Globe2,
  MoreHorizontal,
  RefreshCw,
} from "lucide-react";

import type { TabKindDefinition } from "@/features/workspace/lib/tabKindRegistry";
import {
  disposeWebSession,
  ensureWebSession,
  goBackWeb,
  goForwardWeb,
  getWebSession,
  navigateWeb,
  reloadWeb,
  resizeWeb,
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
  const autoStartKey = React.useRef<string | null>(null);
  const frameRef = React.useRef<HTMLImageElement>(null);
  const surfaceRef = React.useRef<HTMLDivElement>(null);

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

  React.useEffect(() => {
    const requestedUrl = payload.url.trim();
    if (!requestedUrl || requestedUrl === "about:blank") return;
    const key = `${payload.endpoint ?? ""}|${payload.targetId ?? ""}|${requestedUrl}`;
    if (autoStartKey.current === key) return;
    autoStartKey.current = key;
    void ensureWebSession(tab.id, {
      endpoint: payload.endpoint,
      targetId: payload.targetId,
      url: requestedUrl,
    });
  }, [payload.endpoint, payload.targetId, payload.url, tab.id]);

  const navigate = React.useCallback(() => {
    persistPayload();
    if (session.status === "running") {
      void navigateWeb(tab.id, url.trim() || "about:blank");
      return;
    }
    connect();
  }, [connect, persistPayload, session.status, tab.id, url]);

  React.useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || session.status !== "running") return;
    let animationFrame = 0;
    let lastSize = "";
    const syncViewport = () => {
      const bounds = surface.getBoundingClientRect();
      const width = Math.max(240, Math.floor(bounds.width));
      const height = Math.max(240, Math.floor(bounds.height));
      const size = `${width}x${height}`;
      if (size === lastSize) return;
      lastSize = size;
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        void resizeWeb(tab.id, width, height);
      });
    };
    syncViewport();
    const observer = new ResizeObserver(syncViewport);
    observer.observe(surface);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(animationFrame);
    };
  }, [session.status, tab.id]);

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
      <div
        className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border bg-muted/40 px-2"
        data-testid="workspace-web-toolbar"
      >
        <button
          aria-label="Back"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
          disabled={!isRunning}
          onClick={() => void goBackWeb(tab.id)}
          title="Back"
          type="button"
        >
          <ArrowLeft className="size-4" />
        </button>
        <button
          aria-label="Forward"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
          disabled={!isRunning}
          onClick={() => void goForwardWeb(tab.id)}
          title="Forward"
          type="button"
        >
          <ArrowRight className="size-4" />
        </button>
        <button
          aria-label="Reload"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
          disabled={!isRunning}
          onClick={() => void reloadWeb(tab.id)}
          title="Reload"
          type="button"
        >
          <RefreshCw className="size-4" />
        </button>
        <form
          className="flex min-w-0 flex-1 items-center"
          onSubmit={(event) => {
            event.preventDefault();
            navigate();
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-background px-2.5 shadow-sm focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/30">
            <Globe2 className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              aria-label="URL"
              className="h-8 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
              data-testid="workspace-web-url"
              onChange={(event) => setUrl(event.target.value)}
              placeholder="Search or enter address"
              value={url}
            />
            <span
              aria-hidden="true"
              className={`size-1.5 shrink-0 rounded-full ${isRunning ? "bg-emerald-500" : session.status === "connecting" ? "bg-amber-500" : "bg-muted-foreground/40"}`}
              title={session.status}
            />
            <span className="sr-only">{session.status}</span>
          </div>
          <button
            aria-label="Go"
            className="ml-1 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            data-testid="workspace-web-navigate"
            type="submit"
          >
            <ArrowRight className="size-4" />
          </button>
        </form>
        <details
          className="group relative"
          data-testid="workspace-web-advanced"
        >
          <summary
            aria-label="Advanced browser connection"
            className="flex cursor-pointer list-none rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Advanced connection"
          >
            <MoreHorizontal className="size-4" />
          </summary>
          <div className="absolute right-0 top-9 z-20 w-80 space-y-3 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl">
            <label className="block text-xs text-muted-foreground">
              DevTools endpoint (optional)
              <input
                aria-label="DevTools endpoint"
                className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
                data-testid="workspace-web-endpoint"
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder="9222 or 127.0.0.1:9222"
                value={endpoint}
              />
            </label>
            <label className="block text-xs text-muted-foreground">
              Target ID (optional)
              <input
                aria-label="Target ID"
                className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
                data-testid="workspace-web-target"
                onChange={(event) => setTargetId(event.target.value)}
                placeholder="First page"
                value={targetId}
              />
            </label>
            <button
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground hover:bg-muted disabled:opacity-50"
              data-testid="workspace-web-connect"
              disabled={session.status === "connecting"}
              onClick={connect}
              type="button"
            >
              {session.status === "connecting"
                ? "Connecting…"
                : endpoint.trim()
                  ? "Attach to Chromium"
                  : "Launch a new Chromium session"}
            </button>
          </div>
        </details>
      </div>
      {session.error ? (
        <div
          className="flex items-center justify-between gap-3 border-b border-destructive/30 px-3 py-2 text-sm"
          data-testid="workspace-web-error"
        >
          <span className="text-destructive">{session.error}</span>
          <button
            className="rounded-md border border-border px-2 py-1 text-foreground hover:bg-muted"
            onClick={connect}
            type="button"
          >
            Retry
          </button>
        </div>
      ) : null}
      <div
        className="relative min-h-0 flex-1 overflow-hidden bg-background"
        data-buzz-wheel-forwarding=""
        data-testid="workspace-web-surface"
        ref={surfaceRef}
      >
        {session.frame ? (
          <img
            alt={`Live browser page${session.url ? `: ${session.url}` : ""}`}
            className="block h-full w-full select-none"
            data-frame-scroll-y={session.frame.scrollOffsetY}
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
        ) : session.status === "connecting" ? (
          <div
            aria-live="polite"
            className="max-w-md p-8 text-center text-sm text-muted-foreground"
            data-testid="workspace-web-loading"
          >
            Starting browser...
          </div>
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

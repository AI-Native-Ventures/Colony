import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, RefreshCw } from "lucide-react";
import { electronDesktop } from "@/shared/api/electronNativeBridge";
import { useCommunities } from "@/features/communities/useCommunities";
import { updateTabPayload } from "../lib/workspaceTabs";
import { BrowserTeammateControls } from "./BrowserTeammateControls";
import type { TabBodyProps } from "./scratchpadKind";

type BrowserState = {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  error: string | null;
  controller: string;
  mode: "read" | "interact" | null;
};

/** Native Chromium view in the existing workspace tab, with React-owned controls. */
export function ElectronWebBody({ channelId, tab }: TabBodyProps) {
  const { activeCommunity } = useCommunities();
  const business = activeCommunity?.id;
  const api = electronDesktop();
  const payload = tab.payload as { url?: string } | null;
  const initialUrl =
    payload?.url && payload.url !== "about:blank"
      ? payload.url
      : "https://colony.ainative.ventures/";
  const [url, setUrl] = useState(initialUrl);
  const [state, setState] = useState<BrowserState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const address = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!api || !business) return;
    let alive = true;
    let frame = 0;
    let lastBounds = "";
    let ready = false;
    const updateBounds = () => {
      frame = 0;
      if (!ready || !surface.current) return;
      const rect = surface.current.getBoundingClientRect();
      const occluded = !!document.querySelector(
        '[role="dialog"], [role="menu"][data-state="open"], [data-radix-popper-content-wrapper]',
      );
      const request = {
        id: tab.id,
        business,
        visible: !document.hidden && !occluded,
        bounds: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      };
      const serialized = JSON.stringify(request);
      if (serialized === lastBounds) return;
      lastBounds = serialized;
      void api.request("browser:bounds", request).catch(() => {});
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(updateBounds);
    };
    const unsubscribe = api.subscribe((message) => {
      if (message.type !== "browser") return;
      const next = message.payload as BrowserState;
      if (next.id !== tab.id || !alive) return;
      setState(next);
      if (document.activeElement !== address.current) setUrl(next.url);
    });
    void api
      .request<BrowserState>("browser:open", {
        id: tab.id,
        business,
        url: initialUrl,
      })
      .then((value) => {
        if (alive) {
          setState(value);
          ready = true;
          schedule();
        }
      })
      .catch((reason) => {
        if (alive) setError(String(reason));
      });
    const resize = new ResizeObserver(schedule);
    if (surface.current) resize.observe(surface.current);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "data-state", "role"],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      unsubscribe();
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
      void api
        .request("browser:action", { id: tab.id, action: "hide" })
        .catch(() => {});
    };
  }, [api, business, tab.id, initialUrl]);

  function action(action: string) {
    setError(null);
    void api
      ?.request("browser:action", { id: tab.id, action })
      .catch((reason) => setError(String(reason)));
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="electron-web-body"
    >
      <form
        className="flex items-center gap-2 border-b p-2"
        onSubmit={(event) => {
          event.preventDefault();
          const target = url.includes("://") ? url : `https://${url}`;
          void api
            ?.request("browser:action", {
              id: tab.id,
              action: "navigate",
              url: target,
            })
            .then(() => {
              updateTabPayload(channelId, tab.id, { ...payload, url: target });
            })
            .catch((reason) => setError(String(reason)));
        }}
      >
        <button type="button" aria-label="Back" onClick={() => action("back")}>
          <ArrowLeft className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Forward"
          onClick={() => action("forward")}
        >
          <ArrowRight className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Reload"
          onClick={() => action("reload")}
        >
          <RefreshCw className="size-4" />
        </button>
        <input
          ref={address}
          aria-label="Website address"
          className="min-w-0 flex-1 rounded border bg-background px-3 py-1.5 text-sm"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <button type="submit" className="text-sm">
          Go
        </button>
        <button
          type="button"
          className="text-sm"
          onClick={() => action("takeover")}
        >
          Take control
        </button>
      </form>
      <div className="flex items-center gap-3 border-b px-3 py-1 text-xs text-muted-foreground">
        <span>
          {state?.loading
            ? "Loading…"
            : state?.controller === "You"
              ? "You are in control"
              : state?.controller || "Opening browser…"}
          {state?.mode &&
            ` · ${state.mode === "read" ? "read only" : "can interact"}`}
        </span>
        <Link
          to="/settings"
          search={{ section: "browser" }}
          className="underline"
        >
          Import sign-ins
        </Link>
        <BrowserTeammateControls tabId={tab.id} business={business} />
      </div>
      {(error || state?.error) && (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          {error || state?.error}
        </p>
      )}
      <div ref={surface} className="min-h-0 flex-1 bg-background" />
    </div>
  );
}

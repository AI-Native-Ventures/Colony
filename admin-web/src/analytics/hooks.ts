import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analyticsRequest, getAnalyticsSigner } from "./api";
import { OperatorSignerUnavailable, type OperatorSigner } from "./operatorAuth";
import type { AnalyticsEnvelope, AnalyticsQuery, PersonType } from "./types";

export interface AnalyticsResource<T> {
  data?: AnalyticsEnvelope<T>;
  error?: Error;
  loading: boolean;
  refetch: () => void;
}

export function useOperatorSigner(): OperatorSigner | undefined {
  const [signer, setSigner] = useState<OperatorSigner>();
  useEffect(() => {
    try {
      setSigner(getAnalyticsSigner());
    } catch {
      setSigner(undefined);
    }
  }, []);
  return signer;
}

export interface AnalyticsFilters {
  query: AnalyticsQuery;
  range: "24h" | "7d" | "30d" | "all";
  update: (next: Partial<AnalyticsQuery> & { range?: string }) => void;
}

function rangeValue(value: string | null): AnalyticsFilters["range"] {
  return value === "24h" || value === "7d" || value === "30d" ? value : "all";
}

function rangeBounds(
  range: AnalyticsFilters["range"],
): Pick<AnalyticsQuery, "start" | "end"> {
  if (range === "all") return {};
  const end = new Date();
  const start = new Date(end);
  const hours = range === "24h" ? 24 : range === "7d" ? 24 * 7 : 24 * 30;
  start.setTime(end.getTime() - hours * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function useAnalyticsFilters(): AnalyticsFilters {
  const [search, setSearch] = useState(() => location.search);
  useEffect(() => {
    const onPopState = () => setSearch(location.search);
    addEventListener("popstate", onPopState);
    return () => removeEventListener("popstate", onPopState);
  }, []);
  const update = useCallback(
    (next: Partial<AnalyticsQuery> & { range?: string }) => {
      const params = new URLSearchParams(location.search);
      const keys = [
        "community",
        "search",
        "type",
        "online",
        "family",
        "include_archived",
        "range",
      ];
      for (const key of keys) {
        const value = next[key as keyof typeof next];
        if (value === undefined) {
          if (key === "range" && next.range === undefined) continue;
          params.delete(key);
        } else if (value !== "") {
          params.set(key, String(value));
        } else {
          params.delete(key);
        }
      }
      if (next.range && next.range !== "all") params.set("range", next.range);
      if (next.range === "all") params.set("range", "all");
      const serialized = params.toString();
      history.replaceState(
        null,
        "",
        `${location.pathname}${serialized ? `?${serialized}` : ""}`,
      );
      dispatchEvent(new PopStateEvent("popstate"));
      setSearch(location.search);
    },
    [],
  );
  return useMemo(() => {
    const params = new URLSearchParams(search);
    const range = rangeValue(params.get("range"));
    const query: AnalyticsQuery = {
      community: params.get("community") || undefined,
      search: params.get("search") || undefined,
      type: (params.get("type") as PersonType | null) ?? undefined,
      online: params.has("online")
        ? params.get("online") === "true"
        : undefined,
      family:
        (params.get("family") as AnalyticsQuery["family"] | null) ?? undefined,
      include_archived: params.has("include_archived")
        ? params.get("include_archived") === "true"
        : undefined,
      range,
      ...rangeBounds(range),
    };
    return { query, range, update };
  }, [search, update]);
}

export function useAnalyticsResource<T>(
  path: string,
  options: { pollMs?: number; enabled?: boolean; signer?: OperatorSigner } = {},
): AnalyticsResource<T> {
  const { pollMs = 60_000, enabled = true, signer } = options;
  const [resource, setResource] = useState<{
    data?: AnalyticsEnvelope<T>;
    error?: Error;
    loading: boolean;
  }>({ loading: true });
  const [version, setVersion] = useState(0);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const refetch = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) return;
    void version;
    let activeRequest: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (!signer) {
        if (mounted.current) {
          setResource({
            loading: false,
            error: new OperatorSignerUnavailable(),
          });
        }
        return;
      }
      activeRequest?.abort();
      const controller = new AbortController();
      activeRequest = controller;
      setResource((current) => ({
        ...current,
        loading: true,
        error: undefined,
      }));
      try {
        const data = await analyticsRequest<T>(path, signer, {
          signal: controller.signal,
        });
        if (
          mounted.current &&
          !controller.signal.aborted &&
          activeRequest === controller
        ) {
          setResource({ data, loading: false });
        }
      } catch (error) {
        if (
          mounted.current &&
          !controller.signal.aborted &&
          activeRequest === controller
        ) {
          setResource((current) => ({
            ...current,
            loading: false,
            error:
              error instanceof Error ? error : new Error("Analytics failed"),
          }));
        }
      }
    };
    void load();
    if (pollMs > 0) {
      timer = setInterval(() => void load(), pollMs);
    }
    return () => {
      activeRequest?.abort();
      if (timer) clearInterval(timer);
    };
  }, [enabled, path, pollMs, signer, version]);

  return useMemo(() => ({ ...resource, refetch }), [refetch, resource]);
}

import type { Page, WebSocket } from "@playwright/test";

const MAX_ENTRIES = 200;
const MAX_FRAME_BYTES = 256 * 1024;
const EVENT_ID = /^[0-9a-f]{64}$/;
const PROPOSAL_ACTIONS = new Set([
  "agent.create",
  "agent.update",
  "agent.decline",
]);

function responseMetadata(message: unknown) {
  const text = typeof message === "string" ? message : "";
  const category = text.startsWith("rate-limited:")
    ? "rate-limited"
    : text.startsWith("auth-required:")
      ? "auth-required"
      : text.startsWith("invalid:")
        ? "invalid"
        : text.startsWith("blocked:")
          ? "blocked"
          : text === ""
            ? "empty"
            : "other";
  const retry = /retry in (\d+)s/i.exec(text);
  return {
    category,
    rateLimitReason:
      category !== "rate-limited"
        ? null
        : text.includes("quota exceeded")
          ? "quota"
          : text.includes("too many concurrent requests")
            ? "concurrent"
            : text.includes("shared admission unavailable")
              ? "unavailable"
              : "other",
    retryInSeconds: retry ? Math.min(Number(retry[1]), 300) : null,
  };
}

/** Observe only fixture proposal metadata; never retain frame bodies or keys. */
export function installBlocksLiveDiagnostics(
  page: Page,
  relayWsUrl: string,
  instanceEventIds: string[],
) {
  const instanceIds = new Set(
    instanceEventIds.filter((id) => EVENT_ID.test(id)),
  );
  const events = new Set<string>();
  const entries: Record<string, unknown>[] = [];
  const detach: (() => void)[] = [];
  let startedAt: number | null = null;
  let droppedEntries = 0;

  function record(entry: Record<string, unknown>) {
    if (startedAt === null) return;
    if (entries.length >= MAX_ENTRIES) {
      droppedEntries += 1;
      return;
    }
    entries.push({ elapsedMs: Date.now() - startedAt, ...entry });
  }

  function frame(direction: "sent" | "received", payload: string | Buffer) {
    if (startedAt === null || payload.length > MAX_FRAME_BYTES) return;
    let value: unknown;
    try {
      value = JSON.parse(
        typeof payload === "string" ? payload : payload.toString("utf8"),
      );
    } catch {
      return;
    }
    if (!Array.isArray(value)) return;
    if (direction === "received") {
      if (
        value[0] === "OK" &&
        events.has(value[1]) &&
        typeof value[2] === "boolean"
      ) {
        record({
          direction,
          type: "OK",
          eventId: value[1],
          accepted: value[2],
          ...responseMetadata(value[3]),
        });
      } else if (value[0] === "NOTICE") {
        record({ direction, type: "NOTICE", ...responseMetadata(value[1]) });
      }
      return;
    }
    const event = value[1];
    if (
      value[0] !== "EVENT" ||
      !event ||
      typeof event !== "object" ||
      typeof event.id !== "string" ||
      !EVENT_ID.test(event.id) ||
      ![40010, 40011].includes(event.kind) ||
      !Array.isArray(event.tags)
    )
      return;
    const instance = event.tags.find(
      (tag: unknown) =>
        Array.isArray(tag) && tag[0] === "e" && instanceIds.has(tag[1]),
    );
    if (!instance) return;
    const action = event.tags.find(
      (tag: unknown) => Array.isArray(tag) && tag[0] === "block-action",
    );
    if (event.kind === 40010 && !PROPOSAL_ACTIONS.has(action?.[2])) return;
    if (events.size >= MAX_ENTRIES && !events.has(event.id)) {
      droppedEntries += 1;
      return;
    }
    events.add(event.id);
    record({
      direction,
      type: "EVENT",
      eventId: event.id,
      kind: event.kind,
      instanceEventId: instance[1],
      ...(event.kind === 40010 ? { actionId: action[2] } : {}),
    });
  }

  function onSocket(socket: WebSocket) {
    if (new URL(socket.url()).href !== new URL(relayWsUrl).href) return;
    const sent = ({ payload }: { payload: string | Buffer }) =>
      frame("sent", payload);
    const received = ({ payload }: { payload: string | Buffer }) =>
      frame("received", payload);
    const closed = () => record({ type: "socket-closed" });
    socket.on("framesent", sent);
    socket.on("framereceived", received);
    socket.on("close", closed);
    detach.push(() => {
      socket.off("framesent", sent);
      socket.off("framereceived", received);
      socket.off("close", closed);
    });
  }

  page.on("websocket", onSocket);
  return {
    start() {
      startedAt = Date.now();
    },
    stop() {
      page.off("websocket", onSocket);
      for (const cleanup of detach) cleanup();
    },
    snapshot() {
      return { maxEntries: MAX_ENTRIES, droppedEntries, entries };
    },
  };
}

type ManifestRequestMetadata = {
  request: number;
  requestCategory: "manifest" | "catalog" | "roster";
  kind: number;
  manifestIds?: string[];
};

/** Observe only the fixture's manifest/trust REQs, without retaining payloads. */
export function installBlocksManifestDiagnostics(
  page: Page,
  relayWsUrl: string,
  options: { manifestIds: string[]; relaySelfPubkey: string },
) {
  const manifestIds = new Set(
    options.manifestIds.filter((id) => EVENT_ID.test(id)).slice(0, 10),
  );
  const targetUrl = new URL(relayWsUrl).href;
  const entries: Record<string, unknown>[] = [];
  const detach = new Set<() => void>();
  let startedAt: number | null = null;
  let stopped = false;
  let droppedEntries = 0;
  let trackedSubscriptions = 0;
  let nextRequest = 0;

  function record(entry: Record<string, unknown>) {
    if (startedAt === null || stopped) return;
    if (entries.length >= MAX_ENTRIES) {
      droppedEntries += 1;
      return;
    }
    entries.push({ elapsedMs: Date.now() - startedAt, ...entry });
  }

  function classify(
    filter: unknown,
  ): Omit<ManifestRequestMetadata, "request"> | null {
    if (!filter || typeof filter !== "object" || Array.isArray(filter))
      return null;
    const value = filter as Record<string, unknown>;
    if (!Array.isArray(value.kinds) || value.kinds.length !== 1) return null;
    const kind = value.kinds[0];
    if (
      kind === 40012 &&
      Array.isArray(value.ids) &&
      value.ids.length > 0 &&
      value.ids.length <= 10 &&
      value.ids.every((id) => typeof id === "string" && manifestIds.has(id))
    ) {
      return { requestCategory: "manifest", kind, manifestIds: [...value.ids] };
    }
    if (
      !EVENT_ID.test(options.relaySelfPubkey) ||
      !Array.isArray(value.authors) ||
      value.authors.length !== 1 ||
      value.authors[0] !== options.relaySelfPubkey
    )
      return null;
    if (kind === 13534) return { requestCategory: "roster", kind };
    if (
      kind === 30178 &&
      Array.isArray(value["#d"]) &&
      value["#d"].length === 1 &&
      value["#d"][0] === "lead-card"
    )
      return { requestCategory: "catalog", kind };
    return null;
  }

  function onSocket(socket: WebSocket) {
    if (stopped || new URL(socket.url()).href !== targetUrl) return;
    if (detach.size >= MAX_ENTRIES) {
      droppedEntries += 1;
      return;
    }
    const subscriptions = new Map<string, ManifestRequestMetadata>();
    function forget(id: string) {
      if (subscriptions.delete(id)) trackedSubscriptions -= 1;
    }
    function frame(direction: "sent" | "received", payload: string | Buffer) {
      if (startedAt === null || stopped) return;
      if (
        payload.length > MAX_FRAME_BYTES ||
        Buffer.byteLength(payload, "utf8") > MAX_FRAME_BYTES
      )
        return;
      let value: unknown;
      try {
        value = JSON.parse(
          typeof payload === "string" ? payload : payload.toString("utf8"),
        );
      } catch {
        return;
      }
      if (
        !Array.isArray(value) ||
        typeof value[1] !== "string" ||
        value[1].length > 128
      )
        return;
      const id = value[1];
      if (direction === "sent" && value[0] === "REQ") {
        forget(id);
        const metadata = value.length === 3 ? classify(value[2]) : null;
        if (!metadata) return;
        if (trackedSubscriptions >= MAX_ENTRIES) {
          droppedEntries += 1;
          return;
        }
        const request = { request: ++nextRequest, ...metadata };
        subscriptions.set(id, request);
        trackedSubscriptions += 1;
        record({ direction, type: "REQ", ...request });
        return;
      }
      const request = subscriptions.get(id);
      if (!request) return;
      if (direction === "sent" && value[0] === "CLOSE") {
        record({ direction, type: "CLOSE", ...request });
        forget(id);
      } else if (direction === "received" && value[0] === "EVENT") {
        const event = value[2];
        if (
          event &&
          typeof event === "object" &&
          typeof event.id === "string" &&
          EVENT_ID.test(event.id) &&
          event.kind === request.kind
        )
          record({
            direction,
            type: "EVENT",
            ...request,
            ...(request.requestCategory === "manifest" &&
            !request.manifestIds?.includes(event.id)
              ? { unexpectedEvent: true }
              : { eventId: event.id }),
          });
      } else if (direction === "received" && value[0] === "EOSE") {
        record({ direction, type: "EOSE", ...request });
        forget(id);
      } else if (direction === "received" && value[0] === "CLOSED") {
        record({
          direction,
          type: "CLOSED",
          ...request,
          ...responseMetadata(value[2]),
        });
        forget(id);
      }
    }
    const sent = ({ payload }: { payload: string | Buffer }) =>
      frame("sent", payload);
    const received = ({ payload }: { payload: string | Buffer }) =>
      frame("received", payload);
    const cleanup = () => {
      socket.off("framesent", sent);
      socket.off("framereceived", received);
      socket.off("close", closed);
      trackedSubscriptions -= subscriptions.size;
      subscriptions.clear();
      detach.delete(cleanup);
    };
    const closed = () => {
      if (subscriptions.size > 0) record({ type: "socket-closed" });
      cleanup();
    };
    socket.on("framesent", sent);
    socket.on("framereceived", received);
    socket.on("close", closed);
    detach.add(cleanup);
  }

  page.on("websocket", onSocket);
  return {
    start() {
      if (!stopped && startedAt === null) startedAt = Date.now();
    },
    stop() {
      stopped = true;
      page.off("websocket", onSocket);
      for (const cleanup of detach) cleanup();
    },
    snapshot() {
      return {
        maxEntries: MAX_ENTRIES,
        droppedEntries,
        trackedSubscriptions,
        entries: structuredClone(entries),
      };
    },
  };
}

/** Read bounded fixture query statuses; never serialize query keys/data/errors. */
export async function captureBlocksManifestQueryState(
  page: Page,
  manifestIds: string[],
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unavailable = () => ({
    available: false,
    maxEntries: 10,
    truncated: false,
    entries: [],
  });
  try {
    return await Promise.race([
      page
        .evaluate(
          (ids) => {
            const allowed = new Set(
              ids.filter((id) => /^[0-9a-f]{64}$/.test(id)).slice(0, 10),
            );
            const client = (
              window as unknown as {
                __BUZZ_E2E_QUERY_CLIENT__?: {
                  getQueryCache(): {
                    getAll(): {
                      queryKey: readonly unknown[];
                      state: {
                        status: unknown;
                        fetchStatus: unknown;
                        fetchFailureCount: unknown;
                        error: unknown;
                        fetchFailureReason: unknown;
                        data: unknown;
                      };
                    }[];
                  };
                };
              }
            ).__BUZZ_E2E_QUERY_CLIENT__;
            const entries: Record<string, unknown>[] = [];
            if (!client)
              return {
                available: false,
                maxEntries: 10,
                truncated: false,
                entries,
              };
            let truncated = false;
            for (const query of client.getQueryCache().getAll()) {
              const [queryType, , manifestId] = query.queryKey;
              if (
                (queryType !== "block-manifest" &&
                  queryType !== "block-data") ||
                typeof manifestId !== "string" ||
                !allowed.has(manifestId)
              )
                continue;
              if (entries.length >= 10) {
                truncated = true;
                break;
              }
              const { state } = query;
              const result =
                state.data &&
                typeof state.data === "object" &&
                !Array.isArray(state.data)
                  ? (state.data as Record<string, unknown>)
                  : null;
              const resultOk =
                typeof result?.ok === "boolean" ? result.ok : null;
              const resultCode =
                resultOk === false &&
                typeof result?.code === "string" &&
                [
                  "invalid-tags",
                  "invalid-json",
                  "invalid-manifest",
                  "invalid-data",
                  "invalid-event",
                  "missing-manifest",
                  "integrity-failed",
                  "unavailable",
                ].includes(result.code)
                  ? result.code
                  : null;
              const error = state.error ?? state.fetchFailureReason;
              const message = (
                error instanceof Error
                  ? error.message
                  : typeof error === "string"
                    ? error
                    : ""
              ).slice(0, 1024);
              const phase = message.startsWith(
                "Block manifest could not be loaded:",
              )
                ? "manifest-load"
                : message.startsWith("Block trust could not be established:")
                  ? "trust"
                  : queryType === "block-data" && error
                    ? "data-load"
                    : "unknown";
              const category = !error
                ? "none"
                : message.includes("rate-limited:")
                  ? "rate-limited"
                  : message.includes("auth-required:")
                    ? "auth-required"
                    : message.includes("invalid:")
                      ? "invalid"
                      : message.includes("blocked:")
                        ? "blocked"
                        : /timed out|timeout/i.test(message)
                          ? "timeout"
                          : "other";
              entries.push({
                queryType,
                manifestId,
                resultOk,
                resultCode,
                status:
                  typeof state.status === "string" &&
                  ["pending", "error", "success"].includes(state.status)
                    ? state.status
                    : "unknown",
                fetchStatus:
                  typeof state.fetchStatus === "string" &&
                  ["fetching", "paused", "idle"].includes(state.fetchStatus)
                    ? state.fetchStatus
                    : "unknown",
                failureCount:
                  typeof state.fetchFailureCount === "number" &&
                  Number.isFinite(state.fetchFailureCount)
                    ? Math.max(
                        0,
                        Math.min(1000, Math.floor(state.fetchFailureCount)),
                      )
                    : 0,
                errorCategory: category,
                errorPhase: phase,
              });
            }
            return { available: true, maxEntries: 10, truncated, entries };
          },
          manifestIds.filter((id) => EVENT_ID.test(id)).slice(0, 10),
        )
        .catch(unavailable),
      new Promise<ReturnType<typeof unavailable>>((resolve) => {
        timer = setTimeout(() => resolve(unavailable()), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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

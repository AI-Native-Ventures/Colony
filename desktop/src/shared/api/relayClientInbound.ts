import { handleRelayClosed } from "@/shared/api/relayClosedRecovery";
import {
  activateRateLimit,
  parseRateLimitHint,
} from "@/shared/api/relayRateLimitGate";
import {
  isServiceRestartClose,
  isWebSocketClose,
  isWebSocketError,
} from "@/shared/api/relayReconnectPolicy";
import { RECONNECT_BASE_DELAY_MS } from "@/shared/api/relayClientTimings";
import {
  getTextPayload,
  type RelaySubscription,
} from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";

/**
 * The instance surface `RelayClient` exposes to inbound frame dispatch.
 * Passed as closures so the sibling module stays decoupled from the class's
 * private state (same capability pattern as `relayEventPublisher`).
 */
export type InboundFrameCapabilities = {
  connectionGeneration: number;
  recordInbound(): void;
  resetConnection(error: Error): void;
  handleAuthChallenge(challenge: string, generation: number): Promise<void>;
  handleEvent(subId: string, event: RelayEvent): void;
  handleOk(eventId: string, success: boolean, message: string): void;
  handleEose(subId: string): void;
  sendRawWithReconnectRetry(
    payload: unknown[],
    fallbackMessage: string,
  ): Promise<void>;
  setReconnectDelay(ms: number): void;
};

/**
 * Dispatch one inbound relay frame. Stale generations are dropped before any
 * work; close/error frames reset the connection, and relay frames route to
 * the matching handler.
 */
export async function handleRelayWsMessage(
  subscriptions: Map<string, RelaySubscription>,
  caps: InboundFrameCapabilities,
  message: unknown,
  generation: number,
): Promise<void> {
  if (generation !== caps.connectionGeneration) return;
  caps.recordInbound();

  if (isWebSocketClose(message)) {
    if (isServiceRestartClose(message))
      caps.setReconnectDelay(RECONNECT_BASE_DELAY_MS);
    caps.resetConnection(new Error("Relay connection closed."));
    return;
  }
  if (isWebSocketError(message)) {
    caps.resetConnection(new Error("Relay connection errored."));
    return;
  }

  const payload = getTextPayload(message);
  if (!payload) {
    return;
  }

  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return;
  }

  if (!Array.isArray(data) || data.length === 0) {
    return;
  }

  const [type, ...rest] = data;
  if (type === "AUTH" && typeof rest[0] === "string") {
    await caps.handleAuthChallenge(rest[0], generation);
    return;
  }
  if (type === "EVENT" && typeof rest[0] === "string" && rest[1]) {
    caps.handleEvent(rest[0], rest[1] as RelayEvent);
    return;
  }

  if (
    type === "OK" &&
    typeof rest[0] === "string" &&
    typeof rest[1] === "boolean"
  ) {
    caps.handleOk(rest[0], rest[1], typeof rest[2] === "string" ? rest[2] : "");
    return;
  }

  if (type === "EOSE" && typeof rest[0] === "string") {
    caps.handleEose(rest[0]);
    return;
  }

  if (type === "CLOSED" && typeof rest[0] === "string") {
    handleRelayClosed({
      subscriptions,
      subId: rest[0],
      message: typeof rest[1] === "string" ? rest[1] : "",
      sendReq: (subId, filter) =>
        caps.sendRawWithReconnectRetry(
          ["REQ", subId, filter],
          "Failed to restore relay subscription after CLOSED.",
        ),
    });
    return;
  }

  if (type === "NOTICE" && typeof rest[0] === "string") {
    const notice: string = rest[0];
    // Relay back-pressure — arm the gate until the window expires.
    if (notice.startsWith("rate-limited:")) {
      activateRateLimit(parseRateLimitHint(notice));
    }
  }
}

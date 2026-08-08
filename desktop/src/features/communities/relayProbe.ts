/**
 * Normalize a relay URL to ws(s):// form and probe reachability.
 */

/**
 * Collapse every loopback spelling onto 127.0.0.1, preserving the port.
 *
 * The relay identifies a community by the request `Host`, and `localhost:3200`
 * and `127.0.0.1:3200` are two different communities to it, by design:
 * `verify_nip98_event` refuses to alias them because the `u`-tag host IS the
 * community binding. Meanwhile `buzz_core::relay::normalize_relay_url`
 * canonicalises loopback to 127.0.0.1 before the desktop injects
 * BUZZ_RELAY_URL into a managed agent.
 *
 * So a user who typed `localhost` got an app bound to one community and agents
 * bound to another, and every agent's WebSocket answered 404. Canonicalising
 * here, at the point of entry, keeps the app on the same spelling its own
 * agents will use. Non-loopback hosts are never rewritten.
 */
function canonicalizeLoopback(url: URL): URL {
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  ) {
    url.hostname = "127.0.0.1";
  }
  return url;
}

function parsed(raw: string): string | null {
  try {
    return canonicalizeLoopback(new URL(raw)).toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Normalize a user-entered relay URL to ws(s):// form. Returns null if invalid. */
export function normalizeRelayUrl(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return null;

  // Already ws(s)://
  if (trimmed.startsWith("wss://") || trimmed.startsWith("ws://")) {
    return parsed(trimmed);
  }

  // Convert https → wss, http → ws
  if (trimmed.startsWith("https://")) {
    return parsed(`wss://${trimmed.slice(8)}`);
  }
  if (trimmed.startsWith("http://")) {
    return parsed(`ws://${trimmed.slice(7)}`);
  }

  // Match the legacy add/edit community forms: a scheme-less host is assumed
  // to be a secure relay. Validation still rejects whitespace and malformed
  // values instead of blindly persisting the prefixed string.
  if (!trimmed.includes("://")) {
    return parsed(`wss://${trimmed}`);
  }

  return null;
}

/**
 * Probe whether a WebSocket relay is reachable. Opens a connection with a
 * timeout; resolves `true` if the socket opens, `false` on timeout/error.
 * The socket is always closed before returning.
 */
export function probeRelayReachable(
  wsUrl: string,
  timeoutMs = 4000,
): { promise: Promise<boolean>; cancel: () => void } {
  let socket: WebSocket | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  const promise = new Promise<boolean>((resolve) => {
    function settle(result: boolean) {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      socket = null;
      resolve(result);
    }

    try {
      socket = new WebSocket(wsUrl);
      socket.onopen = () => settle(true);
      socket.onerror = () => settle(false);
      socket.onclose = () => settle(false);
      timeoutId = setTimeout(() => settle(false), timeoutMs);
    } catch {
      settle(false);
    }
  });

  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      socket = null;
    },
  };
}

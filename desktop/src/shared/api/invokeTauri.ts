import { invoke } from "@/shared/api/nativeBridge";
import {
  activateRateLimit,
  parseRateLimitHint,
} from "@/shared/api/relayRateLimitGate";

/** Error normalized from a rejected Tauri invocation with its wire payload. */
export class TauriInvokeError extends Error {
  readonly payload: unknown;

  constructor(message: string, payload: unknown) {
    super(message);
    this.name = "TauriInvokeError";
    this.payload = payload;
  }
}

function toTauriError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string") {
    return new TauriInvokeError(error, error);
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return new TauriInvokeError(error.message, error);
  }

  try {
    return new TauriInvokeError(JSON.stringify(error), error);
  } catch {
    return new TauriInvokeError("Unknown Tauri error", error);
  }
}

/**
 * Inspect a Tauri error message and activate the shared rate-limit gate when
 * the Rust relay layer emitted an HTTP 429 response (`relay rate-limited:` prefix).
 *
 * Extracted so it can be unit-tested without mocking the Tauri invoke bridge.
 */
export function applyTauriRateLimitIfNeeded(message: string): void {
  if (message.startsWith("relay rate-limited:")) {
    activateRateLimit(parseRateLimitHint(message));
  }
}

export async function invokeTauri<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    const err = toTauriError(error);
    // Rust emits `relay rate-limited:` for HTTP 429 responses. Activate the
    // shared gate so the TS relay client backs off for the same window.
    applyTauriRateLimitIfNeeded(err.message);
    throw err;
  }
}

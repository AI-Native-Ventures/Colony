/**
 * Reading the message out of whatever a native call rejected with.
 *
 * Both shells forward a Rust `Result<_, String>` failure as a plain string
 * rejection rather than an `Error`, so a `caught instanceof Error` check drops
 * the host's own message and leaves the user with a generic line.
 */

/** Whether a value carries a usable message under `key`. */
function stringProperty(
  value: object,
  key: "error" | "message",
): string | null {
  const candidate = (value as Record<string, unknown>)[key];
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  return trimmed || null;
}

/**
 * The message to show for `caught`: an `Error`'s message, a non-empty string
 * rejection, or a string `error`/`message` property on an object. Anything
 * else falls back to `fallback`.
 */
export function nativeErrorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof Error) return caught.message || fallback;
  if (typeof caught === "string") return caught.trim() || fallback;
  if (typeof caught === "object" && caught !== null) {
    return (
      stringProperty(caught, "error") ??
      stringProperty(caught, "message") ??
      fallback
    );
  }
  return fallback;
}

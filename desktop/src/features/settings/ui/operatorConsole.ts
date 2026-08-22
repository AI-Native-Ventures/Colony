/**
 * Pure logic for the operator console settings card, split out so the
 * role gate and error mapping are unit-testable without a component mount.
 */

/** Relay roles that may open the deployment admin console. */
export function isOperatorRole(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** Copy shown while the membership query resolves. */
export function checkingAccessMessage(): string {
  return "Checking access…";
}

/** Copy for a signed-in identity that is not a relay admin. */
export function noAccessMessage(): string {
  return "The admin console is available to community admins only.";
}

/** Button label, reflecting the in-flight open request. */
export function buttonLabel(opening: boolean): string {
  return opening ? "Opening…" : "Open admin console";
}

/**
 * Map an unknown rejection from `open_operator_console` to user-facing copy.
 * Rust errors arrive as plain strings; prefer their message when present.
 */
export function consoleOpenErrorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) {
    return cause.message;
  }
  if (typeof cause === "string" && cause) {
    return cause;
  }
  return "The admin console did not open.";
}

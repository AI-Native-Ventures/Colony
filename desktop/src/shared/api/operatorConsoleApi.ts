import { invokeTauri } from "@/shared/api/tauri";

/**
 * Open (or focus) the operator console: the deployment admin dashboard in its
 * own webview, authenticated with this identity via the colonysigner bridge.
 * Only meaningful for relay owners/admins; the Rust side derives the admin
 * origin and refuses to sign for anything else.
 *
 * Lives outside `tauri.ts` because that file is under a line-count ratchet;
 * it still goes through the shared `invokeTauri` seam.
 */
export function openOperatorConsole(): Promise<void> {
  return invokeTauri("open_operator_console");
}

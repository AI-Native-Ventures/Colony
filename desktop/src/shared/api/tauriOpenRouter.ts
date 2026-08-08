import { invokeTauri } from "@/shared/api/tauri";

/**
 * Outcome of a `connect_openrouter` attempt.
 *
 * Mirrors the Rust `OpenRouterConnectOutcome` enum. On `connected` the caller
 * stores `key` through the existing provider-key path
 * (`set_global_agent_config` → `env_vars.OPENROUTER_API_KEY`).
 */
export type OpenRouterConnectOutcome =
  | { status: "connected"; key: string }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

/**
 * Run the OpenRouter OAuth PKCE "Connect OpenRouter" flow.
 *
 * Opens the system browser, waits for the authorization callback (up to 10
 * minutes), exchanges the code for a user-owned API key, and returns it.
 * Cancellation and failures are reported as outcomes — the app's stored
 * credentials are never modified by this command.
 *
 * On `connected`, store `key` through the existing provider-key path
 * (`setGlobalAgentConfig` with `env_vars.OPENROUTER_API_KEY`).
 */
export async function connectOpenRouter(): Promise<OpenRouterConnectOutcome> {
  return invokeTauri<OpenRouterConnectOutcome>("connect_openrouter");
}

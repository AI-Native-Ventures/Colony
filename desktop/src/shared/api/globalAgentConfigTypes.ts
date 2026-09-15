// Global agent configuration: the defaults every agent inherits, mirroring the
// Rust `GlobalAgentConfig` / `GlobalAgentConfigSaveResult` structs.

/**
 * Global agent configuration defaults applied to ALL agents.
 *
 * Lowest user-settable layer — per-agent and persona values win on any key
 * collision. Mirrors the Rust `GlobalAgentConfig` struct.
 *
 * Precedence: baked floor < global < persona < per-agent.
 */
export type GlobalAgentConfig = {
  /** Credential source for the global managed-agent defaults. */
  credential_mode: "byok" | "colony_credits";
  /** Global env vars injected into all agents unconditionally. */
  env_vars: Record<string, string>;
  /** Global fallback provider (e.g. "anthropic", "databricks_v2"). Null = no global default. */
  provider: string | null;
  /** Global fallback model identifier. Null = no global default. */
  model: string | null;
  /** Preferred ACP runtime for agents without a persona-specific runtime. */
  preferred_runtime: string | null;
  /**
   * Reasoning effort for the chosen model, named exactly as the provider named
   * it. Absent or null means the vendor's own default decides.
   *
   * Optional because the field is `#[serde(default)]` on the Rust side and a
   * config written before the Power screen had a Reasoning picker simply has no
   * key. Only ever a value the provider advertised for the selected model.
   */
  reasoning_effort?: string | null;
};

/**
 * Result returned by `set_global_agent_config`.
 *
 * Mirrors the Rust `GlobalAgentConfigSaveResult` struct.
 */
export type GlobalAgentConfigSaveResult = {
  /** The persisted global config (after strip-on-write). */
  config: GlobalAgentConfig;
  /** Number of local agents successfully stopped and restarted. */
  restarted_count: number;
  /** Number of agents whose stop succeeded but respawn failed. */
  failed_restart_count: number;
};

// desktop/src/features/onboarding/freshSignupDefaults.ts
/**
 * What a brand-new account's agent config starts as, before anyone chooses.
 *
 * This used to live inside `DefaultConfigStep`, the machine flow's fourth
 * screen, and ran when that screen mounted. The screen is gone: it asked
 * which brain the agents think with, which is the same question the canvas
 * flow's brain screen asks, and asking it twice in two vocabularies is what
 * made first run read as two products bolted together.
 *
 * The seeding itself was never the duplicated part, so it moved here rather
 * than being deleted with the screen. Without it a fresh account reaches the
 * workspace with no provider and no model, and its Chief of Staff cannot
 * start.
 */
import { getBakedBuildEnv, type BakedEnvEntry } from "@/shared/api/tauri";
import {
  getGlobalAgentConfig,
  setGlobalAgentConfig,
} from "@/shared/api/tauriGlobalAgentConfig";
import type { GlobalAgentConfig } from "@/shared/api/types";

/**
 * Seed the shipped OSS defaults only for a completely untouched account.
 *
 * Buzz Agent + OpenRouter is the default because it is the only combination
 * where a new user never handles an API key: `ProviderCredentialField` swaps
 * the paste field for the OAuth PKCE connect control whenever the effective
 * provider is `openrouter`, so onboarding is "authorize in your browser"
 * rather than "go find a key on another vendor's site". The model keeps the
 * previous DeepSeek V4 Flash cost profile, routed through OpenRouter.
 *
 * `OPENROUTER_BASE_URL` is intentionally unset — buzz-agent defaults it to
 * `https://openrouter.ai/api/v1` (crates/buzz-agent/src/config.rs), and the
 * normalized `model` field reaches the agent as `BUZZ_AGENT_MODEL`, which
 * satisfies the readiness model requirement without `OPENROUTER_MODEL`.
 */
export function seedFreshSignupDefaults(
  config: GlobalAgentConfig,
  bakedEnv: BakedEnvEntry[] = [],
): GlobalAgentConfig {
  if (
    config.preferred_runtime ||
    config.provider ||
    config.model ||
    (config.env_vars && Object.keys(config.env_vars).length > 0)
  ) {
    return config;
  }
  if (bakedEnv.some((entry) => entry.key === "BUZZ_AGENT_PROVIDER")) {
    return config;
  }
  return {
    ...config,
    preferred_runtime: "buzz-agent",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash",
    env_vars: { ...(config.env_vars ?? {}) },
  };
}

/** Everything this module touches outside itself, so the decision above can
 *  run under plain node with no Tauri host. */
export type FreshSignupDefaultsIo = {
  loadConfig: () => Promise<GlobalAgentConfig>;
  loadBakedEnv: () => Promise<BakedEnvEntry[]>;
  saveConfig: (config: GlobalAgentConfig) => Promise<unknown>;
};

const WIRED_IO: FreshSignupDefaultsIo = {
  loadConfig: getGlobalAgentConfig,
  loadBakedEnv: getBakedBuildEnv,
  saveConfig: setGlobalAgentConfig,
};

/**
 * Write the seed, unless this account already has agent defaults.
 *
 * Returns what was written, or null when nothing needed writing. Unlike the
 * screen this replaces, the write is eager rather than staged: there is no
 * longer a Save button to carry a draft to, and a founder who picks a brain
 * on the next screen overwrites it through `applyBrainChoice` anyway.
 *
 * A failure here is not fatal and callers treat it that way. Agent defaults
 * remain editable in Settings, and stranding someone in onboarding over a
 * config write would cost more than the config does.
 */
export async function applyFreshSignupDefaults(
  io: FreshSignupDefaultsIo = WIRED_IO,
): Promise<GlobalAgentConfig | null> {
  const [current, bakedEnv] = await Promise.all([
    io.loadConfig(),
    io.loadBakedEnv().catch(() => [] as BakedEnvEntry[]),
  ]);
  const seeded = seedFreshSignupDefaults(current, bakedEnv);
  if (seeded === current) return null;
  await io.saveConfig(seeded);
  return seeded;
}

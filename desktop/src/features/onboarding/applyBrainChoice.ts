/**
 * Make the brain a founder picked during onboarding the one their agents use.
 *
 * The canvas flow asks "Pick who does the thinking", records the answer in
 * `answers.brain`, and — until this module existed — did nothing else with it.
 * The choice reached the resumable draft and stopped there, so a founder who
 * picked Claude Code landed in a workspace whose Agent defaults still read
 * "Oh My Pi" with no model selected, and their Chief of Staff never answered.
 * Nothing errored: the config the agent starts from was simply never written.
 *
 * The older `OnboardingV2Flow` does write it (`configForAutomaticCli` on the
 * runtime it auto-selected). This is the same write, driven by an explicit
 * human choice instead of detection order.
 *
 * `resolveTrack` hands the screen runtime *labels*, not ids, so the label is
 * matched back to a catalog entry here. An unmatched label writes nothing
 * rather than guessing: a wrong `preferred_runtime` is a workspace whose
 * agents cannot start.
 */
import type {
  AcpRuntimeCatalogEntry,
  GlobalAgentConfig,
} from "@/shared/api/types";

import { discoverAcpRuntimes } from "@/shared/api/tauri";
import {
  getGlobalAgentConfig,
  setGlobalAgentConfig,
} from "@/shared/api/tauriGlobalAgentConfig";

import {
  COLONY_AGENT_RUNTIME_ID,
  configForAutomaticCli,
  defaultColonyAgentConfig,
} from "./automaticRuntime";

const WIRED_IO = {
  listRuntimes: discoverAcpRuntimes,
  loadConfig: getGlobalAgentConfig,
  saveConfig: setGlobalAgentConfig,
};

/** The sentinel the flow records when Colony does the thinking. */
export const COLONY_BRAIN_ANSWER = "colony";

/**
 * The config a brain choice implies, or null when nothing should be written.
 *
 * Pure so the decision can be tested without a Tauri host: every caller passes
 * the catalog and the current config in.
 */
export function planBrainConfig(
  runtimes: readonly AcpRuntimeCatalogEntry[],
  current: GlobalAgentConfig,
  brain: string | null,
): GlobalAgentConfig | null {
  const chosen = brain?.trim();
  if (!chosen) return null;

  // Both spellings of "Colony does the thinking" resolve without consulting
  // the catalog. `COLONY_BRAIN_ANSWER` is what the flow recorded while the
  // screen dealt in labels, and older resumable drafts still carry it; the
  // runtime id is what it records now. Neither may depend on the hosted agent
  // being present in the catalog, because it is hosted: a probe that came back
  // empty must still be able to write the config for it.
  if (chosen === COLONY_BRAIN_ANSWER || chosen === COLONY_AGENT_RUNTIME_ID) {
    return defaultColonyAgentConfig(current);
  }

  // The screen deals in ids; drafts written before it did carry labels. Match
  // on either so a resumed run is not silently ignored.
  const runtime = runtimes.find(
    (candidate) => candidate.label === chosen || candidate.id === chosen,
  );
  if (!runtime) return null;
  if (runtime.id === COLONY_AGENT_RUNTIME_ID) {
    return defaultColonyAgentConfig(current);
  }

  return configForAutomaticCli(current, runtime.id);
}

/**
 * Everything this module touches outside itself, so the decision above can run
 * under plain node with no Tauri host.
 */
export type ApplyBrainChoiceIo = {
  listRuntimes: () => Promise<AcpRuntimeCatalogEntry[]>;
  loadConfig: () => Promise<GlobalAgentConfig>;
  saveConfig: (config: GlobalAgentConfig) => Promise<unknown>;
};

/** Apply the chosen brain to the global agent defaults. */
export async function applyBrainChoice(
  brain: string | null,
  io: ApplyBrainChoiceIo = WIRED_IO,
): Promise<GlobalAgentConfig | null> {
  if (!brain?.trim()) return null;
  const [runtimes, current] = await Promise.all([
    io.listRuntimes(),
    io.loadConfig(),
  ]);
  const next = planBrainConfig(runtimes, current, brain);
  if (!next) return null;
  await io.saveConfig(next);
  return next;
}

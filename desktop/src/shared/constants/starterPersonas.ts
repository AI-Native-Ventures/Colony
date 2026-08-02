// Display names for the built-in starter personas, keyed by their stable
// persona IDs. Must mirror BUILT_IN_PERSONAS in
// desktop/src-tauri/src/managed_agents/personas.rs — the Rust side is
// authoritative for the real backend. Every UI surface, the E2E bridge, and
// the E2E specs read names from here, so a rename is one edit per side
// (this file + personas.rs) instead of a breaking change scattered across
// dozens of literals.
//
// Behaviour must never key off these names: match on the persona ID
// (`builtin:fizz`), a role ID (`chief-of-staff`), or a pubkey. Names are
// presentation and mention text only.

export const STARTER_PERSONA_IDS = {
  bumble: "builtin:bumble",
  fizz: "builtin:fizz",
  honey: "builtin:honey",
} as const;

export type StarterPersonaId =
  (typeof STARTER_PERSONA_IDS)[keyof typeof STARTER_PERSONA_IDS];

export const STARTER_PERSONA_NAMES: Record<StarterPersonaId, string> = {
  [STARTER_PERSONA_IDS.bumble]: "Bumble",
  [STARTER_PERSONA_IDS.fizz]: "Fizz",
  [STARTER_PERSONA_IDS.honey]: "Honey",
};

/** Kickoff display order: lead first, then teammates. */
export const STARTER_PERSONA_ORDER: readonly StarterPersonaId[] = [
  STARTER_PERSONA_IDS.fizz,
  STARTER_PERSONA_IDS.honey,
  STARTER_PERSONA_IDS.bumble,
];

export function starterPersonaName(id: StarterPersonaId): string {
  return STARTER_PERSONA_NAMES[id];
}

/** Animated onboarding APNGs (desktop/public), keyed by persona ID. */
const STARTER_PERSONA_ANIMATIONS: Record<StarterPersonaId, string> = {
  [STARTER_PERSONA_IDS.bumble]: "/onboarding/starter-team/bumble.png",
  [STARTER_PERSONA_IDS.fizz]: "/onboarding/starter-team/fizz.png",
  [STARTER_PERSONA_IDS.honey]: "/onboarding/starter-team/honey.png",
};

function isStarterPersonaId(id: string): id is StarterPersonaId {
  return id in STARTER_PERSONA_NAMES;
}

/** Animation URL for a persona ID, or null for non-starter personas. */
export function starterPersonaAnimation(id: string): string | null {
  return isStarterPersonaId(id) ? STARTER_PERSONA_ANIMATIONS[id] : null;
}

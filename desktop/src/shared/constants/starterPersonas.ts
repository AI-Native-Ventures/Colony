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
  [STARTER_PERSONA_IDS.bumble]: "Tender",
  [STARTER_PERSONA_IDS.fizz]: "Scout",
  [STARTER_PERSONA_IDS.honey]: "Forager",
};

/**
 * The starting lineup a new company opens with, in display order.
 *
 * Scout alone. Forager and Tender still exist as built-in definitions, and an
 * install that already has them keeps them, but they are no longer seeded
 * active for a fresh company. Mirrors `default_active` in
 * desktop/src-tauri/src/managed_agents/personas.rs, which is authoritative.
 *
 * This is the lineup, not the catalog: iterate it to render what a new company
 * starts with, never to enumerate every built-in persona.
 */
export const STARTER_PERSONA_ORDER: readonly StarterPersonaId[] = [
  STARTER_PERSONA_IDS.fizz,
];

export function starterPersonaName(id: StarterPersonaId): string {
  return STARTER_PERSONA_NAMES[id];
}

/** Animated onboarding APNGs (desktop/public), keyed by persona ID. */
const STARTER_PERSONA_ANIMATIONS: Record<StarterPersonaId, string> = {
  [STARTER_PERSONA_IDS.bumble]: "/onboarding/starter-team/tender.png",
  [STARTER_PERSONA_IDS.fizz]: "/onboarding/starter-team/scout.png",
  [STARTER_PERSONA_IDS.honey]: "/onboarding/starter-team/forager.png",
};

function isStarterPersonaId(id: string): id is StarterPersonaId {
  return id in STARTER_PERSONA_NAMES;
}

/** Animation URL for a persona ID, or null for non-starter personas. */
export function starterPersonaAnimation(id: string): string | null {
  return isStarterPersonaId(id) ? STARTER_PERSONA_ANIMATIONS[id] : null;
}

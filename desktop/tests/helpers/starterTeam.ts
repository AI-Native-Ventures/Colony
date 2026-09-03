import {
  STARTER_PERSONA_IDS,
  STARTER_PERSONA_ORDER,
  starterPersonaAnimation,
  starterPersonaName,
} from "../../src/shared/constants/starterPersonas";

// Starter-team names exactly as the product ships them. Specs that type
// mentions at bridge-seeded starter personas, or assert product copy that
// embeds a starter name, derive their strings from here so a product rename
// is a constants change, not a spec rewrite. Self-consistent literals a spec
// both seeds and asserts (arbitrary message content, spec-created agent
// names) do not need these.
export { STARTER_PERSONA_IDS, STARTER_PERSONA_ORDER, starterPersonaAnimation };

export const GUIDE_NAME = starterPersonaName(STARTER_PERSONA_IDS.fizz);
export const SECOND_NAME = starterPersonaName(STARTER_PERSONA_IDS.honey);
export const THIRD_NAME = starterPersonaName(STARTER_PERSONA_IDS.bumble);

/**
 * Every built-in persona name, for specs that seed all three and assert on the
 * catalog. This is the catalog, NOT the starting lineup: a new company is
 * seeded with `STARTER_LINEUP_NAMES` only, and a spec that wants all three has
 * to activate them itself through `activePersonaIds`.
 */
export const STARTER_NAMES: readonly string[] = [
  GUIDE_NAME,
  SECOND_NAME,
  THIRD_NAME,
];

/** What a fresh company actually starts with. */
export const STARTER_LINEUP_NAMES: readonly string[] =
  STARTER_PERSONA_ORDER.map(starterPersonaName);

/** `@fizz`-style mention token for a display name. */
export function mentionToken(name: string) {
  return `@${name.toLowerCase()}`;
}

/**
 * The partial mention a spec types to summon the autocomplete, e.g. `@fi`.
 * Two characters is enough to be unambiguous among the starter names.
 */
export function mentionPrefix(name: string, characters = 2) {
  return `@${name.toLowerCase().slice(0, characters)}`;
}

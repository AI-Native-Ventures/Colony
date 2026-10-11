/**
 * The first word a stranger should never meet in our videos, if `src` has
 * one. "AI agents" is allowed: on 2026-10-11 the owner asked for AI
 * employees to be defined as AI agents.
 */
export function bannedWord(src: string): string | undefined {
  return src
    .replace(/\bAI agents\b/g, "")
    .match(
      /\b(agents?|workspaces?|models?|channels?|relays?|tokens?|nostr)\b/i,
    )?.[0];
}

/**
 * Phase 1 Colony Credits eligibility shared by the settings handle. Keep the
 * runtime/provider matrix identical to the Tauri preflight: Codex is
 * OpenAI-compatible by construction; Goose and Buzz Agent require an
 * OpenAI-compatible provider; subscription/custom runtimes stay BYOK.
 */
export function isColonyCreditsEligible(
  runtimeId: string,
  provider: string | null | undefined,
): boolean {
  if (runtimeId === "codex") return true;
  if (runtimeId !== "goose" && runtimeId !== "buzz-agent") return false;
  const normalized = provider?.trim().toLowerCase();
  return normalized === "openai" || normalized === "openai-compat";
}

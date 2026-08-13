/**
 * Curated one-line descriptions for harness catalog entries.
 *
 * Content policy (agreed in the BYOH UX thread): exactly ONE neutral,
 * vendor-sourced category sentence per entry — what kind of tool it is —
 * with provenance cited inline. No feature inventories, no marketing
 * superlatives, no volatile model/provider claims. Operational setup copy
 * (status, hints) stays generated from runtime state, never hand-authored
 * here. Research: ~/.buzz/RESEARCH/BYOH_CATALOG_IA.md.
 */

const HARNESS_DESCRIPTIONS: Record<string, string> = {
  // Built-in runtimes.
  "buzz-agent": "Colony's built-in agent runtime, bundled with the app.",
  // Source: https://code.claude.com/docs/en/overview — "Claude Code is an
  // agentic coding tool" that lives in the terminal.
  claude: "Anthropic's agentic coding tool that runs in the terminal.",
  // Source: https://developers.openai.com/codex — "Codex is OpenAI's coding
  // agent".
  codex: "OpenAI's coding agent, connected through the codex-acp adapter.",

  // Bundled presets — sources per RESEARCH/BYOH_CATALOG_IA.md.
  // Source: https://github.com/can1357/oh-my-pi
  omp: "A terminal coding agent with integrated development tools.",
  // Source: https://github.com/anomalyco/opencode
  opencode: "An open-source coding agent.",
  // Source: https://github.com/PrimeIntellect-ai/prime-agent
  "prime-agent": "An open-source coding agent from Prime Intellect.",
};

/**
 * One neutral sentence describing the harness, or null for entries we don't
 * curate (customs, unknown ids). Callers must render nothing rather than
 * invent copy.
 */
export function harnessDescription(id: string): string | null {
  return HARNESS_DESCRIPTIONS[id.trim().toLowerCase()] ?? null;
}

/**
 * Shared presentation for website job agent identities. The record supplies
 * pubkeys; the caller supplies names, roles, and Colony color tokens, so the
 * UI renders identity from canonical data instead of inventing names.
 */

export const WEBSITE_AGENT_FALLBACK_CLASS = "bg-accent text-accent-foreground";

const AGENT_COLOR_CLASS: Record<string, string> = {
  violet: "bg-violet-500/20 text-violet-700 dark:text-violet-300",
  blue: "bg-blue-500/20 text-blue-700 dark:text-blue-300",
  coral: "bg-rose-500/20 text-rose-700 dark:text-rose-300",
  rose: "bg-rose-500/20 text-rose-700 dark:text-rose-300",
  green: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300",
  teal: "bg-teal-500/20 text-teal-700 dark:text-teal-300",
  amber: "bg-amber-500/20 text-amber-700 dark:text-amber-300",
  lime: "bg-lime-500/20 text-lime-700 dark:text-lime-300",
};

const AGENT_DOT_CLASS: Record<string, string> = {
  violet: "bg-violet-500",
  blue: "bg-blue-500",
  coral: "bg-rose-500",
  rose: "bg-rose-500",
  green: "bg-emerald-500",
  teal: "bg-teal-500",
  amber: "bg-amber-500",
  lime: "bg-lime-500",
};

export function websiteAgentColorClass(color: string | undefined): string {
  return (color && AGENT_COLOR_CLASS[color]) || WEBSITE_AGENT_FALLBACK_CLASS;
}

export function websiteAgentDotClass(color: string | undefined): string {
  return (color && AGENT_DOT_CLASS[color]) || "bg-muted-foreground/50";
}

export function websiteAgentInitial(name: string | undefined): string {
  return name?.trim()?.[0]?.toUpperCase() ?? "?";
}

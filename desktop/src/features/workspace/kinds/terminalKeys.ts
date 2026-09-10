export type ResolveResult = "copy" | "paste" | "search" | "clear" | "pass";

export interface ResolveOptions {
  hasSelection: boolean;
  platform: "mac" | "other";
}

export function resolveTerminalKey(
  event: {
    metaKey?: boolean;
    ctrlKey?: boolean;
    key?: string;
    shiftKey?: boolean;
  },
  { hasSelection, platform }: ResolveOptions,
): ResolveResult {
  const isMac = platform === "mac";
  const cmd = isMac ? event.metaKey : event.ctrlKey;
  const key = event.key ?? "";

  if (cmd && key === "c") {
    if (hasSelection) return "copy";
    return "pass"; // SIGINT without selection
  }

  if (cmd && key === "v") {
    return "paste";
  }

  if (cmd && key === "f") {
    return "search";
  }

  if (cmd && key === "k") {
    return "clear";
  }

  return "pass";
}

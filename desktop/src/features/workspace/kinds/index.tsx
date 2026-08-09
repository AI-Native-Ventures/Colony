import type * as React from "react";

import { registerTabKind } from "@/features/workspace/lib/tabKindRegistry";
import {
  ScratchpadBody,
  scratchpadKindDefinition,
  type TabBodyProps,
} from "@/features/workspace/kinds/scratchpadKind";

/**
 * Kind string to body component.
 *
 * Kept separate from the registry so the registry stays a plain `.ts` module
 * that the `node --test` type-stripper can load without JSX.
 */
const bodies = new Map<string, React.ComponentType<TabBodyProps>>();

let registered = false;

/** Look up the body for a kind. Unknown kinds render a fallback in the shell. */
export function getTabBody(
  kind: string,
): React.ComponentType<TabBodyProps> | undefined {
  return bodies.get(kind);
}

/**
 * Register every shipping kind. Idempotent, because the workspace shell calls
 * it on mount and a channel remount must not throw on a duplicate kind.
 */
export function registerAllTabKinds(): void {
  if (registered) return;
  registered = true;
  registerTabKind(scratchpadKindDefinition);
  bodies.set(scratchpadKindDefinition.kind, ScratchpadBody);
}

export type { TabBodyProps };

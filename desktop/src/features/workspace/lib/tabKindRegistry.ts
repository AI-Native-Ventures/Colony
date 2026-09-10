import type { WorkspaceTab } from "@/features/workspace/lib/workspaceTabs";
import type { Project } from "@/features/projects/projectModels";

/**
 * What the workspace needs to know about a tab kind.
 *
 * Everything kind-specific lives behind this definition. The workspace shell
 * looks a kind up, asks it for a title and an initial payload, and renders the
 * body registered for it. It never branches on the kind string itself.
 */
export type TabKindContext = {
  channelId: string;
  projects: readonly Project[] | undefined;
};

export type TabKindDefinition = {
  /** Stable identifier stored on the tab. Never renamed once shipped. */
  kind: string;
  /** Human-facing name in the new-tab page and tab context menus. */
  label: string;
  /** Title a freshly created tab gets. */
  createTitle: () => string;
  /** Initial kind-scoped payload. Opaque to the workspace layer. */
  createPayload: () => unknown;
  /**
   * Whether the new-tab page offers this kind. A kind can be registered and
   * fully functional while staying out of shipped UI, which is how the
   * kind-agnostic contract is proven without building a second surface.
   */
  /** Optional: whether this kind is available for the given channel/project context. */
  isAvailable?: (context: TabKindContext) => boolean;
  canCreateFromNewTabPage: boolean;
  /** Optional kind-owned cleanup before the shell removes a tab. */
  dispose?: (tab: WorkspaceTab) => void | Promise<void>;
};

const registry = new Map<string, TabKindDefinition>();

/** Register a kind. Throws on a duplicate: that is always a wiring bug. */
export function registerTabKind(definition: TabKindDefinition): void {
  if (registry.has(definition.kind)) {
    throw new Error(`tab kind "${definition.kind}" is already registered`);
  }
  registry.set(definition.kind, definition);
}

/** Look a kind up. Unknown kinds resolve to undefined, never throw: a tab
 * restored from storage may name a kind this build does not have. */
export function getTabKind(kind: string): TabKindDefinition | undefined {
  return registry.get(kind);
}

/** Kinds the new-tab page should offer, in registration order.
 *  When `context` is provided, kinds whose `isAvailable` returns false are hidden. */
export function listCreatableTabKinds(
  context?: TabKindContext,
): TabKindDefinition[] {
  return [...registry.values()].filter((definition) => {
    if (!definition.canCreateFromNewTabPage) return false;
    if (context && definition.isAvailable && !definition.isAvailable(context))
      return false;
    return true;
  });
}

/** Test-only: empty the registry between cases. */
export function clearTabKindRegistry(): void {
  registry.clear();
}

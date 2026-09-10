import * as React from "react";

/**
 * What a tile inside the Factory canvas may ask the canvas to do.
 *
 * A tile is rendered by the workspace's kind registry, several layers below
 * the component that owns the tile tree, so it has no route to the tree by
 * props. The canvas provides this; a tile dragged out of the Factory into the
 * plain workspace strip renders with no provider above it, and reads `null` —
 * which is why every consumer must handle its absence rather than assume the
 * Factory is there.
 */
export type FactoryTileActions = {
  /** Agents on tiles in this Factory, in tab order. */
  agents: ReadonlyArray<{ tabId: string; pubkey: string; title: string }>;
  /**
   * Put an agent's tile in the pane to the right of `sourceTabId`, splitting
   * that pane when nothing is there yet. Focuses an existing tile instead of
   * opening a second one for the same agent.
   */
  openAgentBeside: (
    sourceTabId: string,
    agent: { pubkey: string; name: string; threadRootId: string | null },
  ) => void;
  /** Open the launcher with the brief already started. */
  openLauncher: (briefPrefill: string) => void;
  /** Open a terminal in the same pane as `sourceTabId`, pinned to `cwd`. */
  openTerminalHere: (
    sourceTabId: string,
    options: { cwd: string; title: string },
  ) => void;
};

const FactoryTileContext = React.createContext<FactoryTileActions | null>(null);

export function FactoryTileProvider({
  actions,
  children,
}: {
  actions: FactoryTileActions;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <FactoryTileContext.Provider value={actions}>
      {children}
    </FactoryTileContext.Provider>
  );
}

/** The Factory's actions, or null when this tile is not inside a Factory. */
export function useFactoryTileActions(): FactoryTileActions | null {
  return React.useContext(FactoryTileContext);
}

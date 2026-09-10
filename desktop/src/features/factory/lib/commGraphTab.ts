/**
 * The graph tab's identity, separate from its kind definition.
 *
 * The Factory toolbar opens the graph, and the kind definition lives in
 * `workspace/kinds` next to the factory's own — importing that module from the
 * toolbar closes a cycle (`kinds/index` → `factoryKind` → `FactoryToolbar` →
 * `commGraphKind`) whose evaluation order left the kind unregistered. Both
 * sides read these constants instead.
 */
export const COMM_GRAPH_TAB_KIND = "comm-graph";
export const COMM_GRAPH_TAB_TITLE = "Graph";

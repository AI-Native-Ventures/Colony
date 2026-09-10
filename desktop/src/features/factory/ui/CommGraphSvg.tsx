import type * as React from "react";

import {
  commGraphEdgeGeometry,
  layoutCommGraph,
  type CommGraphNodePosition,
} from "@/features/factory/lib/commGraphLayout";
import type {
  CommGraph,
  CommGraphEdge,
} from "@/features/factory/lib/commGraph";

/** How one node is labelled. Resolved by the tile, never by the SVG. */
export type CommGraphPerson = {
  pubkey: string;
  name: string;
  initials: string;
  /** Role subtitle under the name: "owner", a job title, "Agent". */
  role: string;
};

export type CommGraphSelection = { a: string; b: string } | null;

/** Whether a pair is the selected one, in either direction. */
export function isSelectedPair(
  selection: CommGraphSelection,
  from: string,
  to: string,
): boolean {
  if (!selection) return false;
  return (
    (selection.a === from && selection.b === to) ||
    (selection.a === to && selection.b === from)
  );
}

export type CommGraphSvgProps = {
  graph: CommGraph;
  people: ReadonlyMap<string, CommGraphPerson>;
  selection: CommGraphSelection;
  onSelectPair: (pair: { a: string; b: string }) => void;
};

export function CommGraphSvg({
  graph,
  people,
  selection,
  onSelectPair,
}: CommGraphSvgProps): React.JSX.Element {
  const layout = layoutCommGraph(graph.nodes);
  const positions = new Map<string, CommGraphNodePosition>(
    layout.positions.map((position) => [position.pubkey, position]),
  );

  return (
    <svg
      viewBox={layout.viewBox}
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full"
      data-testid="comm-graph-svg"
      role="img"
      aria-label="Communication graph"
    >
      <defs>
        <marker
          id="comm-graph-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L10 5 L0 10 z" fill="context-stroke" />
        </marker>
      </defs>

      {graph.edges.map((edge) => (
        <EdgeMark
          key={`${edge.from}-${edge.to}-${edge.kind}`}
          edge={edge}
          from={positions.get(edge.from)}
          to={positions.get(edge.to)}
          selected={isSelectedPair(selection, edge.from, edge.to)}
          onSelect={onSelectPair}
        />
      ))}

      {layout.positions.map((position) => (
        <NodeMark
          key={position.pubkey}
          position={position}
          person={people.get(position.pubkey)}
          selected={
            selection !== null &&
            (selection.a === position.pubkey || selection.b === position.pubkey)
          }
        />
      ))}
    </svg>
  );
}

function EdgeMark({
  edge,
  from,
  to,
  selected,
  onSelect,
}: {
  edge: CommGraphEdge;
  from: CommGraphNodePosition | undefined;
  to: CommGraphNodePosition | undefined;
  selected: boolean;
  onSelect: (pair: { a: string; b: string }) => void;
}): React.JSX.Element | null {
  if (!from || !to) return null;
  const geometry = commGraphEdgeGeometry(
    from,
    to,
    edge.kind === "ask" ? 46 : 30,
  );
  const isAsk = edge.kind === "ask";
  const stroke = selected
    ? "stroke-primary"
    : isAsk
      ? "stroke-warning"
      : "stroke-muted-foreground";
  const label = isAsk
    ? `${edge.count} open ask${edge.count === 1 ? "" : "s"}`
    : String(edge.count);

  return (
    // biome-ignore lint/a11y/useSemanticElements: <button> is not valid SVG content, so the edge carries the button role on its <g>
    <g
      // A focused edge is already redrawn in the selected colour, and the
      // default ring outlines the curve's whole bounding box, so keep the ring
      // for keyboard focus only.
      className="cursor-pointer focus:outline-none focus-visible:outline-2 focus-visible:outline-ring"
      data-testid={`comm-graph-edge-${edge.from}-${edge.to}`}
      data-count={edge.count}
      data-kind={edge.kind}
      data-selected={selected ? "true" : "false"}
      role="button"
      tabIndex={0}
      aria-label={`${label} from ${edge.from} to ${edge.to}`}
      aria-pressed={selected}
      onClick={() => onSelect({ a: edge.from, b: edge.to })}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect({ a: edge.from, b: edge.to });
      }}
    >
      {/* A wide invisible twin of the curve: the 1.5-unit stroke is far too
          thin to click at this scale. */}
      <path
        d={geometry.path}
        className="fill-none stroke-transparent"
        strokeWidth={16}
      />
      <path
        d={geometry.path}
        className={`fill-none ${stroke} ${selected ? "opacity-100" : "opacity-70"}`}
        strokeWidth={selected ? 2.5 : 1.5}
        strokeDasharray={isAsk ? "5 4" : undefined}
        markerEnd="url(#comm-graph-arrow)"
      />
      <text
        x={geometry.labelX}
        y={geometry.labelY}
        textAnchor="middle"
        className={`text-2xs ${
          selected
            ? "fill-primary font-bold"
            : isAsk
              ? "fill-warning"
              : "fill-muted-foreground"
        }`}
      >
        {label}
      </text>
    </g>
  );
}

function NodeMark({
  position,
  person,
  selected,
}: {
  position: CommGraphNodePosition;
  person: CommGraphPerson | undefined;
  selected: boolean;
}): React.JSX.Element {
  const isOwner = position.kind === "owner";
  return (
    <g data-testid={`comm-graph-node-${position.pubkey}`}>
      <circle
        cx={position.x}
        cy={position.y}
        r={position.radius}
        className={
          isOwner
            ? "fill-primary stroke-primary"
            : selected
              ? "fill-muted stroke-primary"
              : "fill-muted stroke-border"
        }
        strokeWidth={1.5}
      />
      <text
        x={position.x}
        y={position.y + 5}
        textAnchor="middle"
        className={`text-sm font-bold ${isOwner ? "fill-primary-foreground" : "fill-foreground"}`}
      >
        {person?.initials ?? ""}
      </text>
      <text
        x={position.x}
        y={position.nameY}
        textAnchor="middle"
        className="fill-foreground text-xs"
      >
        {person?.name ?? ""}
      </text>
      <text
        x={position.x}
        y={position.roleY}
        textAnchor="middle"
        className="fill-muted-foreground text-2xs"
      >
        {person?.role ?? ""}
      </text>
    </g>
  );
}

/**
 * Layout for the communication graph: owner on the left, agents on an arc to
 * its right, all in one fixed viewBox so the SVG scales with its pane instead
 * of needing a measured container.
 *
 * Pure geometry, no React and no DOM: the tile only maps the numbers onto
 * `<path>` and `<text>`.
 */
import type { CommGraphNode } from "./commGraph";

export const COMM_GRAPH_VIEW_WIDTH = 640;
export const COMM_GRAPH_VIEW_HEIGHT = 460;

/** Node circle radius, in viewBox units. */
export const COMM_GRAPH_NODE_RADIUS = 26;

const OWNER_X = 118;
const CENTER_Y = COMM_GRAPH_VIEW_HEIGHT / 2;
// An ellipse rather than a circle: the pane is wider than it is tall, so a
// circular arc pushed the top and bottom agents (and their labels) outside the
// viewBox.
const ARC_RADIUS_X = 400;
const ARC_RADIUS_Y = 148;
const ARC_SPREAD_RADIANS = (52 * Math.PI) / 180;

/** Baseline offsets below a node's centre for its two label lines. */
const NAME_LABEL_OFFSET = COMM_GRAPH_NODE_RADIUS + 18;
const ROLE_LABEL_OFFSET = COMM_GRAPH_NODE_RADIUS + 33;

export type CommGraphNodePosition = {
  pubkey: string;
  kind: CommGraphNode["kind"];
  x: number;
  y: number;
  radius: number;
  /** Baseline for the display-name line. */
  nameY: number;
  /** Baseline for the role subtitle line. */
  roleY: number;
};

export type CommGraphLayout = {
  viewBox: string;
  width: number;
  height: number;
  positions: readonly CommGraphNodePosition[];
};

export type CommGraphEdgeGeometry = {
  /** A quadratic path, trimmed to the circle edges at both ends. */
  path: string;
  /** Where the count label sits, just off the curve's midpoint. */
  labelX: number;
  labelY: number;
};

/** How far an edge bows off the straight line between two nodes. */
const EDGE_BOW = 30;
/** Gap left at the target end so the arrow marker is not buried in the node. */
const ARROW_CLEARANCE = 11;

function position(
  node: CommGraphNode,
  x: number,
  y: number,
): CommGraphNodePosition {
  return {
    pubkey: node.pubkey,
    kind: node.kind,
    x,
    y,
    radius: COMM_GRAPH_NODE_RADIUS,
    nameY: y + NAME_LABEL_OFFSET,
    roleY: y + ROLE_LABEL_OFFSET,
  };
}

/**
 * Place the nodes. The owner (the first node, by construction in
 * `buildCommGraph`) anchors the left edge; the rest fan out clockwise from the
 * top of the arc, and a lone agent sits level with the owner.
 */
export function layoutCommGraph(
  nodes: readonly CommGraphNode[],
): CommGraphLayout {
  const positions: CommGraphNodePosition[] = [];
  const owner = nodes.find((node) => node.kind === "owner") ?? null;
  const agents = nodes.filter((node) => node !== owner);

  if (owner) positions.push(position(owner, OWNER_X, CENTER_Y));

  agents.forEach((node, index) => {
    const fraction = agents.length === 1 ? 0.5 : index / (agents.length - 1);
    const angle = -ARC_SPREAD_RADIANS + fraction * 2 * ARC_SPREAD_RADIANS;
    positions.push(
      position(
        node,
        OWNER_X + ARC_RADIUS_X * Math.cos(angle),
        CENTER_Y + ARC_RADIUS_Y * Math.sin(angle),
      ),
    );
  });

  return {
    viewBox: `0 0 ${COMM_GRAPH_VIEW_WIDTH} ${COMM_GRAPH_VIEW_HEIGHT}`,
    width: COMM_GRAPH_VIEW_WIDTH,
    height: COMM_GRAPH_VIEW_HEIGHT,
    positions,
  };
}

/**
 * The curve for one directed edge.
 *
 * The bow is taken along the perpendicular of the from→to direction, so the
 * reverse edge between the same pair bows the opposite way and both directions
 * stay visible and separately clickable.
 */
export function commGraphEdgeGeometry(
  from: CommGraphNodePosition,
  to: CommGraphNodePosition,
  bow: number = EDGE_BOW,
): CommGraphEdgeGeometry {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return { path: `M ${from.x} ${from.y}`, labelX: from.x, labelY: from.y };
  }

  const ux = dx / length;
  const uy = dy / length;
  // Perpendicular of the direction: flips with the direction, which is what
  // separates A→B from B→A.
  const px = -uy;
  const py = ux;

  const startX = from.x + ux * from.radius;
  const startY = from.y + uy * from.radius;
  const endX = to.x - ux * (to.radius + ARROW_CLEARANCE);
  const endY = to.y - uy * (to.radius + ARROW_CLEARANCE);

  const controlX = (startX + endX) / 2 + px * bow * 2;
  const controlY = (startY + endY) / 2 + py * bow * 2;

  // Midpoint of the quadratic, then nudged further along the same perpendicular
  // so the count label clears its own curve.
  const midX = 0.25 * startX + 0.5 * controlX + 0.25 * endX;
  const midY = 0.25 * startY + 0.5 * controlY + 0.25 * endY;

  return {
    path: `M ${round(startX)} ${round(startY)} Q ${round(controlX)} ${round(controlY)} ${round(endX)} ${round(endY)}`,
    labelX: round(midX + px * 10),
    labelY: round(midY + py * 10),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

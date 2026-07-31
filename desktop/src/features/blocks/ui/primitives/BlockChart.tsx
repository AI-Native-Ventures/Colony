import { cn } from "@/shared/lib/cn";

import { resolveChartData } from "./resolvers";
import type {
  BlockChartKind,
  BlockChartNode,
  ResolvedChartDatum,
} from "./types";

const WIDTH = 560;
const HEIGHT = 220;
const PAD_X = 28;
const PAD_Y = 20;

export type BlockChartGeometry = {
  baselineY: number;
  bars: Array<{ x: number; y: number; width: number; height: number }>;
  points: Array<{ x: number; y: number }>;
  linePath: string;
  areaPath: string;
  donutPaths: string[];
};

function polarPoint(cx: number, cy: number, radius: number, angle: number) {
  return {
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle),
  };
}

function donutPath(start: number, end: number): string {
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const outer = 78;
  const inner = 48;
  const outerStart = polarPoint(cx, cy, outer, start);
  const outerEnd = polarPoint(cx, cy, outer, end);
  const innerEnd = polarPoint(cx, cy, inner, end);
  const innerStart = polarPoint(cx, cy, inner, start);
  const largeArc = end - start > Math.PI ? 1 : 0;
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outer} ${outer} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${inner} ${inner} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
}

export function buildBlockChartGeometry(
  data: readonly ResolvedChartDatum[],
): BlockChartGeometry {
  const plotWidth = WIDTH - PAD_X * 2;
  const plotHeight = HEIGHT - PAD_Y * 2;
  const values = data.map((datum) => datum.value);
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, ...values);
  const span = maximum - minimum || 1;
  const y = (value: number) => PAD_Y + ((maximum - value) / span) * plotHeight;
  const baselineY = y(0);
  const slot = data.length > 0 ? plotWidth / data.length : plotWidth;
  const barWidth = Math.max(2, Math.min(48, slot * 0.62));
  const bars = data.map((datum, index) => {
    const valueY = y(datum.value);
    return {
      x: PAD_X + index * slot + (slot - barWidth) / 2,
      y: Math.min(valueY, baselineY),
      width: barWidth,
      height: Math.max(1, Math.abs(valueY - baselineY)),
    };
  });
  const points = data.map((datum, index) => ({
    x:
      data.length === 1
        ? WIDTH / 2
        : PAD_X + (index / (data.length - 1)) * plotWidth,
    y: y(datum.value),
  }));
  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
  const areaPath =
    points.length > 0
      ? `M ${points[0].x} ${baselineY} ${points
          .map((point) => `L ${point.x} ${point.y}`)
          .join(" ")} L ${points.at(-1)?.x ?? points[0].x} ${baselineY} Z`
      : "";
  const positiveTotal = data.reduce(
    (sum, datum) => sum + Math.max(0, datum.value),
    0,
  );
  let angle = -Math.PI / 2;
  const donutPaths =
    positiveTotal > 0
      ? data.flatMap((datum) => {
          const value = Math.max(0, datum.value);
          if (value === 0) return [];
          const start = angle;
          angle += (value / positiveTotal) * Math.PI * 2;
          return [donutPath(start, angle)];
        })
      : [];
  return { areaPath, bars, baselineY, donutPaths, linePath, points };
}

function ChartMarks({
  data,
  geometry,
  kind,
}: {
  data: readonly ResolvedChartDatum[];
  geometry: BlockChartGeometry;
  kind: BlockChartKind;
}) {
  if (data.length === 0) return null;
  if (kind === "bar") {
    return data.map((datum, index) => {
      const bar = geometry.bars[index];
      return (
        <rect
          className="fill-current opacity-80"
          height={bar.height}
          key={`${datum.label}:${datum.value}`}
          rx="4"
          width={bar.width}
          x={bar.x}
          y={bar.y}
        />
      );
    });
  }
  if (kind === "donut") {
    return geometry.donutPaths.map((path, index) => (
      <path
        className="fill-current"
        d={path}
        key={path}
        opacity={Math.max(0.35, 1 - index * 0.12)}
      />
    ));
  }
  return (
    <>
      {kind === "area" ? (
        <path className="fill-current opacity-15" d={geometry.areaPath} />
      ) : null}
      <path
        className="fill-none stroke-current"
        d={geometry.linePath}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="3"
      />
      {data.map((datum, index) => {
        const point = geometry.points[index];
        return (
          <circle
            className="fill-background stroke-current"
            cx={point.x}
            cy={point.y}
            key={`${datum.label}:${datum.value}`}
            r="4"
            strokeWidth="3"
          />
        );
      })}
    </>
  );
}

export function BlockChart({
  className,
  data,
  node,
  title = "Chart",
}: {
  className?: string;
  data: unknown;
  node: BlockChartNode;
  title?: string;
}) {
  const values = resolveChartData(node, data);
  const geometry = buildBlockChartGeometry(values);
  return (
    <figure
      className={cn(
        "min-w-0 rounded-xl border border-border/60 bg-muted/10 p-3",
        className,
      )}
      data-block-primitive="chart"
    >
      <figcaption className="mb-2 text-sm font-semibold">{title}</figcaption>
      {values.length > 0 ? (
        <svg
          aria-label={`${title}, ${node.kind} chart`}
          className="h-auto w-full text-primary"
          role="img"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        >
          <title>{`${title}, ${node.kind} chart`}</title>
          {node.kind !== "donut" ? (
            <line
              className="stroke-border"
              x1={PAD_X}
              x2={WIDTH - PAD_X}
              y1={geometry.baselineY}
              y2={geometry.baselineY}
            />
          ) : null}
          <ChartMarks data={values} geometry={geometry} kind={node.kind} />
        </svg>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No chart data available.
        </p>
      )}
      <details className="mt-2 rounded-lg border border-border/50 bg-background/50 px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-ring">
          View chart data
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{title} data</caption>
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-4" scope="col">
                  Label
                </th>
                <th className="py-1 text-right" scope="col">
                  Value
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {values.map((datum) => (
                <tr key={`${datum.label}:${datum.value}`}>
                  <th className="py-1.5 pr-4 font-normal" scope="row">
                    {datum.label}
                  </th>
                  <td className="py-1.5 text-right tabular-nums">
                    {datum.value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

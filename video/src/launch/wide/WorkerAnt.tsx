import { legAngles } from "./gait.ts";

const W = 466;
const H = 309;

const LEGS_A = ["M257 198 L336 282", "M220 210 L196 298", "M164 215 L112 272"];
const LEGS_B = ["M247 205 L294 294", "M235 209 L246 300", "M202 203 L136 292"];

const layer: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  transformOrigin: "50% 72%",
};

/**
 * The Colony ant mark walking with the brand gait (two leg tripods rocking
 * 5 degrees, body bobbing 1%), centred on (x, y), `size` px long, nose along
 * `angle` (radians). `amp` 0 holds the legs still.
 */
export const WorkerAnt: React.FC<{
  x: number;
  y: number;
  angle: number;
  size: number;
  color: string;
  phase: number;
  amp: number;
  eye?: string;
  opacity?: number;
}> = ({
  x,
  y,
  angle,
  size,
  color,
  phase,
  amp,
  eye = "#ffffff",
  opacity = 1,
}) => {
  const { a, b, bob } = legAngles(phase);
  const height = size * (H / W);
  const leg = (deg: number): React.CSSProperties => ({
    ...layer,
    transform: `rotate(${(deg * amp).toFixed(3)}deg) translateY(${((deg / 5) * 1.6 * amp).toFixed(3)}%)`,
  });
  const stroke = {
    fill: "none",
    stroke: color,
    strokeWidth: 14,
    strokeLinecap: "round" as const,
  };
  return (
    <div
      style={{
        position: "absolute",
        left: x - size / 2,
        top: y - height / 2,
        width: size,
        height,
        opacity,
        transform: `rotate(${((angle * 180) / Math.PI).toFixed(3)}deg)`,
      }}
    >
      <svg aria-hidden="true" viewBox={`0 0 ${W} ${H}`} style={leg(a)}>
        <g {...stroke}>
          {LEGS_A.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
      </svg>
      <svg aria-hidden="true" viewBox={`0 0 ${W} ${H}`} style={leg(b)}>
        <g {...stroke}>
          {LEGS_B.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
      </svg>
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${W} ${H}`}
        style={{
          ...layer,
          transform: `translateY(${(bob * 100 * amp).toFixed(3)}%)`,
        }}
      >
        <g {...stroke}>
          <path d="M327 114 Q345 64 397 50" />
          <path d="M343 126 Q377 86 427 80" />
        </g>
        <g fill={color}>
          <circle cx={104} cy={172} r={80} />
          <circle cx={226} cy={164} r={52} />
          <circle cx={313} cy={148} r={46} />
        </g>
        <circle cx={335} cy={136} r={11} fill={eye} />
      </svg>
    </div>
  );
};

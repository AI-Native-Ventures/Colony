import { CAVEAT, POPPINS, SCRIPT, SERIF } from "../launch/fonts";
import { POST_SIZE } from "../launch/wide/posts.ts";
import { RISE, RISE_COLORS as C, type RisePostId } from "./rise.ts";

/**
 * Rise Bakery's three posts for the week, drawn in code after the bakery
 * posts picked on Pinterest: a beige sourdough card in serif capitals, a red
 * hand-lettered market poster, and a cream scallop badge with a royal blue
 * serif and a "7AM" sticker. 264 px squares, like the launch film's posts.
 */

const S = POST_SIZE;

/** A round sourdough loaf with a long scored ear and a little flour. */
export function Loaf({ width }: { width: number }) {
  return (
    <svg
      aria-hidden="true"
      width={width}
      height={width * 0.7}
      viewBox="0 0 200 140"
      style={{ display: "block" }}
    >
      <defs>
        <radialGradient id="rise-crust" cx="44%" cy="34%" r="72%">
          <stop offset="0" stopColor="#ecb874" />
          <stop offset="0.55" stopColor={C.crust} />
          <stop offset="1" stopColor="#8a4d1f" />
        </radialGradient>
      </defs>
      <ellipse cx="100" cy="128" rx="84" ry="8" fill={C.cocoa} opacity="0.18" />
      <path
        d="M14 92C14 44 54 16 100 16s86 28 86 76c0 24-36 36-86 36S14 116 14 92Z"
        fill="url(#rise-crust)"
      />
      <ellipse cx="84" cy="38" rx="44" ry="11" fill="#ffffff" opacity="0.22" />
      <ellipse cx="130" cy="50" rx="22" ry="6" fill="#ffffff" opacity="0.14" />
      <path
        d="M44 64C78 38 126 38 160 66"
        fill="none"
        stroke="#f7dfb2"
        strokeWidth="8"
        strokeLinecap="round"
      />
      <path
        d="M47 70C80 47 124 47 156 72"
        fill="none"
        stroke="#7c4219"
        strokeWidth="2.4"
        strokeLinecap="round"
        opacity="0.5"
      />
      {[0, 1, 2, 3].map((k) => (
        <path
          key={k}
          d={`M${58 + k * 22} ${96 - (k % 2) * 4}l12 -10`}
          stroke="#f2d39f"
          strokeWidth="3.4"
          strokeLinecap="round"
          opacity="0.9"
        />
      ))}
    </svg>
  );
}

const CROISSANT_SEGMENTS = [
  { cx: 34, cy: 76, rx: 22, ry: 12, rot: -38 },
  { cx: 166, cy: 76, rx: 22, ry: 12, rot: 38 },
  { cx: 64, cy: 58, rx: 28, ry: 21, rot: -20 },
  { cx: 136, cy: 58, rx: 28, ry: 21, rot: 20 },
  { cx: 100, cy: 52, rx: 33, ry: 28, rot: 0 },
];

/** A croissant: five golden segments on a curve, the middle one on top. */
export function Croissant({ width }: { width: number }) {
  return (
    <svg
      aria-hidden="true"
      width={width}
      height={width * 0.6}
      viewBox="0 0 200 120"
      style={{ display: "block" }}
    >
      <defs>
        <linearGradient id="rise-flake" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f6cd86" />
          <stop offset="0.6" stopColor="#d8913f" />
          <stop offset="1" stopColor="#9c5523" />
        </linearGradient>
      </defs>
      <ellipse cx="100" cy="106" rx="78" ry="7" fill={C.cocoa} opacity="0.18" />
      {CROISSANT_SEGMENTS.map((s) => (
        <g
          key={`${s.cx}-${s.cy}`}
          transform={`rotate(${s.rot} ${s.cx} ${s.cy})`}
        >
          <ellipse
            cx={s.cx}
            cy={s.cy}
            rx={s.rx}
            ry={s.ry}
            fill="url(#rise-flake)"
            stroke="#8e4c1d"
            strokeWidth="1.6"
            strokeOpacity="0.55"
          />
          <ellipse
            cx={s.cx - s.rx * 0.18}
            cy={s.cy - s.ry * 0.45}
            rx={s.rx * 0.55}
            ry={s.ry * 0.22}
            fill="#ffffff"
            opacity="0.32"
          />
        </g>
      ))}
    </svg>
  );
}

/** Red and cream stripes with a scalloped edge, like a market stall. */
function Awning() {
  const stripes = 8;
  const w = S / stripes;
  return (
    <svg
      aria-hidden="true"
      width={S}
      height={48}
      viewBox={`0 0 ${S} 48`}
      style={{ position: "absolute", left: 0, top: 0 }}
    >
      {Array.from({ length: stripes }, (_, k) => (
        <g key={k}>
          <rect
            x={k * w}
            y={0}
            width={w}
            height={30}
            fill={k % 2 === 0 ? C.red : C.paper}
          />
          <path
            d={`M${k * w} 30a${w / 2} ${w / 2.4} 0 0 0 ${w} 0Z`}
            fill={k % 2 === 0 ? C.red : C.paper}
          />
        </g>
      ))}
      <rect x={0} y={0} width={S} height={4} fill="#b8301f" />
    </svg>
  );
}

function SourdoughPost() {
  return (
    <div style={{ position: "absolute", inset: 0, background: C.paper }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 14,
          textAlign: "center",
          fontFamily: POPPINS,
          fontSize: 8,
          fontWeight: 600,
          letterSpacing: "0.24em",
          color: "rgb(74 44 26 / 0.7)",
        }}
      >
        RISE BAKERY · MELVILLE
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 26,
          textAlign: "center",
          fontFamily: SCRIPT,
          fontSize: 30,
          lineHeight: 1,
          color: C.crust,
        }}
      >
        New this week
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 58,
          textAlign: "center",
          fontFamily: SERIF,
          fontWeight: 700,
          fontSize: 31,
          letterSpacing: "0.03em",
          lineHeight: 1,
          color: C.cocoa,
        }}
      >
        SOURDOUGH
      </div>
      <div style={{ position: "absolute", left: 47, top: 100 }}>
        <Loaf width={170} />
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 222,
          display: "flex",
          justifyContent: "center",
        }}
      >
        <span
          style={{
            height: 26,
            padding: "0 14px",
            borderRadius: 999,
            border: `1.5px solid ${C.cocoa}`,
            display: "flex",
            alignItems: "center",
            fontFamily: SERIF,
            fontWeight: 600,
            fontSize: 12.5,
            color: C.cocoa,
          }}
        >
          Out of the oven at 7am
        </span>
      </div>
    </div>
  );
}

function MarketPost() {
  return (
    <div style={{ position: "absolute", inset: 0, background: C.cream }}>
      <Awning />
      <div
        style={{
          position: "absolute",
          left: 14,
          top: 52,
          fontFamily: CAVEAT,
          fontWeight: 700,
          fontSize: 48,
          lineHeight: 0.92,
          color: C.red,
          transform: "rotate(-5deg)",
          transformOrigin: "left top",
        }}
      >
        Saturday
        <br />
        <span style={{ marginLeft: 30 }}>market!</span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 16,
          top: 152,
          fontFamily: POPPINS,
          fontSize: 7.5,
          fontWeight: 700,
          letterSpacing: "0.2em",
          color: C.red,
        }}
      >
        RISE BAKERY
      </div>
      <div
        style={{
          position: "absolute",
          left: 16,
          top: 164,
          fontFamily: CAVEAT,
          fontWeight: 700,
          fontSize: 21,
          lineHeight: 1.1,
          color: C.red,
        }}
      >
        Sat 18 Oct
        <br />
        7am to 1pm
        <br />
        Melville Square
      </div>
      <div style={{ position: "absolute", left: 134, top: 186 }}>
        <Loaf width={118} />
      </div>
      <div
        style={{
          position: "absolute",
          left: 140,
          top: 142,
          transform: "rotate(-8deg)",
        }}
      >
        <Croissant width={108} />
      </div>
    </div>
  );
}

/** A scalloped badge path around (cx, cy), `bumps` waves deep `depth`. */
function scallopPath(
  cx: number,
  cy: number,
  r: number,
  bumps: number,
  depth: number,
): string {
  const steps = bumps * 12;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const rr = r + depth * Math.cos(a * bumps);
    pts.push(
      `${(cx + rr * Math.cos(a)).toFixed(2)} ${(cy + rr * Math.sin(a)).toFixed(2)}`,
    );
  }
  return `M${pts.join("L")}Z`;
}

function CroissantPost() {
  const pattern = [];
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 6; col++) {
      pattern.push(
        <div
          key={`${row}-${col}`}
          style={{
            position: "absolute",
            left: col * 46 + (row % 2) * 23 - 10,
            top: row * 46 - 6,
            opacity: 0.2,
            transform: `rotate(${(row + col) % 2 === 0 ? -20 : 15}deg)`,
          }}
        >
          <Croissant width={34} />
        </div>,
      );
    }
  }
  return (
    <div style={{ position: "absolute", inset: 0, background: C.butter }}>
      {pattern}
      <svg
        aria-hidden="true"
        width={S}
        height={S}
        viewBox={`0 0 ${S} ${S}`}
        style={{ position: "absolute", inset: 0 }}
      >
        <path d={scallopPath(132, 124, 94, 14, 5)} fill={C.paper} />
      </svg>
      <div
        style={{
          position: "absolute",
          left: 38,
          right: 38,
          top: 66,
          textAlign: "center",
          fontFamily: SERIF,
          fontWeight: 700,
          color: C.blue,
          lineHeight: 0.95,
        }}
      >
        <div style={{ fontSize: 46, letterSpacing: "-0.01em" }}>Warm</div>
        <div style={{ fontSize: 31, letterSpacing: "-0.01em" }}>croissants</div>
        <div
          style={{
            marginTop: 10,
            fontFamily: POPPINS,
            fontSize: 7.5,
            fontWeight: 700,
            letterSpacing: "0.2em",
          }}
        >
          AT THE MARKET FROM 7
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 20,
          top: 22,
          width: 58,
          height: 58,
          borderRadius: "50%",
          background: C.blue,
          color: "#ffffff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: SERIF,
          fontWeight: 700,
          fontSize: 18,
          transform: "rotate(-12deg)",
          boxShadow: "0 6px 12px -6px rgb(42 69 201 / 0.7)",
        }}
      >
        7AM
      </div>
      <div
        style={{
          position: "absolute",
          left: 128,
          top: 170,
          transform: "rotate(-10deg)",
        }}
      >
        <Croissant width={124} />
      </div>
      <div
        style={{
          position: "absolute",
          left: 16,
          bottom: 12,
          fontFamily: POPPINS,
          fontSize: 8,
          fontWeight: 600,
          color: "rgb(74 44 26 / 0.75)",
        }}
      >
        {RISE.handle}
      </div>
    </div>
  );
}

const ART: Record<RisePostId, React.FC> = {
  sourdough: SourdoughPost,
  market: MarketPost,
  croissant: CroissantPost,
};

/** One of Rise Bakery's posts at full size, with the rounded post frame. */
export const RisePostArt: React.FC<{ id: RisePostId }> = ({ id }) => {
  const Art = ART[id];
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        borderRadius: 22,
        overflow: "hidden",
      }}
    >
      <Art />
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 22,
          border: "1px solid rgb(74 44 26 / 0.12)",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
};

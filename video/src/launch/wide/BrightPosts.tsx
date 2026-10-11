import { ANTON, POPPINS } from "../fonts";
import { BRIGHT, BRIGHT_COLORS as C, GEYSER_PRICE } from "./bright.ts";
import {
  ArrowUpRightIcon,
  BrightLockup,
  ClockIcon,
  PhoneIcon,
  ShieldIcon,
  StarIcon,
} from "./BrightIcons";
import { POST_SIZE } from "./posts.ts";

/**
 * Bright Plumbing's three Instagram posts, drawn in code after the plumbing
 * posts the owner pointed to on Pinterest: one bold warning, one offer, one
 * review. Each is 264 px square and carries the brand, a way to book, or both.
 */

const S = POST_SIZE;

/** Navy strip along the foot of a post: the number to call and a button. */
function ContactBar({ cta }: { cta: string }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: 38,
        background: C.navy,
        display: "flex",
        alignItems: "center",
        padding: "0 12px 0 15px",
        gap: 6,
        fontFamily: POPPINS,
        color: "#ffffff",
      }}
    >
      <PhoneIcon size={12} color={C.orange} />
      <span
        style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: "0.01em" }}
      >
        {BRIGHT.phone}
      </span>
      <span style={{ flex: 1 }} />
      <span
        style={{
          height: 22,
          padding: "0 10px",
          borderRadius: 999,
          background: C.orange,
          fontSize: 8.5,
          fontWeight: 700,
          letterSpacing: "0.1em",
          display: "flex",
          alignItems: "center",
        }}
      >
        {cta}
      </span>
    </div>
  );
}

/** A falling drop of water, pointed end up. */
function Drop({ x, y, r }: { x: number; y: number; r: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path
        d={`M0 ${-r * 1.9} C0 ${-r * 1.9} ${-r} ${-r * 0.4} ${-r} ${r * 0.15} a${r} ${r} 0 0 0 ${2 * r} 0 C${r} ${-r * 0.4} 0 ${-r * 1.9} 0 ${-r * 1.9} Z`}
        fill={C.blue}
      />
      <circle
        cx={-r * 0.35}
        cy={r * 0.05}
        r={r * 0.28}
        fill="#ffffff"
        opacity={0.7}
      />
    </g>
  );
}

/** A steel pipe coming in from the right, turning down, dripping; a wrench on it. */
function LeakPipe() {
  const y = 150;
  const x = 150;
  return (
    <svg
      aria-hidden="true"
      width={S}
      height={S}
      viewBox={`0 0 ${S} ${S}`}
      style={{ position: "absolute", inset: 0 }}
    >
      <ellipse cx={x} cy={222} rx={22} ry={3.5} fill={C.blue} opacity={0.18} />
      <path
        d={`M${S + 20} ${y} H${x + 26} Q${x} ${y} ${x} ${y + 26} V${y + 44}`}
        fill="none"
        stroke={C.steel}
        strokeWidth={26}
      />
      <path
        d={`M${S + 20} ${y - 7} H${x + 26} Q${x - 7} ${y - 7} ${x - 7} ${y + 26} V${y + 44}`}
        fill="none"
        stroke={C.steelLight}
        strokeWidth={5}
      />
      <path
        d={`M${S + 20} ${y + 8} H${x + 26} Q${x + 8} ${y + 8} ${x + 8} ${y + 26} V${y + 44}`}
        fill="none"
        stroke={C.steelDark}
        strokeWidth={4}
        opacity={0.75}
      />
      <rect
        x={x - 17}
        y={y + 42}
        width={34}
        height={9}
        rx={2.5}
        fill={C.steelDark}
      />
      <rect
        x={x + 54}
        y={y - 17}
        width={11}
        height={34}
        rx={3}
        fill={C.steelDark}
      />
      <rect
        x={x + 56}
        y={y - 15}
        width={3}
        height={30}
        rx={1.5}
        fill={C.steelLight}
        opacity={0.8}
      />
      <Drop x={x} y={y + 58} r={4.6} />
      <Drop x={x} y={y + 71} r={3} />
      <path
        transform="translate(184 160) scale(2.6)"
        d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"
        fill={C.orange}
      />
    </svg>
  );
}

function LeakPost() {
  return (
    <div style={{ position: "absolute", inset: 0, background: "#ffffff" }}>
      <div
        style={{
          position: "absolute",
          left: 118,
          top: 78,
          width: 250,
          height: 250,
          borderRadius: "50%",
          background: C.sky,
        }}
      />
      <LeakPipe />
      <div style={{ position: "absolute", left: 16, top: 15 }}>
        <BrightLockup size={15} />
      </div>
      <div
        style={{
          position: "absolute",
          left: 15,
          top: 41,
          fontFamily: ANTON,
          fontSize: 47,
          lineHeight: 0.97,
          letterSpacing: "0.005em",
          color: C.navy,
          textTransform: "uppercase",
        }}
      >
        Don’t wait
        <br />
        for the
        <br />
        <span style={{ color: C.blue }}>leak.</span>
      </div>
      <ContactBar cta="BOOK TODAY" />
    </div>
  );
}

/** A geyser: an upright tank with a dial, hot and cold pipes on top. */
function Geyser() {
  const cx = 214;
  const top = 128;
  const bottom = 244;
  return (
    <svg
      aria-hidden="true"
      width={S}
      height={S}
      viewBox={`0 0 ${S} ${S}`}
      style={{ position: "absolute", inset: 0 }}
    >
      <ellipse
        cx={cx}
        cy={bottom + 5}
        rx={34}
        ry={4.5}
        fill="#020b2a"
        opacity={0.3}
      />
      <rect
        x={cx - 15}
        y={top - 22}
        width={8}
        height={26}
        rx={2}
        fill={C.steel}
      />
      <rect
        x={cx + 7}
        y={top - 22}
        width={8}
        height={26}
        rx={2}
        fill={C.steel}
      />
      <rect
        x={cx - 17}
        y={top - 26}
        width={12}
        height={8}
        rx={2}
        fill="#ff5a3c"
      />
      <rect
        x={cx + 5}
        y={top - 26}
        width={12}
        height={8}
        rx={2}
        fill="#3fa9ff"
      />
      <rect
        x={cx - 30}
        y={top}
        width={60}
        height={bottom - top}
        rx={25}
        fill="#eef2f7"
        stroke="#c9d3e0"
        strokeWidth={1.5}
      />
      <path
        d={`M${cx + 8} ${top + 0.75} A24.25 24.25 0 0 1 ${cx + 29.25} ${top + 25} V${bottom - 25} A24.25 24.25 0 0 1 ${cx + 8} ${bottom - 0.75} Z`}
        fill="#d9e1ec"
      />
      <rect
        x={cx - 23}
        y={top + 16}
        width={5}
        height={bottom - top - 36}
        rx={2.5}
        fill="#ffffff"
      />
      <rect
        x={cx - 29.25}
        y={top + 56}
        width={58.5}
        height={8}
        fill={C.orange}
      />
      <circle
        cx={cx}
        cy={top + 27}
        r={12}
        fill="#ffffff"
        stroke={C.navy}
        strokeWidth={2.5}
      />
      <path
        d={`M${cx} ${top + 28} L${cx + 5.5} ${top + 20.5}`}
        stroke="#ff5a3c"
        strokeWidth={2.4}
        strokeLinecap="round"
      />
      <circle cx={cx} cy={top + 28} r={2} fill={C.navy} />
      <rect
        x={cx - 13}
        y={top + 76}
        width={26}
        height={15}
        rx={3}
        fill="#ffffff"
      />
      <rect
        x={cx - 8}
        y={top + 80.5}
        width={16}
        height={2}
        rx={1}
        fill={C.blue}
        opacity={0.6}
      />
      <rect
        x={cx - 8}
        y={top + 85}
        width={11}
        height={2}
        rx={1}
        fill={C.blue}
        opacity={0.4}
      />
    </svg>
  );
}

function GeyserPost() {
  return (
    <div style={{ position: "absolute", inset: 0, background: C.blue }}>
      <svg
        aria-hidden="true"
        width={S}
        height={S}
        style={{ position: "absolute", inset: 0 }}
      >
        <defs>
          <pattern
            id="bright-grid"
            width="22"
            height="22"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M22 0H0V22"
              fill="none"
              stroke="#ffffff"
              strokeWidth="1"
              opacity="0.12"
            />
          </pattern>
        </defs>
        <rect width={S} height={S} fill="url(#bright-grid)" />
      </svg>
      <div
        style={{
          position: "absolute",
          left: 14,
          top: 14,
          width: S - 28,
          height: 164,
          borderRadius: 18,
          background: "#ffffff",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 28,
          top: 30,
          fontFamily: POPPINS,
          fontSize: 8.5,
          fontWeight: 700,
          letterSpacing: "0.18em",
          color: C.orange,
        }}
      >
        WINTER SPECIAL
      </div>
      <div
        style={{
          position: "absolute",
          left: 27,
          top: 46,
          fontFamily: POPPINS,
          fontSize: 26,
          fontWeight: 800,
          lineHeight: 1.04,
          letterSpacing: "-0.03em",
          color: C.navy,
        }}
      >
        Geyser
        <br />
        check before
        <br />
        <span style={{ color: C.blue }}>winter.</span>
      </div>
      <Geyser />
      <div
        style={{
          position: "absolute",
          left: 196,
          top: 2,
          width: 62,
          height: 62,
          borderRadius: "50%",
          background: C.orange,
          boxShadow: "0 8px 16px -8px rgb(2 11 42 / 0.6)",
          transform: "rotate(-12deg)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          color: "#ffffff",
        }}
      >
        <span
          style={{
            fontFamily: POPPINS,
            fontSize: 7.5,
            fontWeight: 700,
            letterSpacing: "0.16em",
            marginBottom: -2,
          }}
        >
          FROM
        </span>
        <span style={{ fontFamily: ANTON, fontSize: 22, lineHeight: 1.05 }}>
          {GEYSER_PRICE}
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 16,
          top: 200,
          height: 30,
          padding: "0 12px 0 14px",
          borderRadius: 999,
          background: C.orange,
          display: "flex",
          alignItems: "center",
          gap: 5,
          fontFamily: POPPINS,
          fontSize: 11.5,
          fontWeight: 700,
          color: "#ffffff",
        }}
      >
        Book a check
        <ArrowUpRightIcon size={13} color="#ffffff" stroke={2.8} />
      </div>
      <div
        style={{
          position: "absolute",
          left: 18,
          top: 240,
          display: "flex",
          alignItems: "center",
          gap: 5,
          fontFamily: POPPINS,
          fontSize: 10.5,
          fontWeight: 600,
          color: "#ffffff",
        }}
      >
        <PhoneIcon size={11} color="#ffffff" />
        {BRIGHT.phone}
      </div>
    </div>
  );
}

/** Small drops and spanners, faint, behind the review. */
function ToolPattern() {
  const cells = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 7; col++) {
      const x = col * 40 + (row % 2) * 20 + 6;
      const y = row * 38 + 8;
      cells.push(
        (row + col) % 2 === 0 ? (
          <path
            key={`${row}-${col}`}
            d={`M${x + 6} ${y}C${x + 6} ${y} ${x} ${y + 7} ${x} ${y + 11}a6 6 0 0 0 12 0C${x + 12} ${y + 7} ${x + 6} ${y} ${x + 6} ${y}Z`}
            fill="none"
            stroke={C.blue}
            strokeWidth={1.4}
          />
        ) : (
          <circle
            key={`${row}-${col}`}
            cx={x + 6}
            cy={y + 8}
            r={5}
            fill="none"
            stroke={C.blue}
            strokeWidth={1.4}
          />
        ),
      );
    }
  }
  return (
    <svg
      aria-hidden="true"
      width={S}
      height={180}
      style={{ position: "absolute", left: 0, top: 0, opacity: 0.1 }}
    >
      {cells}
    </svg>
  );
}

const BADGES = [
  { label: "Same day", Icon: ClockIcon },
  { label: "Licensed", Icon: ShieldIcon },
  { label: "4.9 stars", Icon: StarIcon },
] as const;

function ReviewPost() {
  return (
    <div style={{ position: "absolute", inset: 0, background: C.sky }}>
      <ToolPattern />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 15,
          display: "flex",
          justifyContent: "center",
        }}
      >
        <BrightLockup size={15} />
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 42,
          display: "flex",
          justifyContent: "center",
          gap: 2,
        }}
      >
        {[0, 1, 2, 3, 4].map((k) => (
          <StarIcon key={k} size={15} color={C.orange} />
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: 12,
          right: 12,
          top: 64,
          textAlign: "center",
          fontFamily: POPPINS,
          fontSize: 23,
          fontWeight: 700,
          lineHeight: 1.12,
          letterSpacing: "-0.025em",
          color: C.navy,
        }}
      >
        “Fast, clean
        <br />
        and friendly.”
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 130,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          gap: 7,
          fontFamily: POPPINS,
          fontSize: 11,
          color: C.muted,
        }}
      >
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: 11,
            background: C.orange,
            color: "#ffffff",
            fontWeight: 700,
            fontSize: 11,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          L
        </span>
        <span style={{ fontWeight: 600, color: C.navy }}>Lerato M.</span>
        Rosebank
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 86,
          background: C.navy,
          display: "flex",
          justifyContent: "space-around",
          alignItems: "center",
          padding: "0 10px",
        }}
      >
        {BADGES.map(({ label, Icon }) => (
          <div
            key={label}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: 17,
                border: "1.5px solid rgb(255 255 255 / 0.3)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon
                size={17}
                color={label === "4.9 stars" ? C.orange : "#ffffff"}
              />
            </span>
            <span
              style={{
                fontFamily: POPPINS,
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "#ffffff",
              }}
            >
              {label}
            </span>
          </div>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 86,
          height: 3,
          background: C.orange,
        }}
      />
    </div>
  );
}

const POST_ART: Record<string, React.FC> = {
  leak: LeakPost,
  geyser: GeyserPost,
  review: ReviewPost,
};

/** One of Bright Plumbing's posts, drawn at full size. */
export const PostArt: React.FC<{ id: string }> = ({ id }) => {
  const Art = POST_ART[id];
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        borderRadius: 22,
        overflow: "hidden",
      }}
    >
      {Art ? <Art /> : null}
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 22,
          border: `1px solid ${C.line}`,
          boxSizing: "border-box",
        }}
      />
    </div>
  );
};

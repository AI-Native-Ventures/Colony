import { ANTON, POPPINS } from "../launch/fonts";
import { MO, MO_COLORS as C, MO_NOW, MO_OLD, MO_SERVICES } from "./mo.ts";

const OLD_SERIF = '"Times New Roman", Times, serif';
const OLD_SANS = "Arial, Helvetica, sans-serif";

/** Mo's site as it was: a 2018 template with last year's price and weekday hours. */
export function MoOldPage() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "#eeeae2",
        fontFamily: OLD_SANS,
        color: "#555555",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: 96,
          background: "linear-gradient(#b04a3c, #7e2b22)",
          padding: "18px 30px 0",
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            fontFamily: OLD_SERIF,
            fontStyle: "italic",
            fontWeight: 700,
            fontSize: 38,
            color: "#ffffff",
            textShadow: "2px 2px 0 #4f1912",
            lineHeight: 1,
          }}
        >
          {MO.name}
        </div>
        <div style={{ marginTop: 8, fontSize: 14, color: "#f0d9d4" }}>
          Your friendly garage in {MO.place}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 96,
          height: 34,
          background: "#d6cfc1",
          borderBottom: "1px solid #b6ad9b",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 30px",
          fontSize: 14,
          color: "#888070",
        }}
      >
        {["Home", "About Us", "Prices", "Contact Us"].map((name, k) => (
          <span key={name} style={{ display: "flex", gap: 10 }}>
            {k > 0 ? <span>|</span> : null}
            <span style={{ color: "#2a4f8f", textDecoration: "underline" }}>
              {name}
            </span>
          </span>
        ))}
      </div>
      <div style={{ position: "absolute", left: 30, top: 158, width: 470 }}>
        <div
          style={{
            fontFamily: OLD_SERIF,
            fontWeight: 700,
            fontSize: 30,
            color: "#333333",
          }}
        >
          Welcome to Mo's!
        </div>
        <div style={{ marginTop: 14, fontSize: 15, lineHeight: 1.55 }}>
          We fix all cars and bakkies. Services, brakes, tyres and more. Bring
          your car in or phone us for a booking.
        </div>
        <div
          style={{
            marginTop: 22,
            width: 440,
            border: "2px solid #b6ad9b",
            background: "#f7f3ea",
            padding: "14px 18px",
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              fontFamily: OLD_SERIF,
              fontWeight: 700,
              fontSize: 24,
              color: "#333333",
            }}
          >
            Our Prices
          </div>
          <div
            style={{
              marginTop: 10,
              display: "flex",
              justifyContent: "space-between",
              fontSize: 24,
              color: "#333333",
            }}
          >
            <span>Full service</span>
            <b>{MO_OLD.service}</b>
          </div>
          <div
            style={{
              marginTop: 6,
              display: "flex",
              justifyContent: "space-between",
              fontSize: 18,
            }}
          >
            <span>Brakes</span>
            <span>R600</span>
          </div>
        </div>
        <div
          style={{
            marginTop: 18,
            fontSize: 22,
            color: "#333333",
          }}
        >
          <b>Hours:</b> {MO_OLD.hours}
        </div>
        <div style={{ marginTop: 4, fontSize: 18, color: "#8a3a2f" }}>
          Closed weekends
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 560,
          top: 158,
          width: 340,
          height: 250,
          background: "#e2ddd2",
          border: "1px solid #bdb5a5",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          fontSize: 14,
          color: "#a09886",
        }}
      >
        <svg aria-hidden="true" width="44" height="36" viewBox="0 0 44 36">
          <rect
            x="1"
            y="1"
            width="42"
            height="34"
            fill="none"
            stroke="#b9b09e"
            strokeWidth="2"
          />
          <path d="M6 30l10-12 8 8 6-6 8 10Z" fill="#cdc5b4" />
          <circle cx="31" cy="11" r="4" fill="#cdc5b4" />
        </svg>
        Photo coming soon
      </div>
      <div
        style={{
          position: "absolute",
          left: 560,
          top: 424,
          width: 340,
          fontSize: 15,
          lineHeight: 1.5,
        }}
      >
        <b style={{ color: "#333333" }}>Phone:</b> {MO.phone}
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 74,
          background: "#d6cfc1",
          borderTop: "1px solid #b6ad9b",
          padding: "14px 30px 0",
          boxSizing: "border-box",
          fontSize: 12,
          lineHeight: 1.6,
          color: "#7d7565",
        }}
      >
        Copyright © 2018 {MO.name}. All rights reserved. | Last updated: June
        2018
        <br />
        Best viewed in Internet Explorer at 1024 x 768
      </div>
    </div>
  );
}

/** A brake disc and red caliper: the page's one picture, drawn rather than photographed. */
function BrakeDisc({ size }: { size: number }) {
  const holes = Array.from({ length: 10 }, (_, k) => (k * Math.PI * 2) / 10);
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 200 200">
      <circle cx="100" cy="100" r="92" fill="#2a2e36" />
      <circle cx="100" cy="100" r="86" fill="#3a3f49" />
      <circle
        cx="100"
        cy="100"
        r="80"
        fill="none"
        stroke="#4a505c"
        strokeWidth="2"
      />
      {holes.map((a) => (
        <circle
          key={a}
          cx={100 + 62 * Math.cos(a)}
          cy={100 + 62 * Math.sin(a)}
          r="4.5"
          fill="#22252c"
        />
      ))}
      <circle cx="100" cy="100" r="40" fill="#22252c" />
      <circle cx="100" cy="100" r="30" fill="#4a505c" />
      {[0, 1, 2, 3, 4].map((k) => {
        const a = (k * Math.PI * 2) / 5 - Math.PI / 2;
        return (
          <circle
            key={k}
            cx={100 + 18 * Math.cos(a)}
            cy={100 + 18 * Math.sin(a)}
            r="4"
            fill="#22252c"
          />
        );
      })}
      <path
        d="M150 38 C178 58 190 92 182 126 L156 116 C161 94 154 72 136 58 Z"
        fill={C.red}
      />
      <rect x="160" y="70" width="10" height="26" rx="4" fill="#ff8a80" />
    </svg>
  );
}

function Tile({
  label,
  value,
  note,
  red,
}: {
  label: string;
  value: string;
  note: string;
  red: boolean;
}) {
  return (
    <div
      style={{
        position: "relative",
        flex: 1,
        height: 150,
        borderRadius: 14,
        background: red ? C.red : C.panel,
        border: red ? "none" : `2px solid ${C.line}`,
        padding: "16px 22px",
        boxSizing: "border-box",
        color: C.text,
      }}
    >
      <div
        style={{
          position: "absolute",
          right: 16,
          top: 14,
          height: 28,
          padding: "0 12px",
          borderRadius: 999,
          background: red ? "#ffffff" : C.red,
          color: red ? C.redDeep : "#ffffff",
          fontFamily: POPPINS,
          fontSize: 15,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          letterSpacing: "0.04em",
        }}
      >
        NEW
      </div>
      <div
        style={{
          fontFamily: ANTON,
          fontSize: 26,
          letterSpacing: "0.03em",
          lineHeight: 1.1,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: ANTON,
          fontSize: 56,
          lineHeight: 1.05,
          marginTop: 2,
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontFamily: POPPINS,
          fontSize: 16,
          marginTop: 4,
          color: red ? "#ffe3e0" : C.muted,
        }}
      >
        {note}
      </div>
    </div>
  );
}

/** Mo's site after the green employee: the new price and Saturday hours, in the Pinterest style. */
export function MoNewPage() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: C.page,
        fontFamily: POPPINS,
        color: C.text,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: 40,
          background: C.red,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 28px",
          fontSize: 17,
          fontWeight: 600,
        }}
      >
        <span>Call {MO.phone}</span>
        <span>Open Monday to Saturday</span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 40,
          height: 72,
          borderBottom: `1.5px solid ${C.line}`,
          display: "flex",
          alignItems: "center",
          gap: 26,
          padding: "0 28px",
        }}
      >
        <span
          style={{
            fontFamily: ANTON,
            fontSize: 30,
            letterSpacing: "0.02em",
          }}
        >
          MO'S <span style={{ color: C.red }}>AUTO</span> REPAIRS
        </span>
        <span style={{ flex: 1 }} />
        {["Services", "Prices", "Reviews"].map((n) => (
          <span key={n} style={{ fontSize: 17, color: C.muted }}>
            {n}
          </span>
        ))}
        <span
          style={{
            height: 44,
            padding: "0 20px",
            borderRadius: 8,
            background: C.red,
            fontSize: 16,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            letterSpacing: "0.03em",
          }}
        >
          BOOK A SERVICE
        </span>
      </div>
      <div style={{ position: "absolute", left: 28, top: 132, width: 560 }}>
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: "0.16em",
            color: C.red,
          }}
        >
          {MO.place.toUpperCase()} · SINCE {MO.since}
        </div>
        <div
          style={{
            fontFamily: ANTON,
            fontSize: 62,
            lineHeight: 1.02,
            marginTop: 8,
            letterSpacing: "0.01em",
          }}
        >
          KEEP YOUR CAR
          <br />
          <span style={{ color: C.red }}>RUNNING STRONG</span>
        </div>
        <div style={{ marginTop: 12, fontSize: 19, color: C.muted }}>
          Honest repairs, fair prices, done the same day.
        </div>
      </div>
      <div style={{ position: "absolute", right: 34, top: 120 }}>
        <BrakeDisc size={230} />
      </div>
      <div
        style={{
          position: "absolute",
          left: 28,
          right: 28,
          top: 372,
          display: "flex",
          gap: 18,
        }}
      >
        <Tile
          label="FULL SERVICE"
          value={MO_NOW.service}
          note="Oil, filters and a 40-point check"
          red
        />
        <Tile
          label="NOW OPEN SATURDAYS"
          value={MO_NOW.saturday}
          note="Book online or call us"
          red={false}
        />
      </div>
      <div
        style={{
          position: "absolute",
          left: 28,
          right: 28,
          top: 540,
          display: "flex",
          gap: 14,
        }}
      >
        {MO_SERVICES.map((s) => (
          <div
            key={s.title}
            style={{
              flex: 1,
              height: 64,
              borderRadius: 10,
              background: C.panel,
              border: `1.5px solid ${C.line}`,
              padding: "8px 16px",
              boxSizing: "border-box",
            }}
          >
            <div style={{ fontSize: 17, fontWeight: 700 }}>{s.title}</div>
            <div style={{ fontSize: 14, color: C.muted }}>{s.price}</div>
          </div>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 56,
          background: C.panel,
          borderTop: `1.5px solid ${C.line}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: ANTON,
          fontSize: 22,
          letterSpacing: "0.04em",
          color: C.muted,
        }}
      >
        BOOKINGS:{" "}
        <span style={{ color: C.text, marginLeft: 10 }}>{MO.phone}</span>
      </div>
    </div>
  );
}

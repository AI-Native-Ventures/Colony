import { ANTON, POPPINS } from "../launch/fonts";
import { NEW_TILES } from "./ep06Phone.ts";
import { MO, MO_COLORS as C, MO_OLD, MO_SERVICES } from "./mo.ts";

const OLD_SERIF = '"Times New Roman", Times, serif';
const OLD_SANS = "Arial, Helvetica, sans-serif";

/** Mo's page as it was, on a phone: the 2018 template, last year's price, weekday hours. 800 px wide. */
export function MoOldPhonePage() {
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
          height: 120,
          background: "linear-gradient(#b04a3c, #7e2b22)",
          padding: "22px 32px 0",
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            fontFamily: OLD_SERIF,
            fontStyle: "italic",
            fontWeight: 700,
            fontSize: 46,
            color: "#ffffff",
            textShadow: "2px 2px 0 #4f1912",
            lineHeight: 1,
          }}
        >
          {MO.name}
        </div>
        <div style={{ marginTop: 12, fontSize: 19, color: "#f0d9d4" }}>
          Your friendly garage in {MO.place}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 120,
          height: 44,
          background: "#d6cfc1",
          borderBottom: "1px solid #b6ad9b",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 32px",
          fontSize: 19,
          color: "#888070",
        }}
      >
        {["Home", "About Us", "Prices", "Contact Us"].map((name, k) => (
          <span key={name} style={{ display: "flex", gap: 12 }}>
            {k > 0 ? <span>|</span> : null}
            <span style={{ color: "#2a4f8f", textDecoration: "underline" }}>
              {name}
            </span>
          </span>
        ))}
      </div>
      <div style={{ position: "absolute", left: 32, right: 32, top: 192 }}>
        <div
          style={{
            fontFamily: OLD_SERIF,
            fontWeight: 700,
            fontSize: 38,
            color: "#333333",
          }}
        >
          Welcome to Mo's!
        </div>
        <div style={{ marginTop: 12, fontSize: 21, lineHeight: 1.5 }}>
          We fix all cars and bakkies. Services, brakes, tyres and more. Bring
          your car in or phone us for a booking.
        </div>
        <div
          style={{
            marginTop: 24,
            border: "2px solid #b6ad9b",
            background: "#f7f3ea",
            padding: "18px 22px",
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              fontFamily: OLD_SERIF,
              fontWeight: 700,
              fontSize: 30,
              color: "#333333",
            }}
          >
            Our Prices
          </div>
          <div
            style={{
              marginTop: 12,
              display: "flex",
              justifyContent: "space-between",
              fontSize: 28,
              color: "#333333",
            }}
          >
            <span>Full service</span>
            <b>{MO_OLD.service}</b>
          </div>
          <div
            style={{
              marginTop: 8,
              display: "flex",
              justifyContent: "space-between",
              fontSize: 22,
            }}
          >
            <span>Brakes</span>
            <span>R600</span>
          </div>
        </div>
        <div style={{ marginTop: 26, fontSize: 25, color: "#333333" }}>
          <b>Hours:</b> {MO_OLD.hours}
        </div>
        <div style={{ marginTop: 6, fontSize: 21, color: "#8a3a2f" }}>
          Closed weekends
        </div>
        <div
          style={{
            marginTop: 26,
            height: 120,
            background: "#e2ddd2",
            border: "1px solid #bdb5a5",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 14,
            fontSize: 18,
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
      </div>
    </div>
  );
}

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
      <path
        d="M150 38 C178 58 190 92 182 126 L156 116 C161 94 154 72 136 58 Z"
        fill={C.red}
      />
      <rect x="160" y="70" width="10" height="26" rx="4" fill="#ff8a80" />
    </svg>
  );
}

/** Mo's new page on a phone, after the green employee: the new price and Saturday hours up front. 800 px wide. */
export function MoNewPhonePage() {
  const [service, saturday] = NEW_TILES;
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
          height: 48,
          background: C.red,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 32px",
          fontSize: 20,
          fontWeight: 600,
        }}
      >
        <span>Call {MO.phone}</span>
        <span>Open Mon to Sat</span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 48,
          height: 84,
          borderBottom: `1.5px solid ${C.line}`,
          display: "flex",
          alignItems: "center",
          padding: "0 32px",
        }}
      >
        <span
          style={{ fontFamily: ANTON, fontSize: 40, letterSpacing: "0.02em" }}
        >
          MO'S <span style={{ color: C.red }}>AUTO</span> REPAIRS
        </span>
        <span style={{ flex: 1 }} />
        <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24">
          <path
            d="M4 7h16M4 12h16M4 17h16"
            stroke={C.text}
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </svg>
      </div>
      <div style={{ position: "absolute", left: 32, top: 152, width: 560 }}>
        <div
          style={{
            fontSize: 18,
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
            fontSize: 64,
            lineHeight: 1.02,
            marginTop: 8,
            letterSpacing: "0.01em",
          }}
        >
          KEEP YOUR CAR
          <br />
          <span style={{ color: C.red }}>RUNNING STRONG</span>
        </div>
        <div style={{ marginTop: 10, fontSize: 21, color: C.muted }}>
          Honest repairs, fair prices, same day.
        </div>
      </div>
      <div style={{ position: "absolute", right: 26, top: 150 }}>
        <BrakeDisc size={176} />
      </div>
      {[service, saturday].map((tile, k) => {
        const red = k === 0;
        return (
          <div
            key={tile.label}
            style={{
              position: "absolute",
              left: 32,
              right: 32,
              top: tile.top,
              height: tile.h,
              borderRadius: 18,
              background: red ? C.red : C.panel,
              border: red ? "none" : `2px solid ${C.line}`,
              padding: "18px 26px",
              boxSizing: "border-box",
            }}
          >
            <div
              style={{
                position: "absolute",
                right: 22,
                top: 20,
                height: 34,
                padding: "0 14px",
                borderRadius: 999,
                background: red ? "#ffffff" : C.red,
                color: red ? C.redDeep : "#ffffff",
                fontSize: 18,
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
                fontSize: 28,
                letterSpacing: "0.03em",
                lineHeight: 1.1,
              }}
            >
              {tile.label}
            </div>
            <div
              style={{
                fontFamily: ANTON,
                fontSize: 62,
                lineHeight: 1.05,
                marginTop: 2,
              }}
            >
              {tile.value}
            </div>
          </div>
        );
      })}
      <div
        style={{
          position: "absolute",
          left: 32,
          right: 32,
          top: 678,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 14,
        }}
      >
        {MO_SERVICES.map((s) => (
          <div
            key={s.title}
            style={{
              height: 66,
              borderRadius: 12,
              background: C.panel,
              border: `1.5px solid ${C.line}`,
              padding: "8px 18px",
              boxSizing: "border-box",
            }}
          >
            <div style={{ fontSize: 20, fontWeight: 700 }}>{s.title}</div>
            <div style={{ fontSize: 16, color: C.muted }}>{s.price}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

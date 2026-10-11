import { CAVEAT, POPPINS } from "../fonts";
import {
  BRIGHT,
  BRIGHT_COLORS as C,
  SITE_BANDS as B,
  SITE_SERVICES,
  SITE_TRUST,
} from "./bright.ts";
import {
  ArrowIcon,
  BrightMark,
  ClockIcon,
  PhoneIcon,
  PinIcon,
  ServiceGlyph,
  ShieldIcon,
  StarIcon,
  TagIcon,
} from "./BrightIcons";

/**
 * Bright Plumbing's website, before and after the green employee repaints it.
 * The new page follows the plumbing sites the owner pointed to on Pinterest:
 * a clear promise in navy, an orange booking button, proof up front, priced
 * services, and a call bar at the foot.
 */

const OLD_SERIF = '"Times New Roman", Times, serif';
const OLD_SANS = "Arial, Helvetica, sans-serif";

/** The site as it was: a 2010s template nobody has touched since 2019. */
export function OldPage() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "#f1ede4",
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
          background: "linear-gradient(#6688ad, #3e5f85)",
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
            textShadow: "2px 2px 0 #23405f",
            lineHeight: 1,
          }}
        >
          Bright Plumbing
        </div>
        <div style={{ marginTop: 8, fontSize: 14, color: "#dbe5f0" }}>
          Your local plumber since 2009
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 96,
          height: 34,
          background: "#d7d0c2",
          borderBottom: "1px solid #b7ae9c",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 30px",
          fontSize: 14,
          color: "#888070",
        }}
      >
        {["Home", "About Us", "Services", "Contact Us"].map((name, k) => (
          <span key={name} style={{ display: "flex", gap: 10 }}>
            {k > 0 ? <span>|</span> : null}
            <span style={{ color: "#2a4f8f", textDecoration: "underline" }}>
              {name}
            </span>
          </span>
        ))}
      </div>
      <div style={{ position: "absolute", left: 30, top: 160, width: 520 }}>
        <div
          style={{
            fontFamily: OLD_SERIF,
            fontWeight: 700,
            fontSize: 30,
            color: "#333333",
          }}
        >
          Welcome to our website!
        </div>
        <div style={{ marginTop: 14, fontSize: 15, lineHeight: 1.55 }}>
          We are a family owned plumbing company based in Johannesburg. We do
          all types of plumbing work. No job too small! Please phone us for a
          quote.
        </div>
        <div
          style={{
            marginTop: 18,
            fontSize: 15,
            fontWeight: 700,
            color: "#333333",
          }}
        >
          Our Services:
        </div>
        <div style={{ marginTop: 6, fontSize: 15, lineHeight: 1.7 }}>
          • Plumbing
          <br />• Geysers
          <br />• Drains
          <br />• General maintenance
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 600,
          top: 160,
          width: 300,
          height: 230,
          background: "#e4dfd4",
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
          left: 600,
          top: 404,
          width: 300,
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        <b style={{ color: "#333333" }}>Prices:</b> please phone us for a quote.
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 74,
          background: "#d7d0c2",
          borderTop: "1px solid #b7ae9c",
          padding: "14px 30px 0",
          boxSizing: "border-box",
          fontSize: 12,
          lineHeight: 1.6,
          color: "#7d7565",
        }}
      >
        Copyright © 2019 Bright Plumbing. All rights reserved. | Last updated:
        March 2019
        <br />
        Best viewed in Internet Explorer at 1024 x 768
      </div>
    </div>
  );
}

/** A white panel van with the business on its side and a ladder on the roof. */
function Van() {
  return (
    <svg aria-hidden="true" width="300" height="160" viewBox="0 0 300 160">
      <ellipse cx="152" cy="148" rx="138" ry="7" fill="#020b2a" opacity="0.3" />
      <rect x="34" y="16" width="150" height="5" rx="2" fill="#d4dce8" />
      {[0, 1, 2, 3, 4, 5, 6, 7].map((k) => (
        <rect
          key={k}
          x={40 + k * 19}
          y="13"
          width="3"
          height="13"
          rx="1"
          fill="#d4dce8"
        />
      ))}
      <path
        d="M14 124V44q0-18 18-18h164q14 0 23 11l32 39q5 6 17 8l14 2q10 2 10 14v24q0 6-6 6H20q-6 0-6-6Z"
        fill="#ffffff"
      />
      <path d="M14 112h278v12q0 6-6 6H20q-6 0-6-6Z" fill="#e3e9f2" />
      <path d="M14 94h271l7 1v10H14Z" fill={C.blue} />
      <path d="M205 38h7l32 40h-39Z" fill="#a8c6ff" />
      <path d="M201 34v90" stroke="#d6dde8" strokeWidth="2" />
      <rect x="211" y="84" width="14" height="4" rx="2" fill="#b5c0cf" />
      <rect x="280" y="90" width="12" height="9" rx="2.5" fill="#ffd36b" />
      <rect x="268" y="118" width="26" height="10" rx="3" fill="#3c4658" />
      <rect x="10" y="118" width="18" height="10" rx="3" fill="#3c4658" />
      {[76, 236].map((x) => (
        <g key={x}>
          <circle cx={x} cy="130" r="23" fill="#cfd7e3" />
          <circle cx={x} cy="130" r="19" fill="#1d2433" />
          <circle cx={x} cy="130" r="8.5" fill="#c3ccd8" />
          <circle cx={x} cy="130" r="3" fill="#1d2433" />
        </g>
      ))}
      <svg
        aria-hidden="true"
        x="24"
        y="42"
        width="34"
        height="34"
        viewBox="0 0 32 32"
      >
        <rect width="32" height="32" rx="9" fill={C.blue} />
        <path
          d="M16 5.5C16 5.5 8.8 14.2 8.8 19.1a7.2 7.2 0 0 0 14.4 0C23.2 14.2 16 5.5 16 5.5Z"
          fill="#ffffff"
        />
      </svg>
      <text
        x="66"
        y="58"
        fontFamily={POPPINS}
        fontWeight="800"
        fontSize="17"
        letterSpacing="-0.3"
        fill={C.navy}
      >
        Bright Plumbing
      </text>
      <text
        x="66"
        y="76"
        fontFamily={POPPINS}
        fontWeight="600"
        fontSize="10.5"
        fill={C.blue}
      >
        {BRIGHT.phone}
      </text>
    </svg>
  );
}

/** A small drop, outline only, floating behind the van. */
function Bubble({ x, y, r }: { x: number; y: number; r: number }) {
  return (
    <div
      style={{
        position: "absolute",
        left: x - r,
        top: y - r,
        width: 2 * r,
        height: 2 * r,
        borderRadius: r,
        border: "2px solid rgb(255 255 255 / 0.28)",
      }}
    />
  );
}

const HERO_PANEL = { x: 512, y: 88, w: 392, h: 284 };

function HeroPanel() {
  return (
    <div
      style={{
        position: "absolute",
        left: HERO_PANEL.x,
        top: HERO_PANEL.y,
        width: HERO_PANEL.w,
        height: HERO_PANEL.h,
        borderRadius: 26,
        overflow: "hidden",
        background: `linear-gradient(140deg, #3274ff, ${C.deep})`,
      }}
    >
      <svg
        aria-hidden="true"
        width={HERO_PANEL.w}
        height={HERO_PANEL.h}
        style={{ position: "absolute", inset: 0 }}
      >
        <circle
          cx={HERO_PANEL.w}
          cy="0"
          r="170"
          fill="none"
          stroke="#ffffff"
          strokeWidth="2"
          opacity="0.14"
        />
        <circle
          cx={HERO_PANEL.w}
          cy="0"
          r="250"
          fill="none"
          stroke="#ffffff"
          strokeWidth="2"
          opacity="0.08"
        />
        <path
          d="M196 50c20 2 34 12 40 28"
          fill="none"
          stroke="#ffffff"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
        <path
          d="M228 72l8 7 5-11"
          fill="none"
          stroke="#ffffff"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <Bubble x={330} y={70} r={9} />
      <Bubble x={356} y={104} r={5} />
      <Bubble x={300} y={46} r={4} />
      <div
        style={{
          position: "absolute",
          left: 24,
          top: 18,
          fontFamily: CAVEAT,
          fontWeight: 700,
          fontSize: 29,
          lineHeight: 0.95,
          color: "#ffffff",
          transform: "rotate(-4deg)",
          transformOrigin: "left top",
        }}
      >
        Fixed today,
        <br />
        not next week!
      </div>
      <div style={{ position: "absolute", left: 46, top: 86 }}>
        <Van />
      </div>
    </div>
  );
}

function ReviewChip() {
  return (
    <div
      style={{
        position: "absolute",
        left: 462,
        top: 342,
        height: 62,
        padding: "0 18px 0 12px",
        borderRadius: 16,
        background: "#ffffff",
        boxShadow: "0 18px 36px -16px rgb(11 31 68 / 0.45)",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <div style={{ display: "flex" }}>
        {[
          ["L", C.orange],
          ["T", C.blue],
          ["N", "#12a37a"],
        ].map(([letter, bg], k) => (
          <span
            key={letter}
            style={{
              width: 30,
              height: 30,
              borderRadius: 15,
              marginLeft: k ? -9 : 0,
              background: bg,
              border: "2.5px solid #ffffff",
              color: "#ffffff",
              fontSize: 12,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {letter}
          </span>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ display: "flex", gap: 1 }}>
          {[0, 1, 2, 3, 4].map((k) => (
            <StarIcon key={k} size={13} color={C.orange} />
          ))}
        </div>
        <span style={{ fontSize: 13, fontWeight: 600, color: C.navy }}>
          4.9 from 212 reviews
        </span>
      </div>
    </div>
  );
}

const TRUST_ICONS = [ShieldIcon, PinIcon, ClockIcon, TagIcon];

/** The repainted site: a clear promise, a real button, proof, prices. */
export function NewPage() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "#ffffff",
        fontFamily: POPPINS,
        color: C.navy,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: B.header.top,
          height: B.header.bottom - B.header.top,
          borderBottom: `1px solid ${C.line}`,
          display: "flex",
          alignItems: "center",
          padding: "0 36px",
        }}
      >
        <BrightMark size={36} />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginLeft: 10,
            lineHeight: 1,
          }}
        >
          <span
            style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em" }}
          >
            Bright
          </span>
          <span
            style={{
              marginTop: 3,
              fontSize: 8.5,
              fontWeight: 700,
              letterSpacing: "0.34em",
              color: C.blue,
            }}
          >
            PLUMBING
          </span>
        </div>
        <div
          style={{
            display: "flex",
            gap: 28,
            marginLeft: 64,
            fontSize: 15,
            fontWeight: 500,
            color: "#4a5672",
          }}
        >
          <span
            style={{
              color: C.navy,
              fontWeight: 600,
              borderBottom: `2.5px solid ${C.orange}`,
              paddingBottom: 3,
            }}
          >
            Home
          </span>
          <span>Services</span>
          <span>Prices</span>
          <span>Reviews</span>
        </div>
        <span style={{ flex: 1 }} />
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            fontSize: 15,
            fontWeight: 600,
            marginRight: 22,
          }}
        >
          <PhoneIcon size={16} color={C.blue} />
          {BRIGHT.phone}
        </span>
        <span
          style={{
            height: 42,
            padding: "0 20px",
            borderRadius: 999,
            background: C.orange,
            color: "#ffffff",
            fontSize: 14.5,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
          }}
        >
          Book a plumber
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: B.hero.top,
          height: B.hero.bottom - B.hero.top,
          background: `linear-gradient(90deg, #ffffff 40%, ${C.mist})`,
        }}
      />
      <div style={{ position: "absolute", left: 36, top: 100, width: 460 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.2em",
            color: C.blue,
          }}
        >
          <span
            style={{
              width: 22,
              height: 3,
              borderRadius: 2,
              background: C.orange,
            }}
          />
          LICENSED · INSURED · LOCAL
        </div>
        <div
          style={{
            marginTop: 12,
            fontSize: 45,
            fontWeight: 700,
            lineHeight: 1.1,
            letterSpacing: "-0.03em",
          }}
        >
          Same-day plumber
          <br />
          <span style={{ color: C.blue }}>in Sandton.</span>
        </div>
        <div
          style={{
            marginTop: 14,
            width: 410,
            fontSize: 16,
            lineHeight: 1.55,
            color: C.muted,
          }}
        >
          Leaks, drains and geysers fixed today. Upfront prices and a tidy job,
          every time.
        </div>
        <div style={{ marginTop: 22, display: "flex", gap: 12 }}>
          <span
            style={{
              height: 50,
              padding: "0 22px 0 26px",
              borderRadius: 999,
              background: C.orange,
              color: "#ffffff",
              fontSize: 15.5,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 8,
              boxShadow: "0 12px 22px -12px rgb(255 122 26 / 0.8)",
            }}
          >
            Book a call-out
            <ArrowIcon size={18} color="#ffffff" />
          </span>
          <span
            style={{
              height: 50,
              padding: "0 22px",
              borderRadius: 999,
              border: "1.5px solid #d3dbea",
              boxSizing: "border-box",
              fontSize: 15.5,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <PhoneIcon size={16} color={C.blue} />
            Call us now
          </span>
        </div>
      </div>
      <HeroPanel />
      <ReviewChip />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: B.trust.top,
          height: B.trust.bottom - B.trust.top,
          background: C.mist,
          borderTop: `1px solid ${C.line}`,
          borderBottom: `1px solid ${C.line}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 36px",
        }}
      >
        {SITE_TRUST.map((label, k) => {
          const Icon = TRUST_ICONS[k];
          return (
            <span
              key={label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                fontSize: 13.5,
                fontWeight: 600,
              }}
            >
              <Icon size={19} color={C.blue} />
              {label}
            </span>
          );
        })}
      </div>
      <div
        style={{
          position: "absolute",
          left: 36,
          right: 36,
          top: B.services.top + 18,
          display: "flex",
          alignItems: "flex-end",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              letterSpacing: "0.2em",
              color: C.blue,
            }}
          >
            OUR SERVICES
          </div>
          <div
            style={{
              marginTop: 2,
              fontSize: 25,
              fontWeight: 700,
              letterSpacing: "-0.02em",
            }}
          >
            Fixed right, the first time.
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 14,
            fontWeight: 600,
            color: C.blue,
            marginBottom: 6,
          }}
        >
          View all services
          <ArrowIcon size={16} color={C.blue} />
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 36,
          right: 36,
          top: B.services.top + 86,
          display: "flex",
          gap: 17,
        }}
      >
        {SITE_SERVICES.map((service, k) => {
          const lit = k === 1;
          return (
            <div
              key={service.title}
              style={{
                flex: 1,
                height: 78,
                borderRadius: 18,
                padding: "0 16px",
                boxSizing: "border-box",
                background: lit ? C.blue : "#ffffff",
                border: lit ? "none" : `1px solid ${C.line}`,
                boxShadow: lit
                  ? "0 16px 30px -18px rgb(29 91 255 / 0.9)"
                  : "0 10px 24px -20px rgb(11 31 68 / 0.5)",
                display: "flex",
                alignItems: "center",
                gap: 13,
                color: lit ? "#ffffff" : C.navy,
              }}
            >
              <span
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: 23,
                  background: lit ? "rgb(255 255 255 / 0.16)" : C.sky,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <ServiceGlyph
                  icon={service.icon}
                  size={24}
                  color={lit ? "#ffffff" : C.blue}
                />
              </span>
              <span style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: 16, fontWeight: 600 }}>
                  {service.title}
                </span>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: lit ? "rgb(255 255 255 / 0.8)" : C.muted,
                  }}
                >
                  {service.price}
                </span>
              </span>
              <span style={{ flex: 1 }} />
              <span
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  background: lit ? "#ffffff" : "transparent",
                  border: lit ? "none" : `1.5px solid ${C.line}`,
                  boxSizing: "border-box",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <ArrowIcon size={15} color={C.blue} />
              </span>
            </div>
          );
        })}
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: B.cta.top,
          height: B.cta.bottom - B.cta.top,
          background: C.navy,
          display: "flex",
          alignItems: "center",
          padding: "0 36px",
          gap: 14,
          color: "#ffffff",
        }}
      >
        <span
          style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-0.01em" }}
        >
          Need a plumber today?
        </span>
        <span style={{ fontSize: 14.5, color: "rgb(255 255 255 / 0.72)" }}>
          We pick up 7 days a week.
        </span>
        <span
          style={{
            marginLeft: 14,
            height: 40,
            padding: "0 18px",
            borderRadius: 999,
            background: C.orange,
            fontSize: 14,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 7,
          }}
        >
          <PhoneIcon size={15} color="#ffffff" />
          Call {BRIGHT.phone}
        </span>
      </div>
    </div>
  );
}

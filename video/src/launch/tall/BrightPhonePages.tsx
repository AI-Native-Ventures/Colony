import type { SiteSetup } from "../../explainers/SitePhone";
import { CAVEAT, POPPINS } from "../fonts";
import { BRIGHT, BRIGHT_COLORS as C, SITE_SERVICES } from "../wide/bright.ts";
import {
  ArrowIcon,
  BrightMark,
  PhoneIcon,
  ServiceGlyph,
  StarIcon,
} from "../wide/BrightIcons";
import { Van } from "../wide/BrightSite";
import { BRIGHT_OLD_PHONE as O, BRIGHT_PHONE as N } from "./filmPages.ts";

/**
 * Bright Plumbing's website on a phone, before and after the green employee
 * repaints it: the film's two pages (BrightSite) laid out for an 800 px
 * screen. Page pixels.
 */

const OLD_SERIF = '"Times New Roman", Times, serif';
const OLD_SANS = "Arial, Helvetica, sans-serif";

/** The site as it was, on a phone: the 2019 template, no prices, no photo. */
export function BrightOldPhonePage() {
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
          top: O.header.top,
          height: O.header.bottom - O.header.top,
          background: "linear-gradient(#6688ad, #3e5f85)",
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
            textShadow: "2px 2px 0 #23405f",
            lineHeight: 1,
          }}
        >
          {BRIGHT.name}
        </div>
        <div style={{ marginTop: 12, fontSize: 19, color: "#dbe5f0" }}>
          Your local plumber since 2009
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: O.nav.top,
          height: O.nav.bottom - O.nav.top,
          background: "#d7d0c2",
          borderBottom: "1px solid #b7ae9c",
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 32px",
          fontSize: 19,
          color: "#888070",
        }}
      >
        {["Home", "About Us", "Services", "Contact Us"].map((name, k) => (
          <span key={name} style={{ display: "flex", gap: 12 }}>
            {k > 0 ? <span>|</span> : null}
            <span style={{ color: "#2a4f8f", textDecoration: "underline" }}>
              {name}
            </span>
          </span>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: 32,
          right: 32,
          top: O.welcome.top,
        }}
      >
        <div
          style={{
            fontFamily: OLD_SERIF,
            fontWeight: 700,
            fontSize: 38,
            color: "#333333",
          }}
        >
          Welcome to our website!
        </div>
        <div style={{ marginTop: 12, fontSize: 21, lineHeight: 1.5 }}>
          We are a family owned plumbing company based in Johannesburg. We do
          all types of plumbing work. No job too small! Please phone us for a
          quote.
        </div>
        <div
          style={{
            marginTop: 18,
            fontSize: 21,
            fontWeight: 700,
            color: "#333333",
          }}
        >
          Our Services:
        </div>
        <div style={{ marginTop: 4, fontSize: 21, lineHeight: 1.6 }}>
          • Plumbing
          <br />• Geysers
          <br />• Drains
          <br />• General maintenance
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 32,
          right: 32,
          top: O.photo.top,
          height: O.photo.bottom - O.photo.top,
          background: "#e4dfd4",
          border: "1px solid #bdb5a5",
          boxSizing: "border-box",
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
      <div
        style={{
          position: "absolute",
          left: 32,
          right: 32,
          top: O.prices.top,
          fontSize: 21,
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
          top: O.footer.top,
          height: O.footer.bottom - O.footer.top,
          background: "#d7d0c2",
          borderTop: "1px solid #b7ae9c",
          padding: "14px 32px 0",
          boxSizing: "border-box",
          fontSize: 16,
          lineHeight: 1.6,
          color: "#7d7565",
        }}
      >
        Copyright © 2019 {BRIGHT.name}. Last updated: March 2019
        <br />
        Best viewed in Internet Explorer at 1024 x 768
      </div>
    </div>
  );
}

/** The van panel under the promise: the handwritten line, the van, the reviews. */
function VanPanel() {
  const w = 800 - 72;
  const h = N.panel.bottom - N.panel.top;
  return (
    <div
      style={{
        position: "absolute",
        left: 36,
        top: N.panel.top,
        width: w,
        height: h,
        borderRadius: 30,
        overflow: "hidden",
        background: `linear-gradient(140deg, #3274ff, ${C.deep})`,
      }}
    >
      <svg
        aria-hidden="true"
        width={w}
        height={h}
        style={{ position: "absolute", inset: 0 }}
      >
        <circle
          cx={w}
          cy="0"
          r="190"
          fill="none"
          stroke="#ffffff"
          strokeWidth="2"
          opacity="0.14"
        />
        <circle
          cx={w}
          cy="0"
          r="280"
          fill="none"
          stroke="#ffffff"
          strokeWidth="2"
          opacity="0.08"
        />
      </svg>
      <div
        style={{
          position: "absolute",
          left: 30,
          top: 24,
          fontFamily: CAVEAT,
          fontWeight: 700,
          fontSize: 40,
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
      <div
        style={{
          position: "absolute",
          left: 30,
          top: h - 30 - 60,
          height: 60,
          padding: "0 20px 0 12px",
          borderRadius: 16,
          background: "#ffffff",
          boxShadow: "0 18px 36px -16px rgb(11 31 68 / 0.6)",
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
                width: 32,
                height: 32,
                borderRadius: 16,
                marginLeft: k ? -10 : 0,
                background: bg,
                border: "2.5px solid #ffffff",
                color: "#ffffff",
                fontSize: 13,
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
              <StarIcon key={k} size={15} color={C.orange} />
            ))}
          </div>
          <span style={{ fontSize: 15, fontWeight: 600, color: C.navy }}>
            4.9 from 212 reviews
          </span>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: w - 300 * 1.12 - 22,
          top: h - 160 * 1.12 - 4,
          transform: "scale(1.12)",
          transformOrigin: "0 0",
        }}
      >
        <Van />
      </div>
    </div>
  );
}

/** The repainted site on a phone: the promise, a real button, the van, prices. */
export function BrightNewPhonePage() {
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
          top: N.hero.top,
          height: N.hero.bottom - N.hero.top,
          background: `linear-gradient(180deg, #ffffff 30%, ${C.mist} 70%, #ffffff)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: N.header.top,
          height: N.header.bottom - N.header.top,
          borderBottom: `1px solid ${C.line}`,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          padding: "0 36px",
        }}
      >
        <BrightMark size={46} />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginLeft: 12,
            lineHeight: 1,
          }}
        >
          <span
            style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em" }}
          >
            Bright
          </span>
          <span
            style={{
              marginTop: 4,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.34em",
              color: C.blue,
            }}
          >
            PLUMBING
          </span>
        </div>
        <span style={{ flex: 1 }} />
        <span
          style={{
            height: 54,
            padding: "0 24px",
            borderRadius: 999,
            background: C.orange,
            color: "#ffffff",
            fontSize: 20,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
          }}
        >
          Book a plumber
        </span>
        <svg
          aria-hidden="true"
          width="40"
          height="40"
          viewBox="0 0 24 24"
          style={{ marginLeft: 20 }}
        >
          <path
            d="M4 7h16M4 12h16M4 17h16"
            stroke={C.navy}
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </svg>
      </div>
      <div style={{ position: "absolute", left: 36, right: 36, top: 116 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: 15,
            fontWeight: 600,
            letterSpacing: "0.2em",
            color: C.blue,
          }}
        >
          <span
            style={{
              width: 26,
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
            fontSize: 62,
            fontWeight: 700,
            lineHeight: 1.08,
            letterSpacing: "-0.03em",
          }}
        >
          Same-day plumber
          <br />
          <span style={{ color: C.blue }}>in Sandton.</span>
        </div>
        <div
          style={{
            marginTop: 12,
            width: 640,
            fontSize: 22,
            lineHeight: 1.5,
            color: C.muted,
          }}
        >
          Leaks, drains and geysers fixed today. Upfront prices and a tidy job,
          every time.
        </div>
        <div style={{ marginTop: 18, display: "flex", gap: 14 }}>
          <span
            style={{
              height: 58,
              padding: "0 26px 0 30px",
              borderRadius: 999,
              background: C.orange,
              color: "#ffffff",
              fontSize: 21,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 10,
              boxShadow: "0 12px 22px -12px rgb(255 122 26 / 0.8)",
            }}
          >
            Book a call-out
            <ArrowIcon size={22} color="#ffffff" />
          </span>
          <span
            style={{
              height: 58,
              padding: "0 26px",
              borderRadius: 999,
              border: "1.5px solid #d3dbea",
              boxSizing: "border-box",
              fontSize: 21,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <PhoneIcon size={20} color={C.blue} />
            Call us now
          </span>
        </div>
      </div>
      <VanPanel />
      <div
        style={{
          position: "absolute",
          left: 36,
          right: 36,
          top: N.services.top,
        }}
      >
        <div
          style={{
            fontSize: 13,
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
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: "-0.02em",
          }}
        >
          Fixed right, the first time.
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 36,
          right: 36,
          top: N.services.bottom - 82,
          height: 82,
          display: "flex",
          gap: 12,
        }}
      >
        {SITE_SERVICES.map((service, k) => {
          const lit = k === 1;
          return (
            <div
              key={service.title}
              style={{
                flex: 1,
                borderRadius: 18,
                padding: "0 14px",
                boxSizing: "border-box",
                background: lit ? C.blue : "#ffffff",
                border: lit ? "none" : `1px solid ${C.line}`,
                boxShadow: lit
                  ? "0 16px 30px -18px rgb(29 91 255 / 0.9)"
                  : "0 10px 24px -20px rgb(11 31 68 / 0.5)",
                display: "flex",
                alignItems: "center",
                gap: 12,
                color: lit ? "#ffffff" : C.navy,
              }}
            >
              <span
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 21,
                  flexShrink: 0,
                  background: lit ? "rgb(255 255 255 / 0.16)" : C.sky,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <ServiceGlyph
                  icon={service.icon}
                  size={22}
                  color={lit ? "#ffffff" : C.blue}
                />
              </span>
              <span style={{ display: "flex", flexDirection: "column" }}>
                <span
                  style={{
                    fontSize: 17,
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                  }}
                >
                  {service.title}
                </span>
                <span
                  style={{
                    fontSize: 15,
                    fontWeight: 500,
                    color: lit ? "rgb(255 255 255 / 0.8)" : C.muted,
                  }}
                >
                  {service.price}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Bright's site in the film's phone browser: its address, its two pages, "Updated" once repainted. */
export const BRIGHT_SITE: SiteSetup = {
  domain: BRIGHT.domain,
  chip: "Updated",
  Old: BrightOldPhonePage,
  New: BrightNewPhonePage,
};

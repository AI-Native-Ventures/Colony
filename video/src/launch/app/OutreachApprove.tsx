import { CLICK_AT, MORE_CLICKS } from "../film.ts";
import { easeInOutCubic, progress } from "../math.ts";
import { Cursor, type CursorKey } from "./Cursor";
import { UI } from "./ui.ts";

type Draft = { lead: string; subject: string; body: string };

/** Emails the amber employee wrote for Bright Plumbing, waiting for a yes. */
const DRAFTS: Draft[] = [
  {
    lead: "Rosebank Auto Care",
    subject: "Leaky pipes at the workshop?",
    body: "Hi Thabo, Bright Plumbing fixes leaks and blocked drains for workshops in Rosebank. Can we take a look this week?",
  },
  {
    lead: "Sandton Medical Suites",
    subject: "A burst geyser can close a practice",
    body: "Hi Lerato, we can be there within the hour, any day, so your patients never notice a thing.",
  },
  {
    lead: "Grayston Office Park",
    subject: "Blocked drains in the building?",
    body: "Hi Pieter, we keep drains clear for office parks in Sandton. Would a free check help?",
  },
];

const CLICKS = [CLICK_AT, ...MORE_CLICKS];
const CARD_TOP = [268, 470, 672];
const BUTTON = { x: 785, dy: 138 };
const FLY_AT = 22.6;

const KEYS: CursorKey[] = [
  { at: 19.3, x: 520, y: 900 },
  { at: CLICK_AT - 0.2, x: BUTTON.x, y: CARD_TOP[0] + BUTTON.dy },
  { at: CLICK_AT + 0.1, x: BUTTON.x, y: CARD_TOP[0] + BUTTON.dy },
  { at: MORE_CLICKS[0] - 0.15, x: BUTTON.x, y: CARD_TOP[1] + BUTTON.dy },
  { at: MORE_CLICKS[0] + 0.1, x: BUTTON.x, y: CARD_TOP[1] + BUTTON.dy },
  { at: MORE_CLICKS[1] - 0.15, x: BUTTON.x, y: CARD_TOP[2] + BUTTON.dy },
  { at: MORE_CLICKS[1] + 0.2, x: BUTTON.x, y: CARD_TOP[2] + BUTTON.dy },
  { at: 22.6, x: 620, y: 900 },
];

const Stat: React.FC<{ label: string; value: number; x: number }> = ({
  label,
  value,
  x,
}) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: 120,
      width: 396,
      height: 116,
      borderRadius: 22,
      background: UI.card,
      border: `1.5px solid ${UI.line}`,
    }}
  >
    <div
      style={{
        position: "absolute",
        left: 24,
        top: 18,
        fontSize: 22,
        color: UI.muted,
      }}
    >
      {label}
    </div>
    <div
      style={{
        position: "absolute",
        left: 24,
        top: 46,
        fontSize: 50,
        fontWeight: 800,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {value}
    </div>
  </div>
);

/** The real Outreach screen: drafts waiting, approved one by one, then sent on their way. */
export const OutreachApprove: React.FC<{ t: number; opacity: number }> = ({
  t,
  opacity,
}) => {
  const approved = CLICKS.filter((c) => t >= c + 0.05).length;
  return (
    <div style={{ position: "absolute", inset: 0, opacity }}>
      <div
        style={{
          position: "absolute",
          left: 56,
          top: 36,
          fontSize: 56,
          fontWeight: 700,
          letterSpacing: "-0.02em",
        }}
      >
        Outreach
      </div>
      <Stat label="Drafts Ready" value={DRAFTS.length - approved} x={56} />
      <Stat label="Approved" value={approved} x={488} />
      {DRAFTS.map((draft, i) => {
        const isApproved = t >= CLICKS[i] + 0.05;
        const fly = easeInOutCubic(progress(t, FLY_AT + i * 0.1, 0.7));
        if (fly >= 1) return null;
        return (
          <div
            key={draft.lead}
            style={{
              position: "absolute",
              left: 56,
              top: CARD_TOP[i],
              width: 828,
              height: 186,
              borderRadius: 24,
              background: UI.card,
              border: `1.5px solid ${isApproved ? "hsl(160 60% 45% / 0.5)" : UI.line}`,
              opacity: 1 - fly,
              transform: `translate(${(fly * fly * 1100).toFixed(1)}px, ${(-fly * 140).toFixed(1)}px) rotate(${(-fly * 4).toFixed(2)}deg)`,
              boxShadow:
                fly > 0
                  ? `-60px 10px 70px -12px hsl(38 92% 50% / ${(0.7 * (1 - fly)).toFixed(3)})`
                  : undefined,
            }}
          >
            <div
              style={{
                position: "absolute",
                left: 24,
                top: 20,
                display: "flex",
                alignItems: "center",
                gap: 12,
                fontSize: 28,
                fontWeight: 700,
              }}
            >
              <span
                style={{
                  width: 30,
                  height: 22,
                  borderRadius: 4,
                  border: `3px solid ${UI.violet}`,
                  boxSizing: "border-box",
                }}
              />
              {draft.lead}
              <span style={{ fontWeight: 400, fontSize: 24, color: UI.muted }}>
                · Email
              </span>
            </div>
            <div
              style={{
                position: "absolute",
                right: 24,
                top: 20,
                padding: "6px 16px",
                borderRadius: 999,
                fontSize: 20,
                fontWeight: 600,
                background: isApproved ? UI.successSoft : "#eeecf4",
                color: isApproved ? UI.success : UI.muted,
              }}
            >
              {isApproved ? "Approved" : "Draft"}
            </div>
            <div
              style={{
                position: "absolute",
                left: 24,
                top: 66,
                fontSize: 26,
                fontWeight: 600,
              }}
            >
              {draft.subject}
            </div>
            <div
              style={{
                position: "absolute",
                left: 24,
                top: 106,
                width: 600,
                height: 60,
                overflow: "hidden",
                fontSize: 21,
                lineHeight: 1.4,
                color: UI.muted,
              }}
            >
              {draft.body}
            </div>
            <div
              style={{
                position: "absolute",
                right: 24,
                bottom: 22,
                width: 150,
                height: 52,
                borderRadius: 14,
                background: UI.violet,
                color: "#fff",
                fontSize: 24,
                fontWeight: 700,
                display: "grid",
                placeItems: "center",
                opacity: isApproved ? 0 : 1,
              }}
            >
              Approve
            </div>
          </div>
        );
      })}
      <Cursor t={t} keys={KEYS} clicks={CLICKS} opacity={opacity} />
    </div>
  );
};

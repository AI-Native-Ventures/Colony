import { typedText } from "../typing.ts";
import { Cursor, type CursorKey } from "./Cursor";
import { UI } from "./ui.ts";

const WEBSITE = "brightplumbing.co.za";
const SUMMARY =
  "Fixes leaks, geysers and blocked drains for homes and offices in Sandton.";
const TYPE_FROM = 9.9;
const READ_AT = 11.3;
const READ_DONE = 12.3;

/** Pointer path: rests by the website field while it types, then presses "Read website". */
const KEYS: CursorKey[] = [
  { at: 9.6, x: 760, y: 820 },
  { at: 10.4, x: 640, y: 470 },
  { at: 11.2, x: 150, y: 532 },
  { at: 12.6, x: 150, y: 532 },
  { at: 13.2, x: 700, y: 860 },
];

const label: React.CSSProperties = {
  position: "absolute",
  left: 56,
  fontSize: 26,
  fontWeight: 600,
  color: UI.ink,
};

const field: React.CSSProperties = {
  position: "absolute",
  left: 56,
  width: 828,
  background: UI.card,
  border: `1.5px solid ${UI.line}`,
  borderRadius: 20,
  padding: "0 28px",
  fontSize: 32,
  color: UI.ink,
  display: "flex",
  alignItems: "center",
};

/** The real "Your business" setup form, typing the website and reading it. */
export const BusinessForm: React.FC<{ t: number; opacity: number }> = ({
  t,
  opacity,
}) => {
  const website = typedText(WEBSITE, t, TYPE_FROM, 14);
  const typing = t > TYPE_FROM && website.length < WEBSITE.length;
  const caret = typing || Math.floor(t * 2) % 2 === 0;
  const reading = t >= READ_AT && t < READ_DONE;
  const summary = typedText(SUMMARY, t, READ_DONE + 0.05, 60);
  const link =
    t < READ_AT
      ? "Read website"
      : reading
        ? "Reading your website…"
        : "Read website again";
  return (
    <div style={{ position: "absolute", inset: 0, opacity }}>
      <div
        style={{
          position: "absolute",
          left: 56,
          top: 40,
          fontSize: 60,
          fontWeight: 700,
          letterSpacing: "-0.02em",
        }}
      >
        Your business
      </div>
      <div
        style={{
          position: "absolute",
          left: 56,
          top: 120,
          fontSize: 28,
          color: UI.muted,
        }}
      >
        Only the essentials. You can add more as you go.
      </div>

      <div style={{ ...label, top: 204 }}>Business name</div>
      <div style={{ ...field, top: 246, height: 86 }}>Bright Plumbing</div>

      <div style={{ ...label, top: 364 }}>
        Website{" "}
        <span style={{ fontWeight: 400, color: UI.muted, fontSize: 24 }}>
          optional
        </span>
      </div>
      <div style={{ ...field, top: 406, height: 86 }}>
        <span>{website}</span>
        {t > TYPE_FROM - 0.4 && t < READ_AT ? (
          <span
            style={{
              width: 3,
              height: 40,
              marginLeft: 2,
              background: UI.violet,
              opacity: caret ? 1 : 0,
            }}
          />
        ) : null}
      </div>
      {website.length > 0 ? (
        <div
          style={{
            position: "absolute",
            left: 56,
            top: 512,
            fontSize: 28,
            fontWeight: 600,
            color: UI.violet,
            display: "flex",
            alignItems: "center",
            gap: 14,
          }}
        >
          {reading ? (
            <span
              style={{
                width: 26,
                height: 26,
                borderRadius: "50%",
                border: `4px solid ${UI.violetSoft}`,
                borderTopColor: UI.violet,
                transform: `rotate(${(t * 540).toFixed(1)}deg)`,
              }}
            />
          ) : null}
          {link}
        </div>
      ) : null}

      <div style={{ ...label, top: 590 }}>Business summary</div>
      <div
        style={{
          ...field,
          top: 632,
          height: 196,
          alignItems: "flex-start",
          padding: "22px 28px",
          lineHeight: 1.4,
          fontSize: 30,
          color: summary ? UI.ink : UI.muted,
        }}
      >
        {summary || "We help…"}
      </div>

      <Cursor t={t} keys={KEYS} clicks={[READ_AT]} opacity={opacity} />
    </div>
  );
};

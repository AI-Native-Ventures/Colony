import {
  AbsoluteFill,
  Composition,
  interpolate,
  Sequence,
  useCurrentFrame,
} from "remotion";
import { AntMark } from "./brand/AntMark";
import { t1Schema, type T1Props } from "./t1/schema";

export const Hello: React.FC = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill
      style={{
        backgroundColor: "hsl(258 90% 66%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <h1
        style={{
          color: "white",
          fontSize: 120,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          textAlign: "center",
          opacity,
        }}
      >
        Colony
      </h1>
    </AbsoluteFill>
  );
};

export const T1: React.FC<T1Props> = (props) => {
  const { hook, hue, lines, results, approval, endCard } = props;
  const frame = useCurrentFrame();
  const hueColor =
    hue === "violet"
      ? "hsl(258 90% 66%)"
      : hue === "blue"
        ? "hsl(217 91% 60%)"
        : hue === "pink"
          ? "hsl(330 81% 60%)"
          : hue === "amber"
            ? "hsl(38 92% 50%)"
            : "hsl(160 60% 45%)";

  const ownerLine = lines.find((l) => l.who === "owner");
  const scoutLine = lines.find((l) => l.who === "scout");

  return (
    <AbsoluteFill style={{ backgroundColor: hueColor }}>
      {/* Soft radial gradient overlay for depth */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 50% 30%, ${hueColor}20 0%, ${hueColor} 70%)`,
          opacity: 0.6,
        }}
      />
      {/* Phone-shaped panel */}
      <div
        style={{
          position: "absolute",
          top: 80,
          left: "50%",
          transform: "translateX(-50%)",
          width: 920,
          height: 1680,
          backgroundColor: "#fff",
          borderRadius: 36,
          overflow: "hidden",
          boxShadow: "0 24px 80px rgba(0,0,0,0.35)",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: 24,
            borderBottom: "1px solid #e5e5e5",
            fontSize: 28,
            fontWeight: 600,
            color: "#1a1a2e",
          }}
        >
          Colony · #general
        </div>

        {/* Hook card */}
        <Sequence from={0} durationInFrames={60}>
          <AbsoluteFill
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 40,
            }}
          >
            <h2
              style={{
                color: "#1a1a2e",
                fontSize: 52,
                textAlign: "center",
                lineHeight: 1.15,
                fontWeight: 700,
              }}
            >
              {hook}
            </h2>
          </AbsoluteFill>
        </Sequence>

        {/* Owner message */}
        <Sequence from={60} durationInFrames={90}>
          <div
            style={{
              padding: 20,
              display: "flex",
              justifyContent: "flex-end",
              alignItems: "flex-start",
            }}
          >
            <div
              style={{
                backgroundColor: hueColor,
                color: "white",
                padding: 16,
                borderRadius: 20,
                borderBottomRightRadius: 4,
                maxWidth: 640,
                fontSize: 28,
                lineHeight: 1.35,
              }}
            >
              {ownerLine?.text ?? ""}
            </div>
          </div>
        </Sequence>

        {/* Scout reply */}
        <Sequence from={150} durationInFrames={60}>
          <div
            style={{
              padding: 20,
              display: "flex",
              justifyContent: "flex-start",
              alignItems: "flex-start",
            }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 24,
                backgroundColor: "#f0e6f5",
                color: hueColor,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 22,
                fontWeight: 700,
                flexShrink: 0,
                marginRight: 12,
              }}
            >
              S
            </div>
            <div
              style={{
                backgroundColor: "#f8f7fa",
                color: "#1a1a2e",
                padding: 16,
                borderRadius: 20,
                borderBottomLeftRadius: 4,
                maxWidth: 640,
                fontSize: 28,
                lineHeight: 1.35,
              }}
            >
              {scoutLine?.text ?? ""}
            </div>
          </div>
        </Sequence>

        {/* Results rows */}
        {results.map((r, i) => (
          <Sequence key={r.name} from={210 + i * 40} durationInFrames={30}>
            <div
              style={{
                padding: "12px 20px",
                borderBottom: "1px solid #eee",
                display: "flex",
                alignItems: "center",
              }}
            >
              <div
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 6,
                  backgroundColor: hueColor,
                  flexShrink: 0,
                  marginRight: 14,
                }}
              />
              <div style={{ fontSize: 22, color: "#2a2a3e" }}>
                <div style={{ fontWeight: 600 }}>{r.name}</div>
                <div style={{ fontSize: 18, color: "#6a6a7e" }}>{r.detail}</div>
              </div>
            </div>
          </Sequence>
        ))}

        {/* Approval card */}
        <Sequence from={360} durationInFrames={120}>
          <div
            style={{
              margin: 20,
              padding: 28,
              backgroundColor: "#fff",
              borderRadius: 24,
              border: "2px solid #eae8f0",
              boxShadow: "0 4px 20px rgba(0,0,0,0.06)",
            }}
          >
            <div
              style={{
                fontSize: 36,
                fontWeight: 700,
                color: "#1a1a2e",
                marginBottom: 8,
              }}
            >
              {approval.question}
            </div>
            <div style={{ fontSize: 20, color: "#6a6a7e", marginBottom: 20 }}>
              {approval.fine}
            </div>
            <div style={{ display: "flex", gap: 16 }}>
              <button
                type="button"
                style={{
                  flex: 1,
                  padding: "14px 0",
                  backgroundColor: hueColor,
                  color: "white",
                  border: "none",
                  borderRadius: 16,
                  fontSize: 24,
                  fontWeight: 700,
                  cursor: "pointer",
                  transform: `scale(${interpolate(Math.sin(frame * 0.15), [-1, 1], [0.97, 1.03], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })})`,
                }}
              >
                Approve and send
              </button>
              <button
                type="button"
                style={{
                  flex: 1,
                  padding: "14px 0",
                  backgroundColor: "#f0f0f5",
                  color: "#6a6a7e",
                  border: "none",
                  borderRadius: 16,
                  fontSize: 24,
                  fontWeight: 600,
                }}
              >
                Not now
              </button>
            </div>
          </div>
        </Sequence>

        {/* End card */}
        <Sequence from={540} durationInFrames={180}>
          <AbsoluteFill
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: 60,
              textAlign: "center",
            }}
          >
            <h2
              style={{
                color: "#1a1a2e",
                fontSize: 64,
                fontWeight: 800,
                lineHeight: 1.1,
                marginBottom: 24,
              }}
            >
              {endCard.title}
            </h2>
            <div style={{ color: hueColor, fontSize: 28, fontWeight: 600 }}>
              {endCard.url}
            </div>
            <div style={{ marginTop: 36, opacity: 0.9 }}>
              <div style={{ width: 140, height: 93, color: hueColor }}>
                <AntMark className="t1-end-ant" />
              </div>
            </div>
          </AbsoluteFill>
        </Sequence>
      </div>
    </AbsoluteFill>
  );
};

export const Root = () => {
  return (
    <>
      <Composition
        id="Hello"
        component={Hello}
        durationInFrames={90}
        fps={30}
        width={1080}
        height={1920}
      />
      <Composition
        id="T1"
        component={T1}
        durationInFrames={720}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          hook: "I found 23 customers for my boss before he woke up.",
          hue: "violet",
          lines: [
            {
              who: "owner",
              text: "Find 20 offices in Sandton that might need a plumber.",
            },
            {
              who: "scout",
              text: "Done. 20 offices found, with a contact name for each. 20 intro emails drafted.",
            },
          ],
          results: [
            {
              name: "Bryanston Business Park",
              detail: "Facilities manager: Thabo M.",
            },
            {
              name: "Sandton Medical Suites",
              detail: "Practice manager: Lerato K.",
            },
            {
              name: "Grayston Office Tower",
              detail: "Building manager: Pieter V.",
            },
          ],
          approval: {
            question: "Send 20 intro emails from your address?",
            fine: "You can read each one before it goes.",
          },
          endCard: {
            title: "Give your business a team.",
            url: "colony.ainative.ventures",
          },
        }}
        schema={t1Schema}
      />
    </>
  );
};

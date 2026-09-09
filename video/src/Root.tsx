import {
  AbsoluteFill,
  Composition,
  interpolate,
  useCurrentFrame,
} from "remotion";
import { AntMark } from "./brand/AntMark";
import { t1Schema, type T1Props } from "./t1/schema";

function fadeIn(frame: number, startFrame: number) {
  if (frame < startFrame) return 0;
  const f = frame - startFrame;
  return interpolate(Math.min(f, 15), [0, 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

function slideUp(frame: number, startFrame: number) {
  if (frame < startFrame) return 40;
  const f = frame - startFrame;
  return interpolate(Math.min(f, 15), [0, 15], [40, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

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

  const panelFadeIn = interpolate(
    Math.max(0, Math.min(frame - 60, 12)),
    [0, 12],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const hookFadeOut = interpolate(
    Math.max(0, Math.min(frame - 48, 12)),
    [0, 12],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  const showHook = frame < 60;
  const showPanel = frame >= 48;

  // Click ring at 480
  const clickProgress = Math.max(0, Math.min(frame - 480, 10));
  const ringScale = interpolate(clickProgress, [0, 10], [1.4, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const ringOpacity = interpolate(clickProgress, [0, 10], [0.5, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Button pulse loop
  const pulseScale =
    interpolate(Math.sin(frame * 0.15), [-1, 1], [0.97, 1.03], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }) * (frame >= 360 && frame < 490 ? 1 : 0.97);

  const showSent = frame >= 490;

  return (
    <AbsoluteFill style={{ backgroundColor: hueColor }}>
      {/* Hook card - full bleed */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: showHook ? "flex" : "none",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: 80,
          opacity: hookFadeOut,
        }}
      >
        <h2
          style={{
            color: "white",
            fontSize: 104,
            textAlign: "center",
            lineHeight: 1.1,
            fontWeight: 800,
            maxWidth: 900,
          }}
        >
          {hook}
        </h2>
        <div style={{ marginTop: 48, opacity: 0.9 }}>
          <div style={{ width: 120, height: 79, color: "white" }}>
            <AntMark />
          </div>
        </div>
      </div>

      {/* Phone panel */}
      <div
        style={{
          position: "absolute",
          top: showPanel ? 60 : 0,
          left: "50%",
          transform: `translateX(-50%) translateY(${showPanel ? 0 : -40}px)`,
          width: 940,
          height: 1560,
          backgroundColor: "#fff",
          borderRadius: 48,
          overflow: "hidden",
          boxShadow: "0 24px 80px rgba(0,0,0,0.35)",
          opacity: panelFadeIn,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        {/* Header */}
        <div
          style={{
            height: 96,
            padding: "0 36px",
            borderBottom: "1px solid #e6e3ee",
            display: "flex",
            alignItems: "center",
            fontSize: 40,
            fontWeight: 600,
            color: "#1a1a2e",
          }}
        >
          Colony · #general
        </div>

        {/* Chat content - flex column, bottom-anchored */}
        <div
          style={{
            height: 1464,
            padding: 48,
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            gap: 28,
            overflow: "hidden",
          }}
        >
          {/* Owner message (always shown from frame 60+) */}
          {frame >= 60 && ownerLine && (
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                opacity: fadeIn(frame, 60),
                transform: `translateY(${slideUp(frame, 60)}px)`,
              }}
            >
              <div
                style={{
                  backgroundColor: hueColor,
                  color: "white",
                  padding: "28px 32px",
                  borderRadius: 32,
                  borderBottomRightRadius: 8,
                  maxWidth: 760,
                  fontSize: 44,
                  lineHeight: 1.3,
                }}
              >
                {ownerLine.text}
              </div>
              <div
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: 36,
                  backgroundColor: hueColor,
                  color: "white",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 32,
                  fontWeight: 700,
                  flexShrink: 0,
                  marginLeft: 16,
                  marginBottom: 8,
                }}
              >
                Y
              </div>
            </div>
          )}

          {/* Scout reply */}
          {frame >= 150 && scoutLine && (
            <div
              style={{
                display: "flex",
                justifyContent: "flex-start",
                alignItems: "flex-end",
                opacity: fadeIn(frame, 150),
                transform: `translateY(${slideUp(frame, 150)}px)`,
              }}
            >
              <div
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: 36,
                  backgroundColor: "#f0e6f5",
                  color: hueColor,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 32,
                  fontWeight: 700,
                  flexShrink: 0,
                  marginRight: 16,
                }}
              >
                S
              </div>
              <div>
                <div
                  style={{
                    fontSize: 28,
                    color: hueColor,
                    fontWeight: 600,
                    marginBottom: 6,
                    letterSpacing: 1,
                  }}
                >
                  Scout · AI employee
                </div>
                <div
                  style={{
                    backgroundColor: "#f8f7fa",
                    color: "#1a1a2e",
                    padding: "28px 32px",
                    borderRadius: 32,
                    borderBottomLeftRadius: 8,
                    maxWidth: 760,
                    fontSize: 44,
                    lineHeight: 1.3,
                  }}
                >
                  {scoutLine.text}
                </div>
              </div>
            </div>
          )}

          {/* Results rows */}
          {results.map((r, i) => {
            const start = 210 + i * 40;
            return frame >= start ? (
              <div
                key={r.name}
                style={{
                  width: "100%",
                  padding: "28px 32px",
                  borderRadius: 24,
                  border: "1px solid #e6e3ee",
                  backgroundColor: "#fff",
                  opacity: fadeIn(frame, start),
                  transform: `translateY(${slideUp(frame, start)}px)`,
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <div
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 8,
                    backgroundColor: hueColor,
                    flexShrink: 0,
                    marginRight: 20,
                  }}
                />
                <div>
                  <div
                    style={{
                      fontSize: 44,
                      fontWeight: 600,
                      color: "#1a1a2e",
                    }}
                  >
                    {r.name}
                  </div>
                  <div style={{ fontSize: 34, color: "#6a6a7e" }}>
                    {r.detail}
                  </div>
                </div>
              </div>
            ) : null;
          })}

          {/* Approval card */}
          {frame >= 360 && (
            <div
              style={{
                width: "100%",
                padding: 36,
                borderRadius: 32,
                border: showSent
                  ? "2px solid hsl(160 60% 45%)"
                  : `2px solid ${hueColor}`,
                backgroundColor: showSent ? "#f0fff4" : "#fff",
                opacity: fadeIn(frame, 360),
              }}
            >
              {!showSent ? (
                <>
                  <div
                    style={{
                      fontSize: 26,
                      letterSpacing: 2,
                      fontWeight: 700,
                      color: hueColor,
                      textTransform: "uppercase" as const,
                      marginBottom: 12,
                    }}
                  >
                    Waiting for your ok
                  </div>
                  <div
                    style={{
                      fontSize: 52,
                      fontWeight: 700,
                      color: "#1a1a2e",
                      marginBottom: 12,
                      lineHeight: 1.15,
                    }}
                  >
                    {approval.question}
                  </div>
                  <div
                    style={{
                      fontSize: 32,
                      color: "#6a6a7e",
                      marginBottom: 28,
                    }}
                  >
                    {approval.fine}
                  </div>
                  <div style={{ display: "flex", gap: 16 }}>
                    <button
                      type="button"
                      style={{
                        flex: 1,
                        padding: "18px 0",
                        backgroundColor: hueColor,
                        color: "white",
                        border: "none",
                        borderRadius: 20,
                        fontSize: 40,
                        fontWeight: 700,
                        cursor: "pointer",
                        transform: `scale(${pulseScale})`,
                      }}
                    >
                      Approve and send
                    </button>
                    <button
                      type="button"
                      style={{
                        flex: 1,
                        padding: "18px 0",
                        backgroundColor: "#ececf3",
                        color: "#6a6a7e",
                        border: "none",
                        borderRadius: 20,
                        fontSize: 40,
                        fontWeight: 600,
                      }}
                    >
                      Not now
                    </button>
                  </div>
                  {/* Click ring */}
                  {frame >= 480 && (
                    <div
                      style={{
                        position: "absolute",
                        top: 166,
                        left: 54,
                        width: 200,
                        height: 96,
                        borderRadius: 20,
                        border: `4px solid ${hueColor}`,
                        opacity: ringOpacity,
                        pointerEvents: "none",
                        transform: `scale(${ringScale})`,
                      }}
                    />
                  )}
                </>
              ) : (
                <>
                  <div
                    style={{
                      width: 96,
                      height: 96,
                      borderRadius: 48,
                      backgroundColor: "hsl(160 60% 45%)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      marginBottom: 24,
                    }}
                  >
                    <span
                      style={{ fontSize: 52, color: "white", fontWeight: 700 }}
                    >
                      ✓
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 60,
                      fontWeight: 700,
                      color: "#1a1a2e",
                      marginBottom: 16,
                    }}
                  >
                    Sent.
                  </div>
                  <div style={{ fontSize: 36, color: "#2a6a3e" }}>
                    20 emails on their way. Every one read by you first.
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* End card - full bleed */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: frame >= 540 ? "flex" : "none",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: 80,
          textAlign: "center",
          opacity: interpolate(
            Math.max(0, Math.min(frame - 540, 12)),
            [0, 12],
            [0, 1],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          ),
        }}
      >
        <h2
          style={{
            color: "white",
            fontSize: 96,
            fontWeight: 800,
            lineHeight: 1.1,
            marginBottom: 24,
            maxWidth: 900,
          }}
        >
          {endCard.title}
        </h2>
        <div
          style={{
            color: "rgba(255,255,255,0.8)",
            fontSize: 44,
            fontWeight: 600,
          }}
        >
          {endCard.url}
        </div>
        <div style={{ marginTop: 48, opacity: 0.9 }}>
          <div style={{ width: 140, height: 93, color: "white" }}>
            <AntMark />
          </div>
        </div>
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

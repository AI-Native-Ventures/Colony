import { useMemo } from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { AntMark } from "../brand/AntMark";
import { Grain } from "../launch/Backdrop";
import { musicVolume } from "../launch/duck.ts";
import { INTER } from "../launch/fonts";
import { clamp01, progress, smoothstep } from "../launch/math.ts";
import { TALL_CLOSE } from "../launch/tall/close.ts";
import { TALL_H, TALL_W } from "../launch/tall/frame.ts";
import { useFontsReady } from "../launch/useFontsReady";
import { CloseScene } from "../launch/wide/CloseScene";
import { easeOutBack } from "../launch/wide/EmployeeHero";
import { SCOUT_LOOK } from "../launch/wide/employees.ts";
import { LightWorld } from "../launch/wide/MeshGradient";
import {
  CARD_BOX,
  CHAT_BOX,
  type InterviewPlan,
  type InterviewScript,
  type Pair,
  type PlacedLine,
  breakLines,
  planInterview,
} from "./plan.ts";

const INK = "#17151f";
const MUTED = "#5d5a6b";
const VIOLET = SCOUT_LOOK.color;
const DEEP = SCOUT_LOOK.deep;
/** Quieter than the explainers: a conversation, so the voices carry it. */
const DUCK = { base: 0.3, ducked: 0.1, attack: 0.25, release: 0.5 };

function tint(color: string, alpha: number): string {
  return color.replace(")", ` / ${alpha})`);
}

/** In over `inFor` from `at`: 0 before, 1 after. */
function enter(t: number, at: number, inFor: number): number {
  return clamp01(progress(t, at, inFor));
}

/** The shake of the card as the stamp lands, in pixels. */
function shake(t: number, stampAt: number): number {
  if (t < stampAt) return 0;
  const k = 1 - clamp01((t - stampAt) / 0.3);
  return Math.sin((t - stampAt) * 95) * 9 * k;
}

/** The one being interviewed: eyebrow, avatar, name and role, then the stamp. */
function CandidateCard({
  t,
  plan,
  script,
}: {
  t: number;
  plan: InterviewPlan;
  script: InterviewScript;
}) {
  const gone = smoothstep(
    plan.close.dimFrom - 0.3,
    plan.close.dimFrom + 0.2,
    t,
  );
  if (gone >= 1) return null;
  const eyebrow = enter(t, 0.1, 0.4);
  const avatar = easeOutBack(enter(t, 0.25, 0.55));
  const name = enter(t, 0.45, 0.45);
  const role = enter(t, 0.65, 0.4);
  const cx = CARD_BOX.x + CARD_BOX.w / 2;
  const dx = shake(t, plan.stampAt);
  const stamp = enter(t, plan.stampAt - 0.16, 0.16);
  return (
    <div
      style={{
        position: "absolute",
        left: CARD_BOX.x,
        top: CARD_BOX.y,
        width: CARD_BOX.w,
        height: CARD_BOX.h,
        opacity: 1 - gone,
        transform: `translateX(${dx.toFixed(2)}px)`,
        fontFamily: INTER,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          display: "flex",
          justifyContent: "center",
          opacity: eyebrow,
          transform: `translateY(${((1 - eyebrow) * 14).toFixed(2)}px)`,
        }}
      >
        <span
          style={{
            padding: "10px 26px",
            borderRadius: 999,
            background: tint(VIOLET, 0.14),
            color: DEEP,
            fontSize: 30,
            fontWeight: 750,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
          }}
        >
          Job interview
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          left: CARD_BOX.w / 2 - 88,
          top: 84,
          width: 176,
          height: 176,
          borderRadius: "50%",
          background: VIOLET,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
          transform: `scale(${avatar.toFixed(4)})`,
          boxShadow: `0 24px 50px -24px ${tint(DEEP, 0.7)}`,
        }}
      >
        <span style={{ display: "flex", width: 112, height: 74 }}>
          <AntMark />
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 290,
          textAlign: "center",
          color: INK,
          fontSize: 112,
          fontWeight: 800,
          letterSpacing: "-0.045em",
          lineHeight: 1,
          opacity: name,
          transform: `translateY(${((1 - name) * 18).toFixed(2)}px)`,
        }}
      >
        {script.name}
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 418,
          display: "flex",
          justifyContent: "center",
          opacity: role,
        }}
      >
        <span
          style={{
            padding: "8px 24px",
            borderRadius: 999,
            border: `2px solid ${tint(DEEP, 0.25)}`,
            color: DEEP,
            fontSize: 34,
            fontWeight: 650,
          }}
        >
          {script.role}
        </span>
      </div>
      {stamp > 0 ? (
        <div
          style={{
            position: "absolute",
            left: cx - CARD_BOX.x - 260,
            top: 150,
            width: 520,
            display: "flex",
            justifyContent: "center",
            opacity: Math.min(1, stamp * 3),
            transform: `rotate(-11deg) scale(${(2.3 - 1.3 * stamp * stamp).toFixed(4)})`,
          }}
        >
          <span
            style={{
              padding: "8px 40px 14px",
              border: `11px solid ${DEEP}`,
              borderRadius: 22,
              color: DEEP,
              background: "rgb(255 255 255 / 0.55)",
              fontSize: 150,
              fontWeight: 900,
              letterSpacing: "0.06em",
              lineHeight: 1,
            }}
          >
            HIRED
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** How each side's bubble sets its words: size, weight, padding, and the widest its text may run. */
type BubbleLook = {
  size: number;
  weight: number;
  padX: number;
  padY: number;
  text: number;
};
const TRACKING = -0.02;
const YOURS: BubbleLook = {
  size: 54,
  weight: 600,
  padX: 36,
  padY: 26,
  text: 790,
};
const THEIRS: BubbleLook = {
  size: 64,
  weight: 750,
  padX: 40,
  padY: 30,
  text: 740,
};

let measure: CanvasRenderingContext2D | null = null;

/** How wide `text` sets in a bubble's type. */
function textWidth(text: string, look: BubbleLook): number {
  if (!measure) measure = document.createElement("canvas").getContext("2d");
  if (!measure) return text.length * look.size * 0.5;
  measure.font = `${look.weight} ${look.size}px "${INTER}"`;
  measure.letterSpacing = `${TRACKING * look.size}px`;
  return measure.measureText(text).width;
}

/** One line in a chat bubble: yours on the left, the employee's on the right, word by word as it is said. */
function Bubble({
  t,
  line,
  label,
}: {
  t: number;
  line: PlacedLine;
  label: string;
}) {
  const mine = line.speaker === "you";
  const pop = enter(t, line.at - 0.12, 0.24);
  if (pop <= 0) return null;
  const look = mine ? YOURS : THEIRS;
  const words = line.text.split(" ");
  const lines = breakLines(words, (text) => textWidth(text, look), look.text);
  const spoken = line.seconds * 0.85;
  let index = 0;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: mine ? "flex-start" : "flex-end",
        gap: 10,
        opacity: pop,
        transform: `translateY(${((1 - pop) * 18).toFixed(2)}px) scale(${(0.94 + 0.06 * pop).toFixed(4)})`,
        transformOrigin: mine ? "0% 100%" : "100% 100%",
      }}
    >
      <span
        style={{
          fontSize: 30,
          fontWeight: 700,
          color: mine ? MUTED : DEEP,
          padding: "0 12px",
        }}
      >
        {label}
      </span>
      <div
        style={{
          padding: `${look.padY}px ${look.padX}px`,
          borderRadius: 40,
          borderBottomLeftRadius: mine ? 10 : 40,
          borderBottomRightRadius: mine ? 40 : 10,
          background: mine ? "rgb(255 255 255 / 0.94)" : VIOLET,
          color: mine ? INK : "#fff",
          fontSize: look.size,
          fontWeight: look.weight,
          lineHeight: 1.18,
          letterSpacing: `${TRACKING}em`,
          boxShadow: mine
            ? "0 22px 50px -30px rgb(40 20 80 / 0.45)"
            : `0 26px 54px -28px ${tint(DEEP, 0.75)}`,
        }}
      >
        {lines.map((text) => (
          <div key={text} style={{ whiteSpace: "nowrap" }}>
            {text.split(" ").map((word, w, row) => {
              const k = index++;
              const at = line.at + (k / words.length) * spoken;
              return (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: words repeat
                  key={w}
                  style={{
                    opacity: mine ? 1 : smoothstep(at - 0.06, at + 0.12, t),
                  }}
                >
                  {word}
                  {w < row.length - 1 ? " " : ""}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A question and its answer, leaving upwards as the next question comes. */
function Exchange({
  t,
  pair,
  until,
  name,
}: {
  t: number;
  pair: Pair;
  until: number;
  name: string;
}) {
  if (t < pair.question.at - 0.15) return null;
  const leave = smoothstep(until - 0.35, until - 0.05, t);
  if (leave >= 1) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: CHAT_BOX.x,
        top: CHAT_BOX.y,
        width: CHAT_BOX.w,
        height: CHAT_BOX.h,
        display: "flex",
        flexDirection: "column",
        gap: 34,
        fontFamily: INTER,
        opacity: 1 - leave,
        transform: `translateY(${(-50 * leave).toFixed(2)}px)`,
      }}
    >
      <Bubble t={t} line={pair.question} label="You" />
      {pair.answer ? <Bubble t={t} line={pair.answer} label={name} /> : null}
    </div>
  );
}

/** The music ducked under the voices, a pop per bubble, the stamp's thud, the voices. */
function InterviewSound({ plan }: { plan: InterviewPlan }) {
  const { fps } = useVideoConfig();
  const windows = plan.lines.map((l) => [l.at, l.end] as const);
  const first = plan.lines[0].at;
  const pops = plan.lines.map((l) => l.at - 0.12);
  return (
    <>
      <Audio
        src={staticFile("launch/music-b.mp3")}
        trimBefore={Math.round((7 - first) * fps)}
        volume={(f) => {
          const s = f / fps;
          return (
            musicVolume(s, windows, DUCK) *
            (1 - smoothstep(plan.seconds - 1.6, plan.seconds, s))
          );
        }}
      />
      {pops.map((at) => (
        <Sequence key={`pop-${at}`} from={Math.round(at * fps)} layout="none">
          <Audio src={staticFile("launch/sfx-pop.mp3")} volume={0.3} />
        </Sequence>
      ))}
      <Sequence from={Math.round(plan.stampAt * fps)} layout="none">
        <Audio
          src={staticFile("launch/sfx-pop.mp3")}
          volume={0.95}
          playbackRate={0.55}
        />
      </Sequence>
      <Sequence from={Math.round(plan.stampAt * fps)} layout="none">
        <Audio src={staticFile("launch/sfx-click.mp3")} volume={0.7} />
      </Sequence>
      <Sequence from={Math.round(plan.close.dimFrom * fps)} layout="none">
        <Audio src={staticFile("launch/sfx-whoosh.mp3")} volume={0.45} />
      </Sequence>
      <Sequence from={Math.round(plan.close.logoIn * fps)} layout="none">
        <Audio src={staticFile("launch/sfx-pop.mp3")} volume={0.45} />
      </Sequence>
      {plan.lines.map((l) => (
        <Sequence key={l.id} from={Math.round(l.at * fps)} layout="none">
          <Audio src={staticFile(l.file)} />
        </Sequence>
      ))}
    </>
  );
}

/** "Job interview": an AI employee interviewed by you, for Reels. */
export const InterviewVideo: React.FC<{ script: InterviewScript }> = ({
  script,
}) => {
  useFontsReady();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const plan = useMemo(() => planInterview(script), [script]);
  const stops = useMemo(
    () => [
      { id: "lilac" as const, at: 0 },
      { id: "orchid" as const, at: plan.close.dimFrom },
    ],
    [plan],
  );
  return (
    <AbsoluteFill style={{ backgroundColor: "#f3eefb" }}>
      <LightWorld t={t} stops={stops} width={TALL_W} height={TALL_H} />
      <CandidateCard t={t} plan={plan} script={script} />
      {plan.pairs.map((pair, i) => (
        <Exchange
          key={pair.question.id}
          t={t}
          pair={pair}
          name={script.name}
          until={plan.pairs[i + 1]?.question.at ?? plan.close.dimFrom + 0.2}
        />
      ))}
      <CloseScene
        t={t}
        timing={plan.close}
        ants={null}
        plain
        layout={TALL_CLOSE}
      />
      <Grain t={t} width={TALL_W} height={TALL_H} opacity={0.05} />
      <InterviewSound plan={plan} />
    </AbsoluteFill>
  );
};

/** The length of an interview, for its composition. */
export function interviewFrames(script: InterviewScript): number {
  return Math.ceil(planInterview(script).seconds * 30);
}

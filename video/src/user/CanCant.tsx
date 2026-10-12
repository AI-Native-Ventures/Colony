import { useMemo } from "react";
import {
  AbsoluteFill,
  Img,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { INTER } from "../launch/fonts";
import { smoothstep } from "../launch/math.ts";
import { useFontsReady } from "../launch/useFontsReady";
import { LightWorld } from "../launch/wide/MeshGradient";
import { Subtitles } from "../launch/wide/Subtitles";
import { CAN_CANT, CAN_CANT_TITLE, type Claim } from "./canCantClaims.ts";
import {
  lookAt,
  lookAtTime,
  type ProofGroup,
  type ProofStep,
  proofGroups,
  sameBox,
} from "./canCantLayout.ts";
import {
  type Box,
  checkManifest,
  type Manifest,
  unionBox,
} from "./manifest.ts";
import { FRAME } from "./stage.ts";
import { type TimedBeat, timeline } from "./timeline.ts";
import { UserCard } from "./UserCards";
import { UserSound } from "./UserSound";
import { voiceFile, voiceLead, voiceSeconds } from "./voiceCuts.ts";

const INK = "#17151f";
const NO_KEYWORDS: ReadonlySet<string> = new Set();
/** Longest a caption lingers after its words when no line follows soon. */
const HOLD = 1.8;
/** Lines the title and end cards already show in big type: spoken, never captioned. */
const ON_CARDS: ReadonlySet<string> = new Set([
  CAN_CANT_TITLE.id,
  ...CAN_CANT.filter((claim) => claim.kind === "close").flatMap((claim) =>
    claim.lines.map((line) => line.id),
  ),
]);
/** The words on the left: the pill's top, and the line under it. */
const WORDS = { x: 120, pillTop: 360, lineTop: 448, width: 620 } as const;
/** Frame pixels over which a card's edges soften into it. */
const FEATHER = 22;

const TONE = {
  can: { label: "It can", bg: "hsl(152 55% 40% / 0.14)", fg: "152 60% 26%" },
  cant: { label: "It can't", bg: "hsl(258 90% 66% / 0.15)", fg: "258 70% 40%" },
} as const;

type Kind = keyof typeof TONE;

/** The video's beats: the title line, then each claim. */
const BEATS: readonly TimedBeat[] = [
  { id: "title", lines: [CAN_CANT_TITLE], minSeconds: 4 },
  ...CAN_CANT.map((claim) => ({
    id: claim.id,
    lines: claim.lines,
    minSeconds: claim.minSeconds,
  })),
];

type Span = { from: number; to: number };
type ClaimSpan = Span & { claim: Claim & { kind: Kind } };

/** A run of claims with the same pill, which stays up across them. */
function kindRuns(claims: readonly ClaimSpan[]): (Span & { kind: Kind })[] {
  const runs: (Span & { kind: Kind })[] = [];
  for (const { claim, from, to } of claims) {
    const run = runs[runs.length - 1];
    if (run && run.kind === claim.kind && Math.abs(run.to - from) < 1e-6)
      run.to = to;
    else runs.push({ kind: claim.kind, from, to });
  }
  return runs;
}

/** In over the first moments of a span, out over its last. */
function presence(
  t: number,
  { from, to }: Span,
  inFor: number,
  outFor: number,
) {
  return (
    smoothstep(from, from + inFor, t) * (1 - smoothstep(to - outFor, to, t))
  );
}

function Pill({ t, run }: { t: number; run: Span & { kind: Kind } }) {
  const shown = presence(t, run, 0.4, 0.3);
  if (shown <= 0) return null;
  const tone = TONE[run.kind];
  return (
    <span
      style={{
        position: "absolute",
        left: WORDS.x,
        top: WORDS.pillTop,
        opacity: shown,
        transform: `translateX(${((1 - shown) * -24).toFixed(2)}px)`,
        padding: "10px 24px",
        borderRadius: 999,
        background: tone.bg,
        color: `hsl(${tone.fg})`,
        fontFamily: INTER,
        fontSize: 34,
        fontWeight: 750,
        letterSpacing: "-0.01em",
      }}
    >
      {tone.label}
    </span>
  );
}

function Line({ t, span }: { t: number; span: ClaimSpan }) {
  const shown = presence(t, span, 0.45, 0.25);
  if (shown <= 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: WORDS.x,
        top: WORDS.lineTop,
        width: WORDS.width,
        opacity: shown,
        transform: `translateY(${((1 - shown) * 14).toFixed(2)}px)`,
        fontFamily: INTER,
        fontSize: 68,
        fontWeight: 800,
        lineHeight: 1.06,
        letterSpacing: "-0.035em",
        color: INK,
        textWrap: "balance",
      }}
    >
      {span.claim.line}
    </div>
  );
}

/** What a card points at, held while the claims in a row point at the same thing. */
type Ring = Span & { box: Box; kind: Kind };

function ringsOf(group: ProofGroup, kinds: Record<string, Kind>): Ring[] {
  const rings: Ring[] = [];
  group.steps.forEach((step, i) => {
    if (!step.focus) return;
    const ring = rings[rings.length - 1];
    if (
      ring &&
      sameBox(ring.box, step.focus) &&
      Math.abs(ring.to - step.from) < 1e-6
    ) {
      ring.to = step.to;
      return;
    }
    rings.push({
      box: step.focus,
      kind: kinds[step.id],
      from: step.from + (i === 0 ? 1.0 : 0.7),
      to: step.to,
    });
  });
  return rings;
}

const edge = (direction: string) =>
  `linear-gradient(${direction}, transparent 0, #000 ${FEATHER}px, #000 calc(100% - ${FEATHER}px), transparent 100%)`;
const SOFT_EDGES: React.CSSProperties = {
  maskImage: `${edge("to right")}, ${edge("to bottom")}`,
  WebkitMaskImage: `${edge("to right")}, ${edge("to bottom")}`,
  maskComposite: "intersect",
  WebkitMaskComposite: "source-in",
};

/** The real screen beside the words: one part of it, moving closer to what the claim points at. */
function ProofCard({
  t,
  group,
  manifest,
  kinds,
}: {
  t: number;
  group: ProofGroup;
  manifest: Manifest;
  kinds: Record<string, Kind>;
}) {
  const shown = presence(t, group, 0.5, 0.4);
  if (shown <= 0) return null;
  const { card, scale } = group.layout;
  const keys = [
    { at: Number.NEGATIVE_INFINITY, look: lookAt(group.layout, null) },
    ...group.steps.map((step, i) => ({
      at: step.from + (i === 0 ? 0.6 : 0.15),
      look: lookAt(group.layout, step.focus),
    })),
  ];
  const look = lookAtTime(t, keys);
  const drift = 1 + 0.02 * smoothstep(group.from, group.to, t);
  const s = scale * look.zoom * drift;
  const screen = group.steps[0].screen;
  const rings = ringsOf(group, kinds);
  return (
    <div
      style={{
        position: "absolute",
        left: card.x,
        top: card.y,
        width: card.w,
        height: card.h,
        borderRadius: 24,
        overflow: "hidden",
        background: "#f9f8fc",
        opacity: shown,
        transform: `translateX(${((1 - shown) * 40).toFixed(2)}px)`,
        boxShadow:
          "0 40px 90px -40px rgb(40 20 80 / 0.5), 0 0 0 1px rgb(23 21 31 / 0.07)",
      }}
    >
      <div style={{ position: "absolute", inset: 0, ...SOFT_EDGES }}>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: screen.w,
            height: screen.h,
            transformOrigin: "0 0",
            transform: `translate(${(card.w / 2 - look.x * s).toFixed(3)}px, ${(card.h / 2 - look.y * s).toFixed(3)}px) scale(${s.toFixed(5)})`,
          }}
        >
          {group.steps.map((step, i) =>
            i > 0 && step.shot === group.steps[i - 1].shot ? null : (
              <Img
                key={step.id}
                src={staticFile(`user/${manifest.shots[step.shot].file}`)}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: screen.w,
                  height: screen.h,
                  opacity:
                    i === 0
                      ? 1
                      : smoothstep(step.from - 0.2, step.from + 0.2, t),
                }}
              />
            ),
          )}
          {rings.map((ring) => {
            const strength =
              smoothstep(ring.from, ring.from + 0.4, t) *
              (ring.to >= group.to - 1e-6
                ? 1
                : 1 - smoothstep(ring.to - 0.35, ring.to - 0.05, t));
            if (strength <= 0) return null;
            const pad = 6;
            const hole = {
              x: ring.box.x - pad,
              y: ring.box.y - pad,
              w: ring.box.w + 2 * pad,
              h: ring.box.h + 2 * pad,
            };
            const id = `wash-${ring.box.x.toFixed(0)}-${ring.box.y.toFixed(0)}-${ring.from.toFixed(2)}`;
            return (
              <div key={id} style={{ position: "absolute", inset: 0 }}>
                <svg
                  width={screen.w}
                  height={screen.h}
                  style={{ position: "absolute", inset: 0 }}
                  aria-hidden="true"
                >
                  <mask id={id}>
                    <rect width={screen.w} height={screen.h} fill="#fff" />
                    <rect
                      x={hole.x}
                      y={hole.y}
                      width={hole.w}
                      height={hole.h}
                      rx={9}
                      fill="#000"
                    />
                  </mask>
                  <rect
                    width={screen.w}
                    height={screen.h}
                    fill="#ffffff"
                    opacity={0.5 * strength}
                    mask={`url(#${id})`}
                  />
                </svg>
                <div
                  style={{
                    position: "absolute",
                    left: hole.x,
                    top: hole.y,
                    width: hole.w,
                    height: hole.h,
                    boxSizing: "border-box",
                    borderRadius: 9,
                    border: `${(3 / s).toFixed(3)}px solid hsl(${TONE[ring.kind].fg} / ${(0.85 * strength).toFixed(3)})`,
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** "What your AI team can and can't do": each line beside the real screen that proves it. */
export const CanCant: React.FC<{ manifest: Manifest | null }> = ({
  manifest,
}) => {
  useFontsReady();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const tl = useMemo(() => timeline(BEATS, voiceSeconds), []);
  const lines = useMemo(
    () =>
      tl.lines.map((line, i) => ({
        id: line.id,
        file: voiceFile(line.id),
        at: line.at - voiceLead(line.id),
        speech: [line.at, line.end] as const,
        text: line.text,
        caption: line.caption,
        until: Math.min(
          (tl.lines[i + 1]?.at ?? Number.POSITIVE_INFINITY) - 0.05,
          line.end + HOLD,
        ),
      })),
    [tl],
  );
  const claims = useMemo(
    () =>
      CAN_CANT.flatMap((claim): ClaimSpan[] => {
        const span = tl.beats.find((b) => b.id === claim.id);
        return span && claim.kind !== "close"
          ? [
              {
                claim: { ...claim, kind: claim.kind },
                from: span.from,
                to: span.to,
              },
            ]
          : [];
      }),
    [tl],
  );
  const groups = useMemo(() => {
    if (!manifest) return [];
    return proofGroups(
      claims.flatMap(({ claim, from, to }): ProofStep[] => {
        if (!claim.shot || !claim.region) return [];
        const shot = manifest.shots[claim.shot];
        return [
          {
            id: claim.id,
            shot: claim.shot,
            from,
            to,
            region: unionBox(claim.region.map((name) => shot.boxes[name])),
            focus: claim.focus?.length
              ? unionBox(claim.focus.map((name) => shot.boxes[name]))
              : null,
            screen: { w: shot.width, h: shot.height },
          },
        ];
      }),
    );
  }, [claims, manifest]);
  const kinds = useMemo(
    () => Object.fromEntries(claims.map(({ claim }) => [claim.id, claim.kind])),
    [claims],
  );
  if (!manifest) return null;
  const title = tl.beats[0];
  const close = tl.beats[tl.beats.length - 1];
  return (
    <AbsoluteFill style={{ background: "#f7f4fb", overflow: "hidden" }}>
      <LightWorld t={t} width={FRAME.w} height={FRAME.h} />
      <UserCard
        opacity={1 - smoothstep(title.to - 0.6, title.to, t)}
        headline="What your AI team can and can't do"
        subline="How Colony works today."
      />
      {kindRuns(claims).map((run) => (
        <Pill key={`${run.kind}-${run.from}`} t={t} run={run} />
      ))}
      {claims.map((span) => (
        <Line key={span.claim.id} t={t} span={span} />
      ))}
      {groups.map((group) => (
        <ProofCard
          key={group.steps[0].id}
          t={t}
          group={group}
          manifest={manifest}
          kinds={kinds}
        />
      ))}
      <UserCard
        opacity={smoothstep(close.from, close.from + 0.6, t)}
        headline="You stay in charge."
        subline="Nothing goes out without your yes."
        footer="colony.global"
      />
      <Subtitles
        t={t}
        lines={lines.filter((line) => !ON_CARDS.has(line.id))}
        keywords={NO_KEYWORDS}
        holdLast={false}
        until={Object.fromEntries(lines.map((l) => [l.id, l.until]))}
      />
      <UserSound lines={lines} clicks={[]} seconds={tl.seconds} />
    </AbsoluteFill>
  );
};

/** The video's length from the voice, and the captured shots, checked. */
export async function canCantMetadata(): Promise<{
  durationInFrames: number;
  props: { manifest: Manifest };
}> {
  const raw = await fetch(staticFile("user/manifest.json")).then((r) =>
    r.json(),
  );
  const manifest = checkManifest(raw);
  const tl = timeline(BEATS, voiceSeconds);
  return { durationInFrames: Math.ceil(tl.seconds * 30), props: { manifest } };
}

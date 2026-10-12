import { useMemo } from "react";
import {
  AbsoluteFill,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Cursor, cursorAt } from "../launch/app/Cursor";
import { smoothstep } from "../launch/math.ts";
import { useFontsReady } from "../launch/useFontsReady";
import { LightWorld } from "../launch/wide/MeshGradient";
import { Subtitles } from "../launch/wide/Subtitles";
import { AppStage, ClickRing } from "./AppStage";
import { cameraAt, project, projectBox } from "./camera.ts";
import { checkManifest, type Manifest } from "./manifest.ts";
import { CAPTION_TOP, FRAME, toFrame } from "./stage.ts";
import { beatProblems, START_HERE } from "./startHereBeats.ts";
import { timeline } from "./timeline.ts";
import { UserCard } from "./UserCards";
import { UserSound } from "./UserSound";
import {
  cameraKeys,
  clicksOf,
  placeMoves,
  pointerKeys,
  shotAt,
} from "./userTimeline.ts";
import { voiceFile, voiceLead, voiceSeconds } from "./voiceCuts.ts";

const NO_KEYWORDS: ReadonlySet<string> = new Set();
/** Longest a caption lingers after its words when no line follows soon. */
const HOLD = 1.8;

/** Zoomed in, the app fades out above the captions, so the words sit on the brand light. */
const fade = `linear-gradient(to bottom, #000 0, #000 ${CAPTION_TOP - 30}px, transparent ${CAPTION_TOP + 10}px)`;
const ABOVE_CAPTIONS: React.CSSProperties = {
  maskImage: fade,
  WebkitMaskImage: fade,
};

/** "Start here": setting up Colony on the real app, step by step. */
export const StartHere: React.FC<{ manifest: Manifest | null }> = ({
  manifest,
}) => {
  useFontsReady();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const tl = useMemo(() => timeline(START_HERE, voiceSeconds), []);
  const placed = useMemo(() => placeMoves(START_HERE, tl), [tl]);
  const plan = useMemo(() => {
    if (!manifest) return null;
    const clicks = clicksOf(placed);
    return {
      keys: cameraKeys(placed, manifest),
      clicks,
      pointer: pointerKeys(clicks, manifest),
    };
  }, [manifest, placed]);
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
  if (!manifest || !plan) return null;

  const title = tl.beats[0];
  const end = tl.beats[tl.beats.length - 1];
  const appIn = smoothstep(title.to - 0.5, title.to + 0.3, t);
  const appOut = smoothstep(end.from - 0.2, end.from + 0.5, t);
  const camera = cameraAt(t, plan.keys);
  const { shot, previous, mix } = shotAt(placed, t);

  const next = plan.clicks.find((c) => t < c.at + 0.35);
  const ring =
    next && next.shot === shot
      ? {
          box: projectBox(
            toFrame(manifest.shots[next.shot].boxes[next.target]),
            camera,
          ),
          strength:
            smoothstep(next.at - 0.5, next.at - 0.2, t) *
            (1 - smoothstep(next.at + 0.1, next.at + 0.35, t)),
        }
      : null;
  const pointer = project(cursorAt(plan.pointer, t), camera);
  const pointerOpacity = appIn * (1 - appOut);

  return (
    <AbsoluteFill style={{ background: "#f7f4fb", overflow: "hidden" }}>
      <LightWorld t={t} width={FRAME.w} height={FRAME.h} />
      <div style={{ position: "absolute", inset: 0, ...ABOVE_CAPTIONS }}>
        <AppStage
          manifest={manifest}
          camera={camera}
          shot={shot}
          previous={previous}
          mix={mix}
          opacity={appIn * (1 - appOut)}
        />
      </div>
      {ring ? <ClickRing box={ring.box} strength={ring.strength} /> : null}
      {pointerOpacity > 0 ? (
        <Cursor
          t={t}
          keys={[{ at: 0, ...pointer }]}
          clicks={plan.clicks.map((c) => c.at)}
          opacity={pointerOpacity}
        />
      ) : null}
      <UserCard
        opacity={1 - smoothstep(title.to - 0.7, title.to - 0.1, t)}
        headline="Start here"
        subline="Set up Colony, step by step."
      />
      <UserCard
        opacity={smoothstep(end.from + 0.2, end.from + 0.8, t)}
        headline="Your team is set up."
        subline="colony.global"
      />
      <Subtitles
        t={t}
        lines={lines}
        keywords={NO_KEYWORDS}
        holdLast={false}
        until={Object.fromEntries(lines.map((l) => [l.id, l.until]))}
      />
      <UserSound
        lines={lines}
        clicks={plan.clicks.map((c) => c.at)}
        seconds={tl.seconds}
      />
    </AbsoluteFill>
  );
};

/** The film's length from the voice, and the captured shots, checked. */
export async function startHereMetadata(): Promise<{
  durationInFrames: number;
  props: { manifest: Manifest };
}> {
  const raw = await fetch(staticFile("user/manifest.json")).then((r) =>
    r.json(),
  );
  const manifest = checkManifest(raw);
  const problems = beatProblems(START_HERE, manifest);
  if (problems.length > 0)
    throw new Error(`Start here's camera plan:\n${problems.join("\n")}`);
  const tl = timeline(START_HERE, voiceSeconds);
  return { durationInFrames: Math.ceil(tl.seconds * 30), props: { manifest } };
}

import { LOOKS, TONES } from "../launch/wide/employees.ts";
import { postLandsAt } from "../launch/wide/posts.ts";
import { EP05, EP05_LINES, EP05_REQUEST } from "./ep05.ts";
import { ExplainerShell, type ShellConfig } from "./ExplainerShell";
import { RISE_POSTS } from "./rise.ts";
import {
  ApproveCursor,
  RisePostCarriers,
  RisePostsCard,
} from "./RisePostsCard";

/** Explainer 5's world: warm for the bakery's hook, Colony's lilac for the end card. */
export const EP05_SHELL: ShellConfig = {
  lines: EP05_LINES,
  keywords: {
    h1: new Set(["post?", "honest."]),
    m1: new Set(["AI", "employees.", "posts."]),
    w1: new Set(["sourdough,", "Saturday", "market."]),
    w2: new Set(["words", "pictures,", "style."]),
    w3: new Set(["best", "times"]),
    y1: new Set(["yes."]),
  },
  tone: TONES.pink,
  world: [
    { id: "sunset", at: 0 },
    { id: "lilac", at: EP05.closeFrom },
  ],
  hook: {
    lines: ["When did you", "last post?"],
    subline: "Be honest.",
    shape: "croissant",
    seed: 20261105,
    wordsAt: EP05.hookWordsAt,
    sublineAt: EP05.hookHonestAt,
    swarmFrom: EP05.swarmFrom,
    stageFrom: EP05.stageFrom,
    stageTo: EP05.stageTo,
    tone: TONES.pink,
  },
  hero: { look: LOOKS.pink, timing: EP05 },
  close: {
    dimFrom: EP05.closeFrom,
    dark: EP05.closeDark,
    logoIn: EP05.logoIn,
    name: EP05.name,
    tagline: EP05.tagline,
    earlyAt: EP05.earlyAt,
    urlAt: EP05.urlAt,
  },
  /** Draft B's lift (7 s into the track) lands on the stage opening, then on the end card's logo. */
  music: [
    { from: 0, until: 24, trackAt: 7 - EP05.stageTo },
    { from: 22.5, until: 33, trackAt: 7 - (EP05.logoIn - 22.5) },
  ],
  pops: [
    ...RISE_POSTS.map((_, i) => postLandsAt(i, EP05)),
    EP05.readyAt,
    EP05.scheduledAt,
    EP05.logoIn,
  ],
  whooshes: [EP05.stageFrom, EP05.closeFrom],
  clicks: [EP05.click],
  scribbles: [
    {
      from: EP05.requestFrom,
      until: EP05.requestFrom + EP05_REQUEST.length / EP05.requestCps,
    },
  ],
  extras: [
    { at: EP05.swarmBuilt, file: "launch/sfx-shimmer.mp3", volume: 0.25 },
  ],
};

/** Explainer 5's work: the posts card, the ants carrying the posts in, the pointer on Approve. Panel pixels. */
export function ep05Work(t: number): React.ReactNode {
  return (
    <>
      <RisePostsCard t={t} />
      <RisePostCarriers t={t} />
      <ApproveCursor t={t} />
    </>
  );
}

/** Explainer 5, "Makes your posts", for Rise Bakery. */
export const Explainer05: React.FC = () => (
  <ExplainerShell config={EP05_SHELL}>{ep05Work}</ExplainerShell>
);

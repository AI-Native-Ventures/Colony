import { OWNER } from "../launch/wide/employees.ts";
import {
  EP07,
  EP07_DRAFT,
  EP07_LINES,
  EP07_SECONDS,
  queueRowAt,
  EP07_QUEUE,
  REVIEW_APPROVE,
} from "./ep07.ts";
import { ExplainerShell, type ShellConfig } from "./ExplainerShell";
import { ApproveButton, ApprovePointer } from "./kit";
import { ReviewCard, SentPlane } from "./ReviewCard";

export const EP07_SHELL: ShellConfig = {
  lines: EP07_LINES,
  keywords: {
    m1: new Set(["everything", "first."]),
    w1: new Set(["reply", "quote."]),
    w2: new Set(["shorter,", "supplies."]),
    w3: new Set(["rewrites", "seconds."]),
    y1: new Set(["yes."]),
    y2: new Set(["only", "goes."]),
  },
  tone: OWNER,
  world: [
    { id: "sky", at: 0 },
    { id: "lilac", at: EP07.closeFrom },
  ],
  hook: {
    lines: ["An AI that emails", "your customers?"],
    subline: "Only if you say yes.",
    shape: "sprayBottle",
    seed: 20261107,
    wordsAt: EP07.hookWordsAt,
    sublineAt: EP07.hookSublineAt,
    swarmFrom: EP07.swarmFrom,
    stageFrom: EP07.stageFrom,
    stageTo: EP07.stageTo,
    tone: OWNER,
  },
  hero: { look: OWNER, timing: EP07 },
  close: {
    dimFrom: EP07.closeFrom,
    dark: EP07.closeDark,
    logoIn: EP07.logoIn,
    name: EP07.name,
    tagline: EP07.tagline,
    earlyAt: EP07.earlyAt,
    urlAt: EP07.urlAt,
  },
  music: [
    { from: 0, until: EP07.closeFrom + 0.4, trackAt: 7 - EP07.stageTo },
    { from: EP07.logoIn - 2, until: EP07_SECONDS, trackAt: 7 - 2 },
  ],
  pops: [
    ...EP07_QUEUE.map((_, i) => queueRowAt(i, EP07)),
    EP07.rewriteAt + 0.3 + EP07_DRAFT.after.length / EP07.rewriteCps,
    EP07.approvedAt,
    EP07.logoIn,
  ],
  whooshes: [EP07.stageFrom, EP07.sentAt, EP07.closeFrom],
  clicks: [EP07.click],
  scribbles: [
    {
      from: EP07.noteFrom,
      until: EP07.noteFrom + EP07_DRAFT.note.length / EP07.noteCps,
    },
  ],
  extras: [
    { at: EP07.swarmBuilt, file: "launch/sfx-shimmer.mp3", volume: 0.25 },
  ],
};

/** Explainer 7, "Nothing goes out without your yes", for Sparkle Cleaning. */
export const Explainer07: React.FC = () => (
  <ExplainerShell config={EP07_SHELL}>
    {(t) => (
      <>
        <ReviewCard t={t} tone={OWNER} timing={EP07} />
        <ApproveButton
          t={t}
          rect={REVIEW_APPROVE}
          tone={OWNER}
          idle="Approve"
          done="Approved"
          timing={{
            approveIn: EP07.approveIn,
            click: EP07.click,
            doneAt: EP07.approvedAt,
          }}
        />
        <ApprovePointer t={t} rect={REVIEW_APPROVE} timing={EP07} />
        <SentPlane t={t} at={EP07.sentAt} color={OWNER.color} />
      </>
    )}
  </ExplainerShell>
);

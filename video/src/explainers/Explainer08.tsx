import { ChatCard } from "./ChatCard";
import {
  EP08,
  EP08_LINES,
  EP08_LOOK,
  EP08_REPLY,
  EP08_SECONDS,
} from "./ep08.ts";
import { ExplainerShell, type ShellConfig } from "./ExplainerShell";
import { ApproveButton, ApprovePointer } from "./kit";
import { CHAT_APPROVE } from "./thandi.ts";

export const EP08_SHELL: ShellConfig = {
  lines: EP08_LINES,
  keywords: {
    m1: new Set(["talk", "people."]),
    w1: new Set(["own", "chat:"]),
    w2: new Set(["Reply", "vegetarian-friendly."]),
    w3: new Set(["same", "place."]),
    y1: new Set(["yes,", "done."]),
  },
  tone: EP08_LOOK,
  world: [
    { id: "orchid", at: 0 },
    { id: "lilac", at: EP08.closeFrom },
  ],
  hook: {
    lines: ["No settings.", "No prompts."],
    subline: "Just tell them.",
    shape: "chefHat",
    seed: 20261108,
    wordsAt: EP08.hookWordsAt,
    sublineAt: EP08.hookSublineAt,
    swarmFrom: EP08.swarmFrom,
    stageFrom: EP08.stageFrom,
    stageTo: EP08.stageTo,
    tone: EP08_LOOK,
  },
  hero: { look: EP08_LOOK, timing: EP08 },
  close: {
    dimFrom: EP08.closeFrom,
    dark: EP08.closeDark,
    logoIn: EP08.logoIn,
    name: EP08.name,
    tagline: EP08.tagline,
    earlyAt: EP08.earlyAt,
    urlAt: EP08.urlAt,
  },
  music: [
    { from: 0, until: EP08.closeFrom + 0.4, trackAt: 7 - EP08.stageTo },
    { from: EP08.logoIn - 2, until: EP08_SECONDS, trackAt: 7 - 2 },
  ],
  pops: [...EP08.threadsAt, EP08.backAt + 0.3, EP08.approvedAt, EP08.logoIn],
  whooshes: [EP08.stageFrom, EP08.closeFrom],
  clicks: [EP08.click],
  scribbles: [
    {
      from: EP08.replyFrom,
      until: EP08.replyFrom + EP08_REPLY.length / EP08.replyCps,
    },
  ],
  extras: [
    { at: EP08.swarmBuilt, file: "launch/sfx-shimmer.mp3", volume: 0.25 },
  ],
};

/** Explainer 8, "Talk to your team", for Thandi's Kitchen. */
export const Explainer08: React.FC = () => (
  <ExplainerShell config={EP08_SHELL}>
    {(t) => (
      <>
        <ChatCard t={t} tone={EP08_LOOK} timing={EP08} reply={EP08_REPLY} />
        <ApproveButton
          t={t}
          rect={CHAT_APPROVE}
          tone={EP08_LOOK}
          idle="Approve"
          done="Approved"
          timing={{
            approveIn: EP08.approveIn,
            click: EP08.click,
            doneAt: EP08.approvedAt,
          }}
        />
        <ApprovePointer t={t} rect={CHAT_APPROVE} timing={EP08} />
      </>
    )}
  </ExplainerShell>
);

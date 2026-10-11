import { CallCard } from "../launch/wide/CallCard";
import { EmailCard, PenAnt } from "../launch/wide/EmailCard";
import { emailTypedAt } from "../launch/wide/email.ts";
import { LOOKS } from "../launch/wide/employees.ts";
import {
  EP04,
  EP04_CALL,
  EP04_EMAIL,
  EP04_LINES,
  EP04_NEXT,
  EP04_REPLY,
  EP04_SECONDS,
  REPLY_NOTE,
  YES_FROM,
} from "./ep04.ts";
import { ExplainerShell, type ShellConfig } from "./ExplainerShell";
import { NoteCard } from "./HandoffScene";
import { HANDOFF_APPROVE } from "./handoff.ts";
import { ApproveButton, ApprovePointer } from "./kit";
import { ReplyNote } from "./ReplyNote";

const typedAt = emailTypedAt(EP04, EP04_EMAIL.lines);

export const EP04_SHELL: ShellConfig = {
  lines: EP04_LINES,
  keywords: {
    m1: new Set(["AI", "employee", "sells"]),
    w1: new Set(["wedding", "venues,", "go-to"]),
    w2: new Set(["replies,"]),
    w3: new Set(["calls", "books"]),
    y1: new Set(["yes."]),
  },
  tone: LOOKS.amber,
  world: [
    { id: "sunset", at: 0 },
    { id: "lilac", at: EP04.closeFrom },
  ],
  hook: {
    lines: ["The best clients", "won't find you."],
    subline: "So go to them.",
    shape: "camera",
    seed: 20261104,
    wordsAt: EP04.hookWordsAt,
    sublineAt: EP04.hookSublineAt,
    swarmFrom: EP04.swarmFrom,
    stageFrom: EP04.stageFrom,
    stageTo: EP04.stageTo,
    tone: LOOKS.amber,
  },
  hero: { look: LOOKS.amber, timing: EP04 },
  close: {
    dimFrom: EP04.closeFrom,
    dark: EP04.closeDark,
    logoIn: EP04.logoIn,
    name: EP04.name,
    tagline: EP04.tagline,
    earlyAt: EP04.earlyAt,
    urlAt: EP04.urlAt,
  },
  music: [
    { from: 0, until: EP04.closeFrom + 0.4, trackAt: 7 - EP04.stageTo },
    { from: EP04.logoIn - 2, until: EP04_SECONDS, trackAt: 7 - 2 },
  ],
  pops: [
    typedAt + 0.1,
    EP04.countRushFrom + EP04.countRush,
    EP04.replyAt,
    EP04.bookedAt,
    EP04.approvedAt,
    EP04.logoIn,
  ],
  whooshes: [EP04.stageFrom, EP04.callIn, EP04.closeFrom],
  clicks: [EP04.click],
  scribbles: [{ from: EP04.typeFrom, until: typedAt }],
  extras: [
    { at: EP04.swarmBuilt, file: "launch/sfx-shimmer.mp3", volume: 0.25 },
  ],
};

/** Explainer 4, "Sells for you", for Golden Hour Photography. */
export const Explainer04: React.FC = () => (
  <ExplainerShell config={EP04_SHELL}>
    {(t) => (
      <>
        <EmailCard
          t={t}
          timing={EP04}
          email={EP04_EMAIL}
          sentAt={EP04.sentAt}
        />
        <PenAnt t={t} timing={EP04} email={EP04_EMAIL} />
        <ReplyNote
          t={t}
          at={EP04.replyAt}
          until={EP04.callIn}
          rect={REPLY_NOTE}
          label={EP04_REPLY.label}
          text={EP04_REPLY.text}
        />
        <CallCard
          t={t}
          timing={EP04}
          call={EP04_CALL}
          business="Golden Hour Photography"
          clockStops
        />
        <NoteCard
          t={t}
          at={EP04.yesCardIn}
          tone={LOOKS.amber}
          title={EP04_NEXT.title}
          subtitle={EP04_NEXT.subtitle}
        />
        <ApproveButton
          t={t}
          rect={HANDOFF_APPROVE}
          tone={LOOKS.amber}
          idle="Approve"
          done="Approved"
          timing={{
            approveIn: EP04.approveIn,
            click: EP04.click,
            doneAt: EP04.approvedAt,
          }}
        />
        <ApprovePointer
          t={t}
          rect={HANDOFF_APPROVE}
          timing={EP04}
          from={YES_FROM}
        />
      </>
    )}
  </ExplainerShell>
);

import { SCOUT_LOOK } from "../launch/wide/employees.ts";
import { SCOUT_CARD, taskLandsAt } from "../launch/wide/scout.ts";
import { PlanCard } from "../launch/wide/ScoutPanel";
import {
  EP01,
  EP01_APPROVE,
  EP01_BEATS,
  EP01_LINES,
  EP01_REQUEST,
  EP01_SECONDS,
  EP01_TASKS,
} from "./ep01.ts";
import { ExplainerShell, type ShellConfig } from "./ExplainerShell";
import { ApproveButton, ApprovePointer, RequestLine } from "./kit";

export const EP01_SHELL: ShellConfig = {
  lines: EP01_LINES,
  keywords: {
    m1: new Set(["AI", "employees:", "Scout", "chief", "staff."]),
    w1: new Set(["one", "sentence:", "property", "developers"]),
    w2: new Set(["plan", "job."]),
    w3: new Set(["checks"]),
    y1: new Set(["yes."]),
  },
  tone: SCOUT_LOOK,
  world: [
    { id: "sky", at: 0 },
    { id: "lilac", at: EP01.closeFrom },
  ],
  hook: {
    lines: ["You're on site", "all day."],
    subline: "Who's running the office?",
    shape: "hardHat",
    seed: 20261101,
    wordsAt: EP01.hookWordsAt,
    sublineAt: EP01.hookSublineAt,
    swarmFrom: EP01.swarmFrom,
    stageFrom: EP01.stageFrom,
    stageTo: EP01.stageTo,
    tone: SCOUT_LOOK,
  },
  hero: { look: SCOUT_LOOK, timing: EP01 },
  close: {
    dimFrom: EP01.closeFrom,
    dark: EP01.closeDark,
    logoIn: EP01.logoIn,
    name: EP01.name,
    tagline: EP01.tagline,
    earlyAt: EP01.earlyAt,
    urlAt: EP01.urlAt,
  },
  music: [
    { from: 0, until: 29, trackAt: 7 - EP01.stageTo },
    { from: 27.5, until: EP01_SECONDS, trackAt: 7 - (EP01.logoIn - 27.5) },
  ],
  pops: [
    ...EP01_TASKS.map((_, i) => taskLandsAt(i, EP01)),
    EP01.checkAt,
    EP01.approvedAt,
    EP01.logoIn,
  ],
  whooshes: [EP01.stageFrom, EP01.closeFrom],
  clicks: [EP01.click],
  scribbles: [
    {
      from: EP01.requestFrom,
      until: EP01.requestFrom + EP01_REQUEST.length / EP01.requestCps,
    },
  ],
  extras: [
    { at: EP01.swarmBuilt, file: "launch/sfx-shimmer.mp3", volume: 0.25 },
  ],
};

/** Explainer 1, "Meet Scout", for Mahlangu Builders. */
export const Explainer01: React.FC = () => (
  <ExplainerShell config={EP01_SHELL}>
    {(t) => (
      <>
        <PlanCard
          t={t}
          timing={EP01}
          tasks={EP01_TASKS}
          title="This month's plan."
          subtitle=""
        />
        <RequestLine
          t={t}
          x={SCOUT_CARD.x + 52}
          y={SCOUT_CARD.y + 122}
          text={EP01_REQUEST}
          from={EP01.requestFrom}
          cps={EP01.requestCps}
          showFrom={EP01_BEATS.work.start}
          tone={SCOUT_LOOK}
        />
        <ApproveButton
          t={t}
          rect={EP01_APPROVE}
          tone={SCOUT_LOOK}
          idle="Approve plan"
          done="Plan approved"
          timing={{
            approveIn: EP01.approveIn,
            click: EP01.click,
            doneAt: EP01.approvedAt,
          }}
        />
        <ApprovePointer t={t} rect={EP01_APPROVE} timing={EP01} />
      </>
    )}
  </ExplainerShell>
);

import { BusinessCard } from "../launch/wide/HowPanel";
import { READ_BUTTON, TEAM_ROWS, teamRowAt } from "../launch/wide/how.ts";
import {
  EP02,
  EP02_FACTS,
  EP02_HIRE,
  EP02_LAYOUT,
  EP02_LINES,
  EP02_LOOK,
  EP02_SECONDS,
  EP02_WEBSITE,
} from "./ep02.ts";
import { ExplainerShell, type ShellConfig } from "./ExplainerShell";
import { ApproveButton, ApprovePointer } from "./kit";

export const EP02_SHELL: ShellConfig = {
  lines: EP02_LINES,
  keywords: {
    m1: new Set(["team", "AI", "employees."]),
    w1: new Set(["website."]),
    w2: new Set(["hair", "salon", "Rosebank,"]),
    w3: new Set(["team:", "Scout"]),
    y1: new Set(["yes."]),
  },
  tone: EP02_LOOK,
  world: [
    { id: "orchid", at: 0 },
    { id: "lilac", at: EP02.closeFrom },
  ],
  hook: {
    lines: ["Hiring takes", "weeks."],
    subline: "This takes a minute.",
    shape: "scissors",
    seed: 20261102,
    wordsAt: EP02.hookWordsAt,
    sublineAt: EP02.hookSublineAt,
    swarmFrom: EP02.swarmFrom,
    stageFrom: EP02.stageFrom,
    stageTo: EP02.stageTo,
    tone: EP02_LOOK,
  },
  hero: { look: EP02_LOOK, timing: EP02 },
  close: {
    dimFrom: EP02.closeFrom,
    dark: EP02.closeDark,
    logoIn: EP02.logoIn,
    name: EP02.name,
    tagline: EP02.tagline,
    earlyAt: EP02.earlyAt,
    urlAt: EP02.urlAt,
  },
  music: [
    { from: 0, until: EP02.closeFrom + 0.4, trackAt: 7 - EP02.stageTo },
    {
      from: EP02.logoIn - 2,
      until: EP02_SECONDS,
      trackAt: 7 - 2,
    },
  ],
  pops: [
    EP02.pasteAt,
    ...TEAM_ROWS.map((_, i) => teamRowAt(i, EP02)),
    EP02.scoutAt,
    EP02.approvedAt,
    EP02.logoIn,
  ],
  whooshes: [EP02.stageFrom, EP02.closeFrom],
  clicks: [EP02.readClick, EP02.click],
  scribbles: [],
  extras: [
    { at: EP02.swarmBuilt, file: "launch/sfx-shimmer.mp3", volume: 0.25 },
  ],
};

/** Explainer 2, "Your team in a minute", for Studio Nala. */
export const Explainer02: React.FC = () => (
  <ExplainerShell config={EP02_SHELL}>
    {(t) => (
      <>
        <BusinessCard
          t={t}
          timing={EP02}
          website={EP02_WEBSITE}
          facts={EP02_FACTS}
          teamSubtitle="Picked from your website. Nothing starts until you say yes."
          teamLayout={EP02_LAYOUT}
          scoutAt={EP02.scoutAt}
          workingAt={EP02.approvedAt}
          hireButton={false}
        />
        <ApproveButton
          t={t}
          rect={EP02_HIRE}
          tone={EP02_LOOK}
          idle="Hire my team"
          done="Team hired"
          timing={{
            approveIn: EP02.approveIn,
            click: EP02.click,
            doneAt: EP02.approvedAt,
          }}
        />
        <ApprovePointer
          t={t}
          rect={READ_BUTTON}
          timing={{ cursorFrom: EP02.cursorFrom, click: EP02.readClick }}
        />
        <ApprovePointer
          t={t}
          rect={EP02_HIRE}
          timing={{ cursorFrom: EP02.yesCursorFrom, click: EP02.click }}
        />
      </>
    )}
  </ExplainerShell>
);

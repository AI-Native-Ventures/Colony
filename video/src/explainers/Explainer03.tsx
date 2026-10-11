import { BOARD, landsAt } from "../launch/wide/beat.ts";
import { EmployeeHero } from "../launch/wide/EmployeeHero";
import { LOOKS } from "../launch/wide/employees.ts";
import { Carriers, LeadsBoard } from "../launch/wide/LeadsBoard";
import {
  EP03,
  EP03_BEATS,
  EP03_LEADS,
  EP03_LINES,
  EP03_PICKS,
  EP03_REQUEST,
  EP03_SECONDS,
} from "./ep03.ts";
import { ExplainerShell, type ShellConfig } from "./ExplainerShell";
import {
  HandoffCard,
  PickChips,
  RestPointer,
  TickPointer,
} from "./HandoffScene";
import { chipLands } from "./handoff.ts";
import { RequestLine } from "./kit";

export const EP03_SHELL: ShellConfig = {
  lines: EP03_LINES,
  keywords: {
    m1: new Set(["AI", "employee", "customers"]),
    w1: new Set(["office", "parks", "Sandton."]),
    w2: new Set(["twenty,", "why"]),
    w3: new Set(["pick"]),
    y1: new Set(["sales", "employee"]),
    y2: new Set(["yes."]),
  },
  tone: LOOKS.blue,
  world: [
    { id: "sea", at: 0 },
    { id: "lilac", at: EP03.closeFrom },
  ],
  hook: {
    lines: ["You fix pipes", "all day."],
    subline: "Who's finding your next customer?",
    shape: "wrench",
    seed: 20261103,
    wordsAt: EP03.hookWordsAt,
    sublineAt: EP03.hookSublineAt,
    swarmFrom: EP03.swarmFrom,
    stageFrom: EP03.stageFrom,
    stageTo: EP03.stageTo,
    tone: LOOKS.blue,
  },
  hero: { look: LOOKS.blue, timing: EP03, until: EP03.heroUntil },
  close: {
    dimFrom: EP03.closeFrom,
    dark: EP03.closeDark,
    logoIn: EP03.logoIn,
    name: EP03.name,
    tagline: EP03.tagline,
    earlyAt: EP03.earlyAt,
    urlAt: EP03.urlAt,
  },
  music: [
    { from: 0, until: EP03.closeFrom + 0.4, trackAt: 7 - EP03.stageTo },
    { from: EP03.logoIn - 2, until: EP03_SECONDS, trackAt: 7 - 2 },
  ],
  pops: [
    ...EP03_LEADS.map((_, i) => landsAt(i, EP03)),
    EP03.countRushFrom + EP03.countRush,
    chipLands(EP03_PICKS.length - 1, EP03),
    EP03.approveIn,
    EP03.logoIn,
  ],
  whooshes: [EP03.stageFrom, EP03.amberAvatarAt, EP03.closeFrom],
  clicks: EP03_PICKS.map((p) => p.at),
  scribbles: [
    {
      from: EP03.requestFrom,
      until: EP03.requestFrom + EP03_REQUEST.length / EP03.requestCps,
    },
  ],
  extras: [
    { at: EP03.swarmBuilt, file: "launch/sfx-shimmer.mp3", volume: 0.25 },
  ],
};

/** Explainer 3, "Finds customers", for Bright Plumbing. */
export const Explainer03: React.FC = () => (
  <ExplainerShell config={EP03_SHELL}>
    {(t) => (
      <>
        <LeadsBoard
          t={t}
          timing={EP03}
          leads={EP03_LEADS}
          subtitle=""
          reasons={{ at: EP03.reasonsAt, every: EP03.reasonsEvery }}
          picks={EP03_PICKS}
        />
        <Carriers t={t} timing={EP03} leads={EP03_LEADS} />
        <RequestLine
          t={t}
          x={BOARD.x + 52}
          y={BOARD.y + 112}
          text={EP03_REQUEST}
          from={EP03.requestFrom}
          cps={EP03.requestCps}
          showFrom={EP03_BEATS.work.start}
          tone={LOOKS.blue}
        />
        <TickPointer
          t={t}
          picks={EP03_PICKS}
          cursorFrom={EP03.tickCursorFrom}
        />
        <EmployeeHero
          t={t}
          look={LOOKS.amber}
          timing={{
            avatarAt: EP03.amberAvatarAt,
            headlineAt: EP03.amberHeadlineAt,
            sublineAt: EP03.amberSublineAt,
          }}
        />
        <HandoffCard
          t={t}
          tone={LOOKS.amber}
          count={EP03_PICKS.length}
          timing={EP03}
        />
        <PickChips
          t={t}
          picks={EP03_PICKS}
          leads={EP03_LEADS}
          color={LOOKS.blue.color}
          timing={EP03}
        />
        <RestPointer t={t} timing={EP03} />
      </>
    )}
  </ExplainerShell>
);

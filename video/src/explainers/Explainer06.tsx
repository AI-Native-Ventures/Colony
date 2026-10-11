import { LOOKS } from "../launch/wide/employees.ts";
import { Painter, WebsiteCard } from "../launch/wide/WebsiteCard";
import {
  BAR_APPROVE,
  DOMAIN_WIDTH,
  EP06,
  EP06_LINES,
  EP06_REQUEST,
  EP06_SECONDS,
  REQUEST_CARD,
  YES_FROM,
} from "./ep06.ts";
import { ExplainerShell, type ShellConfig } from "./ExplainerShell";
import { ApprovePointer, RequestCard } from "./kit";
import { MO } from "./mo.ts";
import { MoNewPage, MoOldPage } from "./MoSite";
import { SiteBarControls } from "./SiteBar";

const MO_PAGES = { Old: MoOldPage, New: MoNewPage };

export const EP06_SHELL: ShellConfig = {
  lines: EP06_LINES,
  keywords: {
    m1: new Set(["AI", "employee", "website."]),
    w1: new Set(["R1,450,", "Saturdays."]),
    w2: new Set(["before", "after."]),
    y1: new Set(["yes,", "live."]),
  },
  tone: LOOKS.green,
  world: [
    { id: "mintPink", at: 0 },
    { id: "lilac", at: EP06.closeFrom },
  ],
  hook: {
    lines: ["Your prices", "went up."],
    subline: "Your website didn't.",
    shape: "car",
    seed: 20261106,
    wordsAt: EP06.hookWordsAt,
    sublineAt: EP06.hookSublineAt,
    swarmFrom: EP06.swarmFrom,
    stageFrom: EP06.stageFrom,
    stageTo: EP06.stageTo,
    tone: LOOKS.green,
  },
  hero: { look: LOOKS.green, timing: EP06 },
  close: {
    dimFrom: EP06.closeFrom,
    dark: EP06.closeDark,
    logoIn: EP06.logoIn,
    name: EP06.name,
    tagline: EP06.tagline,
    earlyAt: EP06.earlyAt,
    urlAt: EP06.urlAt,
  },
  music: [
    { from: 0, until: EP06.closeFrom + 0.4, trackAt: 7 - EP06.stageTo },
    { from: EP06.logoIn - 2, until: EP06_SECONDS, trackAt: 7 - 2 },
  ],
  pops: [
    EP06.paintFrom + EP06.paintDuration,
    EP06.toggleIn,
    EP06.liveAt,
    EP06.logoIn,
  ],
  whooshes: [EP06.stageFrom, EP06.closeFrom],
  clicks: [EP06.click],
  scribbles: [
    {
      from: EP06.requestFrom,
      until: EP06.requestFrom + EP06_REQUEST.length / EP06.requestCps,
    },
  ],
  extras: [
    { at: EP06.swarmBuilt, file: "launch/sfx-shimmer.mp3", volume: 0.25 },
  ],
};

/** Explainer 6, "Keeps your website fresh", for Mo's Auto Repairs. */
export const Explainer06: React.FC = () => (
  <ExplainerShell config={EP06_SHELL}>
    {(t) => (
      <>
        <WebsiteCard
          t={t}
          timing={EP06}
          pages={MO_PAGES}
          domain={MO.domain}
          domainWidth={DOMAIN_WIDTH}
          barEnd={<SiteBarControls t={t} tone={LOOKS.green} timing={EP06} />}
          before={{ from: EP06.beforeFrom, until: EP06.beforeUntil }}
        />
        <Painter t={t} timing={EP06} />
        <RequestCard
          t={t}
          rect={REQUEST_CARD}
          text={EP06_REQUEST}
          from={EP06.requestFrom}
          cps={EP06.requestCps}
          showFrom={EP06.requestIn}
          tone={LOOKS.green}
        />
        <ApprovePointer
          t={t}
          rect={BAR_APPROVE}
          timing={EP06}
          from={YES_FROM}
        />
      </>
    )}
  </ExplainerShell>
);

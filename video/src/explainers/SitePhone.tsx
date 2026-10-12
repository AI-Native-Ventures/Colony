import { easeOutExpo, progress, smoothstep } from "../launch/math.ts";
import { TONES } from "../launch/wide/employees.ts";
import type { SiteTiming } from "../launch/wide/WebsiteCard";
import { WorkerAnt } from "../launch/wide/WorkerAnt";
import { EP06, EP06_REQUEST } from "./ep06.ts";
import { BAR_H, PAGE_H, REQUEST_BUBBLE, wipeY } from "./ep06Phone.ts";
import { MO } from "./mo.ts";
import { MoNewPhonePage, MoOldPhonePage } from "./MoPhonePages";
import { PhoneCard } from "./PhoneCard";
import { PHONE_CARD } from "./phone.ts";
import { PhoneRequest, PinnedButton, tint } from "./phoneKit";
import { Tick } from "./RisePostsCard";

const GREEN = TONES.green;
const INK = "#17151f";
const MUTED = "#6a6780";
const LINE = "#ece9f4";
const PAINTER_X = 690;

type Timing = typeof EP06;
type Paint = { paintFrom: number; paintDuration: number };

/** A site in the phone browser: its address, its old and new pages, and the chip once the new one is up. */
export type SiteSetup = {
  domain: string;
  chip: string;
  Old: React.FC;
  New: React.FC;
};

const EP06_SITE: SiteSetup = {
  domain: MO.domain,
  chip: "Live",
  Old: MoOldPhonePage,
  New: MoNewPhonePage,
};

/** Episode 6's Before and After toggle: when it shows, and while Before is on. */
type Toggle = { at: number; beforeFrom: number; beforeUntil: number };

/** The browser bar: the address (with the chip once the new page is up), then Before and After when there is a toggle. */
function Bar({
  t,
  site,
  chipAt,
  toggle: tg,
}: {
  t: number;
  site: SiteSetup;
  chipAt: number;
  toggle?: Toggle;
}) {
  const toggle = tg ? easeOutExpo(progress(t, tg.at, 0.45)) : 0;
  const before = tg ? t >= tg.beforeFrom && t < tg.beforeUntil : false;
  const live = easeOutExpo(progress(t, chipAt, 0.4));
  const segment = (on: boolean): React.CSSProperties => ({
    flex: 1,
    height: 40,
    borderRadius: 999,
    background: on ? "#ffffff" : "transparent",
    boxShadow: on ? "0 4px 10px -4px rgb(23 21 31 / 0.3)" : undefined,
    color: on ? INK : MUTED,
    fontSize: 21,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  });
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: 0,
        height: BAR_H,
        background: "#f7f6fb",
        borderBottom: `1.5px solid ${LINE}`,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 24,
          top: 20,
          height: 52,
          right: toggle > 0 ? 24 + 236 + 14 : 24,
          borderRadius: 999,
          background: "#ffffff",
          border: `1.5px solid ${LINE}`,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 20px",
          fontSize: 23,
          fontWeight: 600,
          color: INK,
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24">
          <rect x="5" y="10" width="14" height="10" rx="2" fill={MUTED} />
          <path
            d="M8 10V7a4 4 0 0 1 8 0v3"
            fill="none"
            stroke={MUTED}
            strokeWidth="2"
          />
        </svg>
        {site.domain}
        {live > 0 ? (
          <span
            style={{
              marginLeft: "auto",
              height: 34,
              padding: "0 12px",
              borderRadius: 999,
              background: tint(GREEN.color, 0.16),
              color: GREEN.deep,
              fontSize: 19,
              fontWeight: 700,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              opacity: live,
            }}
          >
            <Tick size={18} color={GREEN.deep} />
            {site.chip}
          </span>
        ) : null}
      </div>
      {toggle > 0 ? (
        <div
          style={{
            position: "absolute",
            right: 24,
            top: 20,
            width: 236,
            height: 52,
            borderRadius: 999,
            background: "#ebe8f2",
            padding: 6,
            boxSizing: "border-box",
            display: "flex",
            opacity: toggle,
            transform: `translateX(${((1 - toggle) * 30).toFixed(2)}px)`,
          }}
        >
          <span style={segment(before)}>Before</span>
          <span style={segment(!before)}>After</span>
        </div>
      ) : null}
    </div>
  );
}

/** The page: the old one, repainted top to bottom into the new one, with Before (episode 6) showing the old one again. */
function Page({
  t,
  paint,
  site,
  before: b,
}: {
  t: number;
  paint: Paint;
  site: SiteSetup;
  before?: { from: number; until: number };
}) {
  const { Old, New } = site;
  const wipe = wipeY(t, paint);
  const painting = t >= paint.paintFrom && wipe < PAGE_H;
  const before = b
    ? smoothstep(b.from, b.from + 0.25, t) *
      (1 - smoothstep(b.until, b.until + 0.25, t))
    : 0;
  const edge = painting ? 1 - smoothstep(PAGE_H - 40, PAGE_H, wipe) : 0;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: BAR_H,
        height: PAGE_H,
        overflow: "hidden",
      }}
    >
      <Old />
      {t >= paint.paintFrom ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            clipPath: `inset(0 0 ${(PAGE_H - wipe).toFixed(2)}px 0)`,
            opacity: 1 - before,
          }}
        >
          <New />
        </div>
      ) : null}
      {edge > 0 ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: wipe - 3,
            height: 6,
            background: GREEN.color,
            boxShadow: `0 0 24px 6px ${tint(GREEN.color, 0.6)}`,
            opacity: edge,
          }}
        />
      ) : null}
    </div>
  );
}

/** The green painter walking down the page as it repaints it. Card pixels. */
function Painter({ t, paint: timing }: { t: number; paint: Paint }) {
  const walkIn = timing.paintFrom - 0.6;
  const end = timing.paintFrom + timing.paintDuration;
  if (t < walkIn || t > end + 0.6) return null;
  const y =
    t < timing.paintFrom
      ? BAR_H - 90 + 90 * easeOutExpo(progress(t, walkIn, 0.6))
      : BAR_H + wipeY(t, timing);
  const fade =
    smoothstep(walkIn, walkIn + 0.25, t) * (1 - smoothstep(end, end + 0.5, t));
  return (
    <div style={{ opacity: fade }}>
      <WorkerAnt
        x={PAINTER_X}
        y={y + 26}
        angle={Math.PI / 2}
        size={64}
        color={GREEN.color}
        phase={(t - walkIn) * 4.2}
        amp={t < end ? 1 : 0}
      />
    </div>
  );
}

/** Your request, in a bubble over the foot of the page while you type it; it leaves as the painting starts. */
function RequestBubble({ t, timing }: { t: number; timing: Timing }) {
  const up = easeOutExpo(progress(t, timing.requestIn, 0.5));
  const down = smoothstep(timing.paintFrom - 0.1, timing.paintFrom + 0.35, t);
  if (up <= 0 || down >= 1) return null;
  const top = PHONE_CARD.h - REQUEST_BUBBLE.bottom - REQUEST_BUBBLE.h;
  return (
    <div
      style={{
        position: "absolute",
        left: REQUEST_BUBBLE.left,
        top,
        width: REQUEST_BUBBLE.w,
        height: REQUEST_BUBBLE.h,
        borderRadius: 30,
        background: "#ffffff",
        boxShadow: "0 30px 60px -24px rgb(23 21 31 / 0.55)",
        opacity: up * (1 - down),
        transform: `translateY(${((1 - up) * 60 + down * 80).toFixed(2)}px)`,
      }}
    >
      <PhoneRequest
        t={t}
        text={EP06_REQUEST}
        from={timing.requestFrom}
        cps={timing.requestCps}
        showFrom={timing.requestIn}
        tone={GREEN}
        top={22}
        left={24}
        width={REQUEST_BUBBLE.w - 48}
      />
    </div>
  );
}

/** Episode 6's work on the phone card: Mo's page in a phone browser, your request, the repaint, Before and After, your yes. */
export const SitePhone: React.FC<{ t: number; timing?: Timing }> = ({
  t,
  timing = EP06,
}) => (
  <PhoneCard t={t} enterAt={timing.siteIn} glow="hsl(150 50% 25% / 0.4)">
    <Page
      t={t}
      paint={timing}
      site={EP06_SITE}
      before={{ from: timing.beforeFrom, until: timing.beforeUntil }}
    />
    <Bar
      t={t}
      site={EP06_SITE}
      chipAt={timing.liveAt}
      toggle={{
        at: timing.toggleIn,
        beforeFrom: timing.beforeFrom,
        beforeUntil: timing.beforeUntil,
      }}
    />
    <Painter t={t} paint={timing} />
    <RequestBubble t={t} timing={timing} />
    <PinnedButton
      t={t}
      tone={GREEN}
      idle="Approve"
      done="Live"
      timing={{
        approveIn: timing.approveIn,
        click: timing.click,
        doneAt: timing.liveAt,
      }}
    />
  </PhoneCard>
);

/** The film's website beat on the phone card: the old page repainted top to bottom into the new one, the chip once it is up. */
export const SiteUpdatePhone: React.FC<{
  t: number;
  timing: SiteTiming;
  site: SiteSetup;
}> = ({ t, timing, site }) => (
  <PhoneCard t={t} enterAt={timing.siteIn} glow="hsl(150 50% 25% / 0.4)">
    <Page t={t} paint={timing} site={site} />
    <Bar t={t} site={site} chipAt={timing.chipAt} />
    <Painter t={t} paint={timing} />
  </PhoneCard>
);

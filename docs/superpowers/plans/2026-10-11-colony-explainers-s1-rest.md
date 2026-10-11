# Colony Explainers Season 1, Episodes 1 to 4 and 6 to 8, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This run is native inline: the owner forbids subagents.

**Goal:** Make the other seven explainers the way the approved bakery pilot (episode 5) was made, then open one pull request into develop for the season.

**Architecture:** First lift episode 5's composition into a shared shell and a configurable hook, and give the launch film's work cards (plan, website box, leads, email, call, website repaint) optional data props whose defaults keep the film byte-identical. Each episode is then data (timeline, lines, brand, hook shape) plus a small work scene built from those cards, rendered, gated and added to the watch page one by one.

**Tech Stack:** Remotion 4.0.522, React 19, TypeScript on Node 24's test runner, Gemini TTS (Aoede) and Gemini transcription via `zsh -ic`, ffmpeg, gstack `$B` for Pinterest references.

**Spec:** `docs/superpowers/specs/2026-10-11-colony-explainers-s1-design.html` (scripts are the contract). Pilot plan and its rulings: `docs/superpowers/plans/2026-10-11-colony-explainer-05-bakery-pilot.md`.

## Global Constraints

- 1920 by 1080, 30 fps, 33 to 42 s each; the five beats hook, meet, work, yes, end; hook voiced within the first second; captions hold until the next line (max 1.5 s after their words); lines already on screen as big type get no caption.
- Motion graphics drawn in code only: no AI video, no mascot, no photos; ants only as pattern and carriers.
- Voice: `gemini-3.8-flash-tts`, voice `Aoede`, one read per episode, normalised to -16 LUFS, cut at measured pauses; never print API keys.
- Copy: no em dashes; banned words per `src/launch/banned.ts`; every line passes the stranger test; scripts exactly as in the spec.
- Customer work (website, menu, emails) is drawn in that trade's style; where it is a big on-screen artifact (episode 6 website, episode 8 menu) the style comes from Pinterest references for that trade.
- End card is `CloseScene` with `plain` (no shadow under the logo).
- The launch film must not change: frames 1080, 1320, 1560, 1830, 2025, 2220, 2385 of `Film90` stay byte-identical to `scratchpad/baseline/hashes.txt`, and episode 5 frames 0, 405, 840 too.
- Commit with `git commit -s`; push only `claude/colony-explainers-s1` with an explicit refspec as `nocodeafrica`; one PR into develop at the end.

## Review Focus

1. A refactor that silently changes the launch film or the pilot (the hash gates catch it; run them after Tasks 1 and 2).
2. A hook shape that reads as something else (check the built swarm at its last frame for each episode).
3. Long customer names or URLs overflowing their cards (check every card at its fullest state).
4. Gemini free-tier limits mid-episode (TTS and transcription): wait and retry, switch transcription to `gemini-2.5-flash-lite`, never fake a check.
5. A yes beat whose click does not land on its button (cursor tests per episode).

---

### Task 1: Shared shell and configurable hook (episode 5 moves onto them)

**Files:**
- Create: `video/src/explainers/ExplainerShell.tsx`, `video/src/explainers/hookShapes.ts`, `video/src/explainers/hookShapes.test.ts`, `video/src/explainers/episodeChecks.test.ts` (shared assertions helper, test-only)
- Modify: `video/src/explainers/HookScene.tsx` (props: words, subline, shape, timing, tone, seed), `video/src/explainers/Explainer05.tsx` (becomes config + `<ExplainerShell>`)

**Interfaces:**
- Produces:

```ts
export type HookShapeId = "croissant" | "hardHat" | "scissors" | "wrench" | "camera" | "car" | "sprayBottle" | "chefHat";
export function drawHookShape(id: HookShapeId, ctx: CanvasRenderingContext2D, cx: number, cy: number, width: number): void;
export type HookConfig = { lines: readonly [string, string]; subline: string; shape: HookShapeId; seed: number;
  wordsAt: number; sublineAt: number; swarmFrom: number; stageFrom: number; stageTo: number; tone: Tone };
export type ShellConfig = { seconds: number; lines: EpisodeLine[]; keywords: Record<string, ReadonlySet<string>>;
  tone: Tone; world: PaletteStop[]; hook: HookConfig; hero: { look: HeroLook; timing: HeroTiming };
  close: typeof CLOSE90; music: { from: number; until: number; trackAt: number }[];
  pops: number[]; whooshes: number[]; clicks: number[]; scribbles: { from: number; until: number }[];
  extras?: { at: number; file: string; volume: number }[] };
export const ExplainerShell: React.FC<{ config: ShellConfig; children: (t: number) => React.ReactNode }>;
```

- [ ] **Step 1:** Write `hookShapes.test.ts`: for every `HookShapeId`, drawing on a 400 by 300 canvas stub that records `fill`/`ellipse`/`Path2D` calls must draw at least once inside the box; the ids list equals the eight shapes. Run; expect FAIL (module missing).
- [ ] **Step 2:** Implement `hookShapes.ts`: croissant (from `croissantShape.ts`), wrench, scissors, camera and car from Material icon paths (Apache 2.0) through `Path2D`, hard hat, spray bottle and chef hat from canvas primitives. Run; expect PASS.
- [ ] **Step 3:** Generalise `HookScene` and lift `Explainer05`'s body into `ExplainerShell`; `Explainer05` keeps only its config and work scene.
- [ ] **Step 4:** Gate: render Explainer05 frames 0, 405, 840 and compare to the baseline hashes; all three must match. Typecheck, lint, full tests. Commit `video(explainers): shared shell and hook for the season`.

### Task 2: Launch film cards take data (film unchanged)

**Files:**
- Modify: `video/src/launch/wide/ScoutPanel.tsx` (`tasks?`, `title?`, `footer?`), `HowPanel.tsx` (`website?`, `facts?`, `rows?`, `button?`), `LeadsBoard.tsx` (`leads?` with optional `reason`, `heading?`, `total?`), `EmailCard.tsx` (`email?`), `CallCard.tsx` (`call?`), `WebsiteCard.tsx` (`pages?`, `domain?`)
- Test: extend the matching `*.test.ts` where geometry depends on counts (team rows of five fit the card; leads with reasons fit their row)

- [ ] **Step 1:** Write the failing geometry tests (five team rows fit `BUSINESS_CARD`; a lead row's reason chip ends inside `BOARD`). Run; expect FAIL.
- [ ] **Step 2:** Add the optional props with defaults equal to today's constants; make the geometry helpers take the count.
- [ ] **Step 3:** Gate: render the seven `Film90` baseline frames; all hashes match. Full tests. Commit `video(launch): film cards take data, film unchanged`.

### Tasks 3 to 9: one episode each, in season order 1, 2, 3, 4, 6, 7, 8

Every episode task has the same steps:

- [ ] **Step 1 (references):** only for 6 (auto repair website) and 8 (catering menu): Pinterest logged out with `$B`, contact sheet, three picks noted in the ledger.
- [ ] **Step 2 (brand):** `video/src/explainers/<trade>.ts` with name, place, colours, fonts and any data the cards show; test pins the visible data (e.g. URL, prices, menu items).
- [ ] **Step 3 (voice):** one Aoede read of the spec's lines (plus "Early access is open at colony dot global."), normalise, silencedetect, cut to `public/explainers/epNN-<id>.mp3`, transcribe the joined clips, record cuts in SOURCES.md.
- [ ] **Step 4 (timeline, test first):** `epNN.test.ts` using the shared checks (timeline sound, 33 to 42 s, hook words and swarm on screen from frame 0, stage opens after the hook line and before the meet line, every work moment inside the line it illustrates, the yes click on the yes line, the URL while it is said) plus episode specifics; watch it fail; write `epNN.ts`; watch it pass.
- [ ] **Step 5 (work scene):** `EpNN.tsx` composing the hero and the cards with episode data; stills at each state; fix overlaps.
- [ ] **Step 6 (render and gates):** register `ExplainerNN`; `render:exNN`/`master:exNN`; loudness -16 plus or minus 1 LUFS, true peak at most -1 dBFS, darkest frame above 150, three frames identical twice, voice transcribes in order, 16-frame sheet.
- [ ] **Step 7 (deliver):** add the episode to the watch page (https://claude.ai/artifact/VRHBMC8CnFi1AQDjRYGdNx) and to `~/Desktop/Colony video tests/` as the next number; push.

Episode data:

| # | Business | Hero | Hook shape | Work | Yes |
|---|---|---|---|---|---|
| 1 | Mahlangu Builders, Pretoria | `SCOUT_LOOK` | hard hat | Owner's sentence typed ("More work from property developers this month."), plan card deals three tasks (blue: Find 15 property developers in Pretoria; amber: Email and call each one; pink: Post our latest build), ticks as Scout checks | Approve plan click, "Plan approved" |
| 2 | Studio Nala, Rosebank | `GETTING_STARTED` | scissors | Website box with studionala.co.za, facts (Hair salon; Rosebank; Cuts, colour and braids; Open six days), five team rows (four employees and Scout) | "Hire my team" click |
| 3 | Bright Plumbing, Sandton | `LOOKS.blue` | wrench | Request typed ("Office parks in Sandton"), leads with reasons carried in, count to 20, five ticked | Five slide to the amber employee, "Nothing goes out without your yes" button waits, pointer rests on it |
| 4 | Golden Hour Photography, Cape Town | `LOOKS.amber` | camera | Email typed to a wedding venue, reply, call, "Meeting booked: Fri 11:00" | Next drafts wait, Approve click |
| 6 | Mo's Auto Repairs, Soweto | `LOOKS.green` | car | Owner's line typed ("A full service is now R1,450, and we're open on Saturdays."), old site repainted to a new one from the Pinterest picks, before and after | Approve click, "Live" |
| 7 | Sparkle Cleaning, Fourways | `OWNER` | spray bottle | A quote reply drafted, the owner's note ("Shorter, and mention we bring our own supplies."), the rewrite side by side | Approve click, "Sent" |
| 8 | Thandi's Kitchen, Durban | new violet look "Talk to your team." | chef hat | Three chats (Weddings, Office lunches, Website), a wedding menu card from the Pinterest picks, the owner's reply on it ("Make the wedding menu vegetarian-friendly."), the new menu in the same thread | Approve click |

### Task 10: Season wrap

- [ ] **Step 1:** Re-run the film and pilot hash gates; full tests; typecheck; lint.
- [ ] **Step 2:** Self-review of the whole branch (no subagents); ledger rulings and deferred minors appended to this plan.
- [ ] **Step 3:** Open one PR into develop for the season (`gh pr create --repo AI-Native-Ventures/Colony --base develop`), arm auto-merge, bind it to the session.

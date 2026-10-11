# Colony Launch Video: Rough Cut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (the owner does not allow Claude Code subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build step 3 of 4 from the spec: the full 30 second film with every scene in place, the chosen voice (Gemini "Aoede") and music (Seed Audio draft B), motion rough but timed, so the owner can judge story and timing.

**Architecture:** One new `LaunchFilm` composition (1080 by 1920, 30 fps, 900 frames) reusing the look-proof layers for the opening and adding three app scenes and an end card. All timing lives in one pure, tested module (`film.ts`). Voice lines are pre-cut audio files placed by `<Sequence>`; the music's volume ducks under the voice through a pure, tested function. App screens are vector rebuilds of the real desktop screens (checked against the e2e screenshots in the session scratchpad: `shots/agents.png`, `shots/discovery.png`) in the app's real light lavender theme, floating over the dark swarm world.

**Tech Stack:** Remotion 4.0.522 (`Audio`, `Sequence`, `staticFile` from `remotion`), React 19, TypeScript, Node test runner, ffmpeg for cutting audio and for gates.

**Spec:** `docs/superpowers/specs/2026-10-10-colony-launch-video-design.html` (beat sheet, words on screen, sound, checks). Decisions since the spec: voice Aoede, music draft B, look approved with words slowed (plan `2026-10-10-colony-launch-video-look-proof.md`).

## Global Constraints

- 1080 by 1920, 30 fps, exactly 30 s (900 frames). Standalone `video/` package; never touch the workspace lockfile.
- Every frame is a pure function of time; no `Math.random`.
- Brand hues exactly as in `colors.ts`; violet is Colony, blue finds customers, amber emails, green the website, pink posts.
- Words on screen exactly as the spec's "Words on screen" table; no long dashes; never on screen: agent, workspace, model, channel, relay, token (the real sidebar says "Agents", so the sidebar is never shown).
- Words stay inside x 90 to 940 and y 150 to 1500.
- The music's lift (7.0 s in the track) lands on the logo flash: music starts at film 0, so `T_LOGO_IN` must equal 7.0.
- Voice and on-screen words never disagree, and each caption stays up at least its reading time (words / 3 + 0.5 s).
- Final mix about -16 LUFS integrated, true peak below -1 dB.

## Review Focus

1. **Voice drifting off its scene:** a line placed by hand ends up over the wrong picture. Expected: every voice line ends inside its own scene. Pinned in Task 1 (`film.test.ts`).
2. **The "yes" and the click:** the Approve click must land while "Nothing goes out without your yes" is being said. Pinned in Task 1.
3. **Music swallowing the voice:** without ducking the narration drowns on phone speakers. Expected: music sits clearly lower while a line plays and recovers smoothly. Pinned in Task 2 (`duck.test.ts`) and Task 6 (loudness gate).
4. **Banned words leaking from real UI copy:** rebuilt screens copy real strings. Expected: no banned word anywhere in `src/launch`. Pinned in Task 1 (source guard test).
5. **Silent or missing audio in the render:** a wrong `staticFile` path renders silence without an error. Expected: the rendered MP4's audio transcribes to the full script in order. Pinned in Task 6.

---

### Task 1: Film timeline (pure, tested)

**Files:** Create `video/src/launch/film.ts`, `video/src/launch/film.test.ts`. Modify `video/src/launch/timeline.ts` (T_TREMBLE 4.35, T_RELEASE 4.75, so T_LOGO_IN = 7.0).

**Interfaces:** Produces `FILM_SECONDS = 30`, `SCENES` (`opening`, `business`, `team`, `approve`, `end`, each `{ start, end }`), `VO_LINES` (`{ id, file, at, speech: [from, to], text }`), `CAPTIONS` (`{ text, from, to }`), `CLICK_AT`, `MUSIC_LIFT = 7.0`.

- [ ] Write `film.test.ts`: scenes are contiguous from 0 to 30; every VO line's speech window sits inside one scene; VO lines never overlap; `CLICK_AT` lies inside the speech window of the line containing "your yes"; `T_LOGO_IN === MUSIC_LIFT`; every caption lasts at least words/3 + 0.5 s; no banned word in any `src/launch` source file.
- [ ] Run, watch it fail (module missing).
- [ ] Implement `film.ts` with these values (seconds):
  - Scenes: opening 0 to 9.3, business 9.3 to 13.3, team 13.3 to 17.9, approve 17.9 to 24.4, end 24.4 to 30.
  - Voice (Aoede cuts, file start `at`, speech window): L1 0.30 [0.50, 3.40]; L2 3.70 [3.90, 4.73]; L3 6.85 [7.05, 8.40]; L4a 9.50 [9.70, 10.42]; L4b 13.40 [13.50, 17.37]; L5 18.20 [18.40, 20.95]; L6 24.70 [24.90, 29.17].
  - Captions: "Paste your website." 9.6 to 13.2; "Meet your AI employees." 13.5 to 17.8; "Software that does office work for you." 14.6 to 17.8; "Nothing goes out without your yes." 19.0 to 24.3. (Opening and end captions already live in the proof layers and the end card.)
  - `CLICK_AT` 20.75.
- [ ] Run, watch it pass; commit.

### Task 2: Music ducking (pure, tested)

**Files:** Create `video/src/launch/duck.ts`, `video/src/launch/duck.test.ts`.

**Interfaces:** `musicVolume(t, windows, { base, ducked, attack, release }): number`.

- [ ] Tests: equals `base` far from any window; equals `ducked` in the middle of a window; never changes by more than 0.05 between frames at 30 fps; recovers to `base` within `release` after a window ends.
- [ ] Fail, implement (smoothstep ramps around each window, minimum over windows), pass, commit.

### Task 3: Audio assets in the repo

**Files:** Create `video/public/launch/vo-*.mp3` (7 files cut from the normalized Aoede read at the padded bounds L1 0.18-3.28, L2 3.43-4.65, L3 4.84-6.38, L4a 6.46-7.47, L4b 7.47-11.64, L5 11.74-14.69, L6 14.84-19.50), `video/public/launch/music-b.mp3` (draft B, loudness -18 LUFS), `video/public/launch/SOURCES.md` (model, voice, prompt, date, cost, license note for each file).

- [ ] Cut with ffmpeg; transcribe each cut and compare to its `text` in `VO_LINES`; record results; commit.

### Task 4: App scenes

**Files:** Create `video/src/launch/app/AppWindow.tsx`, `BusinessForm.tsx`, `TeamChart.tsx`, `ApproveInbox.tsx`, `Cursor.tsx`, `Caption.tsx`, `typing.ts` (+ `typing.test.ts`).

Design values (all from the real screens): page surface `#f3f1f8`, cards white with `1px solid #e6e3ee`, radius 24 px at film scale, text `#1a1a2e` and muted `#6a6a7e`, Inter; primary buttons violet `hsl(258 90% 66%)` with white text; window floats over the dark world with a slight 3D tilt (rotateX 6 deg, rotateY -8 deg), soft violet shadow, one slow light sweep.

- **BusinessForm** (business scene): the real "Your business" form at film scale (width 900): heading "Your business", line "Only the essentials. You can add more as you go.", fields "Business name" = "Bright Plumbing", "Website" typed "brightplumbing.co.za" from 9.9 s at 14 characters per second, the "Read website" link pressed at 11.3 s, showing "Reading your website…" until 12.3 s, then the summary field fills with "Fixes leaks, geysers and blocked drains for homes and offices in Sandton." The real note under the summary mentions an internal name, so it is not shown.
- **TeamChart** (team scene): heading "Org chart" and the real line "Who reports to whom, who is working, and what everyone may decide.", four employee cards popping in at 13.7, 13.95, 14.2, 14.45 s, each with a round avatar holding the ant mark in its color and a plain job: "Finds customers" (blue), "Emails new customers" (amber), "Updates your website" (green), "Posts on Instagram" (pink), each with a small "Working" status dot.
- **ApproveInbox** (approve scene): the real "Outreach" screen: heading "Outreach", counters "Drafts Ready" 3 and "Approved" 0 (counting up as drafts are approved), three email drafts with a "Draft" badge that turns to "Approved" written by the amber employee to leads from the real Leads screen style ("Rosebank Auto Care", "Sandton Medical Suites", "Grayston Office Park"), each with subject and two-line body, an "Approve" button (violet). Cursor glides to the first Approve from 19.6 s, clicks at `CLICK_AT`, ripple, chip "Approved"; the other two approve at 21.4 and 21.9 s; at 22.6 s the three cards fly out with amber trails ("sent").
- **Caption**: big bold words above the window (y 230 to 520), reveal blur to sharp, exit fade.
- **typing.ts**: `typedText(full, t, start, cps)` pure; tests for empty before start, full after, monotonic growth.

- [ ] typing tests first (red, green), then the components; type-check and lint; commit.

### Task 5: End card and the LaunchFilm composition

**Files:** Create `video/src/launch/EndCard.tsx`, `video/src/launch/LaunchFilm.tsx`; modify `video/src/Root.tsx`, `video/package.json` (`render:film`, `still:film`).

- End card (24.4 to 30): the window recedes and fades by 25.0 s; the violet logo returns with the glow pulse; "Colony." at 25.4 s, "Your business. Your AI employees." at 25.9 s, an "Early access is open" pill at 27.6 s (as the voice says it), "colony.ainative.ventures" at 27.9 s; hold to 30.
- LaunchFilm: Backdrop; opening layers (solo ant, words, swarm, logo reveal) until 9.3 s with the logo and title easing out 9.0 to 9.6 s; AppWindow with the three scenes crossfading at 13.3 and 17.9 s; captions; end card; vignette and grain; `<Audio>` for the music with `musicVolume` and one `<Sequence>` + `<Audio>` per voice line.

- [ ] Write, type-check, lint, register, commit.

### Task 6: Render, gate, deliver

- [ ] Render `LaunchFilm` (30 fps). Gates: 900 frames and 30.0 s; brightness (no sampled frame with YMAX below 60); determinism (one frame rendered twice, same hash); loudness about -16 LUFS integrated with ebur128; transcript of the rendered audio contains every voice line in order; contact sheet of 12 frames reviewed for overlaps, clipped words, banned words.
- [ ] Self-review the sheet against the bar; fix what a stranger would notice; re-render (at most two passes).
- [ ] Publish on the watch page (same URL) as "Step 3: rough cut", copy the MP4 to the Desktop review folder, push the branch, report what was and was not verified.

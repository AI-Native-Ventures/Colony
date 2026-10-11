# Colony Launch Film: "Finds Customers" Proof Beat Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (the owner does not allow Claude Code subagents). Steps use checkbox (`- [ ]`) syntax.

**Goal:** 15 seconds, 16:9, with voice and music: a blue river of ants turns the dark world bright and becomes the "Finds customers" employee; blue ants carry lead cards like leaf-cutter ants into a big, flat Leads list until "20 found". The owner judges the new app style and the working ants before the rest of the 90 second film is built.

**Architecture:** New compositions live in `video/src/launch/wide/`. Pure, tested modules (`gait.ts`, `walk.ts`, `karaoke.ts`, `beat.ts`) carry all timing and motion; React components draw. The swarm engine from the look proof flies the river into the avatar. Audio: two Aoede cuts plus music draft B from its 7 s groove, ducked under the voice.

**Spec:** `docs/superpowers/specs/2026-10-11-colony-launch-film-90s-design.html` (two worlds, ants are the employees, checks).

## Global Constraints

- 1920 by 1080, 30 fps, 15 s (450 frames). Every frame a pure function of time.
- App text at least 20 px; one focal element per moment; no tilted full-window replicas.
- Brand hues from `colors.ts`; blue is the employee who finds customers. Inter only.
- Real copy where the app has it: the Leads screen heading "Leads." and its line "Find and manage the businesses your company can serve."
- Banned words never on screen (the source scan in `film.test.ts` covers `wide/` too).
- Voice: `vo-blue-1` "This one finds customers." (cut 0.08 to 2.45 of the read), `vo-blue-2` "Twenty offices in Sandton that need a plumber, before your first coffee." (cut 2.46 to 6.50).

## Review Focus

1. Ant legs must move only while the ant moves; a gliding ant with frozen legs reads as cheap. Pinned in `walk.test.ts` (gait amplitude is zero at rest).
2. Carried cards must land exactly in their row slot. Pinned in `beat.test.ts` (each carry path ends at its row).
3. Subtitles must never show a word before it is spoken. Pinned in `karaoke.test.ts`.
4. The counter must never go down and must end at 20. Pinned in `beat.test.ts`.
5. Dark to bright switch must not leave a black or white flash frame. Checked in the brightness gate (YMAX above 60, mean below 250 on every sample).

---

### Task 1: Pure motion and timing modules (tested)

- [ ] `gait.ts`: `legAngles(phase)` returns tripod A and B rotations (0 to -5 degrees, opposite) and body bob, matching the brand CSS gait (`desktop/src/shared/styles/globals/animations.css`, 0.42 s cycle). Tests: A and B opposite; range 0 to -5; period 1.
- [ ] `walk.ts`: `walkState(path, t, start, duration)` returns position, heading and gait amplitude along a cubic path (reusing `bezier` and `bezierTangent` from `swarm.ts`), amplitude 0 before start and after arrival. Tests: starts at the first point, ends at the last, amplitude 0 at rest, no jumps.
- [ ] `karaoke.ts`: `wordsShown(text, speech, t)` spreads words over the speech window by character weight. Tests: none before the window, all after, never ahead of time.
- [ ] `beat.ts`: beat timeline (river 0 to 1.8 s, bright 1.6 to 2.6 s, headline with `vo-blue-1` at 2.3 s, board in 3.6 s, seven carriers from 4.6 s every 0.65 s, `vo-blue-2` at 10.6 s), `LEADS` (seven example businesses in Sandton and nearby, each with area and score), `carryPath(i)` ending at row `i`, `foundCount(t)` rising to 20. Tests: paths end at their rows; count monotonic, ends at 20; voice lines inside 15 s and not overlapping.

### Task 2: Components and composition

- [ ] `BrightStage.tsx` (white to lavender field with two soft color blooms, light grain), `WorkerAnt.tsx` (SVG ant with the gait, color prop, optional carried tag above it), `EmployeeIntro.tsx` (blue avatar with the ant, "AI employee" pill, headline "Finds customers.", line "Finds businesses near you that need what you sell."), `LeadsBoard.tsx` (big flat card: "Leads." heading and real line, a "found" counter pill, column labels Company, Area, Score, seven rows that appear as their carriers land), `Subtitles.tsx` (bottom center, words appear as spoken, key words highlighted in blue), `TeamBeatProof.tsx` (dark river into the avatar through the existing swarm engine, bright reveal, layers, audio).
- [ ] Register `TeamBeatProof` (1920 by 1080, 30 fps, 450 frames); scripts `render:beat` and `master:beat`.
- [ ] Type-check, lint, tests; commit.

### Task 3: Render, gate, deliver

- [ ] Render and master; gates: 450 frames, brightness, loudness about -16 LUFS, transcript in order, determinism on one frame, a 12-frame sheet reviewed for overlaps, small text and stray words.
- [ ] Fix what a stranger would notice (at most two passes); publish on the watch page as "Step 1 of the 90 s film: proof beat", copy to the Desktop folder, push the branch.

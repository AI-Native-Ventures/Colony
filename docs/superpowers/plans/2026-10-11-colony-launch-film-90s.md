# Colony Launch Film (90 s, 16:9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (the owner does not allow Claude Code subagents). Steps use checkbox (`- [ ]`) syntax.

**Goal:** The full 90 second wide launch film in the style the owner approved on the proof beat: dark ant world for the big moments, bright flat product world for the work, ants as the working employees, Aoede voice, music, sound on every action.

**Architecture:** One `Film90` composition (1920 by 1080, 30 fps, 2700 frames) in `video/src/launch/wide/`. All film timing lives in `film90.ts` (pure, tested): acts, voice lines, the blue/amber/pink/green beats, the click, the camera. Each act is a component taking film time `t`. The blue beat module becomes configurable (`BlueTiming`) so the proof beat and the film share code. Milestones are rendered as frame ranges of `Film90` and shown to the owner on the watch page as they land.

**Spec:** `docs/superpowers/specs/2026-10-11-colony-launch-film-90s-design.html`.

## Global Constraints

- 1920 by 1080, 30 fps, 90 s. Pure function of time. Inter only. Brand hues from `colors.ts`.
- One big flat element per moment; app text at least 20 px; no tilted full-window replicas; banned words never on screen (source scan covers `wide/`).
- Voice: one Aoede read of the full script (`film90.txt`), cut at measured pauses; "Introducing: Colony." from a separate clearer take. Every cut transcribed and matched (in context where a short clip is ambiguous).
- Music: Seed Audio 90 s track with cues at 15.9 s (lift), 61 s (peak), 88 s (final chord). Fallback if the provider keeps refusing: an arrangement of approved draft B, flagged as a stand-in.
- Loudness -16 LUFS after `master:film90`; no dark frames except the deliberate opening fade; same frame renders the same twice.

## Timeline (film seconds)

| Act | Span | Voice (speech starts) |
|---|---|---|
| Weight | 0 to 13.6 | "Running a business means doing every job yourself." 0.8; "And there is never enough of you." 5.6; "What if you had a team?" 11.6 |
| Colony | 13.6 to 25.4 | break 13.6, logo 15.85; "Introducing: Colony." 16.0; "Your business. Your AI employees." 19.0; "AI employees are software that does office work for you." 22.3; "Meet yours." 25.3 |
| Blue | 25.4 to 34.6 | "This one finds customers." 27.2; "Twenty offices in Sandton that need a plumber, before your first coffee." 31.0 |
| Amber | 34.6 to 41.2 | "This one writes to each of them, in your words." 35.3 |
| Pink | 41.2 to 47.6 | "This one makes your posts. Three, ready for Instagram." 41.7 |
| Green | 47.6 to 54.2 | "And this one keeps your website up to date." 48.2 |
| Your yes | 54.2 to 67 | "Everything they make comes to you first." 55.0; "Nothing goes out without your yes." 59.6; click on "yes" 61.0 |
| Day back | 67 to 79.5 | "So while you're out doing the work you love, your team keeps the business moving." 68.0 |
| Close | 79.5 to 90 | "Colony." 82.0; "Your business. Your AI employees." 83.2; "Early access is open." 86.0 |

## Review Focus

1. A voice line spoken over the wrong act (pinned: every speech window inside its act).
2. The "yes" click off the word (pinned: click inside the "yes" line).
3. Beats crowding each other: an employee's work still arriving after the next employee speaks (pinned: each beat's last landing before the next beat's first line).
4. Text too small or overlapping in the bright world (gate: a 16-frame contact sheet per milestone, reviewed).
5. Music stand-in drifting from the cues (gate: loudness envelope measured at 15.9, 61 and 88 s).

## Milestones

### A. Meet the team (25.4 to 54.2), shown to the owner
- [ ] `film90.ts` + tests (acts contiguous 0 to 90, voice inside acts, no overlaps, click on "yes", beat landings before next voice).
- [ ] Voice cuts into `public/launch/f90-*.mp3`, transcript check, SOURCES.md.
- [ ] Blue beat retimed through `BlueTiming`; proof beat keeps its own timing (tests for both).
- [ ] Amber beat: avatar, "Writes to them.", a big email card to Thabo at Rosebank Auto Care that writes itself while an amber ant walks along the line like a pen; "Sent for your OK" chip.
- [ ] Pink beat: "Makes your posts.", three square post designs made in code (bold type, color, icon) carried into a 3-up grid by pink ants; "3 ready" chip.
- [ ] Green beat: "Keeps your website fresh.", a website card for Bright Plumbing whose hero section is repainted by a green ant walking along the wipe; "Updated" chip.
- [ ] Transitions: the camera glides across one long bright canvas from employee to employee; each new employee arrives as a short river of its color.
- [ ] Render frames 762 to 1626, gates, publish on the watch page.

### B. Your yes and your day back (54.2 to 79.5), shown to the owner
- [ ] One "Waiting for your OK" card collecting the four pieces of work (leads, emails, posts, website change), each in its employee's color; the cursor presses Approve on "yes"; the work flies out in a colored cascade with sound.
- [ ] Day back: a clock and two columns ("You" and "Your team") with three moments of the plumber's day and what the team did meanwhile; the four ants working in the team column.
- [ ] Render frames 1626 to 2385, gates, publish.

### C. Opening and close in 16:9, music, full assembly
- [ ] Opening layers parametrized by frame size (tall stays as is); wide words tower, swarm, logo, "Introducing Colony." on the lift; four rivers leave the logo after "Meet yours".
- [ ] Close: bright to dark, the four ants return into the logo, end lockup timed to the voice.
- [ ] Music (Seed Audio or the draft B stand-in), ducking, sound effects, master; full gates; publish the 90 s film; Desktop copy; push.

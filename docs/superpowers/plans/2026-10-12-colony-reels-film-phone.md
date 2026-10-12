# Reels Launch Film, Phone Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Reels launch film (`Film90Tall`) with the explainers' look: each scene's work as a tall phone screen under a slim employee header, and big captions.

**Architecture:** The explainers' phone screens take their data and timing as props (their episode values as defaults, proven byte-identical), and the film passes Bright Plumbing's data and the film's times. Each film page shows the slim header (`TallHero` `compactAt` at the card's entrance less 0.6 s) over a `PhoneCard`. The rivers land where each avatar is at that moment (`heroAvatarAt`), blue's leaves Scout's blue job row, and the bursts leave the phone inbox's rows. Captions use `BIG_CAPTIONS`.

**Tech Stack:** Remotion 4.0.522, React 19, TypeScript, `node --test`.

**Spec:** the owner's choice on 2026-10-12, "Yes, same as explainers": each of the seven scenes redrawn as a phone screen, 74 px captions; the opening, the day and the end card stay.

## Global Constraints

- The film's audio PCM is unchanged (28892e89...); the wide film and the eight wide and tall explainers are byte-identical.
- Frame 1080 x 1920; Instagram's covered areas and the feed crop as in `frame.ts`; no em dashes.

## Tasks

1. **Shared:** `heroAvatarAt(t, compactAt)` in `hero.ts` (TallHero uses it); the film's per-page `COMPACT_AT`; rivers target the avatar where it is when they land; big captions in the film. Tests: every river lands on its avatar's position at landing; the bursts and blue's river start inside the phone screens.
2. **How:** `TeamPhone` takes website, facts, rows and timing (no Scout row, no Hire button in the film).
3. **Scout:** `PlanPhone` takes title, tasks, request (optional) and a row layout; four jobs, no request, no Approve in the film; blue's river leaves the blue job row.
4. **Blue:** `LeadsPhone` in a leads-only mode: the film's seven leads with area and score, the count to twenty, no picks or hand-over.
5. **Amber:** `SalesPhone` with the film's email (Thabo) and call (Lindiwe), no reply or sheet; the call's bubbles stack by their height.
6. **Pink:** the posts feed with the film's posts and its own scroll keys.
7. **Green:** Bright Plumbing's old and new pages redrawn for a phone; `SitePhone` without request, toggle or Approve, with "Updated" at the film's time.
8. **Yes:** a new phone inbox: the four pieces of work carried in, "Approve all" pressed, each row approved in turn, bursts out to the right, then what happened to each.
9. **Deliver:** full render with the film's gates, the whole-branch proof, the watch page, Desktop copy, PR.

# Colony Rebrand Design

**Date:** 2026-07-31
**Status:** Approved

## Purpose

Rebrand the consumer-facing surfaces of this fork from Buzz to **Colony**:
in-app landing and onboarding, loading screens, brand animations, app name
and icons, user-visible copy, top-level docs, plus a new public marketing
site at **colony.ainative.ventures**.

This phase changes what users see. It does not rename internals.

## Decisions

- **Name:** Colony. The macOS app is "Colony".
- **Domain:** colony.ainative.ventures (marketing site).
- **Scope:** consumer-facing + docs. Crates, `BUZZ_*` env vars, CLI binary,
  event kinds, protocol names, and technical docs stay Buzz until a later
  technical-rename phase.
- **Approach:** port-and-swap. Keep the existing animation architecture and
  swap the brand inside it. Fresh design only for the marketing site.
- **Platforms:** desktop app + marketing site. Mobile and the web
  repo-browser client follow in a later phase, copying from `docs/BRAND.md`.

## Brand Identity

- **Mark:** geometric minimal ant. Single-silhouette SVG rendered in
  `currentColor` (same theming contract as `BuzzMark`). Three-circle body
  (head, thorax, abdomen), six legs, two antennae. Must stay legible at
  16px and scale to hero size. Static mark plus animated variant.
- **Palette:** violet-led vivid, dark surfaces unchanged:
  - Primary: `hsl(258 90% 66%)` (violet)
  - Accents: blue `hsl(217 91% 60%)`, pink `hsl(330 81% 60%)`,
    amber `hsl(38 92% 50%)`, green `hsl(160 60% 45%)`
  - Landing ants render across these five hues (replacing white/yellow bees).
- **Motion primitives** (all CSS-only, compositor-safe HTML layers, exactly
  the technique documented in `FlappingBee.tsx`):
  1. **Walking ant:** leg-gait loop for boot/loading states.
  2. **Pheromone trails:** animated dotted paths connecting points, used to
     express agents coordinating.
  3. **Scatter field:** fixed-position multi-color ants as a landing
     backdrop (no per-render shimmer, same fixed-scatter pattern as
     `LandingBees`).
- Reduced motion always falls back to the static mark via the existing CSS
  media-query pattern.

## In-App Surfaces (Desktop)

Component swap map. `desktop/src/shared/ui/buzz-logo/` becomes
`desktop/src/shared/ui/colony-logo/`:

| Current | New | Notes |
|---|---|---|
| `BuzzMark.tsx` | `AntMark.tsx` | Static silhouette, `currentColor` |
| `FlappingBee.tsx` | `WalkingAnt.tsx` | Same HTML-layer compositor technique; legs animate instead of wings |
| `FuzzyLogo.tsx` | `ColonyWordmark.tsx` | Port the existing effect onto the new mark |
| `BuzzLogoAnimation.tsx` + `buzz-logo-animation.css` | `ColonyLogoAnimation.tsx` + `colony-logo-animation.css` | Boot gate animation |
| `LandingBees.tsx` (onboarding) | `LandingAnts.tsx` | Same fixed-scatter pattern, five-hue palette |

Consumers updated in place: `App.tsx` boot gate, `OnboardingChrome`,
`SetupStep`, `PendingInviteGate`, `RuntimeIcon`, `TurnLivenessIndicator`,
`AgentSessionTranscriptList`, `HostedCommunityOnboarding`.

- **Strings:** sweep the ~385 "Buzz" references in `desktop/src`; change
  user-visible copy only (window title, settings panels, feedback dialog,
  onboarding copy, update checker). `BUZZ_*` env vars, protocol names, and
  internal identifiers are untouched.
- **Icons:** regenerate the full set from `AntMark`: `icon.icns`, all PNG
  sizes, `dmg-background.png`, source PNG. `productName: "Colony"` in
  `tauri.conf.json` (drives macOS menu bar and window chrome).
- **Bundle identifier stays** `xyz.block.buzz.app` this phase. Changing it
  wipes local app data and keyring entries on installed machines. It is not
  user-visible; it renames in the technical phase.

## Marketing Site

- **Location:** new `site/` directory at repo root (sibling of `web/` and
  `admin-web/`). Vite + React + Tailwind, Biome, wired into the pnpm
  workspace.
- **Pages:** single-page landing with sections: hero (AntMark, headline,
  scatter-field backdrop, download CTA), product story (chat + agents +
  workflows connected by a pheromone-trail animation), feature grid
  (channels, agent teams, workflows, canvas, git), download (macOS DMG from
  the owned-desktop build), footer.
- **Design:** fresh design pass, not a port. Vivid multi-hue on dark;
  motion primitives from Brand Identity are the visual signature. Reduced
  motion and mobile responsive.
- **Hosting:** Cloudflare Pages behind `colony.ainative.ventures` (CNAME in
  the ainative.ventures zone). Static output, no server. Deploy via
  wrangler CLI; CI hookup later.
- **Meta:** OG image and favicon set generated from AntMark; proper title
  and description.

## Docs Sweep

- **README.md:** rebrand the top section: Colony name, mark, product
  description, site link. Technical setup content stays accurate. One line
  notes the Buzz lineage ("built on Buzz") for honest attribution.
- **Consumer copy in repo:** CHANGELOG headers going forward, update-checker
  copy, feedback dialog, welcome and onboarding guide text.
- **New:** `docs/BRAND.md`: palette tokens, mark usage, motion primitives,
  do/don't. Single source of truth for the later mobile and web rebrands.
- **Untouched:** AGENTS.md/CLAUDE.md, CONTRIBUTING.md, ARCHITECTURE.md,
  TESTING.md, RELEASING.md, NOSTR.md. They describe internals still named
  Buzz and rename in the technical phase.

## Out of Scope

- Mobile app and web repo-browser client rebrand.
- Crate, env var, CLI, event-kind, or protocol renames.
- Bundle identifier change.
- Builderlab removal or hosted-community changes (separate active
  workstream on `codex/chat-native-blocks-plan`).
- Marketing site CI/CD automation (manual wrangler deploys this phase).

## Verification

Gates, in order:

1. `just ci` passes (includes the px-text guard for any new components).
2. Playwright e2e smoke passes; any specs asserting "Buzz" strings are
   updated.
3. Visual proof: `just desktop-screenshot` set covering landing/onboarding,
   boot loading gate, agent liveness indicator, and settings. Screenshots
   must be hash-distinct and are posted for owner review.
4. Animation proof: walking-ant gait recorded as a GIF from the real app
   (`just desktop-standalone`), since compositor behavior does not show in
   static screenshots. Reduced motion verified both ways.
5. Site: local build plus a Cloudflare Pages preview URL reviewed by the
   owner before DNS cutover.
6. DNS cutover to colony.ainative.ventures only after preview approval.

## Execution Mechanics

- **Branch:** dedicated worktree `colony-rebrand` off `main`. Never touch
  `codex/chat-native-blocks-plan`.
- **Conflict posture:** known overlap on onboarding files (for example
  `HostedCommunityOnboarding.tsx`, also touched by the owned-relay
  workstream). Consumer-string changes are low-conflict; rebase and resolve
  when the branches meet.
- **Commits:** `git commit -s` (DCO), conventional prefixes, one commit per
  surface (mark components, landing, loading, strings, icons, site, docs).

## Risks

- **Codex branch collision:** both branches edit desktop onboarding.
  Mitigation: small scoped commits, rebase before PR.
- **Icon regeneration quality:** a 16px ant is harder to read than a 16px
  bee. Mitigation: simplify the silhouette at small sizes (dedicated
  small-size variant if needed).
- **E2E assertions on "Buzz" strings:** sweep test specs in the same commit
  as the string change so smoke stays green.

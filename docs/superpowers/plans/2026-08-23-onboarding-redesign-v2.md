# Onboarding redesign v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the eleven onboarding screens against an approved visual direction. The flow works; it looks like every other SaaS onboarding and the owner rejected it on sight.

**The reference is `docs/design/onboarding-redesign-reference.html`.** Open it in a browser before writing anything. It is a working, clickable prototype of the approved direction, and it is the authority on look, motion and copy register. Where this plan and the reference disagree, the reference wins.

**What is NOT changing:** the screen order, the flow logic, the contracts, the services. Screens keep their responsibilities. This is a visual and copy rebuild, not a behaviour change.

## Global Constraints

- **Read the reference file first.** Everything below assumes you have seen it move.
- **rem only, never px, for any text size.** The app implements Cmd +/- zoom by scaling the root font-size, so px text freezes against zoom. `pnpm check:px-text` fails the build on arbitrary literals, px or rem. Use the named tokens.
- **No em dashes anywhere**, including comments and commit messages.
- **No developer jargon in any user-visible string.** Never key, nsec, pubkey, encrypt, relay, token, terminal, community, identity. Never "your Mac"; say "your computer".
- **Animate wrapper elements, never SVG children.** WebKit paints animated SVG children on the main thread and stutters. Every ant in the reference moves by transforming a wrapping div.
- **Every animation needs a `prefers-reduced-motion: reduce` fallback** to a static state. This is a brand rule, not polish.
- **Never run `just ci`**, no full Playwright project runs. Scope to the spec file you changed. Build with `CARGO_TARGET_DIR=/Users/mac/.cargo-shared-target/colony` if you touch Rust (you should not).
- Verify with `pnpm check`, `pnpm typecheck`, and single test files via `node --import ./test-loader.mjs --experimental-strip-types --test <path>`.
- **`git commit -s`.**

---

### Task 1: The field

The surface everything else sits on. Dark, warm from one corner, grained.

**Files:**
- Modify: `desktop/src/features/onboarding/ui/new/canvasTheme.ts`
- Modify: `desktop/src/features/onboarding/ui/new/onboarding-canvas.css`
- Modify: `desktop/src/features/onboarding/ui/new/canvasTheme.test.mjs`

`canvasTheme.ts` already models `base`, `ink: "dark" | "light"` and per-step mesh blobs, so this is a values change plus a grain layer, not a restructure.

Requirements:
- Base becomes the deep indigo ink from the reference, never black. `oklch(0.14 0.028 285)`.
- `ink` becomes `"light"` for every step: light text on a dark field.
- Mesh blobs become the two radial warmths from the reference: violet from the lower left, blue from the upper right, both low chroma and large.
- Add the grain layer: a 0.5rem dotted radial at very low opacity. It stops the gradient banding that large soft radials produce on cheap panels.
- **The step-to-step mesh shift stays.** Each screen already gets its own blob positions, and that slow drift between screens is what makes the field feel alive rather than static. Keep it, retune the values.

- [ ] Steps: update the theme test first to assert the new base and `ink: "light"` for a sample of steps, watch it fail, change the values, watch it pass, commit.

---

### Task 2: Screen chrome

Typography, fields, buttons, choice cards, chips. The parts every screen shares.

**Files:**
- Modify: `desktop/src/features/onboarding/ui/new/onboarding-screens.css`

Take these from the reference verbatim in feel, translated to the repo's token system:

| Element | What the reference does |
|---|---|
| Heading | ~3rem, tracking `-0.03em`, weight 620, max 18ch, one word in violet |
| Eyebrow | 0.6875rem, uppercase, 0.14em tracking, violet |
| Lede | 1.0625rem, dim, max 46ch |
| Input | translucent white fill, 1px border, violet ring on focus |
| Primary button | violet, dark ink text, lifts 1px on hover, violet glow |
| Choice card | three-column grid, slides 2px right on hover, violet border when chosen |
| Chip | same treatment, smaller |

Two things that are not decoration:

1. **The focus ring is 0.22rem of violet at 16% opacity.** Focus has to be obvious for someone tabbing through, and this is the only strong colour on the screen.
2. **Maximum widths are in `ch`, not rem.** 18ch for headings and 46ch for lede keeps line length right at any zoom level, which rem does not.

`screenStyles.test.mjs` asserts every className used by a screen has a rule. Keep it passing; it is what stops a class silently doing nothing.

- [ ] Steps: failing test, run, implement, run, `pnpm check`, commit.

---

### Task 3: Motion

**Files:**
- Modify: `desktop/src/features/onboarding/ui/new/WalkingAnt.tsx`
- Modify: `desktop/src/features/onboarding/ui/new/OnboardingCanvas.tsx`
- Modify: `desktop/src/features/onboarding/ui/new/onboarding-canvas.css`

Three primitives, all in the reference:

1. **Scatter field.** Around 26 ants drifting on a 20 to 36 second loop, each with a random delay so they never sync. Opacity 0.10 to 0.26. Colours cycle the five brand hues. **Each ant's leg animation gets its own negative delay**, otherwise the whole colony steps in lockstep and reads as a repeating texture rather than life.
2. **The button walker.** An ant crosses the primary button on hover, 1.15s linear, fading in and out at the edges.
3. **The marching column.** On the working screen, one ant marches a dashed pheromone path. The dash offset animates; the path itself does not.

The gait is the existing 0.42s alternating tripod. Do not redraw the ant: `WalkingAnt.tsx` already has the mark and the gait, and `docs/BRAND.md` is the authority on it.

**Performance floor:** the scatter field must not cost more than a few percent CPU idle. If it does, cut the count rather than the motion. This machine has been at load 170 today and a background animation that burns CPU during onboarding is worse than no animation.

- [ ] Steps: failing test where testable, implement, verify by eye against the reference, commit.

---

### Task 4: Copy

**Files:**
- Modify: all eleven screens under `desktop/src/features/onboarding/ui/new/screens/`

The register shift is the point. Current copy still explains software; the reference talks about the user's business.

| Screen | Now | Direction |
|---|---|---|
| Account | "Welcome to the colony." | "Let's get your colony started." |
| Recovery | "Keep this code somewhere safe." | "Your way back in." |
| Company | "Now, your company." | keep, it is already plain |
| Probing | "Getting things ready." | "Building your workspace." |
| Brain | "You are already set up." | "Pick who does the thinking." |
| Credits | credits, top up, balance | "Put something in the tin." |

Rules:
- One word per heading may be violet. Choose the word carrying the meaning, not the first noun.
- Never explain a mechanism the user did not ask about.
- Failure copy stays identical across causes: "We couldn't reach that site." A user does not care whether a bot wall or DNS stopped us.

**This breaks `tests/e2e/onboarding-redesign.spec.ts`**, which asserts exact headings. Update it in the same commit. A copy change that leaves the spec asserting old strings is how a green suite starts testing nothing.

- [ ] Steps: change copy and spec together, run that one spec file, commit.

---

### Task 5: Prove it

**Files:**
- Modify: `desktop/tests/e2e/onboarding-redesign.spec.ts`
- Create: screenshots

Run the tour spec at `desktop/tests/e2e/onboarding-tour.spec.ts` (already registered in the smoke project) to capture every screen, then post them with `scripts/post-screenshots.sh`.

**Do not link images any other way.** Relay media URLs fail through GitHub's camo proxy, and a hand-linked image renders broken.

Before posting, check the hashes are distinct:

```bash
shasum -a 256 test-results/onboarding-tour/*.png
```

Identical hashes mean two shots captured the same state, which is the most common screenshot regression here.

- [ ] Steps: run the tour, verify hashes differ, post, open a PR against develop, arm auto-merge.

---

## Self-Review

**What this plan deliberately does not do:** change the flow, the contracts, or the services. If a task tempts you to alter behaviour to make something look better, stop and say so.

**The risk worth naming:** dark onboarding leads into a light app. That transition is unhandled in this plan and may feel abrupt. It is a deliberate threshold moment, before you are inside, but if it reads as a bug rather than a doorway then the app's first frame after onboarding needs a fade. Judge it once the screens exist.

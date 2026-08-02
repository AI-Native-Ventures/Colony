# Colony Starter-Team Abstract Entities

**Status:** Design approved in conversation on 2026-08-02; written-spec review pending.

## Purpose

Replace the three animated bee characters used during Colony onboarding with an original abstract entity family. A literal ant replacement was rejected because antennae, wings, eyes, and a torso preserved the bee silhouette too strongly. The new artwork must break from insects and conventional mascots while keeping the three starter-team roles warm, distinctive, and legible at small UI sizes.

The approved direction is a hybrid family named **Colony Matter**:

- Scout uses the orbital-form language.
- Forager uses the modular-glyph language.
- Tender uses the signal-cocoon language.

Their different structures communicate their roles. Shared material, light, scale, and motion rules make them one family.

## Shared Visual Language

Each entity is a floating, face-free 3D object built around a softly luminous core. Materials combine translucent glass with soft-touch resin or ceramic. Surfaces are pristine but tactile, with restrained variation rather than plasticine fingerprints. Lighting is soft studio illumination with a controlled rim highlight and internal glow.

The entities must not contain or imply:

- faces, paired eyes, mouths, noses, or facial expressions;
- heads, torsos, arms, legs, boots, or humanoid anatomy;
- wings, antennae, insect segmentation, bees, or ants;
- conventional robot parts;
- embedded text, role labels, logos, props, platforms, or ground shadows.

Personality comes from silhouette, balance, material, and motion. Every entity stays centred and reads clearly at its native onboarding size. Complexity must collapse into one strong silhouette rather than a cloud of small details.

## Character Designs

### Scout — Violet Orbital

Scout is a confident violet core crossed by one thin, tilted orbital ring and accompanied by one small satellite bead. The orbit establishes direction and leadership without resembling wings or antennae. The core should feel precise and composed, with a slightly forward tilt rather than a perfectly static sphere.

- Canonical midtone: Colony violet `#895AF6`.
- Allowed supporting tones: lighter lavender highlights and deep violet shadow.
- Element budget: one core, one ring, one satellite; no additional debris.
- Silhouette: round and directional, with the ring contained inside the canvas margin.

### Forager — Amber Modular Cluster

Forager is a compact amber assembly of rounded primitives gathered around a luminous torus core. Modules should look magnetically coordinated, not randomly scattered. The form is denser and busier than Scout, expressing collection, practical work, and reorganisation.

- Canonical midtone: Colony amber `#F59E0B`.
- Allowed supporting tones: warm gold highlights and burnt-amber shadow.
- Element budget: one torus core plus four to six rounded modules.
- Silhouette: compact and stable; all modules remain close enough to read as one entity.

### Tender — Green Signal Cocoon

Tender is a soft green, double-lobed cocoon protecting a luminous inner core. One translucent membrane wraps the form and carries a curved signal seam. The seam must be diagonal or circumferential so it cannot read as an eye or mouth. The object should feel calm, sheltering, and gently alive.

- Canonical midtone: Colony green `#2EB88A`.
- Allowed supporting tones: mint highlights and deep green shadow.
- Element budget: one outer cocoon, one inner glow, and one membrane with a wrapping seam.
- Silhouette: soft and enclosed, with no protrusions that suggest limbs or antennae.

## Motion Design

All three assets use a seamless four-second idle loop. Motion is subtle enough for onboarding and returns to the first pose without a visible jump.

### Shared motion rules

- Exactly 40 frames over 4.00 seconds at 10 fps.
- Infinite loop.
- Frame 40 is pixel-identical to frame 1.
- The optical centre remains stable; no large translation, spin, or scale change.
- Internal light can breathe within a narrow luminance range.

### Character motion

- **Scout:** the ring rotates through a small arc while the satellite advances subtly; the core emits one restrained pulse. The complete orbit is not shown, preventing busy motion.
- **Forager:** modules drift inward and outward by a few pixels as if gathering, then settle back into the exact opening arrangement. The cluster never breaks apart.
- **Tender:** the cocoon gently expands and relaxes while its membrane seam carries a slow light pulse. The motion should feel protective rather than sleepy or facial.

## Output Contract

Produce three animated APNG files at these exact paths and dimensions:

| File | Width | Height |
|---|---:|---:|
| `desktop/public/onboarding/starter-team/scout.png` | 160 | 185 |
| `desktop/public/onboarding/starter-team/forager.png` | 160 | 187 |
| `desktop/public/onboarding/starter-team/tender.png` | 160 | 188 |

Each file must satisfy:

- PNG format with APNG animation chunks;
- 40 decoded frames;
- 4.00-second total duration;
- 10 fps;
- infinite looping;
- real alpha transparency;
- no baked backdrop, checkerboard, floor, or ground shadow;
- file size no greater than 1.2 MB;
- a small, consistent clear margin on every side.

The existing `fizz.png`, `honey.png`, and `bumble.png` bee files remain in place. The consumer files remain unchanged until the new art passes review:

- `desktop/src/features/onboarding/ui/WelcomeKickoffStage.tsx`
- `desktop/src/features/onboarding/ui/CommunityOnboardingFlow.tsx`

## Production Method

Generate one high-resolution master and one restrained motion key pose for each entity. Preserve identity between key poses. Extract or generate true alpha before animation assembly, colour-align saturated material pixels to the canonical Colony hue, animate at elevated resolution, and reduce with premultiplied alpha to avoid light or dark edge fringes.

APNG assembly may use deterministic transforms for bounded ring, module, seam, pulse, and breathing motion. Final compression may reduce colour precision only when native-size comparison shows no visible degradation.

## Acceptance Gate

### Visual proof

- Native-size open and motion-extreme frames are inspected on both light and near-black backgrounds.
- No entity reads as a bee, ant, insect, humanoid, or face.
- Scout, Forager, and Tender remain distinguishable without labels.
- The three assets share material response, lighting direction, glow treatment, and visual weight.
- Thin rings, seams, gaps, and small modules remain legible at native dimensions.
- Animation is inspected through at least two complete loops with no visible seam.

### Technical proof

- An APNG-aware decoder reports the exact width, height, RGBA pixel format, 40 frames, and 10 fps for each file.
- APNG control chunks report infinite playback and 4.00 seconds total duration.
- Transparent corners decode to alpha zero, and the foreground retains fully opaque pixels.
- The decoded final and opening frames satisfy the approved loop-closure rule.
- Each file is no greater than 1.2 MB.
- `git diff` confirms that only the three new assets are added during implementation; bee assets and consumers are untouched.

## Rejection Criteria

Reject a render or loop if any of the following is true:

- it introduces eyes, a mouth-like seam, limbs, wings, antennae, or insect anatomy;
- it relies on a black-and-yellow bee palette or honey imagery;
- its background is opaque or contains a checkerboard preview;
- the three entities look like unrelated assets rather than one material family;
- motion causes clipping, centre drift, a visible loop jump, or unreadable detail;
- a technical metadata check passes while native-size visual proof fails.

## Non-Goals

- Repointing onboarding code to the new filenames.
- Removing the old bee files.
- Changing onboarding layout, copy, role names, or animation consumers.
- Reproducing the geometric `AntMark` logo.
- Adding a general-purpose procedural avatar system.

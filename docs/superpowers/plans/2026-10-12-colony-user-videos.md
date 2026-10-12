# Colony User Videos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two 1920 x 1080 videos for people becoming Colony users: "Start here" (about 2:40, the real sign-up through the first job) and "What your AI team can and can't do" (about 60 s), built from real app screens.

**Architecture:** A Playwright capture script drives the desktop app in its e2e mock mode (the same harness the onboarding, Welcome and first-job specs use) with Bright Plumbing sample data, asserts each screen's heading, and writes sharp screenshots plus the boxes of every element the video points at into `video/public/user/`. Two Remotion compositions load that manifest through `calculateMetadata`, frame each shot in an app window on the brand gradient, ease a camera to the right box, move a pointer to the real button, and play an Aoede voice line per beat with the existing wide subtitles and ducked music.

**Tech Stack:** Playwright with `installMockBridge`, Remotion 4.0.522, React 19, TypeScript, `node --test`, Gemini TTS (Aoede), ffmpeg.

**Spec:** `docs/superpowers/specs/2026-10-12-colony-user-videos-design.html` (approved 2026-10-12; phone calls left out).

## Global Constraints

- Screens and words come from the app people download (`main`). Before capturing, `git diff origin/main origin/develop -- <screen files>` must be empty for every screen used; if not, stop and ask.
- No promises: show the work, never results; no "free"; no phone calls; no prices in the voice.
- Every video 2 line keeps its proof (file and line on `main`) in `video/src/user/canCant.ts`.
- Voice: Aoede, one read per video, cut at pauses, every cut transcribed and matched; loudness -16 LUFS on the master.
- 1920 x 1080, 30 fps. No em dashes in any string, caption or doc.
- The capture runs on demand only: never registered in CI projects. Screenshots are generated, not committed.

## Review Focus

1. A screen's words change in the app: the capture must fail on the heading check, not ship a stale shot (Task 2 asserts every heading before each shot).
2. Leftover test names (Horizon, Tyler) appearing on screen instead of Bright Plumbing (Task 2 asserts they are absent before each shot).
3. Small app text too small to read at 1080p (Task 3 test: every reading beat zooms so 14 px app text renders at 18 px or more).
4. The pointer clicking beside the real button (Task 3 test: the pointer's click point lies inside the target box).
5. Captions covering what the voice talks about (Task 3 test: each beat's target box, after the camera, stays above the caption band).

---

### Task 1: Website read in test mode

**Files:**
- Create: `desktop/src/testing/e2eBridgeWebsiteScan.ts`, `desktop/src/testing/e2eBridgeWebsiteScan.test.mjs`
- Modify: `desktop/src/testing/e2eBridge.ts` (config field and one `case`), `desktop/tests/helpers/bridge.ts` (`MockBridgeOptions.companyWebsiteScan`)

**Interfaces:**
- Produces: mock option `companyWebsiteScan?: { status: "success"; result: RawCompanyScan } | { status: "invalid" | "failed" | "timeout"; message: string }`; `websiteScanResponse(config, command)` returns it, or throws `Unsupported mocked Tauri command: scan_onboarding_company_website` when unset (today's behaviour).

- [ ] Step 1: test (`node --test`): unset option throws the unsupported-command error; a success fixture comes back unchanged.
- [ ] Step 2: run it, watch it fail (module missing).
- [ ] Step 3: implement the module; in `e2eBridge.ts` add `case "scan_onboarding_company_website": return websiteScanResponse(activeConfig?.mock, command);` and the config field; add the option to `MockBridgeOptions`.
- [ ] Step 4: run the test and `pnpm typecheck` in `desktop/`; both pass.
- [ ] Step 5: commit `test(desktop): website read fixture for the e2e bridge`.

### Task 2: Capture script

**Files:**
- Create: `desktop/tests/video/playwright.video.config.ts`, `desktop/tests/video/userVideos.capture.ts`, `desktop/tests/video/brightPlumbing.ts` (sample owner, business, website read, first-job brief)
- Modify: `desktop/package.json` (script `capture:user-videos`)

**Interfaces:**
- Consumes: `installMockBridge`, `seedActiveIdentity`, `createFounderAccount`, `continueFounderBusiness`, `waitForAnimations`, the first-job and Welcome setups (copied from `first-job-handoff.spec.ts` and `scout-channel-onboarding.spec.ts`), `companyWebsiteScan` from Task 1.
- Produces: `video/public/user/<shotId>.png` (1440 x 900 viewport, device scale 2) and `video/public/user/manifest.json`: `{ capturedAt, appCommit, shots: Record<ShotId, { file, width, height, boxes: Record<string, {x,y,w,h}> }> }` with boxes in CSS pixels.
- Shot ids: `account`, `recovery`, `business-empty`, `business-read`, `power-credits`, `power-subscriptions`, `power-replied`, `history`, `welcome-routes`, `welcome-confirm`, `welcome-priority`, `understanding`, `setup`, `first-job`, `first-job-started`, `job-thread`, `outreach-card`, `outreach-sent`, `find-clients`, `history-review`.

- [ ] Step 1: four scenes, each a Playwright test: sign-up (account to history), Welcome (routes to setup approval), first job (suggestion to "In progress"), work and trust shots (thread, outreach card approve to sent, find clients card, history review). Before each shot: assert the screen's heading or label text, assert no "Horizon" or "Tyler" text, `waitForAnimations`, then screenshot and record boxes by role and name.
- [ ] Step 2: run `pnpm build:e2e` then `pnpm capture:user-videos` (kill port 4173 first if a stale server answers). Expected: 20 PNGs and a manifest with 20 shots.
- [ ] Step 3: open a contact sheet of the 20 shots and check each by eye against the spec's table; fix seeds until every shot shows Bright Plumbing.
- [ ] Step 4: confirm the three "confirm" rows of the spec (outreach card on main, the job thread, Scout's tier). Any row that fails is dropped from video 2 and ledgered.
- [ ] Step 5: commit `test(desktop): capture script for the user videos`.

### Task 3: Shots, camera and beat data

**Files:**
- Create: `video/src/user/manifest.ts` (types, `loadManifest` for `calculateMetadata`), `video/src/user/camera.ts` (`frameFor(box, window)`, `cameraAt(t, keys)`), `video/src/user/startHere.ts` (beats), `video/src/user/canCant.ts` (claims with proof), tests beside each.
- Modify: `video/package.json` test glob adds `src/user/*.test.ts`.

**Interfaces:**
- Produces: `type Beat = { id; shot: ShotId; target?: string; click?: string; zoom: number; voice: string; from: number; to: number }`; `START_HERE: readonly Beat[]`; `type Claim = { kind: "can" | "cant"; line: string; shot: ShotId; target: string; proof: string }`; `CAN_CANT: readonly Claim[]`; `cameraAt(t, keys) -> { x; y; scale }`.

- [ ] Step 1: tests: beats in order without gaps over 0.4 s; every reading beat's zoom makes 14 px app text at least 18 px in the frame; a click point lies inside its target box (fixture manifest in the test); the target box stays above the caption band after the camera; every claim has a non-empty proof; no string contains an em dash, "free", "call" or a currency.
- [ ] Step 2: run, watch them fail.
- [ ] Step 3: implement data and math from the spec's tables.
- [ ] Step 4: `npm test`, `npx tsc --noEmit -p .`, `npx biome check src`: all pass.
- [ ] Step 5: commit `video(user): shots, camera and beats for the user videos`.

### Task 4: Voice

**Files:**
- Create: `video/scripts/tts-gemini.mjs` (one read to 24 kHz PCM via `GEMINI_API_KEY`, never printed), `video/public/user/vo-*.mp3`, `video/public/user/SOURCES.md`
- Modify: `video/src/user/startHere.ts`, `video/src/user/canCant.ts` (cut and spoken seconds per line)

- [ ] Step 1: one read per video from the beat texts (no style instructions in the text: Gemini reads them aloud).
- [ ] Step 2: normalise to -16 LUFS, find pauses with `silencedetect`, cut one file per line, transcribe each cut and compare words; re-read any line that does not match.
- [ ] Step 3: put cut and spoken seconds into the data; Task 3's tests still pass with the real durations (beats stretch to fit the voice, never the other way).
- [ ] Step 4: commit `video(user): Aoede voice for the user videos`.

### Task 5: "Start here" composition

**Files:**
- Create: `video/src/user/AppWindow.tsx`, `video/src/user/Shot.tsx`, `video/src/user/StartHere.tsx`, `video/src/user/UserSound.tsx`
- Modify: `video/src/Root.tsx` (`StartHere`, 1920 x 1080, 30 fps, duration from the data, `calculateMetadata` loads the manifest)

- [ ] Step 1: title card, then each beat: the shot in a clean window on the brand gradient, camera to its target, pointer (`launch/app/Cursor`) to its click with the click sound, a soft ring on the target, `Subtitles` with the beat's line; music B looped and ducked under the voice; end card with colony.global.
- [ ] Step 2: stills at every beat's midpoint; check by eye: text readable, pointer on the button, nothing under the captions.
- [ ] Step 3: commit `video(user): Start here`.

### Task 6: "Can and can't do" composition

**Files:**
- Create: `video/src/user/CanCant.tsx`
- Modify: `video/src/Root.tsx` (`CanCant`)

- [ ] Step 1: brand gradient, the line in big type beside a crop of its real screen (from the manifest), "Can" lines then "Can't" lines, close line and end card; lines already on screen get no subtitle.
- [ ] Step 2: stills at every claim; check by eye.
- [ ] Step 3: commit `video(user): can and can't do`.

### Task 7: Deliver

- [ ] Step 1: render both, master to -16 LUFS; gates: size 1920 x 1080, duration, loudness and true peak, darkest frame, three frames rendered twice identical, voice PCM of each cut unchanged in the render.
- [ ] Step 2: watch page with both videos (720p web copies under 15 MB each), Desktop copies numbered 41 and 42, open the page.
- [ ] Step 3: PR into develop (desktop test infra, capture script, video), auto-merge armed, PR bound; owner watches before anything ships.

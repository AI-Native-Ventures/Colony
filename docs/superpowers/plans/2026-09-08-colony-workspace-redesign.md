# Colony Workspace Redesign Implementation Plan

> For agentic workers: execute the owned slices below through the existing collaboration tools; the parent reviews each slice and integrates the rendered proof. The user has explicitly authorized implementation and autonomous PR delivery.

**Goal:** Implement the approved Colony workspace style while preserving channel/thread behaviour and making agent identity readable and consistent.

**Architecture:** Extend the existing theme and Blocks rendering surfaces, not the navigation or event model. One selected accent supplies coordinated chrome and conversation tokens; one gradient-pattern preference uses the existing community appearance record. Agent presentation reuses persisted persona roles and avatars, with a stable identity-based colour fallback.

**Tech Stack:** React 19, TypeScript, Tailwind rem tokens, existing ThemeProvider, native Electron/Core bridge, Node tests and Playwright mock-bridge application tests.

## Current execution state

The initial PR #655 visual gate failed: its screenshots retained the old shell
with colour changes. The previous claim of visual acceptance is superseded and
auto-merge was disabled. Tasks 1–3 are implemented in source, with the structural
correction below. The corrected palette/selection build passed 29 relevant browser
checks and coordinating-agent visual comparison. The final port 4199 artifact
passed 12 combined focused checks with fresh screenshots, following the four
Appearance and pane-geometry checks. CI completion, merge and beta availability
are not established.
See [the proof ledger](../reports/2026-09-08-colony-redesign-proof.md).

## Scope and ownership

The approved reference is `docs/superpowers/specs/2026-09-08-colony-workspace-visual-direction.md` and the local `colony-visual-style.html` preview. Its default desktop layout is sidebar, channel, and an optional thread on the right. Preserve native resizing, split/focus preferences, draft storage, accessible actions and community boundaries. New social workflows or bespoke social cards are outside this redesign.

Theme/shell worker owns ThemeProvider/helper, community appearance persistence,
Settings controls, workspace CSS, brand/workspace sidebar, existing More grouping,
`AppTopChrome`, separate frame markers and existing pane/sidebar width defaults.
Parent owns message/DM identity, role editing, conversation rhythm and generic
long-text expansion, package/dependency coordination, integration screenshots
and PR delivery. The scroll worker owns the timeline correction; onboarding has
its separate plan. These boundaries describe the implemented correction, not an
additional product model.

## Task 1: Accent and gradient preferences

Files:
- Add `desktop/src/shared/theme/workspaceAppearance.ts` and `.test.mjs`.
- Modify `desktop/src/shared/theme/ThemeProvider.tsx`.
- Modify `desktop/src/shared/theme/communityThemePreference.ts`, `CommunityThemeController.tsx` and the existing preference/sync tests.

- [x] Define a closed pattern union and backwards-compatible default:

```ts
export type WorkspaceGradientPattern = "soft-mesh" | "diagonal-wash" | "halo";
export function parseWorkspaceGradientPattern(value: unknown): WorkspaceGradientPattern {
  return value === "diagonal-wash" || value === "halo" ? value : "soft-mesh";
}
```

- [x] Extend the existing community appearance value with the pattern. Old records default to `soft-mesh`; preserve their accent, theme, glass and system preferences. Compare and apply the pattern through the same existing sync path.
- [x] Derive readable light/dark content, raised/composer and border tokens from the existing selected accent. Reuse the existing colour-conversion functions and contrast pairing. Explicit Neutral remains neutral. Non-Colony themes keep their current surfaces.
- [x] Expose the pattern through ThemeProvider and apply one root data attribute; do not create separate channel and thread preferences or duplicate the accent store.
- [x] Add failing tests for old-record defaults, pattern round trips, community separation and distinct derived palette values, then implement and run those tests. Do not add snapshot tests that only reproduce implementation constants.

## Task 2: Render the approved surfaces and controls

Files:
- Modify `desktop/src/app/BuzzThemeSurfaces.tsx`.
- Add `desktop/src/app/WorkspaceAnts.tsx`, rendered in the sidebar footer.
- Modify `desktop/src/shared/styles/globals/buzz-sidebar.css`; extract `workspace-appearance.css` if it improves clarity.
- Modify `desktop/src/features/settings/ui/SettingsPanels.tsx`; add `WorkspacePatternSetting.tsx` beside it.
- Bundle Inter Tight through the existing frontend entry; scope workspace font
  changes to Colony themes and preserve code monospace and text zoom.
- Modify `AppTopChrome.tsx`, `AppSidebar.tsx`, `AppSidebarPinnedHeader.tsx`, the
  existing More menu, `SidebarWorkspaceHeader.tsx` and `CommunitySwitcher.tsx`.
- Reuse `shared/ui/sidebar.tsx`, `useThreadPanelWidth.ts`, `ChannelScreen.tsx`,
  `ChannelPane.tsx` and `FocusThreadDrawer.tsx` for sizing and frame markers.

- [x] Paint coordinated multicolour gradients in the existing frame/sidebar and opaque tinted reading surfaces. The final correction quiets the outer wash and increases the visible reading tint; its final visual gate remains pending. Scope `--background`, borders and composer fades consistently on the shared content surface. Remove the fixed neutral Colony Dark content override.
- [x] Implement the three pattern styles with static CSS gradients. Keep all text colours contrast-paired and preserve user zoom using named rem tokens.
- [x] Add sparse actual `AntMark` decorations behind content, with `aria-hidden`, no pointer events and no animation loop. They must not overlap reading or form text.
- [x] Expose the existing accent picker for Colony themes. Place the three pattern choices inside existing Settings > Appearance with labelled native buttons and selected states. Do not add a global breadcrumb or appearance toolbar.
- [x] Preserve agent/avatar colour tokens independently of the workspace palette. Preserve existing unread, active, muted and working states.
- [x] Keep the current font bundle initially. Match the approved spacing, normal body weight and hierarchy without fetching fonts at runtime or freezing text in pixels. A font-bundle change, if required by rendered comparison, belongs to the parent.


- [x] Put the wordmark and existing workspace switcher in the sidebar, with
  Inbox/Tasks/Agents/Billing and persistent More access to all secondary routes.
  Add a direct Settings action and preserve the existing profile/menu paths.
- [x] Move desktop controls into the sidebar header without losing native window
  clearance, history, sidebar collapse or mobile navigation. Do not paint a
  global empty toolbar over the conversation area.
- [x] Render separately framed channel/thread panes, real context headers and
  inset composers. Use a 240px sidebar default (185–420px bounds). An unsaved
  Colony thread uses 52% of available content; explicit saved widths win, and
  reset restores the responsive default. Preserve the 300px reading minimum,
  add the 12px gutter to the 612px split threshold and drawer maximum, and keep
  the native single-pane/focus fallback. A failing 288px-channel regression at
  860px window width preceded this boundary correction.
- [x] Use quiet raised app-sidebar selection tokens while retaining unread,
  active, prominent-selection and other-theme semantics. This last CSS change
  is implemented; the final combined palette screenshot gate is still open.

## Task 3: Consistent agent identity

Files:
- Add a small presentation helper under `desktop/src/features/agents/` with a focused `.test.mjs`.
- Reuse `desktop/src/features/messages/lib/mentionPersonaLookups.ts`.
- Modify `desktop/src/features/messages/ui/MessageRow.tsx` and an extracted header component if needed.
- Modify `desktop/src/features/sidebar/useDmSidebarMetadata.ts` and `ui/SidebarSection.tsx`.
- Modify the existing agent-definition identity editor through a small component rather than growing the large dialog.

- [x] Resolve the current agent's name, job-role title and avatar from existing persona/agent records. Do not derive a human-facing job title from the worker/leader/executive tier.
- [x] Present name on the first line and a readable secondary job title plus `Agent` marker. Retain owner/access information and profile actions. Human messages must remain distinguishable without relying on colour.
- [x] Carry the same resolved role into single-agent DM rows. Keep group DM labels/counts and human rows intact.
- [x] Preserve configured avatar colours. For missing avatars, derive a colour from stable identity rather than the display name or workspace accent. Do not add a new persisted colour property in this slice.
- [x] Expose the existing role title alongside identity editing; submit the existing role pair without changing rank, manager, runtime, provider or credential semantics.
- [x] Prove role/colour identity survives renaming and accent changes, unknown roles degrade to `Agent`, humans are not mislabelled and DM/header roles agree.

## Task 4: Application proof and delivery

Files:
- Update `desktop/tests/e2e/buzz-theme-screenshots.spec.ts` expectations which currently require the Colony accent picker to be hidden.
- Add a focused redesign screenshot spec under `desktop/tests/e2e/`, registered in `desktop/playwright.config.ts`, using the existing mock bridge and animation helper.
- Existing guards: `thread-focus-mode.spec.ts`, `threadpane-ultrawide.spec.ts`, relevant message and sidebar specs.

- [x] Run scoped Node/TypeScript/Biome checks and relevant browser suites for each implemented slice. Keep isolated proof directories/ports and record which source snapshot each build serves. Final combined checks remain a separate gate below.

```sh
. ./bin/activate-hermit
cd desktop
pnpm typecheck
pnpm check
pnpm test
pnpm build:e2e
pnpm exec playwright test --project=smoke tests/e2e/thread-focus-mode.spec.ts
```

- [x] Capture actual rendered React channel and populated thread together, channel-only after closing, a zero-reply thread, long text, existing generic Blocks, DM roles and Appearance. Exercise draft retention, root continuity, resizing, zoom and keyboard settings controls. Corrected-build and final port 4199 evidence replaces the rejected original screenshots; relay/native/account responses remain synthetic.
- [x] Compare violet, pink and green accents across the three patterns in light/dark, desktop/narrow widths. Inspect screenshots, not just computed styles. The coordinating agent reviewed the corrected composition against the approved reference, and final focused checks include disclosure contrast of at least 4.5:1.
- [ ] Run `just ci` before PR as required. Diagnose any environment failure precisely; do not treat a failed local build as passed. Let required GitHub native/full checks supply their separate proof and never merge with missing, red or pending required checks.
- [ ] Review the corrected final diff and screenshots, update PR #655 against
  `develop`, sign any new commits with `git commit -s`, and publish actual app
  screenshots through `scripts/post-screenshots.sh`. The first visual gate failed,
  so auto-merge remains disabled until the corrected acceptance gate passes;
  only then resume the normal required-check/merge-queue delivery process.
- [ ] Verify actual merge and relevant beta build separately. Do not call a mock-rendered UI packaged or live-proven.

## Acceptance gate

Do not mark this plan complete until the actual final-source app matches the
approved composition, not only its colours; real channel/thread interaction,
settings and stable role identity remain intact; required tests and CI pass;
and the corrected reviewed change is actually merged to `develop`. The initial
PR screenshots failed this gate. Onboarding, installable-beta verification and
release availability remain separately recorded stages.

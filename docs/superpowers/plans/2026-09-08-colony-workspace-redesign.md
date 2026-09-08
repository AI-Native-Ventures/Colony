# Colony Workspace Redesign Implementation Plan

> For agentic workers: execute the owned slices below through the existing collaboration tools; the parent reviews each slice and integrates the rendered proof. The user has explicitly authorized implementation and autonomous PR delivery.

**Goal:** Implement the approved Colony workspace style while preserving channel/thread behaviour and making agent identity readable and consistent.

**Architecture:** Extend the existing theme and Blocks rendering surfaces, not the navigation or event model. One selected accent supplies coordinated chrome and conversation tokens; one gradient-pattern preference uses the existing community appearance record. Agent presentation reuses persisted persona roles and avatars, with a stable identity-based colour fallback.

**Tech Stack:** React 19, TypeScript, Tailwind rem tokens, existing ThemeProvider, native Electron/Core bridge, Node tests and Playwright mock-bridge application tests.

## Scope and ownership

The approved reference is `docs/superpowers/specs/2026-09-08-colony-workspace-visual-direction.md` and the local `colony-visual-style.html` preview. Its default desktop layout is sidebar, channel, and an optional thread on the right. Preserve native resizing, split/focus preferences, draft storage, accessible actions and community boundaries. New social workflows or bespoke social cards are outside this redesign.

Theme worker owns ThemeProvider/helper, community theme preference/controller, Appearance settings, theme/global appearance CSS, `BuzzThemeSurfaces.tsx`, decorative ants and corresponding theme tests. Parent owns shared identity presentation, message/DM role integration, role editor and its tests, package/dependency coordination, packaging repair, integration screenshots and PR delivery. Onboarding is a separate implementation plan and worker.

## Task 1: Accent and gradient preferences

Files:
- Add `desktop/src/shared/theme/workspaceAppearance.ts` and `.test.mjs`.
- Modify `desktop/src/shared/theme/ThemeProvider.tsx`.
- Modify `desktop/src/shared/theme/communityThemePreference.ts`, `CommunityThemeController.tsx` and the existing preference/sync tests.

- [ ] Define a closed pattern union and backwards-compatible default:

```ts
export type WorkspaceGradientPattern = "soft-mesh" | "diagonal-wash" | "halo";
export function parseWorkspaceGradientPattern(value: unknown): WorkspaceGradientPattern {
  return value === "diagonal-wash" || value === "halo" ? value : "soft-mesh";
}
```

- [ ] Extend the existing community appearance value with the pattern. Old records default to `soft-mesh`; preserve their accent, theme, glass and system preferences. Compare and apply the pattern through the same existing sync path.
- [ ] Derive readable light/dark content, raised/composer and border tokens from the existing selected accent. Reuse the existing colour-conversion functions and contrast pairing. Explicit Neutral remains neutral. Non-Colony themes keep their current surfaces.
- [ ] Expose the pattern through ThemeProvider and apply one root data attribute; do not create separate channel and thread preferences or duplicate the accent store.
- [ ] Add failing tests for old-record defaults, pattern round trips, community separation and distinct derived palette values, then implement and run those tests. Do not add snapshot tests that only reproduce implementation constants.

## Task 2: Render the approved surfaces and controls

Files:
- Modify `desktop/src/app/BuzzThemeSurfaces.tsx`.
- Add a small `desktop/src/app/WorkspaceAnts.tsx` if needed.
- Modify `desktop/src/shared/styles/globals/buzz-sidebar.css`; extract `workspace-appearance.css` if it improves clarity.
- Modify `desktop/src/features/settings/ui/SettingsPanels.tsx`; add `WorkspacePatternSetting.tsx` beside it.
- Modify `desktop/src/shared/styles/globals/theme.css` only for coordinated typography.

- [ ] Paint strong accent gradients in the existing frame/sidebar and softer opaque variants in content, channel and thread surfaces. Scope `--background`, borders and composer fades consistently on the shared content surface. Remove the fixed neutral Colony Dark content override.
- [ ] Implement the three pattern styles with static CSS gradients. Keep all text colours contrast-paired and preserve user zoom using named rem tokens.
- [ ] Add sparse actual `AntMark` decorations behind content, with `aria-hidden`, no pointer events and no animation loop. They must not overlap reading or form text.
- [ ] Expose the existing accent picker for Colony themes. Place the three pattern choices inside existing Settings > Appearance with labelled native buttons and selected states. Do not add a global breadcrumb or appearance toolbar.
- [ ] Preserve agent/avatar colour tokens independently of the workspace palette. Preserve existing unread, active, muted and working states.
- [ ] Keep the current font bundle initially. Match the approved spacing, normal body weight and hierarchy without fetching fonts at runtime or freezing text in pixels. A font-bundle change, if required by rendered comparison, belongs to the parent.

## Task 3: Consistent agent identity

Files:
- Add a small presentation helper under `desktop/src/features/agents/` with a focused `.test.mjs`.
- Reuse `desktop/src/features/messages/lib/mentionPersonaLookups.ts`.
- Modify `desktop/src/features/messages/ui/MessageRow.tsx` and an extracted header component if needed.
- Modify `desktop/src/features/sidebar/useDmSidebarMetadata.ts` and `ui/SidebarSection.tsx`.
- Modify the existing agent-definition identity editor through a small component rather than growing the large dialog.

- [ ] Resolve the current agent's name, job-role title and avatar from existing persona/agent records. Do not derive a human-facing job title from the worker/leader/executive tier.
- [ ] Present name on the first line and a readable secondary job title plus `Agent` marker. Retain owner/access information and profile actions. Human messages must remain distinguishable without relying on colour.
- [ ] Carry the same resolved role into single-agent DM rows. Keep group DM labels/counts and human rows intact.
- [ ] Preserve configured avatar colours. For missing avatars, derive a colour from stable identity rather than the display name or workspace accent. Do not add a new persisted colour property in this slice.
- [ ] Expose the existing role title alongside identity editing; submit the existing role pair without changing rank, manager, runtime, provider or credential semantics.
- [ ] Prove role/colour identity survives renaming and accent changes, unknown roles degrade to `Agent`, humans are not mislabelled and DM/header roles agree.

## Task 4: Application proof and delivery

Files:
- Update `desktop/tests/e2e/buzz-theme-screenshots.spec.ts` expectations which currently require the Colony accent picker to be hidden.
- Add a focused redesign screenshot spec under `desktop/tests/e2e/`, registered in `desktop/playwright.config.ts`, using the existing mock bridge and animation helper.
- Existing guards: `thread-focus-mode.spec.ts`, `threadpane-ultrawide.spec.ts`, relevant message and sidebar specs.

- [ ] Run scoped Node tests using the repository test loader and scoped Biome checks while working. Parent coordinates one shared build/server to avoid stale bundles or conflicting E2E builds.

```sh
. ./bin/activate-hermit
cd desktop
pnpm typecheck
pnpm check
pnpm test
pnpm build:e2e
pnpm exec playwright test --project=smoke tests/e2e/thread-focus-mode.spec.ts
```

- [ ] Capture actual rendered React channel and populated thread together, channel-only after closing, a zero-reply thread, long text, existing generic Blocks, DM roles and Appearance. Exercise draft retention, root continuity, resizing, zoom and keyboard settings controls.
- [ ] Compare violet, pink and green accents across the three patterns in light/dark, desktop/narrow widths. Inspect screenshots, not just computed styles. Name mocked relay/native state explicitly.
- [ ] Run `just ci` before PR as required. Diagnose any environment failure precisely; do not treat a failed local build as passed. Let required GitHub native/full checks supply their separate proof and never merge with missing, red or pending required checks.
- [ ] Review the final diff, sign commits with `git commit -s`, open PR(s) against `develop`, attach real application screenshots through `scripts/post-screenshots.sh`, and arm `gh pr merge <number> --repo AI-Native-Ventures/Colony --merge --auto`.
- [ ] Verify actual merge and relevant beta build separately. Do not call a mock-rendered UI packaged or live-proven.

## Acceptance gate

The source app matches the approved visual direction while retaining real channel/thread interaction and settings. Role identity is consistent and stable. Required tests and CI pass, screenshot review is complete, and the reviewed change is merged to `develop`. Onboarding and packaged-beta proof remain separately tracked slices of the overall redesign goal.

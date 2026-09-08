# Colony landing: current app alignment proof

## Reference and scope

Read the new app source at develop `8cbb592eba` (redesign #655 and first-job handoff #660). Visually inspected the corresponding app screenshots, including the final regular Inter/community-rail correction. The landing change is based on main `1b7aad608` and does not promote develop application code.

The new HTML preview follows the real sidebar, shared channel and right-thread layout. Both copies of the selected message include the same source quotes. The sample comparison is inside the thread. Business, people, messages and prices are explicitly examples. Composers are disabled; only thread viewing and quote disclosure are interactive. No task is dispatched and no purchase, approval or completion state is simulated.

## Local browser gate

CUA inspection at `http://127.0.0.1:5179/`:

- 1280px: sidebar and both reading panes render separately with the app's message hierarchy, static ant marks and purple/blue appearance. Computed message text is regular Inter, 14px. No horizontal page overflow.
- 960px: smallest tested split layout keeps channel/thread at 310px/334px; no pane or result-card horizontal overflow.
- 800px: business navigation remains; one reading pane and Back control replace the split view.
- 390px and 320px: one readable pane, no page overflow. At 320px, the result card and reading pane have equal scroll/client widths; source quotes and comparison remain accessible. Body text stays 14px.
- Close restores the full channel and focuses its replies control; Enter reopens the thread. Keyboard End scrolls its named message region to the final content. Mobile Back and reopen both work.
- Both copies of the root include expandable supplier quotes. They contain the exact example inputs used by the comparison.
- Updated getting-started and channels/threads FAQ answers expand correctly.
- Existing early-access form produces a reviewable draft addressed to basheer@ainative.ventures with the synthetic test answers. No email was opened or sent.
- Pause motion changes to Play motion; composers remain disabled. Browser warning/error log is empty.

## Local tooling

`pnpm -C site check`: Biome passes; all three email-builder tests pass.
`pnpm -C site build`: TypeScript and Vite pass.
`git diff --check`: passes.

The full repository CI, protected PR, deployment and public browser gate must be recorded separately; this local evidence does not establish those stages or successful live AI execution.

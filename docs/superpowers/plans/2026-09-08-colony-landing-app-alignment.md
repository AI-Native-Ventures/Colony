# Landing page alignment with the new Colony app

## Acceptance gate

The product preview must match the app UI merged in develop `8cbb592eba` (PRs #655 and #660), use clearly labelled sample content, and explain the workflow to a first-time nontechnical visitor. Preserve the approved ants, multicolour landing gradients, general business positioning, and early-access email-draft form. Do not turn a screenshot into the hero or invent product actions.

## Source contract

- `desktop/src/features/sidebar/ui/{CommunityRail,SidebarWorkspaceHeader,AppSidebarPinnedHeader}.tsx`: community rail, wordmark, business switcher, Inbox, Tasks, Agents, Billing, More, channels and Settings.
- `desktop/src/shared/styles/globals/{workspace-appearance,conversation-appearance}.css`: separate channel and right-thread frames, 12px gaps, 14px corners, flowing messages and structured inline work.
- `desktop/src/shared/theme/workspaceAppearance.ts`: coherent accent-derived gradient frame with opaque tinted reading panes.
- PR #660 restores regular Inter Variable 14px/400 for messages. Agent identities pair a name with job title and Agent label.
- `desktop/src/features/onboarding/ui/new/screens/` and `FirstJobSuggestionView.tsx`: account, recovery code, business description, Welcome setup suggestion, editable brief, explicit Start, staffing and credit checks.
- Visual reference inspected: `/private/tmp/colony-first-job-pr-final-screenshots/01-workspace-font-communities.png`. Reference only; no screenshot embedded or fixture marketing content copied.

## Implementation

1. Replace the editorial conversation illustration with a responsive HTML preview of the actual sidebar/channel/thread layout. Keep the existing sample supplier comparison; repeat the selected root in its thread and present the result inline. App navigation is illustrative, composers are disabled, and opening/closing the sample thread only changes what is displayed.
2. Use the existing Colony wordmark and ant geometry, plus the same regular Inter font with its licence. Keep website decoration separate from the static app preview.
3. Update guide and FAQ to explain account/business setup, shared conversations, job replies, Inbox and Tasks. Distinguish early-access availability from implemented develop behavior. No automatic staffing, spending or completed-job promises.

## Proof and release

- Site checks, type/build gate; desktop and mobile browser rendering, thread open/close and keyboard focus, quote details, no overflow, unchanged early-access form and motion controls.
- Full `just ci`, protected main hotfix PR with all non-skipped checks passing; do not promote application code from develop.
- Verify the deployment's naturally served HTML and assets against the reviewed build, then inspect the public desktop/mobile page and changed interactions. Record local, CI, merge, deploy and public proof separately.

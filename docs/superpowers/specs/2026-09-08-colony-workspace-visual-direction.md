# Colony workspace visual direction

Status: the corrected approved workspace composition merged in
[PR #655](https://github.com/AI-Native-Ventures/Colony/pull/655). Its original
screenshots failed the owner's visual review and are superseded by the corrected
real-app screenshots in
[the verification report](../reports/2026-09-08-colony-redesign-proof.md).
The owner's subsequent regular-font and far-left-community-rail corrections are
merged in
[PR #660](https://github.com/AI-Native-Ventures/Colony/pull/660) at
`8cbb592eba747da945d101c05a6853644f2597ae`, with a verified normal beta. The
[first-job proof ledger](../reports/2026-09-08-first-job-handoff-proof.md) and
[starter fidelity report](../reports/2026-09-08-first-job-starter-fidelity.md)
record the later rendered and native checks. Approval of a preview is not
acceptance of the real application. The approved onboarding remains a separate
design.

## Scope of this comparison

Keep the existing navigation destinations and channels/threads model recognizable.
The implemented primary menu is Inbox, Tasks, Agents and Billing, with secondary
destinations under the existing persistent More control. No destination is
removed. The sidebar carries the Colony wordmark, the existing workspace
switcher and an explicit Settings action.
Compare the same sample conversation across palette and gradient choices, so a
different layout or feature set does not obscure the styling decision. A channel
shows conversation roots; opening a thread shows the same root and its replies,
in a pane to the right while the channel remains visible. On desktop the layout
is communities rail, sidebar, channel, thread. The existing communities rail
remains visible from the first business, including its Add action and active
community marker; switching, unread state and reordering remain available. Closing the thread gives that space back to the
channel. A separate full-page thread was an incorrect interpretation in the
earlier preview and is withdrawn. This exploration does not introduce a new
task store, owner dashboard or Home/Work/Team navigation.

## Recommended treatment

- Treat colour selection as one coordinated accent system. Use Colony's
  multicolour gradients on the app frame and sidebar, with coherent
  lavender/blue, pink/amber and green/blue families drawn from the brand palette.
  Apply the chosen accent to channel and thread backgrounds, selections, links,
  borders and composers as well. Agent identity colours remain independent.
- Keep reading surfaces opaque, gently tinted and quiet in light and dark
  appearances. Their accent wash must visibly change when the accent changes;
  do not leave them fixed white or charcoal. Use lighter tints in conversation
  panes than in surrounding chrome so the gradients do not compete with text.
  Separate navigation, channel context and active conversation through surfaces,
  spacing and alignment rather than competing heavy borders.
- Remove the invented global breadcrumb/header above the conversation area.
  Put Colony branding and the workspace name in the sidebar. The content area
  starts directly with the channel header and, when open, the thread header.
- Make channel and thread titles distinct, author names easy to scan, and times
  and secondary metadata visually subordinate without compromising readability.
- Test realistic long agent updates, not only short sample messages. Use normal
  body weight, comfortable line height and a readable measure, with a concise
  opening and optional expansion of longer details. Use the existing regular
  Inter stack for workspace reading, per the owner's later correction; keep
  onboarding's separate brand typography. Use normal body weight and named rem
  tokens that respect user text zoom;
  do not solve density by making text tiny. The earlier 14px/15px comparison
  belonged to the preview, not a fixed-pixel production text requirement.
  Reserve large typography for page context, not every agent update.
- Keep ordinary messages as a flowing conversation. Use bounded cards for
  deliverables, structured briefs and decisions that have meaningful actions:
  a social post with its caption, a five-weekday content plan, and a review
  decision are useful samples. Do not duplicate the root as a second thread card.
- Show an agent's personal name, then a smaller readable job title and an Agent
  label. Use the same identity in message headers and direct-message rows. Keep
  human authors visually identifiable without relying on colour alone.
- Give agents stable identity colours that do not change with the workspace
  theme. Reuse existing role and avatar metadata wherever possible; a role is
  not the agent's orchestration rank or manager relationship.
- Retain the actual Colony ant geometry around margins and the app frame.
  Decorations must not overlap message text or receive pointer/focus events.
- Prefer moderate panel rounding and comfortable message spacing. Avoid turning
  every message into a large bubble or making the desktop resemble a marketing
  page. Preserve useful information density and visible selected/unread states.
- Respect existing user appearance choices, narrow windows and reduced motion.
  No continuously moving gradient or decorative animation is required.

Place Appearance inside Settings, accessed from the sidebar, rather than in the
conversation header. Preview three accent families (lavender/blue, pink/amber
and green/blue) and visibly different gradient patterns (soft mesh, diagonal
wash and halo). Keep reading surfaces quiet in each style. These are proposed
appearance preferences, not a required setup step. Do not duplicate these
choices in a second design-control panel.

Show the open thread beside the channel by default in this revision so the
relationship can be reviewed immediately. Preserve each pane's draft and text
expansion when opening, closing or switching threads. At widths that cannot
support readable panes, use the existing focused mobile pattern and retain a
clear return to the channel; this is a responsive fallback, not desktop
navigation. Inline work remains in the thread's messages.

## Existing primitives and implementation boundaries

The native default thread layout is already `split`, with an optional existing
focus preference. Reuse `ChannelPane`, `WorkspaceFocusThreadPane` and
`FocusThreadDrawer`; do not introduce a new navigation route for thread opening.
The implementation reuses the existing width state and resize controls. In Colony
themes an unsaved thread width follows 52% of the measured content width, subject
to the existing clamps. A saved explicit width still wins; reset removes that
explicit value and returns to the responsive default. Each reading pane reserves
at least 300px, and the separate frames require a 12px gutter, so the Colony
single-pane boundary is 612px of available content rather than the old 600px.
The gutter applies only while a split thread is present: existing workspace-focus
and profile/agent panel widths retain their original gap-free layout. The drawer
maximum also reserves that gutter. The pre-existing 380px default
remains the fallback for non-Colony themes or unavailable initial measurement.
The sidebar starts at 240px and remains resizable from 185px to 420px; existing
saved widths are retained within those bounds. Narrow screens retain the native
single-pane/focus return path. These are production layout changes, not new
thread entities or separate draft stores.

Appearance remains the existing Settings section. The implementation exposes the
existing accent picker for Colony themes and adds Soft mesh, Diagonal wash and
Halo through the same community preference record. One selection derives the
frame, opaque reading surfaces, borders and composer fades; no separate channel
or thread preference is introduced. The final palette correction makes the outer
wash quieter and the reading tints more visible. The selected app-sidebar row
uses a quiet raised fill and readable foreground while preserving selected,
unread and optional prominent-selection semantics. Non-Colony surfaces retain
their original styling.

The read-only source audit on 8 September found `AgentPersona.roleId` and
`roleTitle` already persisted and published, with a `buildPersonaRoleByPubkey`
lookup available for reuse. The implementation now exposes the existing title
in the definition editor, agent message headers and one-to-one DM rows. The existing
"Edit role" dialog edits rank and manager; keep those concepts separate.

Emoji avatar colours already persist inside `avatarUrl`. Reuse this colour when
available. A universal accent that survives changing to a photo would require an
additional identity property; choose a stable public-key-derived fallback rather
than a name-derived one. The implementation uses that stable identity-derived fallback; it does not add
a universal persisted colour property.

An ordinary channel message already has a Reply action even with zero replies.
The thread panel can display its root with an empty reply list. Only the reply
summary strip is conditional on replies. Preserve this behaviour and make the
relationship clear; do not introduce a separate conversation entity or delay
thread access until the first reply.

## Review gate

Inspect a channel, its linked thread, the sidebar selection, reply composer and
work previews at desktop and narrow widths, in light and dark. Verify long-text
expansion, zero-reply and populated threads, consistent role labels, identity
colour stability across palettes, and Appearance controls. Keep the comparison
local and clearly label sample content. Compare the actual rendered application
against the approved composition, not only its colours or computed styles. The
first PR failed this comparison; passing interaction tests did not substitute
for it. Rebuild after the final source changes before recording visual acceptance.
Keep source checks, mock-rendered proof, packaged native proof, CI and merge as
separate gates.

## Preview verification on 8 September

The earlier preview contains a 241-word update and passed local interaction and
layout checks at 1024px, 736px and 320px in light and dark appearances. Checks
covered root/reply continuity, opening a zero-reply thread, expansion, retained
drafts, local sample approvals, inline post/caption and weekday-plan views,
consistent role labels, stable agent colours across all nine palette/pattern
combinations, and reading-size changes. A missing accessible name on the compact
mobile navigation button was corrected. Rendered channel, expanded thread,
Appearance, narrow and dark examples were visually reviewed. These results prove
the earlier local design preview only; production UI and the approved onboarding
were not changed.

The subsequent split-pane revision passed fresh local checks at 1024px, 736px
and 320px in light and dark appearances. Both channel and thread stay visible
at desktop widths; closing the thread restores channel width. Distinct composer
and detail IDs, separate drafts and expansion, zero-reply thread opening, local
sample actions and root continuity were checked. Both conversation backgrounds
change across accent/pattern choices while agent identity colours remain stable.
The global header is removed and Appearance is accessible through Settings in
the sidebar. Rendered desktop, narrow, Settings and dark views were reviewed.
This is still preview proof, not a production component or runtime change.

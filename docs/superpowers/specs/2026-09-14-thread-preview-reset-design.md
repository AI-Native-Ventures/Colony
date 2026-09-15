# Thread preview reset

## Approved product direction

Preserve the original Website Manager concept: Colony community rail, channel card, adjacent thread, generous preview area, desktop/mobile controls and ordinary feedback. PR 691 stays closed. This reset starts from develop at 714bc1824, not the failed feature branch.

The first acceptance example is a tiny HTML page, not a completed commercial website. An agent attaches revision 1 to an existing thread. The owner asks for a visible change. The agent attaches revision 2. Both remain readable after reopening. A real Horizon website pilot follows separately and may take hours.

## Inventory and choice

The current core artifact composite already renders persisted Block data in messages. Its implementation is crates/buzz-relay/src/core_blocks/composites/artifact.json. It has a title, description, media URL and status. The desktop BlockMedia component uses MediaCollection; it does not render HTML websites. Existing thread replies provide the feedback conversation.

Choose an extension to the existing artifact delivery path. A separate website job broker would recreate too much of PR 691. A screenshot-only artifact would avoid the problem but would not deliver the approved explorable preview. The missing platform capability is a contained HTML preview attached to a persisted artifact.

## Implementation boundaries

1. Define a preview artifact with immutable content identity, title and revision label. Keep the existing owner, community, channel and thread scope. No new company-task or team requirement to display it.
2. Give agents one documented publish operation using existing upload and Block invocation capabilities. Validate exact CLI syntax against the current CLI before documenting it. Agent-authored metadata must not be interpreted as executable application code.
3. Render an isolated preview with desktop/mobile and expanded views inside the approved channel/thread layout. The preview must not inherit Colony cookies, privileged bridge access or app-origin privileges. The current CSP does not permit arbitrary external frames; do not globally relax it. Inspect the old isolated preview modules for selective reuse before changing the host.
4. Use ordinary thread messages for feedback. Revision 2 is a new immutable artifact in the same thread, with an explicit predecessor reference. Do not overwrite revision 1 or introduce a separate approval state machine in this slice.
5. Reopening reads persisted artifact metadata and content. Missing content must display an actionable unavailable state rather than a fabricated preview.

## Acceptance gates

### Platform mechanics: GitHub CI, no paid model

Use two tiny deterministic HTML fixtures with different visible headings. Prove attachment scoping, artifact loading, contained rendering, desktop/mobile and expanded views, version references, reopening and missing-content handling. Check that preview content cannot access the application bridge or signed-in browser session. The fixture exercises the same publish/render path used by an agent; UI-only seeded state is insufficient for the final mechanics proof.

### Agent connection: separate bounded manual check

Use an existing configured agent to publish the tiny page, receive ordinary feedback and publish the changed page. This proves agent-tool integration, not design quality. Do not silently resume the previously rejected paid OpenRouter workflow; that specific approval remains unresolved.

### Website service: separate pilot

After the mechanics pass, run Horizon Labs' actual website brief in Colony. Allow 45 minutes to three hours or more as the job requires. Assess design quality, completeness, progress communication, resumption and final review. This is never a recurring CI merge requirement.

## Explicitly deferred

Automatic website-team installation, a new job broker, mandatory independent QA task receipts, signed design approval, hosting/domain transfer and handover orchestration. These remain part of the broader approved experience and will be added only after the preview and revision path works. No claim that the first slice delivers the entire mockup.

## Execution order

- Audit current upload/Block invoke and isolated preview host boundaries.
- Implement and verify one persisted revision before adding revision navigation.
- Add revision 2, feedback and reopening verification.
- Open a small PR with actual screenshots of the implemented states and deterministic GitHub evidence.
- Run the bounded agent connection check separately, then schedule the real website pilot with the owner.

## Status

Fresh worktree created. Existing artifact renderer and CSP inspected. Product implementation and checks have not started. No CI or paid validation was dispatched during this reset assessment.

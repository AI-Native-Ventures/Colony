# First job: a usable team and retained business context

The new-community and Power changes are merged in #666. The public release
owner is independently taking the reviewed #668 cutoff to production. This
follow-up must not merge into develop until that cutoff is on main.

## Outcome and acceptance

A fresh community can run its displayed first brief without visiting the
technical Agents settings. The first-job card shows Scout coordinating and one
named worker doing the work. **Approve team and start** authorizes that concrete
team and brief using the Power choice the owner already made. Nothing hires or
starts on mount. The owner reviews the result in the same thread.

The business description and website already reviewed in onboarding must reach
the canonical company profile, so Scout does not reopen the obsolete interview.
Existing configured business profiles and manually configured agents are kept.

## Implementation

1. Save the reviewed business context through the existing owner-signed company
   update action, compare-and-set head, relay receipt and readback. Persist the
   signed attempt before publication; retry the same action. Capture owner,
   community and suggestion identity at every boundary. Fill only an
   unconfigured profile; never discard concurrent company edits.
2. Embed a bounded first-job preparation contract in the existing agent safe
   action. The native executor creates one worker idempotently, with worker tier
   and Scout as manager before publishing its head, using current Power defaults.
   Attach it to the exact Welcome channel without starting it. Initialize only
   a fresh Scout's absent executive rank after verifying relay ownership and the
   latest owner-authored head; preserve manual placement. Normal agent proposals
   retain their existing behavior.
3. Keep the signed owner setup root as the first-job proposal. On explicit
   approval, retain and publish the exact owner-signed team approval before native
   execution, retain its result, then use existing task creation and durable
   dispatch. Do not weaken the generic Blocks broker's agent-instance authority.
4. Show the concrete team in the existing inline card, with readable names and
   roles. Preserve the approved channel/thread layout and branding. Retries use
   the saved team and brief; no duplicate worker, membership, task or dispatch.

## Proof gates

- Source review: account/community changes, partial creation, lost receipts,
  concurrent saves, existing team reuse, no early spawn, default model adoption,
  and no generalized owner-approval bypass.
- GitHub only: native/unit and real UI regressions; no local suites, builds or
  hooks. Include a fresh-community path without a pre-seeded approved worker.
- Package: new-community context and explicit team preparation use actual native
  commands. Synthetic provider output must be labelled.
- Live: separate worker reply, Scout review and matching work record in the same
  thread, with funding/provider choice retained. Source/CI do not establish this.

This phase does not add a social-media publishing product, auto-purchase credits,
or enforce a general orchestrator tool policy. Those remain distinct work.

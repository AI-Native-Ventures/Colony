# First-job staffing and business handoff

This follow-up closes two gaps in the previous first-job handoff: a fresh
community had only Scout, and the reviewed business description was retained in
the Welcome suggestion without configuring the canonical company profile.

The first-job card now shows a named coordinator and worker. **Approve team and
start** approves that pair and brief. Existing approved pairs are reused. A
fresh community proposes Sarah for content or Robin for the Discovery starter.
The user still reviews the result in the same channel/right-thread interface.

The exact owner-signed team approval is persisted before publication. Only after
relay acknowledgement does the existing `execute_agent_proposal` native command
accept the optional `first-job-worker` preparation. Ordinary Agent Proposal
Blocks do not accept that field. Native preparation checks the current owner and
community, scopes its recovery ID to owner + canonical relay + signed request,
and uses current Power defaults without model, runtime or credential pins.

A fresh Scout's absent tier is initialized as executive after relay-authoritative
ownership and the latest owner-authored head are checked. Manual placement
conflicts stop for review. The worker is minted with its role, worker tier and
Scout reporting line; its definition, head, profile and Welcome membership must
be acknowledged. Preparation never starts a process. The existing Task/dispatch
path then validates and starts the pair before sending the one saved instruction.

The business answers reach the canonical profile through the existing signed
company update, compare-and-set head and relay receipt. Only an unconfigured
profile is filled. Concurrent/configured profiles and manual names/budgets are
preserved. Old cards with a description exceeding the canonical limit get a
Business details action rather than a retry loop. New onboarding validates the
same Unicode character limit as the relay.

## Verification boundary

Source changes and regression fixtures are implemented. All applicable source CI
checks passed on `fa38d46a6dcddb84b390651b1d5951e172c91b59` in
[run 34384926669](https://github.com/AI-Native-Ventures/Colony/actions/runs/34384926669).
The stable package job also passed startup, signup/relaunch and 23 native
isolation checks, but its separate legacy persistence fixture failed before
Electron launched. An instrumented diagnostic run passed with the same native
binary hash; that retry alone does not establish a fix. The follow-up remains
draft until the revised fixture and all checks pass on its final source.

Packaged fresh-worker preparation and authenticated worker reply/Scout review
remain unproven.
The browser fixture signs real event envelopes but mocks native staffing, relay
responses and payments; it does not establish successful model work or payment
settlement. No local CI, tests, builds or hooks were run for this change.

PR #666 separately merged new-community onboarding and the three Power options.
The release agent independently completed the #668/#670 production cutoff as
version 0.16.9. This follow-up is excluded from that release and must pass its
own checks and review before promotion.
